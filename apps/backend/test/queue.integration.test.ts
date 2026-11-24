/**
 * Tests d'intégration de la file (plan §19) sur un vrai PostgreSQL.
 * Lancer avec : TEST_DATABASE_URL=postgres://... npm test
 * (base dédiée : elle est vidée à chaque exécution).
 */
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, migrate, tx, type Db } from '../src/db/client.js';
import { claimJob, recoverOrphans } from '../src/queue/claim.js';
import { enqueueDeployment, enqueueIfNewSha } from '../src/queue/enqueue.js';

const url = process.env.TEST_DATABASE_URL;
const sha = (c: string) => c.repeat(40);

describe.skipIf(!url)('file de jobs (PostgreSQL)', () => {
  let db: Db;
  let projectA: number;
  let projectB: number;

  beforeAll(async () => {
    db = createPool(url!);
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db, pino({ level: 'silent' }));
  });

  afterAll(async () => {
    await db?.end();
  });

  beforeEach(async () => {
    await db.query('TRUNCATE build_logs, jobs, deployments, projects RESTART IDENTITY CASCADE');
    const insert = (slug: string) =>
      db.query<{ id: number }>(
        `INSERT INTO projects (slug, repo, branch, config) VALUES ($1, $2, 'main', '{}') RETURNING id`,
        [slug, `k/${slug}`],
      );
    projectA = (await insert('a')).rows[0]!.id;
    projectB = (await insert('b')).rows[0]!.id;
  });

  it("un nouveau commit annule les déploiements en attente du même projet", async () => {
    await enqueueIfNewSha(db, projectA, { sha: sha('1') }, 'webhook');
    await enqueueIfNewSha(db, projectA, { sha: sha('2') }, 'webhook');
    const last = await enqueueIfNewSha(db, projectA, { sha: sha('3') }, 'webhook');

    const { rows } = await db.query('SELECT id, sha, status FROM deployments ORDER BY id');
    expect(rows.map((r) => r.status)).toEqual(['superseded', 'superseded', 'queued']);
    const pending = await db.query(`SELECT deployment_id FROM jobs WHERE state = 'pending'`);
    expect(pending.rows).toEqual([{ deployment_id: last }]);
  });

  it("webhook et poll ne créent pas de doublon pour le même SHA", async () => {
    expect(await enqueueIfNewSha(db, projectA, { sha: sha('1') }, 'webhook')).not.toBeNull();
    expect(await enqueueIfNewSha(db, projectA, { sha: sha('1') }, 'poll')).toBeNull();
    const { rows } = await db.query('SELECT count(*)::int AS n FROM deployments');
    expect(rows[0].n).toBe(1);
  });

  it('un seul job running par projet, plusieurs projets en parallèle', async () => {
    await enqueueIfNewSha(db, projectA, { sha: sha('1') }, 'webhook');
    await enqueueIfNewSha(db, projectB, { sha: sha('2') }, 'webhook');
    const j1 = await claimJob(db);
    // Nouveau commit pour A pendant que son build tourne : il attend.
    await enqueueIfNewSha(db, projectA, { sha: sha('3') }, 'webhook');
    const j2 = await claimJob(db);
    const j3 = await claimJob(db);

    expect(j1?.project_id).toBe(projectA);
    expect(j2?.project_id).toBe(projectB);
    expect(j3).toBeNull();
    // Le build en cours de A a reçu une demande d'annulation.
    const { rows } = await db.query('SELECT cancel_requested FROM jobs WHERE id = $1', [j1!.id]);
    expect(rows[0].cancel_requested).toBe('superseded');
  });

  it('SKIP LOCKED : deux workers simultanés ne prennent jamais le même job', async () => {
    for (let i = 0; i < 6; i++) {
      const p = (
        await db.query<{ id: number }>(
          `INSERT INTO projects (slug, repo, branch, config) VALUES ($1, $2, 'main', '{}') RETURNING id`,
          [`p${i}`, `k/p${i}`],
        )
      ).rows[0]!.id;
      await tx(db, (c) => enqueueDeployment(c, { projectId: p, sha: sha(String(i)), trigger: 'manual' }));
    }
    const claimed = await Promise.all(Array.from({ length: 10 }, () => claimJob(db)));
    const ids = claimed.filter((j) => j !== null).map((j) => j!.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(6);
  });

  it('un déploiement interrompu reprend une fois, puis passe en échec', async () => {
    await enqueueIfNewSha(db, projectA, { sha: sha('1') }, 'webhook');
    const job = await claimJob(db);
    await db.query(`UPDATE deployments SET status = 'building' WHERE id = $1`, [job!.deployment_id]);

    // 1re interruption : remis en file, avec une trace dans les logs.
    expect(await recoverOrphans(db, 0)).toEqual({ resumed: 1, failed: 0 });
    let dep = (await db.query('SELECT status FROM deployments WHERE id = $1', [job!.deployment_id])).rows[0];
    expect(dep.status).toBe('queued');
    const log = await db.query(`SELECT line FROM build_logs WHERE deployment_id = $1`, [job!.deployment_id]);
    expect(log.rows[0].line).toContain('resuming automatically');

    // 2e interruption du même déploiement : on abandonne.
    const again = await claimJob(db);
    expect(again?.id).toBe(job!.id);
    expect(again?.attempts).toBe(2);
    expect(await recoverOrphans(db, 0)).toEqual({ resumed: 0, failed: 1 });
    dep = (await db.query('SELECT status, error FROM deployments WHERE id = $1', [job!.deployment_id])).rows[0];
    expect(dep.status).toBe('failed');
    expect(dep.error).toContain('interrupted twice');

    // Le projet est de nouveau libre.
    await enqueueIfNewSha(db, projectA, { sha: sha('2') }, 'webhook');
    expect(await claimJob(db)).not.toBeNull();
  });

  it('pas de reprise si un commit plus récent est déjà en file', async () => {
    await enqueueIfNewSha(db, projectA, { sha: sha('1') }, 'webhook');
    const job = await claimJob(db);
    await db.query(`UPDATE deployments SET status = 'building' WHERE id = $1`, [job!.deployment_id]);
    // Nouveau commit pendant le build (le job en cours reçoit une demande d'annulation).
    await enqueueIfNewSha(db, projectA, { sha: sha('2') }, 'webhook');
    expect(await recoverOrphans(db, 0)).toEqual({ resumed: 0, failed: 1 });
    const next = await claimJob(db);
    expect(next?.deployment_id).not.toBe(job!.deployment_id);
  });
});
