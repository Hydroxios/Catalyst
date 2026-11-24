import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Logger } from 'pino';

export type Db = pg.Pool;
export type DbClient = pg.PoolClient;
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(connectionString: string): Db {
  return new pg.Pool({ connectionString, max: 10 });
}

export async function tx<T>(db: Db, fn: (c: DbClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));
const MIGRATION_LOCK = 7_270_001;

/** Applique les fichiers migrations/*.sql pas encore passés, dans l'ordre alphabétique. */
export async function migrate(db: Db, log: Logger): Promise<void> {
  const client = await db.connect();
  try {
    // Verrou : plusieurs process (api + worker) peuvent démarrer en même temps.
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name TEXT PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );
    const applied = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
    );
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(MIGRATIONS_DIR + file, 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        log.info({ migration: file }, 'migration applied');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
    // Les logs de build contiennent des symboles (▶ ✔ ✖) et du texte arbitraire : UTF-8 obligatoire.
    const { rows } = await client.query<{ encoding: string }>(
      'SELECT pg_encoding_to_char(encoding) AS encoding FROM pg_database WHERE datname = current_database()',
    );
    if (rows[0] && rows[0].encoding !== 'UTF8') {
      log.warn({ encoding: rows[0].encoding }, 'the database is not UTF-8: some logs cannot be stored');
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => {});
    client.release();
  }
}
