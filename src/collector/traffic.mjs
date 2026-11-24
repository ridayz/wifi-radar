import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { readFile } from 'node:fs/promises';
import { num, run } from './exec.mjs';
import { parseAdapterCounters, parseProcNetDev } from './parsers.mjs';

/**
 * Per-interface byte-rate sampler.
 * Windows: one long-lived PowerShell process emitting cumulative adapter counters,
 *          flushed once per second (no script files, no encoded commands).
 * Linux: cumulative counters from /proc/net/dev.
 * Fallback: global totals from `netstat -e` (Windows).
 */
export function startTrafficSampler({ platform, description, adapterName, ifaceName, onSample, onWarn }) {
  if (platform === 'win32') {
    return startWindowsCounters({ description, adapterName, onSample, onWarn });
  }
  if (platform === 'linux') {
    return startProcNetDev({ ifaceName, onSample, onWarn });
  }
  onWarn?.(`Sampling traffic belum didukung di platform ${platform}.`);
  return { source: 'unsupported', stop() {} };
}

const COUNTER_SCRIPT = [
  'while ($true) {',
  '  $parts = @();',
  '  foreach ($a in Get-NetAdapterStatistics) {',
  '    $parts += ("{0}|{1}|{2}" -f $a.Name, $a.ReceivedBytes, $a.SentBytes)',
  '  }',
  '  [Console]::WriteLine(($parts -join ";"));',
  '  [Console]::Out.Flush();',
  '  Start-Sleep -Milliseconds 1000',
  '}',
].join(' ');

function startWindowsCounters({ description, adapterName, onSample, onWarn }) {
  const STALL_MS = 6000;
  const RESTART_WINDOW_MS = 300_000;
  const MAX_RESTARTS = 6;

  let child = null;
  let rl = null;
  let prev = null;
  let stopped = false;
  let fallback = null;
  let lastLineAt = Date.now();
  let killing = false;
  let restartTimer = null;
  let restarts = [];

  const useFallback = (reason) => {
    if (fallback || stopped) return;
    onWarn?.(`Counter PowerShell gagal (${reason}); memakai total netstat -e.`);
    fallback = startNetstatTotals({ onSample });
  };

  const killChild = () => {
    killing = true;
    try {
      rl?.close();
    } catch {
      /* ignore */
    }
    try {
      child?.kill();
    } catch {
      /* ignore */
    }
    child = null;
    rl = null;
    killing = false;
  };

  const restart = (reason) => {
    if (stopped || fallback || restartTimer) return;
    const now = Date.now();
    restarts = restarts.filter((at) => now - at < RESTART_WINDOW_MS);
    restarts.push(now);
    if (restarts.length > MAX_RESTARTS) {
      useFallback(`${restarts.length} restart dalam 5 menit, terakhir: ${reason}`);
      return;
    }
    if (restarts.length > 1) onWarn?.(`Sampler traffic di-restart (${reason}).`);
    killChild();
    const delay = Math.min(5000, 400 * restarts.length);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      spawnChild();
    }, delay);
    restartTimer.unref?.();
  };

  function spawnChild() {
    if (stopped || fallback) return;
    lastLineAt = Date.now();
    // Counters stay cumulative across a restart, so drop the previous reading
    // instead of reporting the downtime backlog as one second of traffic.
    prev = null;

    child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', COUNTER_SCRIPT], {
      windowsHide: true,
    });
    rl = readline.createInterface({ input: child.stdout });

    rl.on('line', (line) => {
      const text = line.trim();
      if (!text) return;
      const counters = parseAdapterCounters(text);
      const adapter = pickAdapter(counters, description, adapterName);
      if (!adapter) return;
      lastLineAt = Date.now();
      if (prev) {
        const dt = Math.max(0.2, (lastLineAt - prev.at) / 1000);
        onSample({
          rx: Math.max(0, (adapter.rx - prev.rx) / dt),
          tx: Math.max(0, (adapter.tx - prev.tx) / dt),
          at: lastLineAt,
        });
      }
      prev = { rx: adapter.rx, tx: adapter.tx, at: lastLineAt };
    });

    child.stderr.on('data', () => {
      /* startup noise only; exit handler decides what to do */
    });
    child.on('error', (err) => {
      if (!killing) restart(err.message);
    });
    child.on('exit', (code) => {
      if (!killing) restart(`proses berhenti (kode ${code ?? '?'})`);
    });
  }

  // Sleep/resume and killed processes both show up as silence here.
  const watchdog = setInterval(() => {
    if (stopped || fallback || restartTimer) return;
    if (Date.now() - lastLineAt > STALL_MS) restart(`tidak ada sampel >${STALL_MS / 1000} dtk`);
  }, 3000);
  watchdog.unref?.();

  spawnChild();

  return {
    source: 'net-adapter-counters',
    stop() {
      stopped = true;
      clearInterval(watchdog);
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = null;
      killChild();
      fallback?.stop();
    },
  };
}

function pickAdapter(counters, description, adapterName) {
  if (counters.length === 0) return null;
  const wanted = [adapterName, description].filter(Boolean).map((v) => String(v).toLowerCase());
  return (
    counters.find((c) => wanted.includes(c.name.toLowerCase())) ||
    counters.find((c) => /wi-?fi|wireless|wlan|802\.11/i.test(c.name)) ||
    counters[0]
  );
}

function startNetstatTotals({ onSample }) {
  let prev = null;
  const timer = setInterval(async () => {
    const res = await run('netstat', ['-e'], { timeout: 3000 });
    const m = /^\s*Bytes?\s+(\d+)\s+(\d+)/im.exec(res.stdout);
    if (!m) return;
    const cur = { rx: Number(m[1]), tx: Number(m[2]), at: Date.now() };
    if (prev) {
      const dt = Math.max(0.2, (cur.at - prev.at) / 1000);
      onSample({
        rx: Math.max(0, (cur.rx - prev.rx) / dt),
        tx: Math.max(0, (cur.tx - prev.tx) / dt),
        at: cur.at,
      });
    }
    prev = cur;
  }, 2000);
  return {
    source: 'netstat',
    stop() {
      clearInterval(timer);
    },
  };
}

function startProcNetDev({ ifaceName, onSample, onWarn }) {
  let prev = null;
  let warned = false;
  const timer = setInterval(async () => {
    if (!ifaceName) return;
    try {
      const text = await readFile('/proc/net/dev', 'utf8');
      const counters = parseProcNetDev(text, ifaceName);
      if (!counters) {
        if (!warned) onWarn?.(`Interface ${ifaceName} tidak ada di /proc/net/dev.`);
        warned = true;
        return;
      }
      const cur = { ...counters, at: Date.now() };
      if (prev) {
        const dt = Math.max(0.2, (cur.at - prev.at) / 1000);
        onSample({
          rx: Math.max(0, (cur.rxBytes - prev.rxBytes) / dt),
          tx: Math.max(0, (cur.txBytes - prev.txBytes) / dt),
          at: cur.at,
        });
      }
      prev = cur;
    } catch (err) {
      onWarn?.(`Gagal membaca /proc/net/dev: ${err.message}`);
    }
  }, 1000);

  return {
    source: 'proc-net-dev',
    stop() {
      clearInterval(timer);
    },
  };
}

export function parseNetstatE(text) {
  const m = /^\s*Bytes?\s+(\d+)\s+(\d+)/im.exec(text);
  if (!m) return null;
  return { rxBytes: num(m[1]), txBytes: num(m[2]) };
}
