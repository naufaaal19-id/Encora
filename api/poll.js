'use strict';
const { handlePoll } = require('../lib/encora');

module.exports = async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    body = body || {};
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(await handlePoll(body.token, body.since));
};
