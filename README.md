# Encora

Aplikasi chat **real-time** untuk simulasi komunikasi data. Pesan diubah menjadi bit
(framing 10 bit + parity), lalu divisualisasikan sebagai sinyal **NRZ-L**. Pesan hanya bisa
dibaca setelah memasukkan kunci akun.

- **Backend:** Node.js, Express, Socket.IO, MongoDB (driver `mongodb`)
- **Database:** MongoDB Atlas (cloud, paket gratis M0 cukup)
- **Frontend:** HTML, CSS, JavaScript (vanilla) + Socket.IO client
- **Real-time:** WebSocket lewat Socket.IO

## Struktur Folder

```text
Encora/
├── backend/
│   ├── server.js
│   ├── package.json
│   └── .env              # dibuat sendiri, tidak ikut ke GitHub
├── frontend/
│   ├── index.html
│   ├── script.js
│   ├── style.css
│   └── config.js         # alamat backend (kosong = satu server dengan frontend)
├── .vscode/
│   └── launch.json
├── .gitignore
└── README.md
```

## Prasyarat

- [Node.js](https://nodejs.org) versi 18 atau lebih baru (pilih versi LTS)
- Akun [MongoDB Atlas](https://www.mongodb.com/cloud/atlas) (gratis)
- VS Code dan Git

Cek instalasi dengan `node -v`, `npm -v`, dan `git --version` di terminal.

## 1. Siapkan Database (MongoDB Atlas)

1. Buat cluster gratis (M0) di MongoDB Atlas.
2. **Security > Database Access:** buat user database dengan password.
   Gunakan huruf dan angka saja supaya password tidak perlu di-encode.
3. **Security > Network Access > Add IP Address:** pilih **Allow access from anywhere**
   (`0.0.0.0/0`), lalu Confirm. Tanpa ini, server akan gagal terhubung.
4. **Database > Connect > Drivers:** salin connection string, bentuknya:

   ```text
   mongodb+srv://USER:PASSWORD@cluster.xxxxx.mongodb.net/?retryWrites=true&w=majority
   ```

Koleksi `users`, `messages`, dan `message_hidden` beserta index-nya dibuat **otomatis**
saat server pertama kali jalan. Tidak ada skema yang perlu diimpor.

## 2. Siapkan Backend

Di terminal VS Code (**Terminal > New Terminal**):

```bash
cd backend
npm install
```

Buat file `backend/.env` dengan isi berikut, lalu ganti `USER` dan `PASSWORD`
sesuai connection string kamu:

```env
PORT=5000
MONGODB_URI=mongodb+srv://USER:PASSWORD@cluster.xxxxx.mongodb.net/?retryWrites=true&w=majority
DB_NAME=encora
```

> Jangan memakai tanda kutip di sekitar nilai `MONGODB_URI`.

## 3. Jalankan Server

```bash
npm start
```

Atau tekan **F5** di VS Code dan pilih **"Encora: Jalankan Server"**.
Untuk auto-restart saat kode berubah: `npm run dev`.

Jika berhasil, terminal menampilkan:

```text
Encora berjalan di http://localhost:5000
-> [DATABASE] Terhubung ke MongoDB (database: encora)
-> [DATABASE] Index siap
```

Buka **http://localhost:5000** di browser.

## 4. Mencoba Chat

1. Daftar akun baru, lalu login.
2. Buka **jendela Incognito** dan login dengan akun kedua.
3. Klik **Tambah Teman via ID**, masukkan ID akun kedua, lalu kirim pesan.
4. Klik **Masukkan kunci untuk melihat pesan** dan isi kunci akunmu.

Data akun bisa dilihat di Atlas lewat **Browse Collections > encora > users**.

## Cara Kerja Encoding

1. Teks diubah ke ASCII 7 bit.
2. Tiap karakter dibungkus frame 10 bit: `Start (0) + 7 bit data + Even Parity + End (1)`.
3. Bit diubah menjadi sinyal **NRZ-L**: bit `1` = level **High**, bit `0` = level **Low**.

Contoh huruf `A`: frame `0100000101`, sinyal NRZ-L `L H L L L L L H L H`.

Yang dikirim ke server dan disimpan di database adalah string bit. Sinyal NRZ-L dihitung
ulang di browser untuk digambar dan di-decode.

## Upload ke GitHub

Dari folder utama proyek:

```bash
git add -A
git status
git commit -m "Pesan commit kamu"
git push
```

Sebelum commit, pastikan `git status` **tidak** menampilkan `.env` atau `node_modules/`
(keduanya sudah diatur di `.gitignore`). File `.env` berisi password database.

Untuk repository baru, buat repository **kosong** di https://github.com/new, lalu:

```bash
git init
git branch -M main
git remote add origin https://github.com/USERNAME/Encora.git
git add .
git commit -m "Initial commit: Encora"
git push -u origin main
```

Saat `git push`, login lewat jendela browser yang muncul. Jika diminta password, pakai
*Personal Access Token*, bukan password akun.

## Deploy Online

> **Penting:** Encora memakai Socket.IO, yang butuh server Node.js yang **hidup terus-menerus**.
> **Vercel (serverless) tidak bisa menjalankan server seperti ini**, begitu juga GitHub Pages.
> Frontend akan tampil, tetapi daftar, login, dan chat tidak akan berfungsi.

Gunakan layanan yang mendukung server Node.js persisten dan WebSocket, misalnya Render,
Railway, Fly.io, atau Hugging Face Spaces (Docker). Syarat paket gratis dan kebutuhan
kartu pembayaran berbeda-beda dan bisa berubah, jadi cek langsung di situs masing-masing.

Pengaturan umum:

- Build command: `cd backend && npm install`
- Start command: `cd backend && npm start`
- Environment variables: `MONGODB_URI` dan `DB_NAME` (jangan isi `PORT`, platform mengaturnya)
- MongoDB Atlas harus mengizinkan `0.0.0.0/0` di Network Access, karena IP platform hosting
  berubah-ubah.

Server yang sama sekaligus menyajikan folder `frontend`, jadi satu layanan sudah cukup.

Jika frontend dan backend ingin dipisah (misalnya frontend di Vercel), isi
`frontend/config.js` dengan alamat backend:

```js
window.ENCORA_BACKEND_URL = 'https://alamat-backend-kamu.example.com';
```

Lalu di backend, isi environment variable `FRONTEND_ORIGIN` dengan alamat frontend
(contoh: `https://encora.vercel.app`) agar CORS hanya mengizinkan domain itu.

## Catatan Keamanan

Proyek ini ditujukan untuk belajar, bukan produksi. Sebelum di-hosting publik:

- Password dan kunci disimpan dalam bentuk bit (belum di-hash). Gunakan `bcrypt`.
- Jangan membagikan `MONGODB_URI` atau screenshot yang memperlihatkannya. Jika sudah
  terlanjur terlihat orang lain, ganti password user di Atlas (**Database Access > Edit**).
- Atur `FRONTEND_ORIGIN` agar `cors.origin` tidak terbuka untuk semua domain.
- Gunakan HTTPS (disediakan otomatis oleh sebagian besar platform hosting).
