// Encora - Backend (Node.js + Express + Socket.IO + MongoDB Atlas)
// Event Socket.IO sama persis dengan versi MySQL/PostgreSQL, jadi frontend tidak perlu diubah.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config({ path: path.join(__dirname, '.env.local') });      // hasil "vercel env pull"
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') });

const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { MongoClient, ObjectId } = require('mongodb');

// ==========================================
// KONFIGURASI
// ==========================================
const PORT = Number(process.env.PORT) || 5000;
const frontendDir = path.join(__dirname, '..', 'frontend');

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || 'encora';
if (!MONGODB_URI) {
    console.error('-> [CONFIG] MONGODB_URI belum diisi di backend/.env');
    process.exit(1);
}

const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
const db = client.db(DB_NAME);
const users = db.collection('users');
const messages = db.collection('messages');
const hidden = db.collection('message_hidden');   // pesan yang dihapus pengguna (hapus untuk saya)

const app = express();
const server = http.createServer(app);
// FRONTEND_ORIGIN (opsional): domain frontend, mis. https://encora.vercel.app. Kosong = semua boleh.
const io = new Server(server, { cors: { origin: process.env.FRONTEND_ORIGIN || '*' } });

// { socket.id: { user_id, user_name } }
const onlineUsers = new Map();

const ID_PATTERN = /^[A-Za-z0-9_]{3,30}$/;
// 1 frame = start 0 + 7 bit data + 1 bit parity + end 1 (kelipatan 10 bit)
const FRAME_PATTERN = /^(?:0[01]{8}1)+$/;

const DB_DOWN_NAMES = new Set([
    'MongoServerSelectionError', 'MongoNetworkError', 'MongoNetworkTimeoutError', 'MongoParseError'
]);

function dbErrorMessage(err, fallback) {
    const authFailed = err && (err.codeName === 'AuthenticationFailed' || err.code === 18);
    return (err && DB_DOWN_NAMES.has(err.name)) || authFailed
        ? 'Server tidak terhubung ke database!'
        : fallback;
}

function getActiveOnlineUserIds() {
    const ids = new Set();
    for (const u of onlineUsers.values()) {
        if (u.user_id) ids.add(u.user_id);
    }
    return [...ids];
}

// ==========================================
// FILE STATIC FRONTEND
// ==========================================
app.use(express.static(frontendDir));
app.get('/healthz', (req, res) => res.json({ ok: true }));
app.get('/favicon.ico', (req, res) => res.status(204).end());

