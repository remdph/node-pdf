import { protocol } from 'electron';
import fs from 'node:fs/promises';

import { listSignatures, signaturePath } from './storage.js';

export const SIGNATURE_SCHEME = 'signature';

/** Privilege descriptor — see stamps/protocol.ts for why all schemes must
 * be registered in a single `registerSchemesAsPrivileged` call. */
export const SIGNATURE_SCHEME_PRIVILEGES = {
  scheme: SIGNATURE_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    bypassCSP: false,
    stream: false,
  },
} as const;

/** Must be called after `app.whenReady()`. */
export function registerSignatureProtocol(): void {
  protocol.handle(SIGNATURE_SCHEME, async (req) => {
    const url = new URL(req.url);
    const id = url.hostname;
    if (!id) return new Response('missing id', { status: 400 });

    const signatures = await listSignatures();
    const signature = signatures.find((s) => s.id === id);
    if (!signature) return new Response('not found', { status: 404 });

    try {
      const bytes = await fs.readFile(signaturePath(signature.id, signature.ext));
      const mime = signature.ext === 'png' ? 'image/png' : 'image/jpeg';
      return new Response(bytes, {
        status: 200,
        headers: { 'Content-Type': mime, 'Cache-Control': 'no-cache' },
      });
    } catch {
      return new Response('read failed', { status: 500 });
    }
  });
}
