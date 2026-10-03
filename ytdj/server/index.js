#!/usr/bin/env node
/** Entry point: boot the server and shut it down cleanly. */

import { createApp } from './server.js';

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? '127.0.0.1';
const server = createApp();

server.listen(port, host, () => {
  const address = server.address();
  const shown = typeof address === 'object' && address ? `${host}:${address.port}` : `${host}:${port}`;
  process.stdout.write(`ytdj listening on http://${shown}\n`);
});

let closing = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    process.stdout.write('\nshutting down\n');
    server.close(() => process.exit(0));
    // Do not wait forever on keep-alive sockets.
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
