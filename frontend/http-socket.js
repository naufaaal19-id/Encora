'use strict';
// Pengganti Socket.IO untuk Vercel: sama-sama punya socket.on / socket.emit,
// tetapi lewat HTTP (POST /api/emit) + polling (POST /api/poll).
window.createHttpSocket = function () {
    const handlers = {};
    const seen = new Set();            // id pesan yang sudah ditampilkan (buang duplikat)
    let token = null, since = 0, timer = null, polling = false;
    let pusher = null, live = false;   // live = Pusher tersambung, polling jadi cadangan lambat

    const FAIL = {
        login_account: ['auth_response', { status: 'error', message: 'Gagal menghubungi server. Coba lagi.' }],
        register_account: ['auth_response', { status: 'error', message: 'Gagal menghubungi server. Coba lagi.' }],
        verify_key: ['key_response', { ok: false, message: 'Gagal menghubungi server.' }],
        change_key: ['key_changed', { ok: false, message: 'Gagal menghubungi server.' }],
        send_message: ['message_error', { message: 'Gagal menghubungi server.' }]
    };

    function fire(name, payload) {
        if (name === 'auth_response' && payload && payload.token) {
            token = payload.token;
            since = payload.now || Date.now();
            seen.clear();
            (payload.history || []).forEach((h) => seen.add(h.id));
            startPolling();
            startRealtime(payload.rt, payload.user_id);
        }
        if (name === 'message_saved' && payload && payload.id) seen.add(payload.id);
        if (name === 'receive_message' && payload) {
            if (payload.id && seen.has(payload.id)) return;
            if (payload.id) seen.add(payload.id);
        }
        (handlers[name] || []).forEach((fn) => { try { fn(payload); } catch (e) { console.error(e); } });
    }

    async function post(url, body) {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
    }

    async function send(event, data) {
        try {
            const r = await post('/api/emit', { event, data, token });
            (r.events || []).forEach(([n, p]) => fire(n, p));
        } catch (e) {
            if (FAIL[event]) fire(FAIL[event][0], FAIL[event][1]);
        }
    }

    // Satu kali polling: ambil pesan baru + daftar online
    async function pollOnce() {
        if (!token || polling) return;
        polling = true;
        try {
            const r = await post('/api/poll', { token, since });
            if (r.expired) { stopPolling(); return; }
            if (r.now) since = r.now;
            (r.events || []).forEach(([n, p]) => fire(n, p));
        } catch (e) { /* koneksi putus sementara, coba lagi */ }
        polling = false;
    }
    function nextDelay() { return live ? 10000 : (document.hidden ? 8000 : 2000); }
    function schedule() {
        clearTimeout(timer);
        if (!token) return;
        timer = setTimeout(async () => { await pollOnce(); schedule(); }, nextDelay());
    }
    function startPolling() { stopPolling(); schedule(); }
    function stopPolling() {
        clearTimeout(timer); timer = null; polling = false; live = false;
        if (pusher) { try { pusher.disconnect(); } catch (e) {} pusher = null; }
    }
    async function pollNow() { await pollOnce(); schedule(); }

    // Real-time: Pusher mengirim sinyal "ada pesan baru", lalu langsung ambil pesannya
    function startRealtime(rt, userId) {
        if (!rt || !window.Pusher || !userId) return;
        try {
            pusher = new window.Pusher(rt.key, {
                cluster: rt.cluster,
                channelAuthorization: { endpoint: '/api/pusher-auth', transport: 'ajax', params: { token } }
            });
            const ch = pusher.subscribe('private-u-' + userId);
            ch.bind('new', pollNow);
            ch.bind('pusher:subscription_succeeded', () => { live = true; pollNow(); });
            pusher.connection.bind('state_change', (st) => { live = st.current === 'connected'; schedule(); });
        } catch (e) { pusher = null; live = false; }
    }

    const api = {
        connected: true,
        on(name, fn) { (handlers[name] = handlers[name] || []).push(fn); return api; },
        emit(name, data) { send(name, data); return api; },
        connect() { api.connected = true; return api; },
        disconnect() {
            if (token) {
                fetch('/api/emit', {
                    method: 'POST', keepalive: true,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ event: 'logout', token })
                }).catch(() => {});
            }
            token = null; stopPolling();
            return api;
        }
    };
    window.addEventListener('pagehide', () => { if (token) api.disconnect(); });
    return api;
};
