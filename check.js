'use strict';
// npm run check
// Calls every part of the running API and prints pass / fail for each step.
// Start the server first (npm start), then run this in a second terminal.
const SelfCheck = require('../public/selfcheck.js');

const origin = process.env.BASE || `http://localhost:${process.env.PORT || 3000}`;
const keys = {
  viewer: process.env.VIEWER_KEY || 'viewer-key-123',
  agent: process.env.AGENT_KEY || 'agent-key-123',
  admin: process.env.ADMIN_KEY || 'admin-key-123',
};
const ICON = { pass: '\u2713', fail: '\u2717', skipped: '-' };

(async () => {
  console.log(`SynapseGate self-check against ${origin}/api/v1\n`);
  try {
    await fetch(`${origin}/api/v1/health`);
  } catch (e) {
    console.error(`Could not reach the server at ${origin}.`);
    console.error('Start it first with:  npm start   (then run this again in a second terminal)');
    process.exit(2);
  }
  const summary = await SelfCheck.run({
    base: `${origin}/api/v1`,
    keys,
    onStep: (r) => {
      console.log(`  ${ICON[r.status]} ${r.name}${r.detail ? `  [${r.detail}]` : ''}  (${r.ms} ms)`);
    },
  });
  console.log(`\n${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped`);
  if (summary.failed > 0) {
    console.log('\nSome checks failed. If every step fails with 401, your API keys differ from the defaults:');
    console.log('set VIEWER_KEY, AGENT_KEY and ADMIN_KEY to the same values the server was started with.');
    process.exit(1);
  }
})();
