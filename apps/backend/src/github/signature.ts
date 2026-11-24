import { createHmac, timingSafeEqual } from 'node:crypto';

/** Vérifie X-Hub-Signature-256 sur le corps brut, en temps constant (plan §7.2). */
export function verifySignature(raw: Buffer, header: string | undefined, secret: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = Buffer.from('sha256=' + createHmac('sha256', secret).update(raw).digest('hex'));
  const received = Buffer.from(header);
  return expected.length === received.length && timingSafeEqual(expected, received);
}
