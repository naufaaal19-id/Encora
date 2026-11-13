# Encora

Aplikasi chat **real-time** untuk simulasi komunikasi data. Pesan diubah menjadi bit
(framing 10 bit + parity), lalu divisualisasikan sebagai sinyal **NRZ-L**. Pesan hanya bisa
dibaca setelah memasukkan kunci akun.

- **Hosting:** Vercel (frontend statis + Serverless Functions)
- **Database:** MongoDB Atlas 
- **Frontend:** HTML, CSS, JavaScript (vanilla)
- **Komunikasi:** HTTP + Pusher Channels (real-time)

## Struktur Folder

```text
Encora/
├── api/
│   ├── emit.js        # menangani aksi: daftar, login, kirim pesan, dll.
│   ├── poll.js        # mengambil pesan baru + daftar user online
│   └── pusher-auth.js # izin subscribe channel Pusher milik user
├── lib/
│   └── encora.js      # logika server + koneksi MongoDB
├── frontend/
│   ├── index.html
│   ├── script.js
│   ├── http-socket.js # HTTP + polling
│   └── style.css
├── local/
│   ├── server.js      # server LOKAL untuk tes di komputer (tidak dipakai Vercel)
│   └── .env           # dibuat sendiri, tidak ikut ke GitHub
├── .vscode/launch.json
├── package.json
├── vercel.json
├── .gitignore
└── README.md
```

## Prasyarat

