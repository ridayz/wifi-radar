import { num } from './exec.mjs';

const WLAN_KEYS = {
  name: ['name', 'nama'],
  description: ['description', 'deskripsi'],
  state: ['state', 'status', 'keadaan'],
  ssid: ['ssid'],
  bssid: ['ap bssid', 'bssid'],
  band: ['band', 'pita'],
  channel: ['channel', 'saluran'],
  radio: ['radio type', 'tipe radio', 'radio'],
  auth: ['authentication', 'autentikasi'],
  cipher: ['cipher', 'sandi'],
  rxRate: ['receive rate (mbps)', 'receive rate', 'kecepatan terima (mbps)'],
  txRate: ['transmit rate (mbps)', 'transmit rate', 'kecepatan kirim (mbps)'],
  signal: ['signal', 'sinyal'],
  rssi: ['rssi'],
};

function keyFor(normalized) {
  for (const [canonical, aliases] of Object.entries(WLAN_KEYS)) {
    if (aliases.includes(normalized)) return canonical;
  }
  return null;
}

/** Parse `netsh wlan show interfaces` (English or Indonesian). */
export function parseWlanInterfaces(text) {
  const blocks = [];
  let cur = {};

  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z][^:]{1,40}?)\s*:\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const normalized = m[1].toLowerCase().replace(/\s+/g, ' ').trim();
    const canonical = keyFor(normalized);
    if (!canonical) continue;
    const value = m[2];
    if (canonical === 'name' && cur.name && Object.keys(cur).length > 1) {
      blocks.push(cur);
      cur = {};
    }
    if (cur[canonical] === undefined) cur[canonical] = value;
  }
  if (Object.keys(cur).length > 0) blocks.push(cur);

  return blocks.map((b) => {
    const stateText = String(b.state || '').toLowerCase();
    const connected = /connected|terhubung|authenticated/.test(stateText);
    const signalPct = b.signal != null ? clamp(num(b.signal), 0, 100) : null;
    const rssi = b.rssi != null ? num(b.rssi) : signalPct != null ? Math.round(signalPct / 2 - 100) : null;
    return {
      connected,
      name: b.name || null,
      description: b.description || null,
      ssid: b.ssid || null,
      bssid: normalizeMac(b.bssid) || null,
      band: b.band || null,
      channel: b.channel != null ? num(b.channel) : null,
      radio: b.radio || null,
      auth: b.auth || null,
      cipher: b.cipher || null,
      rxRateMbps: b.rxRate != null ? num(b.rxRate) : null,
      txRateMbps: b.txRate != null ? num(b.txRate) : null,
      signalPct,
      rssiDbm: rssi,
      state: b.state || null,
    };
  });
}

/** Parse nmcli tabular output into a single active link when available (Linux, best effort). */
export function parseNmcliWifi(text) {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const enabled = line.startsWith('yes:') || line.startsWith('*:');
    if (!enabled) continue;
    const rest = line.replace(/^(\*|yes):/, '');
    const parts = rest.split(/(?<!\\):/).map((p) => p.replace(/\\:/g, ':'));
    const [ssid, bssid, signal, channel, freq] = parts;
    const signalPct = clamp(num(signal), 0, 100);
    return {
      connected: true,
      name: null,
      description: null,
      ssid: ssid || null,
      bssid: normalizeMac(bssid) || null,
      band: freq ? (num(freq) >= 5000 ? '5 GHz' : '2.4 GHz') : null,
      channel: channel != null ? num(channel) : null,
      radio: null,
      auth: null,
      cipher: null,
      rxRateMbps: null,
      txRateMbps: null,
      signalPct,
      rssiDbm: Math.round(signalPct / 2 - 100),
      state: 'connected',
    };
  }
  return null;
}

/** Parse `arp -a` (Windows/macOS) or `ip neigh` (Linux). */
export function parseArp(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    let m = /^(\d{1,3}(?:\.\d{1,3}){3})\s+([0-9a-f]{2}(?:[-:][0-9a-f]{2}){5})\s+(\w+)/i.exec(line);
    if (!m) {
      m = /^(\d{1,3}(?:\.\d{1,3}){3})\s+dev\s+\S+\s+lladdr\s+([0-9a-f]{2}(?::[0-9a-f]{2}){5})/i.exec(line);
    }
    if (!m) {
      m = /\((\d{1,3}(?:\.\d{1,3}){3})\)\s+at\s+([0-9a-f]{2}(?::[0-9a-f]{2}){5})/i.exec(line);
    }
    if (!m) continue;

    const ip = m[1];
    const mac = normalizeMac(m[2]);
    const type = (m[3] || '').toLowerCase();
    if (!mac) continue;
    if (isMulticastOrBroadcast(ip, mac)) continue;
    out.push({ ip, mac, type: type || null });
  }
  return out;
}

