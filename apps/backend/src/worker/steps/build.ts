import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_DOCKERIGNORE, DetectError, detect, renderDockerfile } from '../../build/detect.js';
import { fsSource } from '../../build/sources.js';
import type { Ctx } from '../../context.js';
import type { ProjectRow } from '../../db/schema.js';
import { CommandError, runCommand } from '../../utils/command.js';
import { StepError } from '../errors.js';
import type { DeploymentLogger } from '../logger.js';

export const GENERATED_DOCKERFILE = 'Dockerfile.catalyst';

/**
 * Dockerfile à utiliser : celui du repo s'il existe, sinon un Dockerfile généré
 * d'après la stack détectée (Node, Python, Go, site statique…).
 */
async function resolveDockerfile(project: ProjectRow, dir: string, logger: DeploymentLogger): Promise<string> {
  const cfg = project.config;
  const own = join(dir, cfg.dockerfile);
  if (existsSync(own)) return own;

  const context = join(dir, cfg.context);
  let detection;
  try {
    detection = await detect(fsSource(context), { build_command: cfg.build_command, start_command: cfg.start_command });
  } catch (err) {
    if (err instanceof DetectError) throw new StepError(`no Dockerfile (${cfg.dockerfile}) and ${err.message}`);
    throw err;
  }

  const content = renderDockerfile(detection, { port: cfg.port, buildArgKeys: Object.keys(cfg.build_args) });
  const generated = join(context, GENERATED_DOCKERFILE);
  writeFileSync(generated, content);
  if (!existsSync(join(context, '.dockerignore'))) writeFileSync(join(context, '.dockerignore'), DEFAULT_DOCKERIGNORE);

  logger.system(`ℹ no Dockerfile: detected stack → ${detection.label}`);
  if (detection.forcedPort && detection.forcedPort !== cfg.port) {
    logger.system(
      `⚠ the start command forces port ${detection.forcedPort}, but the project is set to ${cfg.port}: ` +
        `the healthcheck will fail. Set the project port to ${detection.forcedPort} (Settings), or remove -p / --port to use $PORT`,
    );
  } else if (detection.port !== cfg.port && detection.stack !== 'static' && !detection.stack.endsWith('-static')) {
    logger.system(`ℹ the app will receive PORT=${cfg.port} (this stack usually uses ${detection.port})`);
  }
  for (const note of detection.notes) logger.system(`⚠ ${note}`);
  logger.system('— generated Dockerfile —');
  for (const line of content.trimEnd().split('\n')) logger.push('stdout', line);
  return generated;
}

/** `docker build` taggé par SHA, logs streamés ligne par ligne (plan §10.2). */
export async function buildImage(
  ctx: Ctx,
  project: ProjectRow,
  sha: string,
  tag: string,
  dir: string,
  logger: DeploymentLogger,
  signal: AbortSignal,
): Promise<void> {
  const cfg = project.config;
  const context = join(dir, cfg.context);
  if (!existsSync(context)) throw new StepError(`build context not found: ${cfg.context}`);
  const dockerfile = await resolveDockerfile(project, dir, logger);

  const args = [
    'build',
    '--progress=plain',
    '-f',
    dockerfile,
    '-t',
    tag,
    '--label',
    `catalyst.project=${project.slug}`,
    '--label',
    `catalyst.sha=${sha}`,
  ];
  for (const [key, value] of Object.entries(cfg.build_args)) args.push('--build-arg', `${key}=${value}`);
  args.push(context);

  try {
    await runCommand('docker', args, {
      // BUILDX_GIT_INFO=0 : buildx n'essaie pas de lire l'historique git (clone partiel, sans identifiants).
      env: { ...process.env, DOCKER_BUILDKIT: '1', BUILDX_GIT_INFO: '0' },
      signal,
      timeoutMs: ctx.env.BUILD_TIMEOUT_SECONDS * 1000,
      label: 'docker build',
      onLine: (stream, line) => logger.push(stream, line),
    });
  } catch (err) {
    if (signal.aborted) throw err;
    throw new StepError(err instanceof CommandError ? `build failed (${err.message})` : (err as Error).message);
  }
}
