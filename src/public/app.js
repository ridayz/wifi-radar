const $ = (id) => document.getElementById(id);

const css = getComputedStyle(document.documentElement);
const color = (name) => {
  const map = {
    rx: '#4cc9f0',
    tx: '#f2a25c',
    ok: '#45d184',
    warn: '#e7b34d',
    bad: '#ef6262',
    info: '#9ecbff',
    text: '#e9eef4',
    muted: '#8b97a6',
    grid: 'rgba(255,255,255,0.055)',
  };
  return map[name] || css.getPropertyValue(`--${name}`).trim() || '#fff';
};

const state = {
  snapshot: null,
  traffic: [],
  signal: [],
  latency: [],
  recording: false,
};

const CAP = { traffic: 1800, signal: 720, latency: 720 };
// Trafik ditampilkan realtime 60 detik terakhir, bukan 5 menit: satu tes
// speedtest (±30 dtk) jadi memenuhi setengah grafik dan bentuknya bisa
// dibandingkan langsung dengan angka speedtest.
const WINDOW = { traffic: 60, signal: 180, latency: 180 };

/* ------------------------------ formatting ------------------------------ */

function fmtBps(value) {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)} GB/s`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)} MB/s`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1)} KB/s`;
  return `${Math.round(value)} B/s`;
}

function fmtBytes(value) {
  if (!Number.isFinite(value)) return '—';
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)} GB`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)} MB`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(0)} KB`;
  return `${Math.round(value)} B`;
}

function fmtMs(value) {
  if (!Number.isFinite(value)) return '—';
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ms`;
}

function fmtPct(value) {
  if (!Number.isFinite(value)) return '—';
  return `${Math.round(value * 10) / 10}%`;
}

function fmtAgo(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  if (seconds < 5) return 'baru saja';
  if (seconds < 60) return `${seconds} dtk lalu`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} mnt lalu`;
  return `${Math.floor(seconds / 3600)} jam lalu`;
}

