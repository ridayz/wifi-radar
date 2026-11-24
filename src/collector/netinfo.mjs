import os from 'node:os';
import { run } from './exec.mjs';
import { parseRouteLinux, parseRouteWindows } from './parsers.mjs';

/** Read local IPv4, prefix, MAC and default gateway for the active uplink. */
export async function readNetInfo(platform) {
  const hostname = os.hostname();
  let gateway = null;
  let ifaceIp = null;
  let ifaceName = null;

  if (platform === 'win32') {
    const res = await run('route', ['print', '-4', '0.0.0.0'], { timeout: 3000 });
    const def = parseRouteWindows(res.stdout);
    gateway = def?.gateway || null;
    ifaceIp = def?.ifaceIp || null;
  } else {
    const res = await run('ip', ['route', 'show', 'default'], { timeout: 3000 });
    const def = parseRouteLinux(res.stdout);
    gateway = def?.gateway || null;
    ifaceName = def?.iface || null;
  }

  const found = findInterface(platform === 'win32' ? ifaceIp : null, ifaceName);
  if (!ifaceIp) ifaceIp = found?.ip || null;
  if (!ifaceName) ifaceName = found?.name || null;

  return {
    hostname,
    ip: ifaceIp,
    prefix: found?.prefix ?? null,
    mac: found?.mac ?? null,
    iface: ifaceName,
    gateway,
    platform,
    checkedAt: Date.now(),
  };
}

export function findInterface(ip, ifaceName) {
  const interfaces = os.networkInterfaces();
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const addr of addresses || []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      if (ip && addr.address !== ip) continue;
      if (ifaceName && name !== ifaceName) continue;
      return {
        name,
        ip: addr.address,
        mac: addr.mac || null,
        prefix: addr.netmask ? maskToPrefix(addr.netmask) : null,
      };
    }
  }
  return null;
}

export function maskToPrefix(mask) {
  return String(mask)
    .split('.')
    .map((octet) => Number(octet).toString(2).padStart(8, '0'))
    .join('')
    .split('')
    .filter((bit) => bit === '1').length;
}

export function prefixToMask(prefix) {
  const bits = '1'.repeat(prefix).padEnd(32, '0');
  return bits.match(/.{8}/g).map((b) => parseInt(b, 2)).join('.');
}
