import { pino } from 'pino';
import { createPool, migrate } from './client.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL manquant');
  process.exit(1);
}
const db = createPool(url);
try {
  await migrate(db, pino());
} finally {
  await db.end();
}
