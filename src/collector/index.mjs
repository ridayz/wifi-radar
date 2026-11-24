import os from 'node:os';
import { readLink } from './wlan.mjs';
import { readNetInfo } from './netinfo.mjs';
import { startTrafficSampler } from './traffic.mjs';
import { readArpTable, reverseLookup, sweepSubnet } from './devices.mjs';
import { dnsTiming, pingTarget } from './netcheck.mjs';

const CAP = { traffic: 1800, signal: 720, latency: 720 };
const RECORD_MAX = 21600; // 6 hours at 1 Hz
const PING_WINDOW = 12;
const ONLINE_MS = 120_000;

export class Telemetry {
  constructor() {
    this.platform = process.platform;
    this.startedAt = Date.now();
    this.pingTargetIp = process.env.WIFI_RADAR_PING_TARGET || '1.1.1.1';

    this.link = { supported: true, connected: false };
    this.net = { hostname: os.hostname(), ip: null, prefix: null, gateway: null, mac: null, iface: null };
    this.traffic = { rxBps: 0, txBps: 0, totalRx: 0, totalTx: 0, peakRx: 0, peakTx: 0, source: null, lastAt: null };
    this.health = {
      gateway: { rttMs: null, avgMs: null, lossPct: null, samples: 0 },
      internet: { rttMs: null, avgMs: null, minMs: null, maxMs: null, jitterMs: null, lossPct: null, samples: 0 },
      dns: null,
    };
    this.history = { traffic: [], signal: [], latency: [] };
    this.devices = new Map();
    this.recording = { active: false, startedAt: null, samples: [] };
    this.lastScan = null;
    this.warnings = [];
    this.sampler = null;
    this.samplerHint = null;
    this.timers = [];
    this.scanning = false;
    this._prevTrafficAt = null;
    this._internetWindow = [];
    this._gatewayWindow = [];
    this._resolveQueue = [];
    this._resolving = false;
  }

  async start() {
    await this.refreshNetInfo();
    await this.refreshLink();
    await this.sampleDevices();

    this.schedule(5000, () => this.refreshLink());
    this.schedule(5000, () => this.sampleHealth());
    this.schedule(15000, () => this.sampleDevices());
    this.schedule(30000, () => dnsTiming().then((dns) => (this.health.dns = dns)));
    this.schedule(30000, () => this.refreshNetInfo());

    void this.sampleHealth();
    void dnsTiming().then((dns) => (this.health.dns = dns));
    return this;
  }

  schedule(ms, fn) {
    const timer = setInterval(() => {
      Promise.resolve(fn()).catch((err) => this.warn(err.message));
    }, ms);
    timer.unref?.();
    this.timers.push(timer);
  }

  warn(message) {
    if (!message) return;
    this.warnings.unshift({ at: Date.now(), message });
    this.warnings = this.warnings.slice(0, 8);
  }

  async refreshNetInfo() {
    try {
      this.net = { ...this.net, ...(await readNetInfo(this.platform)) };
      this.trackSelf();
    } catch (err) {
      this.warn(`Gagal membaca info jaringan: ${err.message}`);
    }
  }

  /** Keep this host in the device table; the ARP table never lists yourself. */
  trackSelf() {
    const { ip, mac, hostname } = this.net;
    if (!ip || !mac) return;
    const now = Date.now();
    const existing = this.devices.get(mac);
    if (existing) {
      existing.ip = ip;
      existing.lastSeen = now;
      existing.isSelf = true;
      existing.hostname = existing.hostname || hostname || null;
      if (!existing.ips.includes(ip)) existing.ips = [ip, ...existing.ips].slice(0, 8);
      return;
    }
    this.devices.set(mac, {
      key: mac,
      mac,
      ip,
      ips: [ip],
      hostname: hostname || null,
      firstSeen: now,
      lastSeen: now,
      type: null,
      isSelf: true,
      isGateway: false,
    });
  }

