'use strict';
// Encora - frontend (HTML + CSS + JavaScript vanilla + Socket.IO client)
const socket = io();

// ==========================================
// KONSTANTA & STATE
// ==========================================
const START_BIT = '0', END_BIT = '1', FRAME_LEN = 10; // 1 start + 7 data + 1 parity + 1 end
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

let myUserId = '', myUserName = '', activeChatUserId = '';
let contacts = [];          // { id, name, unread }
let messages = [];          // { key, id, ref, sender_id, sender_name, receiver_id, bits, time, opened, pending }
let onlineUserIds = new Set();
let pendingOpen = null;     // pesan yang menunggu verifikasi kunci
let confirmAction = null;   // aksi untuk dialog konfirmasi hapus

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const initial = (name) => esc((name || '?').charAt(0).toUpperCase());
const fmtTime = (iso) => (iso ? new Date(iso) : new Date()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// ==========================================
// 1. ENCODING: TEKS -> BINER -> NRZ-L
// ==========================================
function buildFrames(str) {
    return Array.from(str).map((ch) => {
        const code = ch.charCodeAt(0) & 0x7F;
        const data = code.toString(2).padStart(7, '0');
        const parity = ((data.match(/1/g) || []).length % 2 === 0) ? '0' : '1'; // even parity
        return { ch, code, data, parity, bits: START_BIT + data + parity + END_BIT };
    });
}
const textToCombinedBinaryString = (str) => buildFrames(str).map((f) => f.bits).join('');
// NRZ-L: level sinyal langsung mengikuti bit (1 = High, 0 = Low)
const nrzlEncode = (bits) => [...bits].map((b) => (b === '1' ? 1 : 0));

// ==========================================
// 2. VALIDASI & DECODING: NRZ-L -> BINER -> TEKS
// ==========================================
function validateBitString(bits) {
    if (!bits) return 'Data kosong.';
    if (!/^[01]+$/.test(bits)) return 'Data mengandung karakter selain 0 dan 1.';
    if (bits.length % FRAME_LEN !== 0) return `Jumlah bit (${bits.length}) bukan kelipatan ${FRAME_LEN}.`;
    for (let i = 0; i < bits.length; i += FRAME_LEN) {
        const frame = bits.slice(i, i + FRAME_LEN), no = i / FRAME_LEN + 1;
        if (frame[0] !== START_BIT) return `Frame ke-${no}: bit start harus 0 (ditemukan ${frame[0]}).`;
        if (frame[FRAME_LEN - 1] !== END_BIT) return `Frame ke-${no}: bit end harus 1 (ditemukan ${frame[FRAME_LEN - 1]}).`;
        const ones = (frame.slice(1, 8).match(/1/g) || []).length;
        if (String(ones % 2) !== frame[8]) return `Frame ke-${no}: parity salah.`;
    }
    return null;
}
function nrzlDecode(levels) {
    if (!levels || !levels.length) throw new Error('Data kosong.');
    const bitString = levels.map((l) => (l === 1 ? '1' : '0')).join('');
    const err = validateBitString(bitString);
    if (err) throw new Error(err);
    return bitString.match(new RegExp(`.{${FRAME_LEN}}`, 'g'))
        .map((f) => String.fromCharCode(parseInt(f.slice(1, 8), 2))).join('');
}

// ==========================================
// 3. UI UMUM: toast, dialog, tampilan
// ==========================================
function toast(text) {
    const t = $('#toast');
    t.textContent = text; t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.hidden = true; }, 2800);
}
const setView = (v) => { $('#mainApp').dataset.v = v; };
function openDlg(id) {
    closeDlgs();
    const d = $(id); d.hidden = false;
    const f = d.querySelector('input');
    if (f) setTimeout(() => f.focus(), 0);
}
const closeDlgs = () => $$('.scrim').forEach((d) => { d.hidden = true; });
function askConfirm(title, text, fn) {
    $('#delTitle').textContent = title;
    $('#delText').textContent = text;
    confirmAction = fn;
    openDlg('#delDlg');
}
$$('[data-close]').forEach((b) => b.addEventListener('click', closeDlgs));
$$('.scrim').forEach((s) => s.addEventListener('click', (e) => { if (e.target === s) closeDlgs(); }));
$('#delOk').addEventListener('click', () => { const f = confirmAction; confirmAction = null; closeDlgs(); if (f) f(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeDlgs(); $('#menu').hidden = true; } });

