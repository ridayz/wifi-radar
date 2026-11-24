import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeMac,
  parseAdapterCounters,
  parseArp,
  parsePing,
  parseProcNetDev,
  parseRouteLinux,
  parseRouteWindows,
  parseTypeperfHeader,
  parseTypeperfRow,
  parseWlanInterfaces,
} from '../src/collector/parsers.mjs';
import { subnetHosts } from '../src/collector/devices.mjs';
import { maskToPrefix } from '../src/collector/netinfo.mjs';

const NETSH_EN = `
There is 1 interface on the system:

    Name                   : Wi-Fi
    Description            : MediaTek Wi-Fi 6 MT7921 Wireless LAN Card
    GUID                   : 9eaefa22-420b-4820-b315-a695a73c6c71
    Physical address       : d0:39:57:7b:26:17
    State                  : connected
    SSID                   : Enso
    AP BSSID               : 18:d0:71:08:ea:27
    Band                   : 2.4 GHz
    Channel                : 11
    Radio type             : 802.11n
    Authentication         : Open
    Cipher                 : None
    Receive rate (Mbps)    : 144.4
    Transmit rate (Mbps)   : 144.4
    Signal                 : 85%
    Rssi                   : -54
`;

const NETSH_ID = `
Ada 1 antarmuka pada sistem:

    Nama                   : Wi-Fi
    Deskripsi              : MediaTek Wi-Fi 6 MT7921 Wireless LAN Card
    Status                 : terhubung
    SSID                   : Kantor-Lantai2
    AP BSSID               : aa-bb-cc-dd-ee-ff
    Pita                   : 5 GHz
    Saluran                : 36
    Tipe radio             : 802.11ac
    Autentikasi            : WPA2-Personal
    Sandi                  : CCMP
    Kecepatan terima (Mbps) : 866.7
    Kecepatan kirim (Mbps) : 780.1
    Sinyal                 : 62%
`;

test('parses English netsh wlan output', () => {
  const [link] = parseWlanInterfaces(NETSH_EN);
  assert.equal(link.connected, true);
  assert.equal(link.ssid, 'Enso');
  assert.equal(link.bssid, '18:d0:71:08:ea:27');
  assert.equal(link.channel, 11);
  assert.equal(link.signalPct, 85);
  assert.equal(link.rssiDbm, -54);
  assert.equal(link.rxRateMbps, 144.4);
});

test('parses Indonesian netsh wlan output', () => {
  const [link] = parseWlanInterfaces(NETSH_ID);
  assert.equal(link.connected, true);
  assert.equal(link.ssid, 'Kantor-Lantai2');
  assert.equal(link.band, '5 GHz');
  assert.equal(link.channel, 36);
  assert.equal(link.signalPct, 62);
  assert.equal(link.auth, 'WPA2-Personal');
  assert.equal(link.rxRateMbps, 866.7);
});

test('parses Windows ARP output and drops multicast rows', () => {
  const table = parseArp(`
Interface: 192.168.210.213 --- 0xf
  Internet Address      Physical Address      Type
  192.168.208.1         e4-8d-8c-0a-c6-c8     dynamic
  192.168.210.1         3c-22-fb-0a-11-22     dynamic
  224.0.0.22            01-00-5e-00-00-16     static
  255.255.255.255       ff-ff-ff-ff-ff-ff     static
`);
  assert.equal(table.length, 2);
  assert.deepEqual(table[0], { ip: '192.168.208.1', mac: 'e4:8d:8c:0a:c6:c8', type: 'dynamic' });
});

test('parses Linux neighbour table', () => {
  const table = parseArp(`
192.168.1.1 dev eth0 lladdr aa:bb:cc:dd:ee:ff REACHABLE
192.168.1.50 dev eth0 lladdr 11:22:33:44:55:66 STALE
`);
  assert.equal(table.length, 2);
  assert.equal(table[1].mac, '11:22:33:44:55:66');
});

