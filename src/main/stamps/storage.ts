import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { NodePdfError } from '~shared/types/errors.js';
import type { Stamp, StampExt } from '~shared/types/stamps.js';

const INDEX_FILE = 'index.json';

export function stampsRoot(): string {
  return path.join(app.getPath('userData'), 'stamps');
}

export function stampPath(id: string, ext: StampExt): string {
  return path.join(stampsRoot(), `${id}.${ext}`);
}

async function ensureRoot(): Promise<void> {
  await fs.mkdir(stampsRoot(), { recursive: true });
}

async function readIndex(): Promise<Stamp[]> {
  await ensureRoot();
  const file = path.join(stampsRoot(), INDEX_FILE);
  try {
    const raw = await fs.readFile(file, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is Stamp =>
      typeof s === 'object' &&
      s !== null &&
      typeof (s as Stamp).id === 'string' &&
      typeof (s as Stamp).name === 'string' &&
      ['png', 'jpg', 'jpeg'].includes((s as Stamp).ext) &&
      typeof (s as Stamp).addedAt === 'string',
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function writeIndex(stamps: Stamp[]): Promise<void> {
  await ensureRoot();
  const file = path.join(stampsRoot(), INDEX_FILE);
  await fs.writeFile(file, JSON.stringify(stamps, null, 2), 'utf-8');
}

export async function listStamps(): Promise<Stamp[]> {
  return readIndex();
}

export async function addStampFromFile(srcPath: string): Promise<Stamp> {
  const lower = srcPath.toLowerCase();
  let ext: StampExt;
  if (lower.endsWith('.png')) ext = 'png';
  else if (lower.endsWith('.jpg')) ext = 'jpg';
  else if (lower.endsWith('.jpeg')) ext = 'jpeg';
  else {
    throw new NodePdfError('VALIDATION_ERROR', 'Stamp must be PNG, JPG or JPEG');
  }

  let bytes: Buffer;
  try {
    bytes = await fs.readFile(srcPath);
  } catch (err) {
    throw new NodePdfError('READ_FAILED', `Failed to read image: ${srcPath}`, err);
  }

  const id = randomUUID();
  await ensureRoot();
  await fs.writeFile(stampPath(id, ext), bytes);

  const stamp: Stamp = {
    id,
    name: path.basename(srcPath, path.extname(srcPath)),
    ext,
    addedAt: new Date().toISOString(),
  };

  const index = await readIndex();
  index.push(stamp);
  await writeIndex(index);

  return stamp;
}

export async function removeStamp(id: string): Promise<void> {
  const index = await readIndex();
  const stamp = index.find((s) => s.id === id);
  if (!stamp) return;

  try {
    await fs.unlink(stampPath(stamp.id, stamp.ext));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  await writeIndex(index.filter((s) => s.id !== id));
}

export async function findStamp(id: string): Promise<{ stamp: Stamp; bytes: Buffer } | null> {
  const index = await readIndex();
  const stamp = index.find((s) => s.id === id);
  if (!stamp) return null;
  const bytes = await fs.readFile(stampPath(stamp.id, stamp.ext));
  return { stamp, bytes };
}
