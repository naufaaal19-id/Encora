'use strict';
const { authorizeChannel } = require('../lib/encora');

// Dipanggil pusher-js saat subscribe ke channel private.
module.exports = (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    let body = req.body;
    if (typeof body === 'string') body = Object.fromEntries(new URLSearchParams(body));
    body = body || {};
    res.setHeader('Cache-Control', 'no-store');
    const auth = authorizeChannel(body.token, body.socket_id, body.channel_name);
    if (!auth) return res.status(403).json({ error: 'Forbidden' });
    res.status(200).json(auth);
};
