import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { NodePdfError } from '~shared/types/errors.js';
import type {
  Certificate,
  GenerateCertInput,
  ImportCertInput,
} from '~shared/types/certs.js';

import {
  certMetadata,
  generateSelfSignedP12,
  parseP12,
} from './crypto.js';

const INDEX_FILE = 'index.json';

export function certsRoot(): string {
  return path.join(app.getPath('userData'), 'certs');
}

export function p12Path(id: string): string {
  return path.join(certsRoot(), `${id}.p12`);
}

async function ensureRoot(): Promise<void> {
  await fs.mkdir(certsRoot(), { recursive: true });
}

async function readIndex(): Promise<Certificate[]> {
  await ensureRoot();
  const file = path.join(certsRoot(), INDEX_FILE);
  try {
    const raw = await fs.readFile(file, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((c): c is Certificate =>
      typeof c === 'object' &&
      c !== null &&
      typeof (c as Certificate).id === 'string' &&
      typeof (c as Certificate).label === 'string' &&
      typeof (c as Certificate).subjectCN === 'string' &&
      typeof (c as Certificate).issuerCN === 'string' &&
      typeof (c as Certificate).fingerprint === 'string' &&
      typeof (c as Certificate).serialNumber === 'string' &&
      typeof (c as Certificate).validFrom === 'string' &&
      typeof (c as Certificate).validTo === 'string' &&
      typeof (c as Certificate).isSelfSigned === 'boolean' &&
      typeof (c as Certificate).createdAt === 'string',
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function writeIndex(certs: Certificate[]): Promise<void> {
  await ensureRoot();
  const file = path.join(certsRoot(), INDEX_FILE);
  await fs.writeFile(file, JSON.stringify(certs, null, 2), 'utf-8');
}

export async function listCertificates(): Promise<Certificate[]> {
  return readIndex();
}

export async function generateCertificate(
  input: GenerateCertInput,
): Promise<Certificate> {
  if (!input.password || input.password.length < 4) {
    throw new NodePdfError(
      'VALIDATION_ERROR',
      'Cert password must be at least 4 characters',
    );
  }

  const { p12Der, cert } = generateSelfSignedP12(input);
  const id = randomUUID();
  await ensureRoot();
  // Restrict permissions on the .p12 — even though it's encrypted, there's
  // no reason for other users on the machine to read it.
  await fs.writeFile(p12Path(id), Buffer.from(p12Der), { mode: 0o600 });

  const meta = certMetadata(
    cert,
    id,
    input.label?.trim() || input.commonName.trim(),
    true,
  );
  const record: Certificate = {
    ...meta,
    createdAt: new Date().toISOString(),
  };
  const index = await readIndex();
  index.push(record);
  await writeIndex(index);
  return record;
}

export async function importCertificate(
  input: ImportCertInput,
): Promise<Certificate> {
  if (!input.password) {
    throw new NodePdfError('VALIDATION_ERROR', 'PKCS#12 password is required');
  }

  let p12Bytes: Buffer;
  try {
    p12Bytes = await fs.readFile(input.filePath);
  } catch (err) {
    throw new NodePdfError(
      'READ_FAILED',
      `Failed to read PKCS#12 file: ${input.filePath}`,
      err,
    );
  }

  // Validate the password is correct + extract cert metadata. We store the
  // .p12 verbatim — the user keeps the original password.
  const { cert } = parseP12(new Uint8Array(p12Bytes), input.password);
  const id = randomUUID();
  await ensureRoot();
  await fs.writeFile(p12Path(id), p12Bytes, { mode: 0o600 });

  const issuerCN = cert.issuer.attributes.find((a) => a.shortName === 'CN');
  const subjectCN = cert.subject.attributes.find((a) => a.shortName === 'CN');
  const subjectValue =
    typeof subjectCN?.value === 'string' ? subjectCN.value : '(unnamed)';
  const isSelfSigned =
    (typeof issuerCN?.value === 'string' ? issuerCN.value : '') === subjectValue;

  const meta = certMetadata(
    cert,
    id,
    input.label?.trim() || subjectValue,
    isSelfSigned,
  );
  const record: Certificate = {
    ...meta,
    createdAt: new Date().toISOString(),
  };
  const index = await readIndex();
  index.push(record);
  await writeIndex(index);
  return record;
}

export async function removeCertificate(id: string): Promise<void> {
  const index = await readIndex();
  const cert = index.find((c) => c.id === id);
  if (!cert) return;
  try {
    await fs.unlink(p12Path(id));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  await writeIndex(index.filter((c) => c.id !== id));
}

/** Load the raw PKCS#12 bytes for a stored certificate. The caller decrypts
 * with the user-supplied password. */
export async function readCertP12(id: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(p12Path(id));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}