// ==========================================
// SOCKET.IO
// ==========================================
io.on('connection', (socket) => {

    // ---------- AUTENTIKASI: REGISTER ----------
    socket.on('register_account', async (data) => {
        data = data || {};
        const userId = String(data.user_id || '').trim().toLowerCase();
        const userName = String(data.user_name || '').trim();
        const email = String(data.email || '').trim();
        const password = String(data.password || '');
        const accessKey = String(data.access_key || '');

        if (!userId || !userName || !email || !password || !accessKey) {
            return socket.emit('auth_response', { status: 'error', message: 'Semua kolom wajib diisi!' });
        }
        if (!ID_PATTERN.test(userId)) {
            return socket.emit('auth_response', {
                status: 'error',
                message: 'ID hanya boleh huruf, angka, dan underscore (3-30 karakter)!'
            });
        }

        try {
            const exists = await users.findOne({ $or: [{ user_id: userId }, { email }] }, { projection: { _id: 1 } });
            if (exists) {
                return socket.emit('auth_response', { status: 'error', message: 'ID atau Email sudah digunakan!' });
            }

            await users.insertOne({
                user_id: userId,
                username: userName,
                email,
                password,
                access_key: accessKey,
                ip_address: null,
                created_at: new Date(),
                last_login: null
            });

            console.log(`-> [REGISTER SUCCESS] ${userName} (${userId})`);
            socket.emit('auth_response', {
                status: 'success',
                action: 'register',
                message: 'Registrasi berhasil! Silakan login.'
            });
        } catch (err) {
            console.error('-> [ERROR REGISTER]:', err.message);
            const msg = err.code === 11000
                ? 'ID atau Email sudah digunakan!'
                : dbErrorMessage(err, 'Terjadi kesalahan sistem saat registrasi.');
            socket.emit('auth_response', { status: 'error', message: msg });
        }
    });

    // ---------- AUTENTIKASI: LOGIN ----------
    socket.on('login_account', async (data) => {
        data = data || {};
        const email = String(data.email || '').trim();
        const password = String(data.password || '');

        try {
            const user = email ? await users.findOne({ email }) : null;

            if (!email || !password || !user || user.password !== password) {
                return socket.emit('auth_response', { status: 'error', message: 'Email atau Password salah!' });
            }

            const userId = user.user_id;
            const userName = user.username;

            await users.updateOne({ user_id: userId }, { $set: { last_login: new Date() } });

            // Riwayat chat, tanpa pesan yang sudah dihapus pengguna ini
            const hiddenIds = new Set(
                (await hidden.find({ user_id: userId }).project({ message_id: 1 }).toArray()).map((h) => h.message_id)
            );
            const rows = (await messages
                .find({ $or: [{ sender_id: userId }, { receiver_id: userId }] })
                .sort({ created_at: 1, _id: 1 })
                .toArray()
            ).filter((row) => !hiddenIds.has(String(row._id)));

            // Nama penerima (pengganti LEFT JOIN)
            const receiverIds = [...new Set(rows.map((r) => r.receiver_id))];
            const nameRows = receiverIds.length
                ? await users.find({ user_id: { $in: receiverIds } }).project({ user_id: 1, username: 1 }).toArray()
                : [];
            const nameOf = new Map(nameRows.map((u) => [u.user_id, u.username]));

            const history = rows.map((row) => ({
                id: String(row._id),
                sender_id: row.sender_id,
                sender_name: row.sender_name,
                receiver_id: row.receiver_id,
                receiver_name: nameOf.get(row.receiver_id) || null,
                message: String(row.message || ''),
                created_at: row.created_at ? new Date(row.created_at).toISOString() : null
            }));

            const old = onlineUsers.get(socket.id);
            if (old && old.user_id) socket.leave(old.user_id);
            onlineUsers.set(socket.id, { user_id: userId, user_name: userName });
            socket.join(userId);

            console.log(`-> [LOGIN SUCCESS] ${userName} (${userId})`);
            socket.emit('auth_response', {
                status: 'success',
                action: 'login',
                user_id: userId,
                user_name: userName,
                history
            });
        } catch (err) {
            console.error('-> [ERROR LOGIN]:', err.message);
            socket.emit('auth_response', {
                status: 'error',
                message: dbErrorMessage(err, 'Terjadi kesalahan sistem.')
            });
        }
    });

    // ---------- STATUS ONLINE / OFFLINE ----------
    socket.on('register_online_user', (userId) => {
        const me = onlineUsers.get(socket.id);
        // Identitas hanya dipercaya dari sesi login di server, bukan dari data client
        if (!me || !userId || me.user_id !== userId) return;

        socket.join(me.user_id);
        io.emit('user_status_change', { userId: me.user_id, status: 'online' });
    });

    socket.on('get_online_users', () => {
        socket.emit('online_users_list', getActiveOnlineUserIds());
    });

    // ---------- VERIFIKASI KUNCI BUKA PESAN ----------
    socket.on('verify_key', async (data) => {
        const me = onlineUsers.get(socket.id);
        if (!me) {
            return socket.emit('key_response', { ok: false, message: 'Sesi tidak valid, silakan login ulang.' });
        }

        data = data || {};
        const keyBin = String(data.key || '');

        try {
            // Kunci yang dicek = kunci user yang login (dari sesi server)
            const row = await users.findOne({ user_id: me.user_id }, { projection: { access_key: 1 } });
            const dbKey = row ? row.access_key : null;

            if (!row || !dbKey) {
                socket.emit('key_response', { ok: false, message: 'Akun belum punya kunci.' });
            } else if (dbKey === keyBin) {
                socket.emit('key_response', { ok: true });
            } else {
                socket.emit('key_response', { ok: false, message: 'Kunci salah, pesan tidak bisa dibuka.' });
            }
        } catch (err) {
            console.error('-> [ERROR VERIFY KEY]:', err.message);
            socket.emit('key_response', {
                ok: false,
                message: dbErrorMessage(err, 'Terjadi kesalahan sistem.')
            });
        }
    });

    // ---------- GANTI KUNCI BUKA PESAN ----------
    socket.on('change_key', async (data) => {
        const me = onlineUsers.get(socket.id);
        if (!me) {
            return socket.emit('key_changed', { ok: false, message: 'Sesi tidak valid, silakan login ulang.' });
        }
        data = data || {};
        const oldKey = String(data.old_key || '');
        const newKey = String(data.new_key || '');

        // Kunci baru: frame 10 bit valid, minimal 4 karakter (40 bit)
        if (!FRAME_PATTERN.test(newKey) || newKey.length < 40) {
            return socket.emit('key_changed', { ok: false, message: 'Kunci baru minimal 4 karakter.' });
        }
        try {
            const row = await users.findOne({ user_id: me.user_id }, { projection: { access_key: 1 } });
            if (!row || !row.access_key || row.access_key !== oldKey) {
                return socket.emit('key_changed', { ok: false, message: 'Kunci lama belum benar.' });
            }
            await users.updateOne({ user_id: me.user_id }, { $set: { access_key: newKey } });
            socket.emit('key_changed', { ok: true });
        } catch (err) {
            console.error('-> [ERROR CHANGE KEY]:', err.message);
            socket.emit('key_changed', { ok: false, message: dbErrorMessage(err, 'Terjadi kesalahan sistem.') });
        }
    });

    // ---------- HAPUS PESAN (hanya untuk akun yang menghapus) ----------
    socket.on('delete_messages', async (data) => {
        const me = onlineUsers.get(socket.id);
        if (!me) return;
        const ids = (Array.isArray(data && data.ids) ? data.ids : [])
            .map(String).filter((s) => ObjectId.isValid(s) && s.length === 24).slice(0, 500);
        if (ids.length === 0) return;
        try {
            // Hanya pesan yang melibatkan pengguna ini yang boleh disembunyikan
            const rows = await messages
                .find({ _id: { $in: ids.map((s) => new ObjectId(s)) }, $or: [{ sender_id: me.user_id }, { receiver_id: me.user_id }] })
                .project({ _id: 1 })
                .toArray();
            if (rows.length === 0) return;
            await hidden.bulkWrite(rows.map((r) => ({
                updateOne: {
                    filter: { user_id: me.user_id, message_id: String(r._id) },
                    update: { $setOnInsert: { created_at: new Date() } },
                    upsert: true
                }
            })));
        } catch (err) {
            console.error('-> [ERROR DELETE MESSAGES]:', err.message);
        }
    });

    // ---------- TRANSMISI CHAT ----------
    socket.on('send_message', async (data) => {
        const sender = onlineUsers.get(socket.id);
        if (!sender) {
            return socket.emit('message_error', { message: 'Sesi tidak valid, silakan login ulang.' });
        }

        data = data || {};
        let receiverId = String(data.receiver_id || '').trim();
        const binaryMessage = String(data.message || '').trim();

        if (!receiverId || !binaryMessage) {
            return socket.emit('message_error', { message: 'Pesan atau penerima tidak valid.' });
        }

        // Validasi format frame: kelipatan 10 bit, start 0, end 1
        if (!FRAME_PATTERN.test(binaryMessage)) {
            return socket.emit('message_error', {
                message: 'Format pesan tidak valid (kelipatan 10 bit, start 0, end 1).'
            });
        }

        let msgId = null;
        try {
            const found = await users.findOne({ user_id: receiverId }, { projection: { user_id: 1 } });
            if (!found) {
                return socket.emit('message_error', { message: `ID "${receiverId}" tidak ditemukan!` });
            }
            receiverId = found.user_id;

            const ins = await messages.insertOne({
                sender_id: sender.user_id,
                sender_name: sender.user_name,
                receiver_id: receiverId,
                message: binaryMessage,
                created_at: new Date()
            });
            msgId = String(ins.insertedId);
            console.log(`-> [SUCCESS] Pesan (${binaryMessage.length} bit) ${sender.user_id} -> ${receiverId} tersimpan di MongoDB`);
        } catch (err) {
            console.error('-> [ERROR DATABASE MESSAGES]:', err.message);
            return socket.emit('message_error', {
                message: dbErrorMessage(err, 'Pesan gagal disimpan.')
            });
        }

        socket.emit('message_saved', { ref: data.ref, id: msgId });

        io.to(receiverId).emit('receive_message', {
            id: msgId,
            sender_id: sender.user_id,
            sender_name: sender.user_name,
            receiver_id: receiverId,
            message: binaryMessage,
            time: data.time || ''
        });
    });

    // ---------- DISCONNECT ----------
    socket.on('disconnect', () => {
        const userData = onlineUsers.get(socket.id);
        onlineUsers.delete(socket.id);
        if (userData && userData.user_id) {
            const stillOnline = [...onlineUsers.values()].some(u => u.user_id === userData.user_id);
            if (!stillOnline) {
                io.emit('user_status_change', { userId: userData.user_id, status: 'offline' });
            }
        }
    });
});

// ==========================================
// START SERVER
// ==========================================
server.listen(PORT, '0.0.0.0', async () => {
    console.log(`Encora berjalan di http://localhost:${PORT}`);
    try {
        await db.command({ ping: 1 });
        console.log(`-> [DATABASE] Terhubung ke MongoDB (database: ${DB_NAME})`);
        // Index agar pencarian cepat dan ID/email tidak bisa dobel
        await users.createIndex({ user_id: 1 }, { unique: true });
        await users.createIndex({ email: 1 }, { unique: true });
        await messages.createIndex({ sender_id: 1 });
        await messages.createIndex({ receiver_id: 1 });
        await hidden.createIndex({ user_id: 1, message_id: 1 }, { unique: true });
        console.log('-> [DATABASE] Index siap');
    } catch (err) {
        console.error(`-> [DATABASE] Gagal terhubung: ${err.name} ${err.message}`);
        console.error('   Cek MONGODB_URI di backend/.env dan Network Access di MongoDB Atlas.');
    }
});