- [Node.js](https://nodejs.org) versi 18 atau lebih baru (pilih LTS)
- Akun [MongoDB Atlas](https://www.mongodb.com/cloud/atlas) dan akun [Vercel](https://vercel.com)
- VS Code dan Git

## 1. Siapkan MongoDB Atlas

1. Buat cluster gratis (M0).
2. **Security > Database Access:** buat user database dengan password (huruf dan angka saja).
3. **Security > Network Access:** tambahkan `0.0.0.0/0` (Allow access from anywhere).
   Vercel memakai IP yang berubah-ubah, jadi ini wajib.
4. **Database > Connect > Drivers:** salin connection string.

Koleksi `users`, `messages`, dan `message_hidden` beserta index-nya dibuat otomatis
saat ada request pertama.

## 2. Tes di Komputer

Dari folder utama proyek (bukan `local`):

```bash
npm install
```

Buat file `local/.env`:

```env
PORT=5000
MONGODB_URI=mongodb+srv://USER:PASSWORD@cluster.xxxxx.mongodb.net/?retryWrites=true&w=majority
DB_NAME=encora
```

> Jangan memakai tanda kutip di sekitar `MONGODB_URI`.

Jalankan:

```bash
npm start
```

Buka **http://localhost:5000**. Atau tekan **F5** di VS Code dan pilih
**"Encora: Jalankan Server"**.

## 3. Deploy ke Vercel

1. Push kode ke GitHub, lalu import repository di Vercel (**Add New > Project**).
2. Pengaturan proyek:
   - **Framework Preset:** Other
   - **Root Directory:** kosongkan
   - Build/Output sudah diatur oleh `vercel.json` (output: folder `frontend`).
3. **Settings > Environment Variables:**
   - `MONGODB_URI` = connection string Atlas (tanpa tanda kutip)
   - `DB_NAME` = `encora`
   - `SESSION_SECRET` (opsional) = teks acak panjang untuk menandatangani sesi login
   - `PUSHER_APP_ID`, `PUSHER_KEY`, `PUSHER_SECRET`, `PUSHER_CLUSTER` (untuk real-time, lihat bagian berikutnya)
4. **Deployments > Redeploy** setelah mengubah environment variables.

Setiap `git push` ke branch `main` otomatis memicu deploy ulang.

## 4. Aktifkan Real-time (Pusher Channels)

Tanpa langkah ini aplikasi tetap jalan, tetapi pesan baru muncul dengan jeda sampai 2 detik (polling).

1. Daftar di [pusher.com](https://pusher.com) dan buat app di **Channels** (paket **Sandbox** gratis:
   200.000 pesan/hari dan 100 koneksi bersamaan; cek syarat terbaru di situs Pusher).
2. Pilih cluster terdekat (misalnya `ap1` Singapore), frontend **Vanilla JS**, backend **Node.js**.
3. Buka **App Keys** dan salin `app_id`, `key`, `secret`, `cluster`.
4. Isi di Vercel (**Settings > Environment Variables**), lalu **Redeploy**:

   | Nama | Isi |
   |---|---|
   | `PUSHER_APP_ID` | `app_id` |
   | `PUSHER_KEY` | `key` |
   | `PUSHER_SECRET` | `secret` (rahasia, jangan dibagikan) |
   | `PUSHER_CLUSTER` | misalnya `ap1` |

Untuk tes lokal, tambahkan empat variabel yang sama ke `local/.env`.

Cara kerjanya: saat pesan dikirim, server mengirim **sinyal** lewat Pusher ke channel privat penerima
(`private-u-<id>`). Browser penerima langsung mengambil pesannya lewat `/api/poll`. Isi pesan tidak
dikirim lewat Pusher. Selama Pusher tersambung, polling melambat jadi 10 detik hanya sebagai cadangan
dan untuk memperbarui status online.

## Mencoba Chat

1. Daftar akun baru, lalu login.
2. Di perangkat/jendela Incognito lain, daftar dan login dengan akun kedua.
3. Klik **Tambah Teman via ID**, masukkan ID akun kedua, lalu kirim pesan.
4. Pesan muncul di sisi penerima hampir seketika (maksimal sekitar 2 detik tanpa Pusher).
5. Klik **Masukkan kunci untuk melihat pesan** dan isi kunci akunmu.

## Cara Kerja Encoding

1. Teks diubah ke ASCII 7 bit.
2. Tiap karakter dibungkus frame 10 bit: `Start (0) + 7 bit data + Even Parity + End (1)`.
3. Bit diubah menjadi sinyal **NRZ-L**: bit `1` = **High**, bit `0` = **Low**.

Contoh huruf `A`: frame `0100000101`, sinyal NRZ-L `L H L L L L L H L H`.

Yang dikirim ke server dan disimpan adalah string bit. Sinyal NRZ-L dihitung ulang
di browser untuk digambar dan di-decode.

## Cara Kerja Komunikasi

Server serverless tidak menyimpan koneksi terbuka, jadi:

- Aksi (daftar, login, kirim pesan, ganti kunci, hapus pesan) dikirim lewat `POST /api/emit`.
- Browser mengambil pesan baru dan daftar user online lewat `POST /api/poll`. Dengan Pusher aktif,
  pengambilan dipicu sinyal real-time (cadangan tiap 10 detik). Tanpa Pusher: tiap 2 detik
  (8 detik jika tab tidak aktif).
- Setelah login, server memberi token sesi bertanda tangan (berlaku 12 jam).
- User dianggap online jika aktif dalam 20 detik terakhir.

## Pemecahan Masalah

- **"Server tidak terhubung ke database!"**: `MONGODB_URI` salah/kosong, password salah,
  atau Network Access Atlas belum `0.0.0.0/0`. Lihat **Vercel > Logs** untuk detailnya.
- **Halaman 404 / `/api` tidak ditemukan di Vercel**: pastikan Root Directory kosong dan
  `vercel.json` ikut ter-push.
- **Pesan tidak masuk ke penerima**: pastikan penerima sudah login dan tunggu beberapa detik.
- **Masih terasa tidak real-time**: cek empat variabel `PUSHER_*` di Vercel sudah benar dan sudah di-Redeploy.
  Buka **Debug Console** di dashboard Pusher untuk melihat koneksi dan sinyal yang masuk.

## Catatan Keamanan

Proyek ini untuk belajar, bukan produksi:

- Password dan kunci disimpan dalam bentuk bit (belum di-hash). Gunakan `bcrypt`.
- Jangan membagikan `MONGODB_URI`. Jika sempat terlihat orang lain, ganti password user di Atlas.
- Pastikan `.env` tidak ikut ter-push (sudah ada di `.gitignore`).