// ==========================================
// 4. AUTENTIKASI (LOGIN & REGISTER)
// ==========================================
const loginForm = $('#loginForm'), registerForm = $('#registerForm');
function showForm(which) {
    loginForm.hidden = which !== 'login';
    registerForm.hidden = which !== 'register';
}
$('#toRegisterBtn').addEventListener('click', () => { $('#regErr').textContent = ''; showForm('register'); });
$('#toLoginBtn').addEventListener('click', () => { $('#loginNote').hidden = true; showForm('login'); });

loginForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const rawEmail = $('#loginEmailInput').value.trim();
    const rawPassword = $('#loginPasswordInput').value;
    if (!rawEmail || !rawPassword) { $('#loginErr').textContent = 'Isi email dan password.'; return; }
    if (!socket.connected) { $('#loginErr').textContent = 'Belum terhubung ke server. Coba lagi sebentar.'; return; }
    $('#loginErr').textContent = '';
    socket.emit('login_account', {
        email: textToCombinedBinaryString(rawEmail),
        password: textToCombinedBinaryString(rawPassword)
    });
});

registerForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const user_name = $('#regNameInput').value.trim();
    const user_id = $('#regUserIdInput').value.trim();
    const rawEmail = $('#regEmailInput').value.trim();
    const rawKey = $('#regKeyInput').value;
    const rawPassword = $('#regPasswordInput').value;
    const confirm = $('#regPasswordConfirmInput').value;
    let m = '';
    if (!user_name || !user_id || !rawEmail || !rawKey || !rawPassword || !confirm) m = 'Lengkapi semua kolom.';
    else if (!/^[A-Za-z0-9_]{3,30}$/.test(user_id)) m = 'ID unik hanya boleh huruf, angka, dan garis bawah (3 sampai 30 karakter).';
    else if (!/^[\x00-\x7F]+$/.test(rawEmail + rawKey + rawPassword)) m = 'Email, kunci, dan password hanya boleh berisi karakter ASCII.';
    else if (rawKey.length < 4) m = 'Kunci buka pesan minimal 4 karakter.';
    else if (rawPassword !== confirm) m = 'Ulangi password belum sama dengan password.';
    else if (!socket.connected) m = 'Belum terhubung ke server. Coba lagi sebentar.';
    $('#regErr').textContent = m;
    if (m) return;
    socket.emit('register_account', {
        user_id, user_name,
        email: textToCombinedBinaryString(rawEmail),
        password: textToCombinedBinaryString(rawPassword),
        access_key: textToCombinedBinaryString(rawKey)
    });
});

socket.on('auth_response', (data) => {
    if (data.status === 'error') {
        (registerForm.hidden ? $('#loginErr') : $('#regErr')).textContent = data.message;
        return;
    }
    if (data.action === 'register') {
        const email = $('#regEmailInput').value.trim();
        registerForm.reset();
        $('#loginEmailInput').value = email;
        $('#loginPasswordInput').value = '';
        $('#loginNote').hidden = false;
        showForm('login');
        $('#loginPasswordInput').focus();
    } else if (data.action === 'login') {
        startSession(data);
    }
});

function startSession(data) {
    myUserId = data.user_id;
    myUserName = data.user_name;
    activeChatUserId = '';
    contacts = [];
    messages = [];
    (data.history || []).forEach((h) => {
        const mine = h.sender_id === myUserId;
        const partnerId = mine ? h.receiver_id : h.sender_id;
        addContact(partnerId, (mine ? h.receiver_name : h.sender_name) || partnerId.split('_')[0]);
        messages.push({
            key: 'h' + h.id, id: h.id, sender_id: h.sender_id, sender_name: h.sender_name,
            receiver_id: h.receiver_id, bits: String(h.message || ''), time: fmtTime(h.created_at), opened: null
        });
    });

    $('#loginScreen').hidden = true;
    $('#mainApp').hidden = false;
    $('#myName').textContent = myUserName;
    $('#myAvatar').textContent = myUserName.charAt(0).toUpperCase();
    $('#myIdDisplay').textContent = myUserId;
    $('#searchInput').value = '';
    setView('list');
    onlineUserIds.add(myUserId);
    socket.emit('register_online_user', myUserId);
    socket.emit('get_online_users');
    renderContacts();
    renderChat();
}

