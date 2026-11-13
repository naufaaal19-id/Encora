# Encora

Aplikasi chat **hampir real-time** untuk simulasi komunikasi data. Pesan diubah menjadi bit
(framing 10 bit + parity), lalu divisualisasikan sebagai sinyal **NRZ-L**. Pesan hanya bisa
dibaca setelah memasukkan kunci akun.

- **Hosting:** Vercel (frontend statis + Serverless Functions)
- **Database:** MongoDB Atlas (paket gratis M0 cukup)
- **Frontend:** HTML, CSS, JavaScript (vanilla)
- **Komunikasi:** HTTP + polling tiap 2 detik (Vercel tidak mendukung WebSocket/Socket.IO)

## Struktur Folder

```text
Encora/
├── api/
│   ├── emit.js        # menangani aksi: daftar, login, kirim pesan, dll.
│   └── poll.js        # polling pesan baru + daftar user online
├── lib/
│   └── encora.js      # logika server + koneksi MongoDB
├── frontend/
│   ├── index.html
│   ├── script.js
│   ├── http-socket.js # pengganti Socket.IO (HTTP + polling)
│   └── style.css
├── backend/
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

Dari folder utama proyek (bukan `backend`):

```bash
npm install
```

Buat file `backend/.env`:

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
4. **Deployments > Redeploy** setelah mengubah environment variables.

Setiap `git push` ke branch `main` otomatis memicu deploy ulang.

## Mencoba Chat

1. Daftar akun baru, lalu login.
2. Di perangkat/jendela Incognito lain, daftar dan login dengan akun kedua.
3. Klik **Tambah Teman via ID**, masukkan ID akun kedua, lalu kirim pesan.
4. Pesan muncul di sisi penerima dalam sekitar 2 detik.
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
- Browser menanyakan pesan baru dan daftar user online lewat `POST /api/poll`
  (tiap 2 detik; tiap 8 detik jika tab tidak aktif).
- Setelah login, server memberi token sesi bertanda tangan (berlaku 12 jam).
- User dianggap online jika aktif dalam 20 detik terakhir.

## Pemecahan Masalah

- **"Server tidak terhubung ke database!"**: `MONGODB_URI` salah/kosong, password salah,
  atau Network Access Atlas belum `0.0.0.0/0`. Lihat **Vercel > Logs** untuk detailnya.
- **Halaman 404 / `/api` tidak ditemukan di Vercel**: pastikan Root Directory kosong dan
  `vercel.json` ikut ter-push.
- **Pesan tidak masuk ke penerima**: tunggu 2 detik; pastikan penerima sudah login.

## Catatan Keamanan

Proyek ini untuk belajar, bukan produksi:

- Password dan kunci disimpan dalam bentuk bit (belum di-hash). Gunakan `bcrypt`.
- Jangan membagikan `MONGODB_URI`. Jika sempat terlihat orang lain, ganti password user di Atlas.
- Pastikan `.env` tidak ikut ter-push (sudah ada di `.gitignore`).
