// Postgres de dev embarqué (binaire natif via embedded-postgres) : ni Docker ni WSL.
// Données dans apps/backend/.catalyst/pg ; identifiants et port lus dans DATABASE_URL (apps/backend/.env.dev).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

const envFile = fileURLToPath(new URL('../apps/backend/.env.dev', import.meta.url));
const databaseDir = fileURLToPath(new URL('../apps/backend/.catalyst/pg', import.meta.url));

if (!existsSync(envFile)) {
  console.error('apps/backend/.env.dev manquant : cp apps/backend/.env.dev.example apps/backend/.env.dev');
  process.exit(1);
}
const raw = /^DATABASE_URL=(\S+)/m.exec(readFileSync(envFile, 'utf8'))?.[1];
if (!raw) {
  console.error('DATABASE_URL absent de apps/backend/.env.dev');
  process.exit(1);
}
const url = new URL(raw);
const database = url.pathname.slice(1);

const port = Number(url.port || 5432);
const keepAlive = () => setInterval(() => {}, 1 << 30); // reste au premier plan pour concurrently

// Un Postgres répond déjà (session précédente mal arrêtée, ou base à soi) : on le réutilise.
const probe = new pg.Client({ connectionString: raw, connectionTimeoutMillis: 2000 });
probe.on('error', () => {});
if (await probe.connect().then(() => true, () => false)) {
  await probe.end().catch(() => {});
  console.log(`Postgres already running on localhost:${port}/${database}, reusing it`);
  keepAlive();
} else {
  await start();
}

/** Restes d'une session tuée brutalement (process enfants orphelins qui bloquent la mémoire partagée). */
function killStale() {
  const bin = fileURLToPath(new URL('../node_modules/@embedded-postgres/', import.meta.url)).replaceAll('\\', '/');
  if (process.platform === 'win32') {
    const filter = `$_.CommandLine -and $_.CommandLine.Replace('\\','/') -like '*${bin}*'`;
    spawnSync('powershell', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='postgres.exe'" | Where-Object { ${filter} } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
    ], { stdio: 'ignore' });
  } else {
    spawnSync('pkill', ['-f', `${bin}.*/postgres`], { stdio: 'ignore' });
  }
}

async function start() {
  killStale();
  const logs = [];
  const server = new EmbeddedPostgres({
    databaseDir,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    port,
    persistent: true,
    onLog: (line) => logs.push(String(line).trimEnd()),
    onError: (line) => logs.push(String(line).trimEnd()),
  });
  try {
    if (!existsSync(`${databaseDir}/PG_VERSION`)) await server.initialise();
    await server.start();
  } catch (err) {
    console.error(`Postgres failed to start${err ? `: ${err.message ?? err}` : ''}`);
    console.error(logs.slice(-20).join('\n'));
    process.exit(1);
  }
  await server.createDatabase(database).catch(() => {}); // existe déjà
  console.log(`Postgres ready on localhost:${port}/${database}`);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await server.stop().catch(() => {});
    process.exit(0);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => void stop());
  keepAlive();
}
