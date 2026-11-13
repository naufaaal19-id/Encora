// Encora - server LOKAL (untuk tes di komputer). Di Vercel, file ini tidak dipakai:
// Vercel menjalankan api/emit.js dan api/poll.js langsung.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') });

const express = require('express');
const app = express();
const PORT = Number(process.env.PORT) || 5000;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'frontend')));
app.post('/api/emit', require('../api/emit'));
app.post('/api/poll', require('../api/poll'));
app.get('/favicon.ico', (req, res) => res.status(204).end());

app.listen(PORT, '0.0.0.0', () => console.log(`Encora berjalan di http://localhost:${PORT}`));
