'use strict';
// Encora - logika server (stateless, cocok untuk Vercel serverless + MongoDB Atlas)
const crypto = require('crypto');
const { MongoClient, ObjectId } = require('mongodb');

const ID_PATTERN = /^[A-Za-z0-9_]{3,30}$/;
const FRAME_PATTERN = /^(?:0[01]{8}1)+$/;      // 1 frame = 10 bit (start 0, 7 data, parity, end 1)
const ONLINE_WINDOW_MS = 20000;                // dianggap online jika aktif <20 detik terakhir
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;      // sesi login 12 jam
const OVERLAP_MS = 5000;                       // tumpang tindih polling (duplikat dibuang di client)
const DB_DOWN_NAMES = new Set(['MongoServerSelectionError', 'MongoNetworkError', 'MongoNetworkTimeoutError', 'MongoParseError']);
const DB_DOWN_MSG = 'Server tidak terhubung ke database!';

// ---------- Database (koneksi dipakai ulang antar request) ----------
async function getDb() {
    if (!global._encoraDb) {
        const uri = process.env.MONGODB_URI;
        if (!uri) throw Object.assign(new Error('MONGODB_URI belum diisi'), { name: 'MongoParseError' });
        const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000, maxPoolSize: 5 });
        global._encoraDb = (async () => {
            await client.connect();
            const db = client.db(process.env.DB_NAME || 'encora');
            await Promise.all([
                db.collection('users').createIndex({ user_id: 1 }, { unique: true }),
                db.collection('users').createIndex({ email: 1 }, { unique: true }),
                db.collection('messages').createIndex({ sender_id: 1 }),
                db.collection('messages').createIndex({ receiver_id: 1, created_at: 1 }),
                db.collection('message_hidden').createIndex({ user_id: 1, message_id: 1 }, { unique: true })
            ]);
            return db;
        })();
    }
    try { return await global._encoraDb; }
    catch (err) { global._encoraDb = null; throw err; }
}

function dbErrorMessage(err, fallback) {
    const authFailed = err && (err.codeName === 'AuthenticationFailed' || err.code === 18);
    return (err && DB_DOWN_NAMES.has(err.name)) || authFailed ? DB_DOWN_MSG : fallback;
}

// ---------- Token sesi (ditandatangani HMAC, tanpa menyimpan sesi di server) ----------
function secret() {
    return process.env.SESSION_SECRET ||
        crypto.createHash('sha256').update('encora:' + (process.env.MONGODB_URI || '')).digest('hex');
}
function hmac(body) { return crypto.createHmac('sha256', secret()).update(body).digest('base64url'); }
function signToken(user) {
    const body = Buffer.from(JSON.stringify({ u: user.user_id, n: user.user_name, e: Date.now() + TOKEN_TTL_MS })).toString('base64url');
    return body + '.' + hmac(body);
}
function verifyToken(token) {
    if (typeof token !== 'string') return null;
    const [body, sig] = token.split('.');
    if (!body || !sig) return null;
    const a = Buffer.from(sig), b = Buffer.from(hmac(body));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
        const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        if (!p.e || p.e < Date.now()) return null;
        return { user_id: p.u, user_name: p.n };
    } catch { return null; }
}

// ---------- Helper ----------
async function touch(db, userId) {
    await db.collection('users').updateOne({ user_id: userId }, { $set: { last_seen: new Date() } });
}
async function onlineIds(db) {
    const rows = await db.collection('users')
        .find({ last_seen: { $gt: new Date(Date.now() - ONLINE_WINDOW_MS) } })
        .project({ user_id: 1 }).toArray();
    return rows.map((r) => r.user_id);
}
// event error yang dibalas kalau database tidak bisa dipakai
function errorEvent(event, message) {
    switch (event) {
        case 'register_account':
        case 'login_account': return ['auth_response', { status: 'error', message }];
        case 'verify_key': return ['key_response', { ok: false, message }];
        case 'change_key': return ['key_changed', { ok: false, message }];
        case 'send_message': return ['message_error', { message }];
        default: return null;
    }
}

const NO_SESSION = 'Sesi tidak valid, silakan login ulang.';