  async refreshLink() {
    try {
      const link = await readLink(this.platform);
      this.link = link;
      if (link.connected && link.signalPct != null) {
        this.pushHistory('signal', {
          t: Date.now(),
          pct: Math.round(link.signalPct),
          rssi: link.rssiDbm,
        });
      }
      this.ensureSampler();
    } catch (err) {
      this.warn(`Gagal membaca status WiFi: ${err.message}`);
    }
  }

  ensureSampler() {
    const adapterName = this.link?.adapterName || this.net.iface || '';
    const description = this.link?.description || adapterName;
    const hint = `${this.platform}:${adapterName}:${description}`;
    if (this.sampler && this.samplerHint === hint) return;
    this.sampler?.stop();
    this.samplerHint = hint;
    this._prevTrafficAt = null;
    this.sampler = startTrafficSampler({
      platform: this.platform,
      description,
      adapterName,
      ifaceName: this.net.iface,
      onSample: (sample) => this.onTraffic(sample),
      onWarn: (message) => this.warn(message),
    });
    this.traffic.source = this.sampler.source;
  }

  onTraffic({ rx, tx, at }) {
    const dt = this._prevTrafficAt ? Math.max(0.001, (at - this._prevTrafficAt) / 1000) : 1;
    this._prevTrafficAt = at;

    this.traffic.rxBps = rx;
    this.traffic.txBps = tx;
    this.traffic.totalRx += rx * dt;
    this.traffic.totalTx += tx * dt;
    this.traffic.peakRx = Math.max(this.traffic.peakRx, rx);
    this.traffic.peakTx = Math.max(this.traffic.peakTx, tx);
    this.traffic.lastAt = at;

    this.pushHistory('traffic', { t: at, rx: Math.round(rx), tx: Math.round(tx) });

    if (this.link.connected) {
      this.link.rxRateMbps = Math.round((rx * 8) / 1e6 * 10) / 10;
      this.link.txRateMbps = Math.round((tx * 8) / 1e6 * 10) / 10;
    }

    if (this.recording.active) this.recordSample(at, rx, tx);
  }

  recordSample(at, rx, tx) {
    const sample = {
      t: at,
      iso: new Date(at).toISOString(),
      rxBps: Math.round(rx),
      txBps: Math.round(tx),
      signalPct: this.link?.signalPct ?? null,
      rssiDbm: this.link?.rssiDbm ?? null,
      latencyGwMs: this.health.gateway.rttMs,
      latencyNetMs: this.health.internet.rttMs,
      lossNetPct: this.health.internet.lossPct,
      dnsMs: this.health.dns?.ms ?? null,
      clientsOnline: this.onlineClients().length,
      ssid: this.link?.ssid ?? null,
      bssid: this.link?.bssid ?? null,
      channel: this.link?.channel ?? null,
    };
    const samples = this.recording.samples;
    samples.push(sample);
    if (samples.length > RECORD_MAX) samples.shift();
  }

  async sampleHealth() {
    const gateway = this.net.gateway;
    const [gw, net] = await Promise.all([
      gateway ? pingTarget(gateway, { platform: this.platform, timeoutMs: 900 }) : Promise.resolve({ ok: false, rttMs: null }),
      pingTarget(this.pingTargetIp, { platform: this.platform, timeoutMs: 900 }),
    ]);

    this.health.gateway = summarizePings(this._gatewayWindow, gw);
    this.health.internet = summarizePings(this._internetWindow, net);

    this.pushHistory('latency', {
      t: Date.now(),
      ms: this.health.internet.rttMs,
      loss: this.health.internet.lossPct,
    });
  }