function logout() {
    socket.disconnect();   // server menandai pengguna offline
    socket.connect();      // siap untuk login berikutnya
    myUserId = ''; myUserName = ''; activeChatUserId = '';
    contacts = []; messages = []; pendingOpen = null;
    onlineUserIds.clear();
    closeDlgs();
    $('#menu').hidden = true;
    $('#mainApp').hidden = true;
    $('#loginScreen').hidden = false;
    $('#loginPasswordInput').value = '';
    $('#loginErr').textContent = '';
    $('#loginNote').hidden = true;
    showForm('login');
}

// ==========================================
// 5. STATUS ONLINE
// ==========================================
socket.on('online_users_list', (users) => {
    onlineUserIds = new Set(users);
    if (myUserId) onlineUserIds.add(myUserId);
    renderContacts();
    updateHeader();
});
socket.on('user_status_change', ({ userId, status }) => {
    if (status === 'online') onlineUserIds.add(userId); else onlineUserIds.delete(userId);
    renderContacts();
    updateHeader();
});
function updateHeader() {
    const c = contacts.find((x) => x.id === activeChatUserId);
    if (!c) return;
    $('#chatAvatar').textContent = c.name.charAt(0).toUpperCase();
    $('#chatName').textContent = `${c.name} (${c.id})`;
    $('#chatStatus').textContent = onlineUserIds.has(c.id) ? 'online' : 'offline';
}

// ==========================================
// 6. KONTAK
// ==========================================
function addContact(id, name) {
    let c = contacts.find((x) => x.id === id);
    if (!c) { c = { id, name: cap(String(name || id.split('_')[0])), unread: 0 }; contacts.push(c); }
    return c;
}
function convMessages(id) {
    return messages.filter((m) => (m.sender_id === myUserId && m.receiver_id === id) || (m.sender_id === id && m.receiver_id === myUserId));
}
function renderContacts() {
    const q = $('#searchInput').value.trim().toLowerCase();
    const lastIdx = (id) => { for (let i = messages.length - 1; i >= 0; i--) { const m = messages[i]; if (m.sender_id === id || m.receiver_id === id) return i; } return -1; };
    const sorted = [...contacts].sort((a, b) => lastIdx(b.id) - lastIdx(a.id));
    const list = sorted.filter((c) => !q || c.name.toLowerCase().includes(q) || c.id.includes(q));
    $('#contactList').innerHTML = list.map((c) => {
        const last = convMessages(c.id).slice(-1)[0];
        const right = c.unread && c.id !== activeChatUserId ? `<span class="badge">${c.unread}</span>` : (last ? `<span class="t">${esc(last.time)}</span>` : '');
        return `<button type="button" class="row${c.id === activeChatUserId ? ' on' : ''}" data-id="${esc(c.id)}"><span class="av">${initial(c.name)}${onlineUserIds.has(c.id) ? '<span class="dot"></span>' : ''}</span><strong>${esc(c.name)}</strong>${right}</button>`;
    }).join('');
    const none = $('#contactNone');
    none.textContent = contacts.length ? (list.length ? '' : 'Tidak ada kontak yang cocok.') : 'Belum ada kontak. Tekan tombol + untuk menambah teman lewat ID.';
    none.hidden = !none.textContent;
}
function selectContact(id) {
    activeChatUserId = id;
    const c = contacts.find((x) => x.id === id);
    if (c) c.unread = 0;
    setView('chat');
    updateHeader();
    renderContacts();
    renderChat();
    if (innerWidth > 760) $('#messageInput').focus();
}
$('#contactList').addEventListener('click', (e) => {
    const b = e.target.closest('.row');
    if (b) selectContact(b.dataset.id);
});
$('#searchInput').addEventListener('input', renderContacts);
$('#backBtn').addEventListener('click', () => setView('list'));

