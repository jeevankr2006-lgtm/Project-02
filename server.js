'use strict';

// Friendly check before anything else loads (the code needs Node 18 or newer).
const major = Number(process.versions.node.split('.')[0]);
if (major < 18) {
  console.error(`SynapseGate needs Node.js 18 or newer, but you are running ${process.version}.`);
  console.error('Download the LTS version from https://nodejs.org , restart VS Code, and try again.');
  process.exit(1);
}

const { createApp } = require('./src/app');

const app = createApp();
const port = app.config.port;

app.listen(port).then((actual) => {
  console.log('SynapseGate is running');
  console.log(`  Dashboard : http://localhost:${actual}/`);
  console.log(`  API       : http://localhost:${actual}/api/v1`);
  console.log(`  Docs      : http://localhost:${actual}/api/v1/docs`);
  console.log(`  Health    : http://localhost:${actual}/api/v1/health`);
  console.log('Stop the server with Ctrl+C.');
}).catch((err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use (another copy of the server is probably still running).`);
    console.error('Stop the other one (Ctrl+C in its terminal), or start this one on a different port:');
    console.error('  Windows PowerShell:  $env:PORT=4000; npm start');
    console.error('  Mac / Linux:         PORT=4000 npm start');
  } else {
    console.error('Could not start the server:', err.message);
  }
  process.exit(1);
});

function shutdown(signal) {
  console.log(`\n${signal} received, shutting down...`);
  app.close().then(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
