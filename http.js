'use strict';

// Reads the request body. Anything above `limit` bytes is discarded (drained,
// not stored) and reported as tooLarge so the Gatekeeper can answer 400.
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
      } else if (!tooLarge) {
        chunks.push(chunk);
      }
    });
    req.on('end', () => resolve({ raw: tooLarge ? null : Buffer.concat(chunks).toString('utf8'), tooLarge }));
    req.on('error', reject);
  });
}

module.exports = { readBody };
