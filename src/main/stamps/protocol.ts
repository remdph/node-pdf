import { protocol } from 'electron';
import fs from 'node:fs/promises';

import { stampPath, listStamps } from './storage.js';

export const STAMP_SCHEME = 'stamp';

/** Must be called before `app.whenReady()`. */
export function registerStampScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: STAMP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        bypassCSP: false,
        stream: false,
      },
    },
  ]);
}

/** Must be called after `app.whenReady()`. */
export function registerStampProtocol(): void {
  protocol.handle(STAMP_SCHEME, async (req) => {
    const url = new URL(req.url);
    const id = url.hostname;
    if (!id) return new Response('missing id', { status: 400 });

    const stamps = await listStamps();
    const stamp = stamps.find((s) => s.id === id);
    if (!stamp) return new Response('not found', { status: 404 });

    try {
      const bytes = await fs.readFile(stampPath(stamp.id, stamp.ext));
      const mime = stamp.ext === 'png' ? 'image/png' : 'image/jpeg';
      return new Response(bytes, {
        status: 200,
        headers: { 'Content-Type': mime, 'Cache-Control': 'no-cache' },
      });
    } catch {
      return new Response('read failed', { status: 500 });
    }
  });
}
