// Attend que le Postgres de DATABASE_URL (apps/backend/.env.dev) accepte les connexions.
// Une vraie requête, pas un simple test de port : le relais localhost de WSL accepte le TCP avant que Postgres soit prêt.
import { readFileSync } from 'node:fs';
import pg from 'pg';

const TIMEOUT_MS = 90_000;

let url;
try {
  const env = readFileSync(new URL('../apps/backend/.env.dev', import.meta.url), 'utf8');
  url = /^DATABASE_URL=(\S+)/m.exec(env)?.[1];
} catch {
  console.error('apps/backend/.env.dev manquant : cp apps/backend/.env.dev.example apps/backend/.env.dev');
  process.exit(1);
}
if (!url) {
  console.error('DATABASE_URL absent de apps/backend/.env.dev');
  process.exit(1);
}
const { host, port } = new URL(url);

const tryOnce = async () => {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2000 });
  client.on('error', () => {});
  try {
    await client.connect();
    await client.query('select 1');
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
};

const start = Date.now();
console.log(`waiting for Postgres on ${host}…`);
while (!(await tryOnce())) {
  if (Date.now() - start > TIMEOUT_MS) {
    console.error(`Postgres not reachable on ${host} after ${TIMEOUT_MS / 1000}s`);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 1000));
}
console.log(`Postgres ready (${Math.round((Date.now() - start) / 1000)}s)`);
