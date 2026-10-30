import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildApp } from './app.ts';
import { openDb, seed } from './db.ts';

const dbPath = process.env.DB_PATH ?? 'data/scheduler.db';
if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
const db = openDb(dbPath);
seed(db);

const app = buildApp(db, { logger: { level: process.env.LOG_LEVEL ?? 'info' } });
const port = Number(process.env.PORT ?? 3000);

await app.listen({ port, host: '0.0.0.0' });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close();
    db.close();
    process.exit(0);
  });
}