  async sampleDevices() {
    try {
      const table = await readArpTable(this.platform);
      if (table.length === 0) return;
      const now = Date.now();
      const gatewayMac = table.find((entry) => entry.ip === this.net.gateway)?.mac || null;
      let proxyCount = 0;

      for (const entry of table) {
        // Proxy ARP: a router can answer for many unused IPs with its own MAC.
        // Those are not separate devices, so collapse them.
        if (gatewayMac && entry.mac === gatewayMac && entry.ip !== this.net.gateway) {
          proxyCount++;
          continue;
        }

        const key = entry.mac;
        const existing = this.devices.get(key);
        if (existing) {
          existing.lastSeen = now;
          existing.type = entry.type;
          mergeAddress(existing, entry.ip, this.net);
        } else {
          const device = {
            key,
            mac: entry.mac,
            ip: entry.ip,
            ips: [entry.ip],
            hostname: null,
            firstSeen: now,
            lastSeen: now,
            type: entry.type,
            isSelf: entry.mac === this.net.mac || entry.ip === this.net.ip,
            isGateway: entry.ip === this.net.gateway,
          };
          this.devices.set(key, device);
          this.queueResolve(device);
        }
      }

      if (proxyCount > 0 && !this._proxyWarned) {
        this._proxyWarned = true;
        this.warn(
          `${proxyCount} entri ARP memakai MAC gateway (proxy ARP) dan tidak dihitung sebagai perangkat terpisah.`,
        );
      }
    } catch (err) {
      this.warn(`Gagal membaca tabel ARP: ${err.message}`);
    }
  }

  queueResolve(device) {
    if (!device || device.isSelf || device.hostname) return;
    this._resolveQueue.push(device);
    void this.pumpResolve();
  }

  async pumpResolve() {
    if (this._resolving) return;
    this._resolving = true;
    try {
      while (this._resolveQueue.length > 0) {
        const device = this._resolveQueue.shift();
        if (!device || device.hostname) continue;
        const hostname = await reverseLookup(device.ip, 700);
        if (hostname) device.hostname = hostname;
      }
    } finally {
      this._resolving = false;
    }
  }

  onlineDevices() {
    const now = Date.now();
    return [...this.devices.values()].filter((d) => now - d.lastSeen < ONLINE_MS);
  }

  /** Online peers, excluding this host (used for the "perangkat" counters). */
  onlineClients() {
    return this.onlineDevices().filter((d) => !d.isSelf);
  }

  async deepScan() {
    if (this.scanning) return { busy: true, lastScan: this.lastScan };
    if (!this.net.ip) return { error: 'IP lokal belum terdeteksi' };
    this.scanning = true;
    try {
      const result = await sweepSubnet({
        ip: this.net.ip,
        prefix: this.net.prefix ?? 24,
        platform: this.platform,
      });
      await this.sampleDevices();
      this.lastScan = {
        at: Date.now(),
        scope: result.scope,
        probed: result.probed,
        responsive: result.responsive,
        durationMs: result.durationMs,
        found: this.onlineClients().length,
      };
      return this.lastScan;
    } catch (err) {
      this.warn(`Scan gagal: ${err.message}`);
      return { error: err.message };
    } finally {
      this.scanning = false;
    }
  }

  setRecording(action) {
    if (action === 'start' && !this.recording.active) {
      this.recording = { active: true, startedAt: Date.now(), samples: [] };
    }
    if (action === 'stop' && this.recording.active) {
      this.recording.active = false;
    }
    return this.recordingInfo();
  }

  recordingInfo() {
    return {
      active: this.recording.active,
      startedAt: this.recording.startedAt,
      samples: this.recording.samples.length,
    };
  }

  pushHistory(name, point) {
    const list = this.history[name];
    list.push(point);
    if (list.length > CAP[name]) list.shift();
  }

  deviceList() {
    const now = Date.now();
    return [...this.devices.values()]
      .map((d) => ({
        ...d,
        ips: [...d.ips],
        ipCount: d.ips.length,
        online: now - d.lastSeen < ONLINE_MS,
        seenAgoSec: Math.round((now - d.lastSeen) / 1000),
      }))
      .sort((a, b) => Number(b.online) - Number(a.online) || b.lastSeen - a.lastSeen);
  }

  snapshot({ includeHistory = true } = {}) {
    const snap = {
      ok: true,
      now: Date.now(),
      startedAt: this.startedAt,
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      platform: this.platform,
      link: this.link,
      net: this.net,
      traffic: this.traffic,
      health: this.health,
      devices: this.deviceList(),
      recording: this.recordingInfo(),
      lastScan: this.lastScan,
      scanning: this.scanning,
      warnings: this.warnings,
      lastSignal: this.history.signal[this.history.signal.length - 1] || null,
      lastLatency: this.history.latency[this.history.latency.length - 1] || null,
    };
    if (includeHistory) snap.history = this.history;
    return snap;
  }

