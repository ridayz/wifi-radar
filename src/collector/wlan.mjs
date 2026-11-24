import { run } from './exec.mjs';
import { normalizeLink, parseNmcliWifi, parseWlanInterfaces } from './parsers.mjs';

/** Read the current WiFi link (Windows netsh, Linux nmcli). */
export async function readLink(platform) {
  if (platform === 'win32') {
    const res = await run('netsh', ['wlan', 'show', 'interfaces'], { timeout: 4000 });
    if (!res.stdout) {
      return { supported: true, connected: false, error: res.error || 'netsh tidak mengembalikan data' };
    }
    const links = parseWlanInterfaces(res.stdout);
    const link = links.find((l) => l.connected) || links[0] || null;
    if (!link) return { supported: true, connected: false };
    return normalizeLink({
      supported: true,
      ...link,
      // Adapter description is needed to pick the right perf counter.
      description: link.description,
      adapterName: link.name,
    });
  }

  if (platform === 'linux') {
    const res = await run('nmcli', ['-t', '-f', 'IN-USE,SSID,BSSID,SIGNAL,CHAN,FREQ', 'dev', 'wifi'], {
      timeout: 4000,
    });
    if (!res.ok) {
      return { supported: false, connected: false, error: 'nmcli tidak tersedia' };
    }
    const link = parseNmcliWifi(res.stdout);
    if (!link) return { supported: true, connected: false };
    return { supported: true, ...link };
  }

  return { supported: false, connected: false, error: `Platform ${platform} belum didukung` };
}
