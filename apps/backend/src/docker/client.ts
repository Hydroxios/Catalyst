import Docker from 'dockerode';

export function createDocker(): Docker {
  // DOCKER_HOST est respecté ; sinon /var/run/docker.sock.
  return new Docker();
}

export function isNotFound(err: unknown): boolean {
  return (err as { statusCode?: number } | null)?.statusCode === 404;
}

export async function imageExists(docker: Docker, tag: string): Promise<boolean> {
  try {
    await docker.getImage(tag).inspect();
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

export async function inspectContainer(docker: Docker, name: string): Promise<Docker.ContainerInspectInfo | null> {
  try {
    return await docker.getContainer(name).inspect();
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/** Arrête (avec délai de grâce) puis supprime un conteneur. Absent = rien à faire. */
export async function removeContainer(docker: Docker, name: string, stopTimeoutSeconds = 10): Promise<void> {
  const container = docker.getContainer(name);
  try {
    await container.stop({ t: stopTimeoutSeconds });
  } catch (err) {
    // 304 : déjà arrêté ; 404 : n'existe pas.
    const code = (err as { statusCode?: number }).statusCode;
    if (code !== 304 && code !== 404) throw err;
  }
  try {
    await container.remove({ force: true });
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}

/** Démultiplexe le flux de logs Docker (conteneur sans TTY : trames de 8 octets d'en-tête). */
export function demuxDockerLogs(buf: Buffer): { stream: 'stdout' | 'stderr'; line: string }[] {
  const out: { stream: 'stdout' | 'stderr'; line: string }[] = [];
  const push = (stream: 'stdout' | 'stderr', text: string) => {
    for (const line of text.split(/\r?\n/)) if (line) out.push({ stream, line });
  };
  let offset = 0;
  const looksMultiplexed = buf.length >= 8 && buf[0]! <= 2 && buf[1] === 0 && buf[2] === 0 && buf[3] === 0;
  if (!looksMultiplexed) {
    push('stdout', buf.toString('utf8'));
    return out;
  }
  while (offset + 8 <= buf.length) {
    const type = buf[offset]!;
    const size = buf.readUInt32BE(offset + 4);
    const chunk = buf.subarray(offset + 8, offset + 8 + size).toString('utf8');
    push(type === 2 ? 'stderr' : 'stdout', chunk);
    offset += 8 + size;
  }
  return out;
}

export async function containerLogsTail(
  docker: Docker,
  name: string,
  lines = 100,
): Promise<{ stream: 'stdout' | 'stderr'; line: string }[]> {
  try {
    const buf = await docker.getContainer(name).logs({ stdout: true, stderr: true, tail: lines, follow: false });
    return demuxDockerLogs(Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf)));
  } catch {
    return [];
  }
}