test('parses ping replies in English and Indonesian', () => {
  assert.deepEqual(
    parsePing('Reply from 1.1.1.1: bytes=32 time=14ms TTL=55'),
    { ok: true, rttMs: 14, ttl: '55' },
  );
  assert.equal(parsePing('Balasan dari 192.168.1.1: byte=32 waktu<1ms TTL=64').rttMs, 0.5);
  assert.equal(parsePing('Request timed out.').ok, false);
  assert.equal(parsePing('Permintaan time out.').ok, false);
});

test('parses default routes', () => {
  assert.deepEqual(
    parseRouteWindows(`
          0.0.0.0          0.0.0.0    192.168.208.1  192.168.210.213     50
`),
    { gateway: '192.168.208.1', ifaceIp: '192.168.210.213', metric: 50 },
  );
  assert.deepEqual(parseRouteLinux('default via 10.0.0.1 dev wlp2s0 proto dhcp metric 600'), {
    gateway: '10.0.0.1',
    iface: 'wlp2s0',
  });
});

test('selects the WiFi perf counter and parses rows', () => {
  const header =
    '"(PDH-CSV 4.0)","\\\\HOST\\Network Interface(ASIX USB Ethernet)\\Bytes Received/sec","\\\\HOST\\Network Interface(MediaTek Wi-Fi 6 MT7921 Wireless LAN Card)\\Bytes Received/sec","\\\\HOST\\Network Interface(ASIX USB Ethernet)\\Bytes Sent/sec","\\\\HOST\\Network Interface(MediaTek Wi-Fi 6 MT7921 Wireless LAN Card)\\Bytes Sent/sec"';
  const map = parseTypeperfHeader(header, 'MediaTek Wi-Fi 6 MT7921 Wireless LAN Card');
  assert.ok(map);
  assert.equal(map.instance, 'MediaTek Wi-Fi 6 MT7921 Wireless LAN Card');
  const row = parseTypeperfRow('"11/12/2026 13:19:17.702","0.0","6077.68","0.0","138.82"', map);
  assert.equal(row.rx, 6077.68);
  assert.equal(row.tx, 138.82);
});

test('falls back to a WiFi-like counter when description differs', () => {
  const header =
    '"(PDH-CSV 4.0)","\\\\HOST\\Network Interface(Intel(R) Wi-Fi 6 AX201 160MHz)\\Bytes Received/sec","\\\\HOST\\Network Interface(Intel(R) Wi-Fi 6 AX201 160MHz)\\Bytes Sent/sec"';
  const map = parseTypeperfHeader(header, 'Unknown adapter');
  assert.match(map.instance, /Wi-Fi/);
});

test('parses PowerShell adapter counter lines', () => {
  const counters = parseAdapterCounters('Wi-Fi|12345|678;Ethernet|1|2');
  assert.deepEqual(counters, [
    { name: 'Wi-Fi', rx: 12345, tx: 678 },
    { name: 'Ethernet', rx: 1, tx: 2 },
  ]);
});

test('parses /proc/net/dev counters', () => {  const counters = parseProcNetDev(
    'Inter-|   Receive                                                |  Transmit\n face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n  wlp2s0: 1000 2 0 0 0 0 0 0 2000 3 0 0 0 0 0 0',
    'wlp2s0',
  );
  assert.deepEqual(counters, { rxBytes: 1000, txBytes: 2000 });
});

test('normalizes MAC addresses', () => {
  assert.equal(normalizeMac('D0-39-57-7B-26-17'), 'd0:39:57:7b:26:17');
  assert.equal(normalizeMac('not-a-mac'), null);
});

test('clamps wide subnets to a single /24 sweep', () => {
  const hosts = subnetHosts('192.168.210.213', 16);
  assert.equal(hosts.length, 254);
  assert.equal(hosts[0], '192.168.210.1');
  assert.equal(hosts[253], '192.168.210.254');
});

test('converts netmask to prefix length', () => {
  assert.equal(maskToPrefix('255.255.255.0'), 24);
  assert.equal(maskToPrefix('255.255.240.0'), 20);
});
