# wifi-radar

Dashboard lokal untuk memantau koneksi Wi-Fi yang sedang dipakai: traffic realtime, kekuatan sinyal, latensi/loss internet, dan perangkat yang terdeteksi di LAN. Dirancang untuk network engineer yang butuh **evidence** saat evaluasi kualitas Wi-Fi di lapangan.

Status: `review`

## Fitur

- **Traffic realtime** per adapter Wi-Fi (unduh/unggah, puncak, total sesi) dalam grafik **60 detik terakhir** — satu tes speedtest (±30 dtk) memenuhi separuh grafik, dan panel-foot menampilkan rata-rata 10 detik terakhir yang bisa dibandingkan langsung dengan angka speedtest.
- **Kekuatan sinyal** (%, dBm) beserta riwayat 15 menit dan band/kanal/tipe radio.
- **Kesehatan internet**: latensi gateway & internet, jitter, packet loss, waktu resolusi DNS.
- **Discovery perangkat LAN** lewat tabel ARP/neighbour + sweep TCP `/24`, dengan dedupe per MAC dan baris "host ini".
- **Rekam & ekspor bukti**: rekaman per detik → JSON (lengkap dengan metadata link) atau CSV untuk spreadsheet.
- **Auto-refresh** 1 detik via SSE; tanpa dependency npm.
- **Layout penuh layar**: di lebar ≥1201px dashboard mengisi seluruh jendela tanpa scroll (chart melar, tabel perangkat scroll sendiri); di layar kecil kembali bertumpuk vertikal.

## Jalankan

Prasyarat: **Node.js 20+**. Windows 10/11 untuk dukungan penuh (Windows PowerShell 5.1 sudah tersedia).

```powershell
cd projects/wifi-radar
npm start
```

Buka <http://127.0.0.1:4747>. Server hanya listen di `127.0.0.1`.

Ganti port:

```powershell
$env:PORT=5151; npm start
```

Target probe internet bisa diganti:

```powershell
$env:WIFI_RADAR_PING_TARGET=8.8.8.8; npm start
```

## Alur kerja evidence

1. Jalankan dashboard saat Wi-Fi terhubung.
2. Klik **Scan perangkat** untuk mengisi daftar klien (sweep /24 + baca ARP).
3. Klik **Mulai rekam** tepat sebelum pengujian (mis. speed test, pindah ruangan).
4. Setelah selesai, klik **Stop rekam**, pilih cakupan (`rekaman` / `seluruh sesi`), lalu **Ekspor JSON** atau **CSV**.
5. JSON berisi metadata link (SSID/BSSID/kanal/radio), ringkasan (rata-rata/puncak traffic, sinyal, latensi, loss), daftar perangkat, dan sampel per detik.
6. Cakupan `seluruh sesi` menggabungkan rekaman + history (dedupe per detik). JSON juga mencatat `summary.gaps` — jumlah dan durasi jeda sampling (mis. laptop sleep) supaya total traffic tidak menyesatkan.

## Sumber data

| Metrik | Sumber (Windows) | Catatan |
| --- | --- | --- |
| Traffic per adapter | `Get-NetAdapterStatistics` lewat satu proses PowerShell persisten (counter kumulatif, delta 1 dtk) | Adapter dipilih dari deskripsi/nama Wi-Fi |
| SSID, BSSID, band, kanal, radio, rate, sinyal, RSSI | `netsh wlan show interfaces` tiap 5 dtk | Parser mendukung output Inggris & Indonesia |
| IP, prefix, MAC, gateway | `route print -4 0.0.0.0` + `os.networkInterfaces()` | |
| Perangkat LAN | `arp -a` tiap 15 dtk + sweep TCP port 80 (`/24`) | Dedupe per MAC, proxy ARP difilter |
| Latensi & loss | ICMP ke gateway dan `1.1.1.1` tiap 5 dtk | Jendela 12 probe terakhir |
| DNS | resolusi `one.one.one.one` tiap 30 dtk | |

Linux: pembacaan link via `nmcli`, traffic via `/proc/net/dev`, perangkat via `ip neigh` (best effort).

## Batasan yang perlu diketahui

- **Traffic per perangkat tidak tersedia.** Dashboard hanya bisa mengukur total adapter. Untuk per-klien butuh data dari router/AP (SNMP, API controller, atau flow export).
- **Discovery berbasis ARP** hanya melihat perangkat di L2 yang sama dan yang baru saja berkomunikasi. Perangkat diam bisa belum muncul sampai ada trafik/scan.
- **Sweep mengirim TCP SYN ke port 80** ke seluruh `/24`. Gunakan hanya di jaringan yang kamu berwenang menguji.
- Kalau router memakai **proxy ARP**, banyak IP bisa memiliki MAC gateway yang sama. Entri seperti ini diabaikan dan dicatat di panel peringatan.
- Perangkat bisa tampil `online` sampai ±2 menit setelah pergi karena cache ARP.
- macOS belum didukung untuk sampling traffic.
- Dashboard tidak memodifikasi jaringan; semua operasi read-only + probe ringan.

## Struktur

```
wifi-radar/
├── src/
│   ├── server.mjs              # HTTP + SSE + static + export
│   ├── collector/
│   │   ├── index.mjs           # orkestrasi sampling, history, recording, evidence
│   │   ├── traffic.mjs         # sampler byte-rate (Windows/Linux)
│   │   ├── wlan.mjs            # netsh / nmcli
│   │   ├── devices.mjs         # ARP, reverse DNS, subnet sweep
│   │   ├── netcheck.mjs        # ICMP + DNS timing
│   │   ├── netinfo.mjs         # IP/gateway/prefix
│   │   ├── parsers.mjs         # parser murni (diuji)
│   │   └── exec.mjs            # execFile + decode output
│   └── public/                 # dashboard (HTML/CSS/JS, canvas charts)
├── tests/parsers.test.mjs
└── docs/notes.md
```

## Test

```powershell
npm test
```

13 test parser: netsh (EN/ID), ARP (Windows/Linux/macOS), ping (EN/ID/timeout), route, counter adapter, `/proc/net/dev`, subnet clamp, netmask. Plus 5 test evidence: integrasi traffic, deteksi gap, merge rekaman+history, cakupan ekspor.

## Troubleshooting

- **Port 4747 dipakai** → set `PORT` lain.
- **Traffic `—`** → cek panel peringatan. Di Windows butuh PowerShell; sampler otomatis restart kalau berhenti, dan fallback ke `netstat -e` (total semua adapter) bila restart gagal terus.
- **Grafik traffic bolong** → biasanya laptop sleep/resume. Ekspor JSON menandainya di `summary.gaps`.
- **Daftar perangkat kosong** → jalankan Scan; pastikan terhubung ke Wi-Fi yang sama.
- **Loss tinggi** → cek juga dari perangkat lain; ICMP bisa diprioritaskan rendah oleh sebagian jaringan.

## Sinkron ke GitHub

Repo: https://github.com/ridayz/wifi-radar

```bash
node scripts/sync.mjs -m "feat: ..."   # commit + push
node scripts/sync.mjs --dry-run        # lihat dulu, tanpa commit
node scripts/watch-sync.mjs            # auto commit + push 120 detik setelah edit
```