  /** Per-second samples rebuilt from the in-memory history (last ~30 min of traffic). */
  historySamples() {
    const signal = this.history.signal;
    const latency = this.history.latency;
    let si = 0;
    let li = 0;
    const out = [];
    for (const point of this.history.traffic) {
      while (si + 1 < signal.length && signal[si + 1].t <= point.t) si++;
      while (li + 1 < latency.length && latency[li + 1].t <= point.t) li++;
      const sig = signal[si] && signal[si].t <= point.t + 5000 ? signal[si] : null;
      const lat = latency[li] && latency[li].t <= point.t + 5000 ? latency[li] : null;
      out.push({
        t: point.t,
        iso: new Date(point.t).toISOString(),
        rxBps: point.rx,
        txBps: point.tx,
        signalPct: sig?.pct ?? null,
        rssiDbm: sig?.rssi ?? null,
        latencyGwMs: null,
        latencyNetMs: lat?.ms ?? null,
        lossNetPct: lat?.loss ?? null,
        dnsMs: this.health.dns?.ms ?? null,
        clientsOnline: null,
        ssid: this.link?.ssid ?? null,
        bssid: this.link?.bssid ?? null,
        channel: this.link?.channel ?? null,
      });
    }
    return out;
  }

  /**
   * Whole-session samples: recorded seconds win (they carry gateway latency and
   * client counts), history fills whatever was not recorded. Deduped per second.
   */
  mergedSamples() {
    const bySecond = new Map();
    for (const sample of this.historySamples()) bySecond.set(Math.floor(sample.t / 1000), sample);
    for (const sample of this.recording.samples) bySecond.set(Math.floor(sample.t / 1000), sample);
    return [...bySecond.entries()].sort((a, b) => a[0] - b[0]).map(([, sample]) => sample);
  }

  evidence({ scope = 'record' } = {}) {
    const recorded = this.recording.samples.length > 0;
    const effective = scope === 'session' ? 'session' : recorded ? 'recording' : 'session';
    const samples = effective === 'session' ? this.mergedSamples() : [...this.recording.samples];
    const durationSec =
      samples.length > 1 ? Math.round((samples[samples.length - 1].t - samples[0].t) / 1000) : 0;
    const signals = samples.map((s) => s.signalPct).filter((v) => Number.isFinite(v));
    const latencies = samples.map((s) => s.latencyNetMs).filter((v) => Number.isFinite(v));
    const losses = samples.map((s) => s.lossNetPct).filter((v) => Number.isFinite(v));

    return {
      app: 'wifi-radar',
      version: '1.0.0',
      generatedAt: new Date().toISOString(),
      host: os.hostname(),
      scope: effective,
      session: {
        startedAt: new Date(this.startedAt).toISOString(),
        endedAt: new Date().toISOString(),
        recordedFrom: samples.length ? samples[0].iso : null,
        recordedTo: samples.length ? samples[samples.length - 1].iso : null,
        durationSec,
        samples: samples.length,
      },
      link: this.link,
      net: this.net,
      summary: {
        avgRxBps: avg(samples.map((s) => s.rxBps)),
        avgTxBps: avg(samples.map((s) => s.txBps)),
        peakRxBps: samples.length ? Math.max(...samples.map((s) => s.rxBps)) : null,
        peakTxBps: samples.length ? Math.max(...samples.map((s) => s.txBps)) : null,
        avgSignalPct: avg(signals),
        minSignalPct: signals.length ? Math.min(...signals) : null,
        avgLatencyMs: avg(latencies),
        maxLatencyMs: latencies.length ? Math.max(...latencies) : null,
        avgLossPct: avg(losses),
        maxLossPct: losses.length ? Math.max(...losses) : null,
        ...integrate(samples),
      },
      devices: this.deviceList().map((d) => ({
        ip: d.ip,
        ips: d.ips,
        mac: d.mac,
        hostname: d.hostname,
        firstSeen: new Date(d.firstSeen).toISOString(),
        lastSeen: new Date(d.lastSeen).toISOString(),
        online: d.online,
        isSelf: d.isSelf,
        isGateway: d.isGateway,
      })),
      lastScan: this.lastScan,
      warnings: this.warnings,
      samples,
    };
  }

