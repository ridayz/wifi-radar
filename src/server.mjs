import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Telemetry } from './collector/index.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || readFlag('--port') || 4747);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const telemetry = new Telemetry();
await telemetry.start();

const clients = new Set();
let streamTimer = null;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  try {
    if (url.pathname === '/api/state') {
      return sendJson(res, telemetry.snapshot());
    }
    if (url.pathname === '/api/stream') {
      return openStream(req, res);
    }
    if (url.pathname === '/api/scan') {
      if (req.method !== 'POST') return sendJson(res, { error: 'POST required' }, 405);
      const result = await telemetry.deepScan();
      return sendJson(res, result);
    }
    if (url.pathname === '/api/record') {
      if (req.method !== 'POST') return sendJson(res, { error: 'POST required' }, 405);
      const body = await readBody(req);
      const action = body?.action === 'stop' ? 'stop' : 'start';
      return sendJson(res, telemetry.setRecording(action));
    }
    if (url.pathname === '/api/export') {
      return exportEvidence(url, res);
    }
    return serveStatic(url.pathname, res);
  } catch (err) {
    console.error('[wifi-radar] error:', err);
    if (!res.headersSent) sendJson(res, { error: err.message }, 500);
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  const link = telemetry.link;
  const target = link?.connected
    ? `${link.ssid || 'WiFi'} (${link.band || '?'} / ch ${link.channel ?? '?'})`
    : 'belum terhubung';
  console.log(`WiFi Radar berjalan di http://${HOST}:${PORT}`);
  console.log(`Link terdeteksi: ${target} · traffic source: ${telemetry.traffic.source || 'menunggu'}`);
});

streamTimer = setInterval(() => {
  if (clients.size === 0) return;
  const payload = `event: tick\ndata: ${JSON.stringify(telemetry.snapshot({ includeHistory: false }))}\n\n`;
  for (const res of clients) res.write(payload);
}, 1000);
streamTimer.unref?.();

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function shutdown() {
  clearInterval(streamTimer);
  for (const res of clients) res.end();
  telemetry.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref?.();
}

function openStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': wifi-radar stream\n\n');
  res.write(`event: init\ndata: ${JSON.stringify(telemetry.snapshot())}\n\n`);
  clients.add(res);

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
  heartbeat.unref?.();

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
}

async function exportEvidence(url, res) {
  const format = url.searchParams.get('format') === 'csv' ? 'csv' : 'json';
  const scope = url.searchParams.get('scope') === 'session' ? 'session' : 'record';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const ssid = String(telemetry.link?.ssid || 'wifi').replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();
  const filename = `wifi-radar-${ssid}-${stamp}.${format}`;

  if (format === 'csv') {
    const csv = telemetry.toCsv({ scope });
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
    return res.end(csv);
  }

  const evidence = telemetry.evidence({ scope });
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
  });
  return res.end(JSON.stringify(evidence, null, 2));
}

async function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    return sendJson(res, { error: 'not found' }, 404);
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    return res.end(data);
  } catch {
    return sendJson(res, { error: 'not found' }, 404);
  }
}

function sendJson(res, payload, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 100_000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function readFlag(name) {
  const arg = process.argv.find((a) => a.startsWith(`${name}=`));
  return arg ? arg.split('=')[1] : null;
}