function timeOf(t) {
  return new Date(t).toLocaleTimeString('id-ID', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function clockOf(t) {
  return new Date(t).toLocaleTimeString('id-ID', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[ch]);
}

function qualityOf(pct) {
  if (!Number.isFinite(pct)) return { label: '—', cls: 'neutral' };
  if (pct >= 70) return { label: 'kuat', cls: 'good' };
  if (pct >= 45) return { label: 'cukup', cls: 'warn' };
  if (pct >= 25) return { label: 'lemah', cls: 'warn' };
  return { label: 'buruk', cls: 'bad' };
}

function latencyClass(ms) {
  if (!Number.isFinite(ms)) return 'neutral';
  if (ms < 60) return 'good';
  if (ms < 150) return 'warn';
  return 'bad';
}

function lossClass(pct) {
  if (!Number.isFinite(pct)) return 'neutral';
  if (pct <= 0.5) return 'good';
  if (pct < 3) return 'warn';
  return 'bad';
}

/* -------------------------------- charts -------------------------------- */

const charts = {};

function createChart(canvas, tip, config) {
  const chart = {
    canvas,
    ctx: canvas.getContext('2d'),
    tip,
    config,
    data: [],
    hover: null,
    pad: { l: config.padLeft ?? 62, r: 10, t: 10, b: 22 },
  };
  charts[canvas.id] = chart;

  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    drawChart(chart);
  };
  new ResizeObserver(resize).observe(canvas);
  resize();

  canvas.addEventListener('mousemove', (event) => {
    const rect = canvas.getBoundingClientRect();
    const plotW = rect.width - chart.pad.l - chart.pad.r;
    const x = event.clientX - rect.left - chart.pad.l;
    if (x < 0 || x > plotW || chart.data.length < 2) {
      hideTip(chart);
      return;
    }
    const windowData = chart.data.slice(-chart.config.window);
    const index = Math.round((x / Math.max(1, plotW)) * (windowData.length - 1));
    chart.hover = clamp(index, 0, windowData.length - 1);
    showTip(chart, windowData[chart.hover], rect, plotW);
    drawChart(chart);
  });
  canvas.addEventListener('mouseleave', () => hideTip(chart));
  return chart;
}

function showTip(chart, point, rect, plotW) {
  if (!point || !chart.tip) return;
  chart.tip.hidden = false;
  chart.tip.innerHTML = chart.config.tip(point);
  const windowData = chart.data.slice(-chart.config.window);
  const index = windowData.indexOf(point);
  const ratio = windowData.length > 1 ? index / (windowData.length - 1) : 0;
  chart.tip.style.left = `${chart.pad.l + ratio * plotW}px`;
  chart.tip.style.top = '4px';
}

function hideTip(chart) {
  chart.hover = null;
  if (chart.tip) chart.tip.hidden = true;
  drawChart(chart);
}

function drawChart(chart) {
  const { ctx, canvas, config } = chart;
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.width / dpr;
  const height = canvas.height / dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  if (chart.data.length < 2) {
    ctx.fillStyle = 'rgba(139,151,166,0.45)';
    ctx.font = '12px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Menunggu data…', width / 2, height / 2);
    return;
  }

  const { l, r, t, b } = chart.pad;
  const plotW = width - l - r;
  const plotH = height - t - b;
  const data = chart.data.slice(-config.window);

  let max = config.maxValue ? config.maxValue(data) : 0;
  if (!config.maxValue) {
    for (const series of config.series) {
      for (const point of data) {
        if (Number.isFinite(point[series.key])) max = Math.max(max, point[series.key]);
      }
    }
  }
  if (!Number.isFinite(max) || max <= 0) max = 1;
  if (config.maxFloor) max = Math.max(max, config.maxFloor);
  if (!config.exactMax) max *= 1.12;

  const xOf = (idx) => l + (data.length > 1 ? (idx / (data.length - 1)) * plotW : 0);
  const yOf = (value) => t + plotH - clamp(value / max, 0, 1) * plotH;

  if (config.bands) {
    for (const band of config.bands) {
      const y1 = yOf(band.to);
      const y2 = yOf(band.from);
      ctx.fillStyle = band.color;
      ctx.fillRect(l, y1, plotW, Math.max(0, y2 - y1));
    }
  }

  ctx.font = '10.5px ui-monospace, Consolas, monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const value = (max / 4) * i;
    const y = yOf(value);
    if (i > 0) {
      ctx.strokeStyle = color('grid');
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(l, y);
      ctx.lineTo(l + plotW, y);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(139,151,166,0.7)';
    ctx.fillText(config.yLabel(value), l - 8, y);
  }

  ctx.textBaseline = 'top';
  ctx.fillStyle = 'rgba(139,151,166,0.55)';
  const last = data.length - 1;
  const marks = [
    { index: 0, align: 'left', x: l },
    { index: Math.floor(last / 2), align: 'center', x: xOf(Math.floor(last / 2)) },
    { index: last, align: 'right', x: l + plotW },
  ];
  for (const mark of marks) {
    ctx.textAlign = mark.align;
    ctx.fillText(clockOf(data[mark.index].t), mark.x, t + plotH + 7);
  }

  for (const series of config.series) {
    const values = data.map((point) => point[series.key]);
    ctx.beginPath();
    let started = false;
    values.forEach((value, idx) => {
      if (!Number.isFinite(value)) {
        started = false;
        return;
      }
      const x = xOf(idx);
      const y = yOf(value);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.strokeStyle = series.color;
    ctx.lineWidth = series.width ?? 1.6;
    ctx.lineJoin = 'round';
    ctx.stroke();

    if (series.fill !== false) {
      const gradient = ctx.createLinearGradient(0, t, 0, t + plotH);
      gradient.addColorStop(0, hexAlpha(series.color, 0.16));
      gradient.addColorStop(1, hexAlpha(series.color, 0.01));
      ctx.beginPath();
      let began = false;
      let firstX = null;
      let lastX = null;
      values.forEach((value, idx) => {
        if (!Number.isFinite(value)) return;
        const x = xOf(idx);
        const y = yOf(value);
        if (!began) {
          ctx.moveTo(x, y);
          firstX = x;
          began = true;
        } else {
          ctx.lineTo(x, y);
        }
        lastX = x;
      });
      if (began && firstX != null && lastX != null) {
        ctx.lineTo(lastX, t + plotH);
        ctx.lineTo(firstX, t + plotH);
        ctx.closePath();
        ctx.fillStyle = gradient;
        ctx.fill();
      }
    }
  }

  if (config.markers) config.markers(ctx, data, { xOf, yOf, plotH: t + plotH });

  if (chart.hover != null && chart.hover < data.length) {
    const x = xOf(chart.hover);
    ctx.strokeStyle = 'rgba(233,238,244,0.28)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x, t);
    ctx.lineTo(x, t + plotH);
    ctx.stroke();
    ctx.setLineDash([]);
    for (const series of config.series) {
      const value = data[chart.hover][series.key];
      if (!Number.isFinite(value)) continue;
      ctx.beginPath();
      ctx.arc(x, yOf(value), 3, 0, Math.PI * 2);
      ctx.fillStyle = series.color;
      ctx.fill();
    }
  }
}

function hexAlpha(hex, alpha) {
  const value = hex.replace('#', '');
  const bigint = parseInt(value.length === 3 ? value.split('').map((c) => c + c).join('') : value, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/* -------------------------------- charts setup -------------------------------- */

const trafficChart = createChart($('chartTraffic'), $('tipTraffic'), {
  window: WINDOW.traffic,
  maxFloor: 20_000,
  exactMax: false,
  series: [
    { key: 'rx', color: color('rx') },
    { key: 'tx', color: color('tx') },
  ],
  yLabel: (value) => fmtBps(value).replace(' ', ''),
  tip: (point) =>
    `<div>${timeOf(point.t)}</div><div>↓ ${fmtBps(point.rx)}</div><div>↑ ${fmtBps(point.tx)}</div>`,
});

createChart($('chartSignal'), $('tipSignal'), {
  window: WINDOW.signal,
  maxValue: () => 100,
  exactMax: true,
  series: [{ key: 'pct', color: color('ok') }],
  bands: [
    { from: 0, to: 40, color: 'rgba(239,98,98,0.05)' },
    { from: 40, to: 70, color: 'rgba(231,179,77,0.05)' },
    { from: 70, to: 100, color: 'rgba(69,209,132,0.045)' },
  ],
  yLabel: (value) => `${Math.round(value)}%`,
  tip: (point) => `<div>${timeOf(point.t)}</div><div>${Math.round(point.pct)}% · ${point.rssi ?? '—'} dBm</div>`,
});

createChart($('chartLatency'), $('tipLatency'), {
  window: WINDOW.latency,
  maxFloor: 150,
  maxValue: (data) => Math.max(60, ...data.map((point) => point.ms).filter(Number.isFinite)),
  series: [{ key: 'ms', color: color('info') }],
  yLabel: (value) => `${Math.round(value)}ms`,
  tip: (point) =>
    `<div>${timeOf(point.t)}</div><div>${fmtMs(point.ms)} · loss ${fmtPct(point.loss)}</div>`,
  markers: (ctx, data, { xOf, plotH }) => {
    ctx.fillStyle = 'rgba(239,98,98,0.85)';
    data.forEach((point, idx) => {
      if (Number.isFinite(point.loss) && point.loss > 0) {
        ctx.fillRect(xOf(idx) - 0.75, plotH - 4, 1.5, 4);
      }
    });
  },
});

/* -------------------------------- rendering -------------------------------- */

let deviceSignature = '';
let lastTickAt = 0;

function applySnapshot(snapshot, { replaceHistory = false } = {}) {
  state.snapshot = snapshot;
  state.recording = Boolean(snapshot.recording?.active);

  if (replaceHistory && snapshot.history) {
    state.traffic = snapshot.history.traffic.map((p) => ({ t: p.t, rx: p.rx, tx: p.tx }));
    state.signal = snapshot.history.signal.map((p) => ({ t: p.t, pct: p.pct, rssi: p.rssi }));
    state.latency = snapshot.history.latency.map((p) => ({ t: p.t, ms: p.ms, loss: p.loss }));
  } else {
    const now = snapshot.now || Date.now();
    if (now - lastTickAt >= 500) {
      state.traffic.push({
        t: now,
        rx: snapshot.traffic?.rxBps ?? 0,
        tx: snapshot.traffic?.txBps ?? 0,
      });
      const lastSignal = state.signal[state.signal.length - 1];
      if (snapshot.lastSignal && snapshot.lastSignal.t !== lastSignal?.t) {
        state.signal.push({
          t: snapshot.lastSignal.t,
          pct: snapshot.lastSignal.pct,
          rssi: snapshot.lastSignal.rssi,
        });
      }
      const lastLatency = state.latency[state.latency.length - 1];
      if (snapshot.lastLatency && snapshot.lastLatency.t !== lastLatency?.t) {
        state.latency.push({
          t: snapshot.lastLatency.t,
          ms: snapshot.lastLatency.ms,
          loss: snapshot.lastLatency.loss,
        });
      }
      lastTickAt = now;
    }
    capAll();
  }

  trafficChart.data = state.traffic;
  charts.chartSignal.data = state.signal;
  charts.chartLatency.data = state.latency;

  drawChart(trafficChart);
  drawChart(charts.chartSignal);
  drawChart(charts.chartLatency);

  renderHeader(snapshot);
  renderKpis(snapshot);
  renderLink(snapshot);
  renderHealth(snapshot);
  renderDevices(snapshot.devices || []);
  renderFooter(snapshot);
}

function capAll() {
  for (const key of ['traffic', 'signal', 'latency']) {
    const list = state[key];
    if (list.length > CAP[key]) list.splice(0, list.length - CAP[key]);
  }
}

function renderHeader(snapshot) {
  const link = snapshot.link || {};
  const dot = $('linkDot');
  const connected = Boolean(link.connected);
  dot.className = `dot ${connected ? 'online' : 'offline'}`;
  $('ssid').textContent = connected ? link.ssid || 'Tanpa SSID' : 'Tidak terhubung';

  const parts = [];
  if (connected) {
    if (link.band) parts.push(link.band);
    if (link.channel != null) parts.push(`ch ${link.channel}`);
    if (link.radio) parts.push(link.radio);
    if (link.auth) parts.push(link.auth === 'Open' ? 'open' : link.auth);
  }
  if (snapshot.net?.ip) parts.push(`ip ${snapshot.net.ip}`);
  $('linkMeta').textContent = parts.join(' · ') || '—';

  const btn = $('btnRecord');
  btn.classList.toggle('recording', state.recording);
  btn.textContent = state.recording
    ? `Stop rekam (${snapshot.recording?.samples ?? 0})`
    : 'Mulai rekam';

  const scan = $('btnScan');
  scan.disabled = Boolean(snapshot.scanning);
  scan.textContent = snapshot.scanning ? 'Memindai…' : 'Scan perangkat';
}

function renderKpis(snapshot) {
  const traffic = snapshot.traffic || {};
  $('kpiRx').textContent = fmtBps(traffic.rxBps);
  $('kpiRxSub').textContent = `puncak ${fmtBps(traffic.peakRx)} · ${fmtBytes(traffic.totalRx)}`;
  $('kpiTx').textContent = fmtBps(traffic.txBps);
  $('kpiTxSub').textContent = `puncak ${fmtBps(traffic.peakTx)} · ${fmtBytes(traffic.totalTx)}`;

  const signal = snapshot.link?.signalPct;
  const quality = qualityOf(signal);
  $('kpiSignal').textContent = Number.isFinite(signal) ? `${Math.round(signal)}%` : '—';
  $('kpiSignal').className = `kpi-value ${quality.cls}`;
  $('kpiSignalSub').textContent = Number.isFinite(signal)
    ? `${snapshot.link?.rssiDbm ?? '—'} dBm · ${quality.label}`
    : 'tidak ada data sinyal';

  const inet = snapshot.health?.internet || {};
  const shownLatency = Number.isFinite(inet.rttMs) ? inet.rttMs : inet.avgMs;
  $('kpiLatency').textContent = fmtMs(shownLatency);
  $('kpiLatency').className = `kpi-value ${latencyClass(shownLatency)}`;
  $('kpiLatencySub').textContent = `rata ${fmtMs(inet.avgMs)} · jitter ${fmtMs(inet.jitterMs)}`;
  $('kpiLoss').textContent = fmtPct(inet.lossPct);
  $('kpiLoss').className = `kpi-value ${lossClass(inet.lossPct)}`;
  $('kpiLossSub').textContent = `gerbang ${fmtPct(snapshot.health?.gateway?.lossPct)} · ${inet.samples ?? 0} probe`;

  const devices = snapshot.devices || [];
  const peers = devices.filter((d) => !d.isSelf);
  const online = peers.filter((d) => d.online).length;
  $('kpiClients').textContent = String(online);
  $('kpiClientsSub').textContent = `${peers.length} pernah terlihat`;

  $('legendRx').textContent = fmtBps(traffic.rxBps);
  $('legendTx').textContent = fmtBps(traffic.txBps);

  // Angka pembanding speedtest: rata-rata 10 detik terakhir, bukan puncak
  // per detik dan bukan rata-rata seluruh sesi.
  const recent = state.traffic.slice(-10);
  const avgOf = (key) =>
    recent.length ? recent.reduce((sum, point) => sum + (point[key] || 0), 0) / recent.length : 0;
  $('trafficFoot').textContent =
    `Rata-rata 10 dtk ↓ ${fmtBps(avgOf('rx'))} · ↑ ${fmtBps(avgOf('tx'))} · sumber ${traffic.source ?? '—'}`;

  $('signalHead').textContent = Number.isFinite(signal) ? `${Math.round(signal)}%` : '—';
  $('signalFoot').textContent = snapshot.link?.connected
    ? `${snapshot.link.band ?? '—'} · ch ${snapshot.link.channel ?? '—'} · ${snapshot.link.radio ?? '—'}`
    : 'WiFi tidak terhubung';

  const latencyFoot = [];
  latencyFoot.push(`rata ${fmtMs(inet.avgMs)}`);
  latencyFoot.push(`maks ${fmtMs(inet.maxMs)}`);
  latencyFoot.push(`loss ${fmtPct(inet.lossPct)}`);
  $('latencyFoot').textContent = latencyFoot.join(' · ');
  $('latencyHead').textContent = fmtMs(inet.rttMs);

  $('healthHead').textContent = snapshot.health?.dns ? `DNS ${fmtMs(snapshot.health.dns.ms)}` : 'DNS —';
}

function renderLink(snapshot) {
  const link = snapshot.link || {};
  const net = snapshot.net || {};
  const rows = [
    ['SSID', link.ssid],
    ['BSSID', link.bssid],
    ['Pita / kanal', link.band || link.channel != null ? `${link.band ?? '—'} / ${link.channel ?? '—'}` : null],
    ['Tipe radio', link.radio],
    ['Keamanan', link.auth ? `${link.auth}${link.cipher ? ` · ${link.cipher}` : ''}` : null],
    ['Rate link', link.connected ? `↓${link.rxRateMbps ?? '—'} / ↑${link.txRateMbps ?? '—'} Mbps` : null],
    ['IP lokal', net.ip ? `${net.ip}/${net.prefix ?? '—'}` : null],
    ['Gateway', net.gateway],
    ['MAC', net.mac],
    ['Adapter', link.description || link.adapterName],
  ];
  $('linkRows').innerHTML = rows
    .map(
      ([label, value]) =>
        `<div><dt>${label}</dt><dd title="${escapeHtml(value ?? '—')}">${escapeHtml(value ?? '—')}</dd></div>`,
    )
    .join('');
}

function renderHealth(snapshot) {
  const gw = snapshot.health?.gateway || {};
  const inet = snapshot.health?.internet || {};
  const dns = snapshot.health?.dns;
  const rows = [
    ['Target probe', snapshot.net?.gateway ? `gw + 1.1.1.1` : '1.1.1.1'],
    ['Latensi gateway', fmtMs(gw.rttMs)],
    ['Latensi internet', `${fmtMs(inet.rttMs)} (rata ${fmtMs(inet.avgMs)})`],
    ['Jitter', fmtMs(inet.jitterMs)],
    ['Loss internet', fmtPct(inet.lossPct)],
    ['Resolusi DNS', dns ? (dns.ok ? fmtMs(dns.ms) : 'gagal') : '—'],
  ];
  $('healthRows').innerHTML = rows
    .map(
      ([label, value]) =>
        `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`,
    )
    .join('');
}

function renderDevices(devices) {
  const query = $('deviceSearch').value.trim().toLowerCase();
  const filtered = query
    ? devices.filter((d) =>
        [d.ip, d.mac, d.hostname].filter(Boolean).some((v) => String(v).toLowerCase().includes(query)),
      )
    : devices;

  const signature = `${query}#${filtered
    .map((d) => `${d.ip}:${d.mac}:${d.online}:${d.hostname ?? ''}:${Math.round(d.seenAgoSec / 5)}`)
    .join('|')}`;
  if (signature === deviceSignature) return;
  deviceSignature = signature;

  const meta = $('deviceMeta');
  if (state.snapshot?.lastScan) {
    const scan = state.snapshot.lastScan;
    meta.textContent = `Scan ${scan.scope} · ${scan.probed} host · ${scan.responsive} buka port 80 · ${(
      scan.durationMs / 1000
    ).toFixed(1)} dtk`;
  } else {
    meta.textContent = `${devices.filter((d) => d.online).length} online · ${devices.length} terdeteksi`;
  }

  const body = $('deviceRows');
  if (filtered.length === 0) {
    body.innerHTML = `<tr class="empty-row"><td colspan="6">${
      query ? 'Tidak ada perangkat yang cocok.' : 'Belum ada perangkat. Jalankan “Scan perangkat”.'
    }</td></tr>`;
    return;
  }

  body.innerHTML = filtered
    .map((d) => {
      const tags = [];
      if (d.isSelf) tags.push('<span class="tag self">host ini</span>');
      if (d.isGateway) tags.push('<span class="tag gw">gateway</span>');
      if (d.type) tags.push(`<span class="tag">${escapeHtml(d.type)}</span>`);
      return `<tr>
        <td><span class="status-cell"><i class="dot ${d.online ? 'online' : 'offline'}"></i>${
          d.online ? 'online' : 'offline'
        }</span></td>
        <td class="mono">${escapeHtml(d.ip)}${
          d.ips && d.ips.length > 1 ? `<span class="ip-more" title="${escapeHtml(d.ips.join(', '))}">+${d.ips.length - 1}</span>` : ''
        }</td>
        <td class="mono">${escapeHtml(d.mac)}</td>
        <td>${d.hostname ? escapeHtml(d.hostname) : '<span class="muted">—</span>'}</td>
        <td>${tags.join('') || '<span class="muted">—</span>'}</td>
        <td class="num">${d.online ? 'aktif' : fmtAgo(d.seenAgoSec)}</td>
      </tr>`;
    })
    .join('');
}

function renderFooter(snapshot) {
  const sources = [
    `traffic: ${snapshot.traffic?.source ?? '—'}`,
    'wlan: netsh/nmcli',
    'arp: tabel lokal',
    'probe: ICMP',
    'dns: resolver sistem',
  ];
  $('sources').textContent = `Sumber — ${sources.join(' · ')}`;

  const started = snapshot.startedAt || Date.now();
  const uptime = Math.round((Date.now() - started) / 1000);
  const rec = snapshot.recording?.active
    ? ` · rekaman ${snapshot.recording.samples} sampel`
    : snapshot.recording?.samples
      ? ` · rekaman siap ${snapshot.recording.samples} sampel`
      : '';
  $('sessionInfo').textContent = `sesi ${timeOf(started)} · ${Math.floor(uptime / 60)} mnt${rec}`;
}

/* -------------------------------- actions -------------------------------- */

let toastTimer = null;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 6000);
}

$('btnScan').addEventListener('click', async () => {
  const btn = $('btnScan');
  btn.disabled = true;
  btn.textContent = 'Memindai…';
  try {
    const res = await fetch('/api/scan', { method: 'POST' });
    const data = await res.json();
    if (data.error) toast(`Scan gagal: ${data.error}`);
    else if (data.busy) toast('Scan masih berjalan.');
    else
      toast(
        `Scan ${data.scope}: ${data.probed} host dipindai, ${data.responsive} membuka port 80, ${data.found} perangkat unik online (${(
          data.durationMs / 1000
        ).toFixed(1)} dtk).`,
      );
    await loadState();
  } catch (err) {
    toast(`Scan gagal: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Scan perangkat';
  }
});

$('btnRecord').addEventListener('click', async () => {
  const action = state.recording ? 'stop' : 'start';
  try {
    const res = await fetch('/api/record', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    const data = await res.json();
    state.recording = Boolean(data.active);
    toast(
      data.active
        ? 'Rekaman dimulai. Sampel disimpan per detik untuk bukti.'
        : `Rekaman dihentikan (${data.samples} sampel). Ekspor JSON/CSV untuk menyimpan bukti.`,
    );
    await loadState();
  } catch (err) {
    toast(`Gagal mengubah rekaman: ${err.message}`);
  }
});

$('deviceSearch').addEventListener('input', () => {
  deviceSignature = '';
  renderDevices(state.snapshot?.devices || []);
});

function syncExportLinks() {
  const scope = $('exportScope').value;
  $('exportJson').href = `/api/export?format=json&scope=${scope}`;
  $('exportCsv').href = `/api/export?format=csv&scope=${scope}`;
}
$('exportScope').addEventListener('change', syncExportLinks);
syncExportLinks();

/* -------------------------------- bootstrap -------------------------------- */

async function loadState() {
  const res = await fetch('/api/state');
  const snapshot = await res.json();
  applySnapshot(snapshot, { replaceHistory: true });
}

function connectStream() {
  const source = new EventSource('/api/stream');
  source.addEventListener('init', (event) => {
    try {
      applySnapshot(JSON.parse(event.data), { replaceHistory: true });
    } catch (err) {
      console.error('init parse', err);
    }
  });
  source.addEventListener('tick', (event) => {
    try {
      applySnapshot(JSON.parse(event.data));
    } catch (err) {
      console.error('tick parse', err);
    }
  });
  source.onerror = () => {
    /* EventSource reconnects automatically */
  };
}

loadState()
  .catch(() => {})
  .finally(connectStream);