$('#addContactBtn').addEventListener('click', () => { $('#addInput').value = ''; $('#addErr').textContent = ''; openDlg('#addDlg'); });
$('#addForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const id = $('#addInput').value.trim().toLowerCase();
    let m = '';
    if (!id) m = 'Masukkan ID teman dulu.';
    else if (id === myUserId) m = 'Kamu tidak bisa menambahkan ID diri sendiri.';
    else if (!/^[a-z0-9_]{3,30}$/.test(id)) m = 'Format ID belum benar.';
    $('#addErr').textContent = m;
    if (m) return;
    addContact(id);
    closeDlgs();
    selectContact(id);
});

// ==========================================
// 7. MENU: GANTI KUNCI & KELUAR
// ==========================================
$('#menuBtn').addEventListener('click', () => {
    const m = $('#menu'); m.hidden = !m.hidden;
    $('#menuBtn').setAttribute('aria-expanded', String(!m.hidden));
});
document.addEventListener('click', (e) => { if (!e.target.closest('#menu, #menuBtn')) $('#menu').hidden = true; });
$('#logoutBtn').addEventListener('click', logout);
$('#changeKeyBtn').addEventListener('click', () => {
    $('#menu').hidden = true;
    $('#oldKeyInput').value = ''; $('#newKeyInput').value = ''; $('#chgErr').textContent = '';
    openDlg('#chgDlg');
});
$('#chgForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const o = $('#oldKeyInput').value, n = $('#newKeyInput').value;
    let m = '';
    if (!o) m = 'Isi kunci lama.';
    else if (n.length < 4) m = 'Kunci baru minimal 4 karakter.';
    else if (n === o) m = 'Kunci baru harus beda dari kunci lama.';
    else if (!/^[\x00-\x7F]+$/.test(n)) m = 'Kunci hanya boleh berisi karakter ASCII.';
    $('#chgErr').textContent = m;
    if (m) return;
    socket.emit('change_key', { old_key: textToCombinedBinaryString(o), new_key: textToCombinedBinaryString(n) });
});
socket.on('key_changed', (d) => {
    if (d.ok) { closeDlgs(); toast('Kunci berhasil diganti.'); }
    else $('#chgErr').textContent = d.message || 'Kunci gagal diganti.';
});

// ==========================================
// 8. KIRIM & TERIMA PESAN
// ==========================================
$('#messageForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('#messageInput').value;
    if (!text.trim()) return;
    if (!activeChatUserId) { toast('Pilih kontak penerima dulu.'); return; }
    if (!/^[\x00-\x7F]+$/.test(text)) { toast('Pesan hanya boleh berisi karakter ASCII, tanpa emoji atau huruf khusus.'); return; }
    const bits = textToCombinedBinaryString(text);
    const time = fmtTime();
    const ref = Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    messages.push({ key: ref, id: null, ref, sender_id: myUserId, sender_name: myUserName, receiver_id: activeChatUserId, bits, time, opened: null, pending: true });
    socket.emit('send_message', { sender_id: myUserId, sender_name: myUserName, receiver_id: activeChatUserId, message: bits, time, ref });
    $('#messageInput').value = '';
    renderContacts();
    renderChat();
});
socket.on('message_saved', ({ ref, id }) => {          // server memberi id pesan yang tersimpan
    const m = messages.find((x) => x.ref === ref);
    if (m) { m.id = id; m.pending = false; }
});
socket.on('receive_message', (d) => {
    if (d.sender_id === myUserId || d.receiver_id !== myUserId) return;
    const c = addContact(d.sender_id, d.sender_name);
    messages.push({ key: 'r' + (d.id || Date.now()), id: d.id || null, sender_id: d.sender_id, sender_name: d.sender_name, receiver_id: d.receiver_id, bits: String(d.message || ''), time: d.time || fmtTime(), opened: null });
    if (d.sender_id !== activeChatUserId) c.unread += 1;
    renderContacts();
    if (d.sender_id === activeChatUserId) renderChat();
});
socket.on('message_error', (d) => {
    const i = messages.findIndex((m) => m.pending);     // buang pesan yang gagal terkirim
    if (i >= 0) messages.splice(i, 1);
    toast(d.message || 'Pesan gagal dikirim.');
    renderContacts();
    renderChat();
});

