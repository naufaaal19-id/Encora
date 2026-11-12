// Encora - Backend (Node.js + Express + Socket.IO + MySQL)
// Event Socket.IO sama persis dengan versi Python sebelumnya,
// jadi frontend tidak perlu diubah.

require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const mysql = require('mysql2/promise');

// ==========================================
// KONFIGURASI
// ==========================================
const PORT = Number(process.env.PORT) || 5000;
const frontendDir = path.join(__dirname, '..', 'frontend');

const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'Encora_db',
    charset: 'utf8mb4',
    waitForConnections: true,
    connectionLimit: 10
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// { socket.id: { user_id, user_name } }
const onlineUsers = new Map();

const ID_PATTERN = /^[A-Za-z0-9_]{3,30}$/;
// 1 frame = start 0 + 7 bit data + 1 bit parity + end 1 (kelipatan 10 bit)
const FRAME_PATTERN = /^(?:0[01]{8}1)+$/;

const DB_DOWN_CODES = new Set([
    'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'PROTOCOL_CONNECTION_LOST',
    'ER_ACCESS_DENIED_ERROR', 'ER_BAD_DB_ERROR'
]);

function dbErrorMessage(err, fallback) {
    return DB_DOWN_CODES.has(err && err.code)
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
            const [exists] = await pool.query(
                'SELECT 1 FROM users WHERE user_id = ? OR email = ? LIMIT 1',
                [userId, email]
            );
            if (exists.length > 0) {
                return socket.emit('auth_response', { status: 'error', message: 'ID atau Email sudah digunakan!' });
            }

            await pool.query(
                `INSERT INTO users (user_id, username, email, password, access_key, created_at)
                 VALUES (?, ?, ?, ?, ?, NOW())`,
                [userId, userName, email, password, accessKey]
            );

            console.log(`-> [REGISTER SUCCESS] ${userName} (${userId})`);
            socket.emit('auth_response', {
                status: 'success',
                action: 'register',
                message: 'Registrasi berhasil! Silakan login.'
            });
        } catch (err) {
            console.error('-> [ERROR REGISTER]:', err.message);
            const msg = err.code === 'ER_DUP_ENTRY'
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
            const [users] = await pool.query(
                'SELECT user_id, username, password FROM users WHERE email = ? LIMIT 1',
                [email]
            );
            const user = users[0];

            if (!email || !password || !user || user.password !== password) {
                return socket.emit('auth_response', { status: 'error', message: 'Email atau Password salah!' });
            }

            const userId = user.user_id;
            const userName = user.username;

            await pool.query('UPDATE users SET last_login = NOW() WHERE user_id = ?', [userId]);

            // Riwayat chat (kolom message bertipe LONGBLOB -> Buffer)
            const [rows] = await pool.query(
                `SELECT m.id, m.sender_id, m.sender_name, m.receiver_id,
                        u.username AS receiver_name, m.message, m.created_at
                 FROM messages m
                 LEFT JOIN users u ON u.user_id = m.receiver_id
                 WHERE (m.sender_id = ? OR m.receiver_id = ?)
                   AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id = m.id AND h.user_id = ?)
                 ORDER BY m.created_at ASC, m.id ASC`,
                [userId, userId, userId]
            );

            const history = rows.map((row) => ({
                id: row.id,
                sender_id: row.sender_id,
                sender_name: row.sender_name,
                receiver_id: row.receiver_id,
                receiver_name: row.receiver_name,
                message: Buffer.isBuffer(row.message) ? row.message.toString('utf8') : String(row.message || ''),
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
            const [rows] = await pool.query(
                'SELECT access_key FROM users WHERE user_id = ? LIMIT 1',
                [me.user_id]
            );
            const row = rows[0];
            let dbKey = row ? row.access_key : null;
            if (Buffer.isBuffer(dbKey)) dbKey = dbKey.toString('utf8');

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
            const [rows] = await pool.query('SELECT access_key FROM users WHERE user_id = ? LIMIT 1', [me.user_id]);
            let dbKey = rows[0] ? rows[0].access_key : null;
            if (Buffer.isBuffer(dbKey)) dbKey = dbKey.toString('utf8');

            if (!dbKey || dbKey !== oldKey) {
                return socket.emit('key_changed', { ok: false, message: 'Kunci lama belum benar.' });
            }
            await pool.query('UPDATE users SET access_key = ? WHERE user_id = ?', [newKey, me.user_id]);
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
            .map(Number).filter(Number.isInteger).slice(0, 500);
        if (ids.length === 0) return;
        try {
            // Hanya pesan yang melibatkan pengguna ini yang boleh disembunyikan
            const [rows] = await pool.query(
                'SELECT id FROM messages WHERE id IN (?) AND (sender_id = ? OR receiver_id = ?)',
                [ids, me.user_id, me.user_id]
            );
            if (rows.length === 0) return;
            await pool.query(
                'INSERT IGNORE INTO message_hidden (user_id, message_id) VALUES ?',
                [rows.map((r) => [me.user_id, r.id])]
            );
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
            const [found] = await pool.query(
                'SELECT user_id FROM users WHERE user_id = ? LIMIT 1',
                [receiverId]
            );
            if (found.length === 0) {
                return socket.emit('message_error', { message: `ID "${receiverId}" tidak ditemukan!` });
            }
            receiverId = found[0].user_id;

            const [ins] = await pool.query(
                `INSERT INTO messages (sender_id, sender_name, receiver_id, message, created_at)
                 VALUES (?, ?, ?, ?, NOW())`,
                [sender.user_id, sender.user_name, receiverId, Buffer.from(binaryMessage, 'utf8')]
            );
            msgId = ins.insertId;
            console.log(`-> [SUCCESS] Pesan LONGBLOB (${binaryMessage.length} bit) ${sender.user_id} -> ${receiverId} tersimpan di MySQL`);
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
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Encora berjalan di http://localhost:${PORT}`);
    pool.query('SELECT 1')
        .then(() => {
            console.log('-> [DATABASE] Terhubung ke MySQL');
            // Tabel untuk fitur hapus pesan (dibuat otomatis kalau belum ada)
            return pool.query(
                `CREATE TABLE IF NOT EXISTS message_hidden (
                    user_id VARCHAR(30) NOT NULL,
                    message_id INT NOT NULL,
                    PRIMARY KEY (user_id, message_id),
                    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
                )`
            ).then(() => console.log('-> [DATABASE] Tabel message_hidden siap'));
        })
        .catch((err) => console.error(`-> [DATABASE] Gagal: ${err.code || ''} ${err.message || ''}`.trim(), err.errors ? err.errors.map((e) => e.code).join(', ') : ''));
});
