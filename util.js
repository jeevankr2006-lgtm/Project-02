'use strict';
const crypto = require('node:crypto');

const clone = (v) => (v === undefined ? v : structuredClone(v));
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const iso = (ms) => new Date(ms).toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// Normalised text used for duplicate detection: lower case, single spaces.
const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();

module.exports = { clone, sha256, iso, sleep, isPlainObject, norm };
