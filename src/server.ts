import { createApp } from './app';
import { env } from './config/env';
import { ensureInitialStoreBootstrap } from './lib/bootstrap';
import { prisma } from './lib/prisma';

const app = createApp();
let server: ReturnType<typeof app.listen> | undefined;

async function start() {
  await ensureInitialStoreBootstrap();
  server = app.listen(env.port, () => {
    console.log(`Zamora Liquor API listening on port ${env.port} (${env.nodeEnv})`);
  });
}

start().catch(async (err) => {
  console.error('Failed to start Zamora Liquor API:', err);
  await prisma.$disconnect();
  process.exit(1);
});

async function shutdown() {
  if (!server) {
    await prisma.$disconnect();
    process.exit(0);
    return;
  }
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