// ==========================================
// 9. BUKA PESAN DENGAN KUNCI
// ==========================================
$('#keyForm').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!pendingOpen) return;
    $('#keyErr').textContent = '';
    socket.emit('verify_key', { key: textToCombinedBinaryString($('#keyInput').value), owner_id: myUserId });
});
socket.on('key_response', (d) => {
    if ($('#keyDlg').hidden || !pendingOpen) return;
    if (!d.ok) { $('#keyErr').textContent = d.message || 'Kunci salah, pesan tidak bisa dibuka.'; return; }
    const m = pendingOpen;
    try {
        m.opened = nrzlDecode(nrzlEncode(m.bits));     // validasi start, end, parity lalu decode
    } catch (err) {
        $('#keyErr').textContent = 'Pesan tidak valid: ' + err.message;
        return;
    }
    pendingOpen = null;
    closeDlgs();
    renderChat(true);
});

// ==========================================
// 10. HAPUS PESAN & CHAT (tersimpan di server, hanya untuk akun sendiri)
// ==========================================
function removeMessages(list) {
    const ids = list.map((m) => m.id).filter((id) => id != null);
    if (ids.length) socket.emit('delete_messages', { ids });
    const keys = new Set(list.map((m) => m.key));
    messages = messages.filter((m) => !keys.has(m.key));
}
$('#delChatBtn').addEventListener('click', () => {
    const c = contacts.find((x) => x.id === activeChatUserId);
    if (!c) return;
    askConfirm(`Hapus chat dengan ${c.name}?`, 'Semua pesan di percakapan ini hilang dari tampilanmu. Teman tetap bisa melihatnya.', () => {
        removeMessages(convMessages(c.id));
        contacts = contacts.filter((x) => x.id !== c.id);
        activeChatUserId = '';
        setView('list');
        renderContacts();
        renderChat();
        toast('Chat dihapus.');
    });
});

// ==========================================
// 11. RENDER BUBBLE CHAT & SINYAL NRZ-L
// ==========================================
const lockSvg = '<svg class="i" style="width:16px;height:16px" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
let waveSeq = 0;

// Gelombang NRZ-L + sekat tiap 10 bit (1 frame). Sekat dan keterangan "N frame" selalu sama.
function wave(bits, w = 11) {
    let d = '', prev = null, dv = '';
    [...bits].forEach((c, i) => {
        const y = c === '1' ? 10 : 54;
        d += (i === 0 ? 'M0 ' + y : (y !== prev ? 'V' + y : '')) + 'H' + (i + 1) * w;
        prev = y;
    });
    const W = bits.length * w, id = 'cp' + (++waveSeq);
    for (let k = 0; k <= bits.length / FRAME_LEN; k++) dv += 'M' + k * FRAME_LEN * w + ' 0V64';
    return `<svg viewBox="-4 0 ${W + 8} 64" width="${W + 8}" height="64" data-w="${W}" aria-hidden="true" fill="none" stroke-linejoin="round" stroke-linecap="round">` +
        `<defs><clipPath id="${id}"><rect x="-60" y="0" width="52" height="64"/></clipPath></defs>` +
        `<path d="${dv}" stroke="currentColor" stroke-width="1.5" stroke-dasharray="3 4" opacity=".45"/>` +
        `<path class="bs" d="${d}" stroke="currentColor" stroke-width="3.5"/>` +
        `<path class="tr" d="${d}" clip-path="url(#${id})" stroke="currentColor" stroke-width="6.5"/></svg>`;
}

