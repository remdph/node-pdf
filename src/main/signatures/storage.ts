import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { NodePdfError } from '~shared/types/errors.js';
import type {
  Signature,
  SignatureExt,
  SignatureKind,
} from '~shared/types/signatures.js';

const INDEX_FILE = 'index.json';

export function signaturesRoot(): string {
  return path.join(app.getPath('userData'), 'signatures');
}

export function signaturePath(id: string, ext: SignatureExt): string {
  return path.join(signaturesRoot(), `${id}.${ext}`);
}

async function ensureRoot(): Promise<void> {
  await fs.mkdir(signaturesRoot(), { recursive: true });
}

async function readIndex(): Promise<Signature[]> {
  await ensureRoot();
  const file = path.join(signaturesRoot(), INDEX_FILE);
  try {
    const raw = await fs.readFile(file, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is Signature =>
      typeof s === 'object' &&
      s !== null &&
      typeof (s as Signature).id === 'string' &&
      typeof (s as Signature).label === 'string' &&
      ['drawn', 'typed', 'image'].includes((s as Signature).kind) &&
      ['png', 'jpg', 'jpeg'].includes((s as Signature).ext) &&
      typeof (s as Signature).createdAt === 'string',
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function writeIndex(signatures: Signature[]): Promise<void> {
  await ensureRoot();
  const file = path.join(signaturesRoot(), INDEX_FILE);
  await fs.writeFile(file, JSON.stringify(signatures, null, 2), 'utf-8');
}

export async function listSignatures(): Promise<Signature[]> {
  return readIndex();
}

/** Create from raw PNG bytes (canvas output for drawn/typed signatures). */
export async function addSignatureFromBytes(
  kind: 'drawn' | 'typed',
  label: string,
  bytes: Uint8Array,
): Promise<Signature> {
  if (bytes.length === 0) {
    throw new NodePdfError('VALIDATION_ERROR', 'Signature image is empty');
  }
  // Canvas-generated signatures are always PNG (we use toBlob('image/png')).
  // Sanity-check the first 8 bytes match the PNG magic so we don't silently
  // store junk if the renderer is bypassed.
  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!Buffer.from(bytes.slice(0, 8)).equals(PNG_MAGIC)) {
    throw new NodePdfError('VALIDATION_ERROR', 'Signature bytes are not a PNG');
  }

  const id = randomUUID();
  await ensureRoot();
  await fs.writeFile(signaturePath(id, 'png'), Buffer.from(bytes));

  const signature: Signature = {
    id,
    kind,
    label: label.trim() || (kind === 'drawn' ? 'Drawn signature' : 'Typed signature'),
    ext: 'png',
    createdAt: new Date().toISOString(),
  };

  const index = await readIndex();
  index.push(signature);
  await writeIndex(index);

  return signature;
}

/** Create from a file on disk (image import path). */
export async function addSignatureFromFile(srcPath: string): Promise<Signature> {
  const lower = srcPath.toLowerCase();
  let ext: SignatureExt;
  if (lower.endsWith('.png')) ext = 'png';
  else if (lower.endsWith('.jpg')) ext = 'jpg';
  else if (lower.endsWith('.jpeg')) ext = 'jpeg';
  else {
    throw new NodePdfError('VALIDATION_ERROR', 'Signature must be PNG, JPG or JPEG');
  }

  let bytes: Buffer;
  try {
    bytes = await fs.readFile(srcPath);
  } catch (err) {
    throw new NodePdfError('READ_FAILED', `Failed to read image: ${srcPath}`, err);
  }

  const id = randomUUID();
  await ensureRoot();
  await fs.writeFile(signaturePath(id, ext), bytes);

  const signature: Signature = {
    id,
    kind: 'image' satisfies SignatureKind,
    label: path.basename(srcPath, path.extname(srcPath)),
    ext,
    createdAt: new Date().toISOString(),
  };

  const index = await readIndex();
  index.push(signature);
  await writeIndex(index);

  return signature;
}

export async function removeSignature(id: string): Promise<void> {
  const index = await readIndex();
  const signature = index.find((s) => s.id === id);
  if (!signature) return;

  try {
    await fs.unlink(signaturePath(signature.id, signature.ext));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  await writeIndex(index.filter((s) => s.id !== id));
}

export async function findSignature(
  id: string,
): Promise<{ signature: Signature; bytes: Buffer } | null> {
  const index = await readIndex();
  const signature = index.find((s) => s.id === id);
  if (!signature) return null;
  const bytes = await fs.readFile(signaturePath(signature.id, signature.ext));
  return { signature, bytes };
}
