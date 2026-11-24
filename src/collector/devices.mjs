import dns from 'node:dns/promises';
import net from 'node:net';
import { run } from './exec.mjs';
import { parseArp } from './parsers.mjs';

/** Read the local ARP/neighbour table. */
export async function readArpTable(platform) {
  const res =
    platform === 'linux'
      ? await run('ip', ['neigh'], { timeout: 3000 })
      : await run('arp', ['-a'], { timeout: 3000 });
  return parseArp(res.stdout || '');
}

/** Best-effort reverse DNS for one address. */
export async function reverseLookup(ip, timeoutMs = 800) {
  try {
    const names = await Promise.race([
      dns.reverse(ip),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
    ]);
    return names?.[0] || null;
  } catch {
    return null;
  }
}

export function ipToInt(ip) {
  return String(ip)
    .split('.')
    .reduce((acc, octet) => ((acc << 8) + Number(octet)) >>> 0, 0) >>> 0;
}

export function intToIp(int) {
  return [24, 16, 8, 0].map((shift) => (int >>> shift) & 255).join('.');
}

/**
 * Host list for a sweep. Large prefixes are clamped to the local /24 so a
 * scan finishes in seconds instead of minutes.
 */
export function subnetHosts(ip, prefix, { limit = 512 } = {}) {
  if (!ip) return [];
  const effectivePrefix = Math.min(32, Math.max(24, prefix ?? 24));
  const mask = (0xffffffff << (32 - effectivePrefix)) >>> 0;
  const network = (ipToInt(ip) & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  const hosts = [];
  for (let value = network + 1; value < broadcast && hosts.length < limit; value++) {
    hosts.push(intToIp(value >>> 0));
  }
  return hosts;
}

/** TCP connect probe. Cheap way to force ARP resolution for each host. */
export function probeHost(ip, { port = 80, timeoutMs = 350 } = {}) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    try {
      socket.connect(port, ip);
    } catch {
      finish(false);
    }
  });
}

export async function mapLimit(items, limit, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/** Sweep a subnet, then re-read ARP so newly discovered hosts appear. */
export async function sweepSubnet({ ip, prefix, platform, concurrency = 48 }) {
  const hosts = subnetHosts(ip, prefix);
  const startedAt = Date.now();
  let responsive = 0;
  await mapLimit(hosts, concurrency, async (host) => {
    if (await probeHost(host)) responsive++;
  });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const table = await readArpTable(platform);
  const scopePrefix = Math.min(32, Math.max(24, prefix ?? 24));
  const scopeMask = (0xffffffff << (32 - scopePrefix)) >>> 0;
  const scopeNetwork = (ipToInt(ip) & scopeMask) >>> 0;
  return {
    scope: `${intToIp(scopeNetwork)}/${scopePrefix}`,
    probed: hosts.length,
    responsive,
    durationMs: Date.now() - startedAt,
    table,
  };
}