function renderChat(keepScroll) {
    const has = !!activeChatUserId;
    $('#blank').hidden = has;
    $('#chatView').hidden = !has;
    if (!has) return;
    updateHeader();
    const box = $('#messages'), prevScroll = box.scrollTop;
    const list = convMessages(activeChatUserId);
    const c = contacts.find((x) => x.id === activeChatUserId);
    box.innerHTML = list.length ? list.map((m) => {
        const mine = m.sender_id === myUserId, frames = m.bits.length / FRAME_LEN;
        const body = m.opened != null
            ? `<div class="txt">${esc(m.opened)}</div><div class="meta" style="margin-top:4px">Terbuka dengan kunci kamu</div><button class="key" type="button" data-act="lock" data-key="${esc(m.key)}">Kunci lagi</button>`
            : `<div class="meta lk">${lockSvg}Pesan ter-encode, ${frames} frame, ${m.bits.length} bit</div><div class="sig" data-key="${esc(m.key)}">${wave(m.bits)}</div><button class="key" type="button" data-act="open" data-key="${esc(m.key)}">Masukkan kunci</button>`;
        const del = m.pending ? '' : `<button class="del" type="button" data-act="del" data-key="${esc(m.key)}" aria-label="Hapus pesan">Hapus</button> `;
        return `<div class="grp${mine ? ' me' : ''}"><div class="bub${mine ? ' me' : ''}">${body}<span class="meta tm">${del}${esc(m.time)}</span></div><span class="av sm"${mine ? ' style="background:var(--blue)"' : ''}>${initial(mine ? myUserName : m.sender_name)}</span></div>`;
    }).join('') : `<div class="empty"><strong>Belum ada pesan dengan ${esc(c ? c.name : '')}</strong><div class="meta" style="margin-top:4px">Tulis pesan pertamamu di kolom bawah.</div></div>`;
    box.scrollTop = keepScroll ? prevScroll : box.scrollHeight;
    sigIO.disconnect(); activeSigs.clear();
    box.querySelectorAll('.sig').forEach((s) => sigIO.observe(s));
}

$('#messages').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const m = messages.find((x) => x.key === b.dataset.key);
    if (!m) return;
    if (b.dataset.act === 'open') {
        pendingOpen = m;
        $('#keyInput').value = ''; $('#keyErr').textContent = '';
        openDlg('#keyDlg');
    } else if (b.dataset.act === 'lock') {
        m.opened = null;
        renderChat(true);
    } else if (b.dataset.act === 'del') {
        askConfirm('Hapus pesan ini?', 'Pesan hanya hilang dari tampilanmu. Teman tetap bisa melihatnya.', () => {
            removeMessages([m]);
            renderContacts();
            renderChat(true);
            toast('Pesan dihapus.');
        });
    }
});

// ==========================================
// 12. ANIMASI SINYAL: sekali jalan, ikut menggeser, ulang saat tidak terlihat
// ==========================================
// Satu loop requestAnimationFrame, hanya untuk sinyal yang terlihat di layar.
const SIGNAL_SPEED = 100;   // px per detik
const SIGNAL_MIN_MS = 3500; // durasi minimum satu kali jalan
const activeSigs = new Set(), doneSigs = new Set();
let sigRaf = 0;

function resetSig(s) {
    s._t = 0; s._d = 0;
    doneSigs.delete(s.dataset.key);
    if (s._r) s._r.setAttribute('x', -60);
    s.scrollLeft = 0;
}
function sigTick(now) {
    sigRaf = 0;
    if (document.hidden) return;
    let running = false;
    activeSigs.forEach((s) => {
        if (s._d) return;
        const v = s.firstElementChild;
        if (!s._t) {
            s._t = now; s._r = v.querySelector('rect');
            if (doneSigs.has(s.dataset.key)) { s._d = 1; s._r.setAttribute('x', +v.dataset.w); return; }
        }
        const W = +v.dataset.w, T = Math.max(SIGNAL_MIN_MS, (W + 52) / SIGNAL_SPEED * 1000);
        const k = Math.min((now - s._t) / T, 1), head = k * (W + 52);
        s._r.setAttribute('x', head - 52);
        const mx = +v.getAttribute('width') - s.clientWidth;
        if (mx > 0) s.scrollLeft = Math.max(0, Math.min(mx, head - s.clientWidth / 2));
        if (k >= 1) { s._d = 1; doneSigs.add(s.dataset.key); } else running = true;
    });
    if (running) sigRaf = requestAnimationFrame(sigTick);
}
function sigGo() {
    if (!sigRaf && activeSigs.size && !document.hidden && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
        sigRaf = requestAnimationFrame(sigTick);
    }
}
const sigIO = window.IntersectionObserver
    ? new IntersectionObserver((entries) => {
        entries.forEach((en) => { if (en.isIntersecting) activeSigs.add(en.target); else { activeSigs.delete(en.target); resetSig(en.target); } });
        sigGo();
    })
    : { observe() {}, disconnect() {} };
document.addEventListener('visibilitychange', () => { if (document.hidden) activeSigs.forEach(resetSig); sigGo(); });

// Tampilan awal
showForm('login');
