# Catatan teknis — wifi-radar

## Model sampling

| Data | Interval | Penyimpanan | Catatan |
| --- | --- | --- | --- |
| Traffic | 1 dtk | 1.800 titik (30 mnt) | Nilai = byte/dtk; total sesi diintegrasikan (`rate × dt`) |
| Sinyal | 5 dtk | 720 titik (1 jam) | Persen dari netsh; dBm dipakai langsung bila ada |
| Latensi/loss | 5 dtk | 720 titik (1 jam) | Jendela 12 probe terakhir untuk loss & jitter |
| Perangkat | 15 dtk | map per MAC | `online` = terlihat < 120 dtk |
| DNS | 30 dtk | nilai terakhir | resolve `one.one.one.one` |

Rekaman menyimpan **satu sampel gabungan per detik** (traffic + sinyal + latensi terakhir) agar ekspor CSV/JSON mudah dikorelasikan.

## Kenapa bukan `typeperf`?

Rencana awal memakai `typeperf "\Network Interface(*)\Bytes Received/sec" -sc 0` sebagai stream. Saat stdout dipipe (bukan console), `typeperf` langsung mencetak header + satu sampel lalu keluar (`Exiting, please wait...`), jadi tidak bisa dipakai sebagai sampler 1 Hz.

Alternatif yang dipakai: satu proses **PowerShell persisten** yang memanggil `Get-NetAdapterStatistics` tiap detik dan menulis baris `nama|rx|tx` dengan `[Console]::Out.Flush()`. Sudah diverifikasi streaming per detik melalui pipe. Keuntungan: tanpa startup PowerShell tiap sampel (~1,9 dtk), tanpa file script sementara, tanpa encoded command.

Fallback: `netstat -e` (total semua adapter) bila proses PowerShell gagal.

## Discovery & proxy ARP

Sweep mengirim TCP connect ke port 80 untuk setiap host di `/24` (maksimum 254 host; prefix lebih lebar dipotong ke /24). Setelah itu tabel ARP dibaca ulang.

Temuan di jaringan uji (`Enso`, /22): 218 dari 254 IP hasil sweep memiliki **MAC gateway yang sama** (`e4:8d:8c:0a:c6:c8`), indikasi proxy ARP. Kalau tidak difilter, dashboard melaporkan 229 "perangkat" palsu. Perbaikan:

1. Entri dengan MAC gateway tetapi IP bukan gateway → dilewati.
2. Perangkat di-dedupe **per MAC**, bukan per IP (satu perangkat bisa punya beberapa IP).
3. Peringatan ditampilkan di state (`warnings`) saat filter aktif.

Sweep TCP (bukan ping) dipilih agar tidak perlu spawn 254 proses ping dan tetap memaksa resolusi ARP.

## Rediscovery hostname

Reverse DNS dijalankan **berurutan** lewat satu antrean dengan timeout 700 ms. Sebelumnya semua device baru di-resolve paralel; pada 229 entri palsu itu membanjiri resolver. Dengan dedupe MAC, antrean biasanya < 30 host.

## Ketahanan sampling & gap

Sampler traffic punya **watchdog**: kalau tidak ada sampel selama 6 detik (proses mati, laptop sleep lalu resume, PowerShell crash), sampler di-restart otomatis dengan jeda bertingkat. Lebih dari 6 restart dalam 5 menit → fallback ke `netstat -e` (total semua adapter). Setelah restart, pembacaan counter sebelumnya dibuang supaya backlog selama downtime tidak dilaporkan sebagai traffic satu detik.

Gap tetap mungkin terjadi (mis. laptop sleep berjam-jam). Karena itu ekspor JSON mencatatnya secara jujur di `summary.gaps`:

```json
"gaps": { "count": 1, "totalSec": 4437, "maxSec": 4437 }
```

`summary.totalRxBytes`/`totalTxBytes` diintegrasikan dari sampel yang benar-benar terukur; interval > 5 detik dilewati, tidak dianggap traffic nol.

## Cakupan ekspor

- `scope=record` → hanya sampel rekaman. Jika rekaman kosong, otomatis jatuh ke seluruh sesi dan `scope` di JSON menjadi `session`.
- `scope=session` → gabungan seluruh sesi: sampel rekaman (lebih kaya: latensi gateway + jumlah klien) digabung dengan history traffic/sinyal/latensi, dedupe per detik, urut lama→baru.

