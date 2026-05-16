import fs from 'node:fs/promises';
import path from 'node:path';

import { IPC_CHANNELS } from '~shared/types/ipc.js';
import { handle } from './register.js';

/**
 * Returns the path of the cached first-page JPEG for a PDF. We store it as
 * a hidden sibling of the original PDF (e.g. `.document.pdf.thumb.jpg` next
 * to `document.pdf`). Hidden on Linux/macOS via the leading dot; on Windows
 * the file simply has the dot in its name (still valid, just not OS-hidden).
 */
function thumbPathFor(pdfPath: string): string {
  const dir = path.dirname(pdfPath);
  const base = path.basename(pdfPath);
  return path.join(dir, `.${base}.thumb.jpg`);
}

export function registerRecentsIpc(): void {
  handle<[string], Uint8Array | null>(
    IPC_CHANNELS.recents.readThumb,
    async (_event, filePath) => {
      if (typeof filePath !== 'string' || filePath.length === 0) return null;
      const thumbPath = thumbPathFor(filePath);
      try {
        const [pdfStat, thumbStat] = await Promise.all([
          fs.stat(filePath).catch(() => null),
          fs.stat(thumbPath).catch(() => null),
        ]);
        // PDF gone → no thumb worth showing.
        if (!pdfStat) return null;
        // Thumb missing → caller will fall back.
        if (!thumbStat) return null;
        // Thumb older than PDF → stale; force a fresh render in the caller.
        if (thumbStat.mtimeMs < pdfStat.mtimeMs) return null;
        const bytes = await fs.readFile(thumbPath);
        return new Uint8Array(bytes);
      } catch {
        return null;
      }
    },
  );

  handle<[{ filePath: string; bytes: Uint8Array }], void>(
    IPC_CHANNELS.recents.saveThumb,
    async (_event, input) => {
      if (!input || typeof input.filePath !== 'string' || !input.bytes) return;
      const thumbPath = thumbPathFor(input.filePath);
      try {
        // Always overwrite — the renderer's once-per-open guard already
        // ensures we don't do this multiple times per PdfView mount, and
        // we want each fresh open to refresh the thumb (so quality bumps
        // and externally-modified PDFs propagate automatically).
        await fs.writeFile(thumbPath, Buffer.from(input.bytes));
      } catch {
        // Best-effort: read-only mounts, locked files, etc. Recents will
        // simply fall back to rendering the full PDF.
      }
    },
  );
}
