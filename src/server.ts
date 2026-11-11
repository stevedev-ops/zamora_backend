import { createApp } from './app';
import { env } from './config/env';
import { prisma } from './lib/prisma';

const app = createApp();

const server = app.listen(env.port, () => {
  console.log(`Zamora Liquor API running on http://localhost:${env.port} (${env.nodeEnv})`);
});

async function shutdown() {
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

