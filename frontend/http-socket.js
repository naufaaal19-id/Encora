'use strict';
// Pengganti Socket.IO untuk Vercel: sama-sama punya socket.on / socket.emit,
// tetapi lewat HTTP (POST /api/emit) + polling (POST /api/poll).
window.createHttpSocket = function () {
    const handlers = {};
    const seen = new Set();            // id pesan yang sudah ditampilkan (buang duplikat)
    let token = null, since = 0, timer = null;

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

    function startPolling() {
        stopPolling();
        const tick = async () => {
            if (!token) return;
            try {
                const r = await post('/api/poll', { token, since });
                if (r.expired) { stopPolling(); return; }
                if (r.now) since = r.now;
                (r.events || []).forEach(([n, p]) => fire(n, p));
            } catch (e) { /* koneksi putus sementara, coba lagi */ }
            if (token) timer = setTimeout(tick, document.hidden ? 8000 : 2000);
        };
        timer = setTimeout(tick, 2000);
    }
    function stopPolling() { if (timer) clearTimeout(timer); timer = null; }

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
