# Encora

Aplikasi chat **real-time** untuk simulasi komunikasi data. Pesan diubah menjadi bit
(framing 10 bit + parity), lalu divisualisasikan sebagai sinyal **NRZ-L**. Pesan hanya bisa
dibaca setelah memasukkan kunci akun.

- **Backend:** Node.js, Express, Socket.IO, MySQL (`mysql2`)
- **Frontend:** HTML, CSS, JavaScript (vanilla) + Socket.IO client
- **Real-time:** WebSocket lewat Socket.IO

## Struktur Folder

```text
Encora/
├── backend/
│   ├── server.js
│   ├── package.json
│   └── .env.example
├── database/
│   └── schema.sql
├── frontend/
│   ├── index.html
│   ├── script.js
│   ├── style.css
│   └── crypto-js.min.js
├── .vscode/
│   └── launch.json
├── .gitignore
└── README.md
```

## Prasyarat

- [Node.js](https://nodejs.org) versi 18 atau lebih baru (pilih versi LTS)
- MySQL (Laragon atau XAMPP)
- VS Code dan Git

Cek instalasi dengan `node -v`, `npm -v`, dan `git --version` di terminal.

## 1. Siapkan Database

1. Jalankan MySQL (Laragon: klik **Start All**).
2. Buka HeidiSQL atau phpMyAdmin, lalu jalankan seluruh isi `database/schema.sql`.
   File ini membuat database `Encora_db` beserta tabel `users` dan `messages`.

> **Peringatan:** `schema.sql` memuat `DROP TABLE`. Menjalankannya ulang menghapus semua data lama.

## 2. Siapkan Backend

Di terminal VS Code (**Terminal > New Terminal**):

```bash
cd backend
npm install
```

Salin `.env.example` menjadi `.env`:

- Windows (CMD): `copy .env.example .env`
- PowerShell / Linux / macOS: `cp .env.example .env`

Buka `.env` dan sesuaikan `DB_USER` / `DB_PASSWORD` bila MySQL kamu tidak memakai
`root` dengan password kosong (default Laragon).

## 3. Jalankan Server

```bash
npm start
```

Atau tekan **F5** di VS Code dan pilih **"Encora: Jalankan Server"**.
Untuk auto-restart saat kode berubah: `npm run dev`.

Jika berhasil, terminal menampilkan:

```text
Encora berjalan di http://localhost:5000
-> [DATABASE] Terhubung ke MySQL
```

Buka **http://localhost:5000** di browser.

## 4. Mencoba Chat

1. Daftar akun baru, lalu login.
2. Buka **jendela Incognito** dan login dengan akun kedua.
3. Klik **Tambah Teman via ID**, masukkan ID akun kedua, lalu kirim pesan.
4. Klik **Masukkan kunci untuk melihat pesan** dan isi kunci akunmu.

## Cara Kerja Encoding

1. Teks diubah ke ASCII 7 bit.
2. Tiap karakter dibungkus frame 10 bit: `Start (0) + 7 bit data + Even Parity + End (1)`.
3. Bit diubah menjadi sinyal **NRZ-L**: bit `1` = level **High**, bit `0` = level **Low**.

Contoh huruf `A`: frame `0100000101`, sinyal NRZ-L `L H L L L L L H L H`.

Yang dikirim ke server dan disimpan di database adalah string bit. Sinyal NRZ-L dihitung
ulang di browser untuk digambar dan di-decode.

## Upload ke GitHub

1. Buat repository **kosong** di https://github.com/new (nama misalnya `encora`, jangan centang
   "Add a README").
2. Di terminal, dari folder utama `Encora/`:

```bash
git init
git add .
git commit -m "Initial commit: Encora"
git branch -M main
git remote add origin https://github.com/USERNAME/encora.git
git push -u origin main
```

Ganti `USERNAME` dengan username GitHub kamu. Saat `git push`, login lewat jendela browser
yang muncul. Jika diminta password, pakai *Personal Access Token*, bukan password akun.

Pastikan `.env` dan `node_modules/` tidak ikut ter-upload (sudah diatur di `.gitignore`).

> GitHub hanya menyimpan kode. GitHub Pages tidak bisa menjalankan Node.js dan MySQL, jadi aplikasi
> ini tidak akan hidup di sana. Untuk online, deploy ke layanan seperti Render atau Railway
> dengan database MySQL cloud, dan isi `PORT`, `DB_*` lewat environment variables.

## Catatan Keamanan

Proyek ini ditujukan untuk belajar, bukan produksi. Sebelum di-hosting publik:

- Password dan kunci disimpan dalam bentuk bit (belum di-hash). Gunakan `bcrypt`.
- Batasi `cors.origin` di `backend/server.js`.
- Gunakan HTTPS.