Sebelumnya `scope=session` keliru mengembalikan sampel rekaman saja saat rekaman ada; sekarang history ikut terbawa (`tests/evidence.test.mjs`).

## Host ini di tabel perangkat

Tabel ARP tidak pernah memuat perangkat sendiri. `Telemetry.trackSelf()` menambahkan/menyegarkan baris host sendiri (IP + MAC + hostname) tiap 30 detik, sehingga tabel selalu memuat "host ini". Angka KPI "Perangkat" dan kolom CSV `clients_online` hanya menghitung peer (tanpa host sendiri).

## Jendela grafik traffic

Grafik traffic menampilkan **60 sampel terakhir** (±60 detik), bukan 5 menit. Dengan jendela pendek, satu tes speedtest (±15 dtk unduh + ±15 dtk unggah) memenuhi separuh lebar grafik sehingga bentuknya bisa dibaca, tidak lagi terjepit jadi garis tipis 5% di ujung kanan. Sumbu X memakai jam:menit:detik karena jendela 1 menit tidak bisa dibedakan kalau labelnya hanya jam:menit. Sinyal & latensi tetap 180 sampel (15 menit / 15 menit) karena dipakai melihat tren, bukan burst.

Footer panel traffic menampilkan **rata-rata 10 detik terakhir**, dan itu angka yang setara dengan hasil speedtest. Bedanya dengan angka lain di dashboard:

| Angka | Arti |
| --- | --- |
| KPI unduh/unggah | sampel 1 detik terakhir (detik ini) |
| KPI sub "puncak" | puncak 1 detik seluruh sesi |
| Footer "rata-rata 10 dtk" | rata-rata bergerak 10 detik — bandingkan dengan speedtest |
| Titik tertinggi di grafik | puncak 1 detik (biasanya 1,3–1,6× rata-rata) |

Catatan: speedtest melaporkan rata-rata payload selama window-nya dan membuang ramp-up, sedangkan counter adapter menghitung semua byte (header TCP/IP + Wi-Fi, ACK, retransmisi, trafik aplikasi lain). Pada tes yang sama, rata-rata fase radar vs speedtest terukur 98–99%.

## Layout

Mulai lebar 1201px, `body` jadi flex column setinggi viewport dan `main` memakai sisa tinggi: baris grid (`1.5fr / 1.1fr / 1.3fr`) membagi ruang, `.panel` jadi flex column, dan `.chart-wrap` mengambil sisa tinggi panel — jadi canvas ikut membesar tanpa scroll halaman. Tinggi minimum per baris dijaga (190/160/200px) supaya di layar pendek isi tidak gepeng; kalau tidak muat, `main` yang scroll.

Detail link memakai dua kolom agar 10 baris tetap muat, kesehatan internet tetap satu kolom karena nilainya panjang, dan tabel perangkat scroll di dalam panelnya.

## Transport UI

SSE (`/api/stream`):

- `init` → snapshot lengkap termasuk history (dipakai saat halaman dibuka).
- `tick` → snapshot tanpa history tiap 1 dtk (payload kecil, ~3–6 KB).

Chart digambar di canvas dengan `devicePixelRatio`, ring buffer 300 titik untuk traffic (5 mnt) dan 180 titik untuk sinyal/latensi (15 mnt). Tooltip memakai indeks sampel, bukan interpolasi waktu.

## Ekspor

- `scope=record` → sampel rekaman (fallback ke seluruh sesi bila rekaman kosong).
- `scope=session` → gabungan history traffic + sinyal/latensi terdekat.
- JSON memuat metadata link, ringkasan, daftar perangkat (first/last seen), dan semua sampel.
- CSV memuat satu baris per detik dengan kolom traffic, sinyal, latensi, loss, DNS, jumlah klien.

## Batasan yang disengaja

- Tidak ada traffic per perangkat: butuh SNMP/API router.
- Tidak ada capture packet (bukan tujuan; akan butuh Npcap/admin).
- Tidak ada ping sweep paralel ICMP; sweep TCP lebih murah.
- Bind `127.0.0.1` saja; dashboard tidak untuk diakses dari jaringan.