/** Parse an IPv4 default route (Windows `route print -4 0.0.0.0`). */
export function parseRouteWindows(text) {
  const m = /^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\d{1,3}(?:\.\d{1,3}){3})\s+(\d{1,3}(?:\.\d{1,3}){3})\s+(\d+)/m.exec(text);
  if (!m) return null;
  return { gateway: m[1], ifaceIp: m[2], metric: Number(m[3]) };
}

/** Parse `ip route show default` / `ip -4 route`. */
export function parseRouteLinux(text) {
  const m = /default\s+via\s+(\d{1,3}(?:\.\d{1,3}){3})\s+dev\s+(\S+)/.exec(text);
  if (!m) return null;
  return { gateway: m[1], iface: m[2] };
}

/** Parse one ICMP echo reply (English or Indonesian output). */
export function parsePing(text) {
  const rttMatch =
    /(?:time|waktu|tiempo|temps|zeit|время)\s*([=<])\s*([\d.,]+)\s*ms/i.exec(text) ||
    /\s([=<])\s*([\d.,]+)\s*ms/i.exec(text);
  const replied = /ttl\s*[=:]/i.test(text);
  const unreachable = /(unreachable|timed out|timeout|100%\s*(?:loss|hilang)|destination net)/i.test(text);
  const ok = replied && !unreachable;
  const belowThreshold = rttMatch?.[1] === '<';
  const rtt = rttMatch ? (belowThreshold ? 0.5 : num(rttMatch[2], 0.5)) : null;
  return {
    ok,
    rttMs: ok ? rtt : null,
    ttl: (/(?:ttl|hop)\s*[=:]\s*(\d+)/i.exec(text) || [])[1] || null,
  };
}

/** Parse a `typeperf` CSV header into column indexes for the chosen adapter. */
export function parseTypeperfHeader(headerLine, description) {
  const fields = [...headerLine.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  const columns = [];
  fields.forEach((name, index) => {
    const m = /Network Interface\((.*)\)\\Bytes (Received|Sent)\/sec/i.exec(name);
    if (m) columns.push({ index, instance: m[1], direction: m[2].toLowerCase() });
  });
  if (columns.length === 0) return null;

  const instances = [...new Set(columns.map((c) => c.instance))];
  const wanted =
    instances.find((i) => i.toLowerCase() === String(description || '').toLowerCase()) ||
    instances.find((i) => String(description || '').toLowerCase().includes(i.toLowerCase())) ||
    instances.find((i) => /wi-?fi|wireless|wlan|802\.11/i.test(i)) ||
    instances[0];

  const rx = columns.find((c) => c.instance === wanted && c.direction === 'received');
  const tx = columns.find((c) => c.instance === wanted && c.direction === 'sent');
  if (!rx || !tx) return null;
  return { instance: wanted, rx: rx.index, tx: tx.index };
}

/** Parse a `typeperf` data row into {rx, tx} bytes/second. */
export function parseTypeperfRow(line, map) {
  const fields = [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  if (fields.length <= Math.max(map.rx, map.tx)) return null;
  return {
    rx: Math.max(0, num(fields[map.rx])),
    tx: Math.max(0, num(fields[map.tx])),
  };
}

/** Parse a PowerShell counter line: `Wi-Fi|1234|5678;Ethernet|1|2`. */
export function parseAdapterCounters(text) {
  return String(text)
    .split(';')
    .map((part) => {
      const [name, rx, tx] = part.split('|');
      if (!name) return null;
      return { name: name.trim(), rx: num(rx), tx: num(tx) };
    })
    .filter(Boolean);
}

/** Parse `/proc/net/dev`, returning cumulative bytes for one interface. */
export function parseProcNetDev(text, ifaceName) {
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*([^:]+):\s*(.+)$/.exec(raw);
    if (!m) continue;
    if (m[1].trim() !== ifaceName) continue;
    const nums = m[2].trim().split(/\s+/).map((v) => Number(v));
    return { rxBytes: nums[0] || 0, txBytes: nums[8] || 0 };
  }
  return null;
}

export function normalizeMac(value) {
  if (!value) return null;
  const hex = String(value).toLowerCase().replace(/[^0-9a-f]/g, '');
  if (hex.length !== 12) return null;
  return hex.match(/.{2}/g).join(':');
}

export function isMulticastOrBroadcast(ip, mac) {
  const firstOctet = Number(String(ip).split('.')[0]);
  if (firstOctet >= 224) return true;
  if (mac === 'ff:ff:ff:ff:ff:ff') return true;
  if (mac.startsWith('01:00:5e')) return true;
  return false;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function normalizeLink(link) {
  if (!link) return null;
  if (!link.connected) return { ...link, ssid: link.ssid || null };
  return link;
}
