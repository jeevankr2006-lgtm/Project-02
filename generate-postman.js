'use strict';
// Builds postman/SynapseGate.postman_collection.json from the route registry,
// so the collection always matches the code.  Run: npm run postman
const fs = require('node:fs');
const path = require('node:path');
const { buildRegistry } = require('../src/routes');

const KEY_VAR = { viewer: '{{viewerKey}}', agent: '{{agentKey}}', admin: '{{adminKey}}' };

const items = buildRegistry().map((e) => {
  const header = [];
  if (e.roles !== 'public') header.push({ key: 'x-api-key', value: KEY_VAR[e.roles[0]] });
  for (const [k, v] of Object.entries(e.exampleHeaders || {})) header.push({ key: k, value: v });
  const request = {
    method: e.method,
    header,
    url: {
      raw: `{{baseUrl}}/api/v1${e.examplePath || e.path}${e.exampleQuery || ''}`,
      host: ['{{baseUrl}}'],
      path: ['api', 'v1', ...(e.examplePath || e.path).split('/').filter(Boolean)],
    },
  };
  if (e.exampleQuery) {
    request.url.query = e.exampleQuery.slice(1).split('&').map((p) => {
      const [key, value] = p.split('=');
      return { key, value };
    });
  }
  if (e.exampleBody) {
    request.header.push({ key: 'Content-Type', value: 'application/json' });
    request.body = { mode: 'raw', raw: JSON.stringify(e.exampleBody, null, 2), options: { raw: { language: 'json' } } };
  }
  return { name: `${e.method} ${e.path}  (${e.roles === 'public' ? 'public' : e.roles[0] + '+'})`, request };
});

const collection = {
  info: {
    name: 'SynapseGate API',
    description: 'Generated from the route registry. Set the collection variables, then run the requests in order.',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: [
    { key: 'baseUrl', value: 'http://localhost:3000' },
    { key: 'viewerKey', value: 'viewer-key-123' },
    { key: 'agentKey', value: 'agent-key-123' },
    { key: 'adminKey', value: 'admin-key-123' },
  ],
  item: items,
};

const out = path.join(__dirname, '..', 'postman', 'SynapseGate.postman_collection.json');
fs.writeFileSync(out, JSON.stringify(collection, null, 2) + '\n');
console.log(`Wrote ${items.length} requests to ${path.relative(process.cwd(), out)}`);