  toCsv({ scope = 'record' } = {}) {
    const samples = this.evidence({ scope }).samples;
    const header = [
      'timestamp_iso',
      'ssid',
      'bssid',
      'channel',
      'rx_bps',
      'tx_bps',
      'signal_pct',
      'rssi_dbm',
      'latency_gateway_ms',
      'latency_internet_ms',
      'loss_internet_pct',
      'dns_ms',
      'clients_online',
    ];
    const rows = samples.map((s) =>
      [
        s.iso,
        csvCell(s.ssid),
        csvCell(s.bssid),
        s.channel ?? '',
        s.rxBps ?? '',
        s.txBps ?? '',
        s.signalPct ?? '',
        s.rssiDbm ?? '',
        s.latencyGwMs ?? '',
        s.latencyNetMs ?? '',
        s.lossNetPct ?? '',
        s.dnsMs ?? '',
        s.clientsOnline ?? '',
      ].join(','),
    );
    return [header.join(','), ...rows].join('\n');
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.sampler?.stop();
  }
}

/**
 * Integrate byte rates into totals for the exported scope. Gaps longer than 5 s
 * (sleep, sampler stall) are reported separately instead of being summed, so the
 * totals never claim traffic that was never measured.
 */
export function integrate(samples) {
  let rx = 0;
  let tx = 0;
  let gapCount = 0;
  let gapSec = 0;
  let maxGapSec = 0;

  for (let i = 1; i < samples.length; i++) {
    const dt = (samples[i].t - samples[i - 1].t) / 1000;
    if (!Number.isFinite(dt) || dt <= 0) continue;
    if (dt > 5) {
      gapCount++;
      gapSec += dt;
      maxGapSec = Math.max(maxGapSec, dt);
      continue;
    }
    rx += (samples[i].rxBps || 0) * dt;
    tx += (samples[i].txBps || 0) * dt;
  }

  return {
    totalRxBytes: Math.round(rx),
    totalTxBytes: Math.round(tx),
    gaps: { count: gapCount, totalSec: Math.round(gapSec), maxSec: Math.round(maxGapSec) },
  };
}

function mergeAddress(device, ip, net) {  if (!device.ips.includes(ip)) {
    device.ips.push(ip);
    if (device.ips.length > 8) device.ips.shift();
  }
  if (ip === net.gateway) {
    device.ip = ip;
    device.isGateway = true;
  } else if (device.ip !== net.gateway) {
    device.ip = ip;
  }
  if (ip === net.ip || device.mac === net.mac) device.isSelf = true;
}

function summarizePings(window, result) {  window.push(result);
  if (window.length > PING_WINDOW) window.shift();
  const ok = window.filter((r) => r.ok);
  const rtts = ok.map((r) => r.rttMs).filter(Number.isFinite);
  const jitter =
    rtts.length > 1
      ? avg(rtts.slice(1).map((value, i) => Math.abs(value - rtts[i])))
      : null;
  return {
    rttMs: result.ok ? result.rttMs : null,
    avgMs: avg(rtts),
    minMs: rtts.length ? Math.min(...rtts) : null,
    maxMs: rtts.length ? Math.max(...rtts) : null,
    jitterMs: jitter,
    lossPct: window.length ? Math.round(((window.length - ok.length) / window.length) * 1000) / 10 : null,
    samples: window.length,
  };
}

function avg(values) {
  const list = values.filter((v) => Number.isFinite(v));
  if (list.length === 0) return null;
  return Math.round((list.reduce((a, b) => a + b, 0) / list.length) * 10) / 10;
}

function csvCell(value) {
  if (value == null) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