// ---------- Handler semua event (padanan socket.on di versi Socket.IO) ----------
async function handleEvent(event, data, token) {
    data = data || {};
    const out = [];
    const emit = (name, payload) => out.push([name, payload]);
    const me = verifyToken(token);

    try {
        switch (event) {
            case 'register_account': {
                const userId = String(data.user_id || '').trim().toLowerCase();
                const userName = String(data.user_name || '').trim();
                const email = String(data.email || '').trim();
                const password = String(data.password || '');
                const accessKey = String(data.access_key || '');
                if (!userId || !userName || !email || !password || !accessKey) {
                    emit('auth_response', { status: 'error', message: 'Semua kolom wajib diisi!' }); break;
                }
                if (!ID_PATTERN.test(userId)) {
                    emit('auth_response', { status: 'error', message: 'ID hanya boleh huruf, angka, dan underscore (3-30 karakter)!' }); break;
                }
                const users = (await getDb()).collection('users');
                try {
                    if (await users.findOne({ $or: [{ user_id: userId }, { email }] }, { projection: { _id: 1 } })) {
                        emit('auth_response', { status: 'error', message: 'ID atau Email sudah digunakan!' }); break;
                    }
                    await users.insertOne({
                        user_id: userId, username: userName, email, password, access_key: accessKey,
                        ip_address: null, created_at: new Date(), last_login: null, last_seen: null
                    });
                    emit('auth_response', { status: 'success', action: 'register', message: 'Registrasi berhasil! Silakan login.' });
                } catch (err) {
                    emit('auth_response', {
                        status: 'error',
                        message: err.code === 11000 ? 'ID atau Email sudah digunakan!'
                            : dbErrorMessage(err, 'Terjadi kesalahan sistem saat registrasi.')
                    });
                }
                break;
            }

            case 'login_account': {
                const email = String(data.email || '').trim();
                const password = String(data.password || '');
                const db = await getDb();
                const users = db.collection('users');
                const user = email ? await users.findOne({ email }) : null;
                if (!email || !password || !user || user.password !== password) {
                    emit('auth_response', { status: 'error', message: 'Email atau Password salah!' }); break;
                }
                const userId = user.user_id;
                await users.updateOne({ user_id: userId }, { $set: { last_login: new Date(), last_seen: new Date() } });

                const hiddenIds = new Set(
                    (await db.collection('message_hidden').find({ user_id: userId }).project({ message_id: 1 }).toArray())
                        .map((h) => h.message_id)
                );
                const rows = (await db.collection('messages')
                    .find({ $or: [{ sender_id: userId }, { receiver_id: userId }] })
                    .sort({ created_at: 1, _id: 1 }).toArray()
                ).filter((row) => !hiddenIds.has(String(row._id)));

                const receiverIds = [...new Set(rows.map((r) => r.receiver_id))];
                const nameRows = receiverIds.length
                    ? await users.find({ user_id: { $in: receiverIds } }).project({ user_id: 1, username: 1 }).toArray()
                    : [];
                const nameOf = new Map(nameRows.map((u) => [u.user_id, u.username]));

                emit('auth_response', {
                    status: 'success', action: 'login',
                    user_id: userId, user_name: user.username,
                    token: signToken({ user_id: userId, user_name: user.username }),
                    now: Date.now(),
                    history: rows.map((row) => ({
                        id: String(row._id), sender_id: row.sender_id, sender_name: row.sender_name,
                        receiver_id: row.receiver_id, receiver_name: nameOf.get(row.receiver_id) || null,
                        message: String(row.message || ''),
                        created_at: row.created_at ? new Date(row.created_at).toISOString() : null
                    }))
                });
                break;
            }

            case 'register_online_user': {
                if (!me) break;
                await touch(await getDb(), me.user_id);
                break;
            }

            case 'get_online_users': {
                if (!me) break;
                emit('online_users_list', await onlineIds(await getDb()));
                break;
            }

            case 'logout': {
                if (!me) break;
                await (await getDb()).collection('users').updateOne({ user_id: me.user_id }, { $set: { last_seen: null } });
                break;
            }

            case 'verify_key': {
                if (!me) { emit('key_response', { ok: false, message: NO_SESSION }); break; }
                const row = await (await getDb()).collection('users').findOne({ user_id: me.user_id }, { projection: { access_key: 1 } });
                const dbKey = row ? row.access_key : null;
                if (!row || !dbKey) emit('key_response', { ok: false, message: 'Akun belum punya kunci.' });
                else if (dbKey === String(data.key || '')) emit('key_response', { ok: true });
                else emit('key_response', { ok: false, message: 'Kunci salah, pesan tidak bisa dibuka.' });
                break;
            }

            case 'change_key': {
                if (!me) { emit('key_changed', { ok: false, message: NO_SESSION }); break; }
                const oldKey = String(data.old_key || '');
                const newKey = String(data.new_key || '');
                if (!FRAME_PATTERN.test(newKey) || newKey.length < 40) {
                    emit('key_changed', { ok: false, message: 'Kunci baru minimal 4 karakter.' }); break;
                }
                const users = (await getDb()).collection('users');
                const row = await users.findOne({ user_id: me.user_id }, { projection: { access_key: 1 } });
                if (!row || !row.access_key || row.access_key !== oldKey) {
                    emit('key_changed', { ok: false, message: 'Kunci lama belum benar.' }); break;
                }
                await users.updateOne({ user_id: me.user_id }, { $set: { access_key: newKey } });
                emit('key_changed', { ok: true });
                break;
            }

            case 'delete_messages': {
                if (!me) break;
                const ids = (Array.isArray(data.ids) ? data.ids : [])
                    .map(String).filter((s) => s.length === 24 && ObjectId.isValid(s)).slice(0, 500);
                if (!ids.length) break;
                const db = await getDb();
                const rows = await db.collection('messages')
                    .find({ _id: { $in: ids.map((s) => new ObjectId(s)) }, $or: [{ sender_id: me.user_id }, { receiver_id: me.user_id }] })
                    .project({ _id: 1 }).toArray();
                if (!rows.length) break;
                await db.collection('message_hidden').bulkWrite(rows.map((r) => ({
                    updateOne: {
                        filter: { user_id: me.user_id, message_id: String(r._id) },
                        update: { $setOnInsert: { created_at: new Date() } },
                        upsert: true
                    }
                })));
                break;
            }

            case 'send_message': {
                if (!me) { emit('message_error', { message: NO_SESSION }); break; }
                let receiverId = String(data.receiver_id || '').trim();
                const bits = String(data.message || '').trim();
                if (!receiverId || !bits) { emit('message_error', { message: 'Pesan atau penerima tidak valid.' }); break; }
                if (!FRAME_PATTERN.test(bits)) {
                    emit('message_error', { message: 'Format pesan tidak valid (kelipatan 10 bit, start 0, end 1).' }); break;
                }
                const db = await getDb();
                const found = await db.collection('users').findOne({ user_id: receiverId }, { projection: { user_id: 1 } });
                if (!found) { emit('message_error', { message: `ID "${receiverId}" tidak ditemukan!` }); break; }
                receiverId = found.user_id;
                const ins = await db.collection('messages').insertOne({
                    sender_id: me.user_id, sender_name: me.user_name,
                    receiver_id: receiverId, message: bits, created_at: new Date()
                });
                await touch(db, me.user_id);
                emit('message_saved', { ref: data.ref, id: String(ins.insertedId) });
                break;
            }

            default: break;
        }
    } catch (err) {
        console.error(`-> [ERROR ${event}]:`, err.message);
        const ev = errorEvent(event, dbErrorMessage(err, 'Terjadi kesalahan sistem.'));
        if (ev) out.push(ev);
    }
    return { events: out };
}

// ---------- Polling: pesan baru + daftar online (pengganti push Socket.IO) ----------
async function handlePoll(token, since) {
    const me = verifyToken(token);
    if (!me) return { expired: true, events: [] };
    const now = Date.now();
    try {
        const db = await getDb();
        await touch(db, me.user_id);
        const from = new Date((Number(since) || now) - OVERLAP_MS);
        const rows = await db.collection('messages')
            .find({ receiver_id: me.user_id, created_at: { $gt: from } })
            .sort({ created_at: 1, _id: 1 }).limit(200).toArray();
        const events = rows.map((r) => ['receive_message', {
            id: String(r._id), sender_id: r.sender_id, sender_name: r.sender_name,
            receiver_id: r.receiver_id, message: String(r.message || ''), time: ''
        }]);
        events.push(['online_users_list', await onlineIds(db)]);
        return { events, now };
    } catch (err) {
        console.error('-> [ERROR poll]:', err.message);
        return { events: [], now: Number(since) || now };   // coba lagi di polling berikutnya
    }
}

module.exports = { handleEvent, handlePoll, signToken, verifyToken };
