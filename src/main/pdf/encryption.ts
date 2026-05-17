import type { PdfPermissions } from '~shared/types/ipc.js';

/** Map our user-friendly permission flags to the shape pdf-lib's `encrypt`
 * expects. We grant the unspecified-but-related capabilities by default
 * (e.g. content accessibility is always on so screen readers work). */
export function toPdfLibPermissions(
  p: PdfPermissions | undefined,
): Record<string, unknown> {
  const all = !p; // undefined → grant everything
  return {
    printing: all || p?.printing ? 'highResolution' : false,
    modifying: all || (p?.modifying ?? false),
    copying: all || (p?.copying ?? false),
    annotating: all || (p?.annotating ?? false),
    fillingForms: all || (p?.modifying ?? false),
    documentAssembly: all || (p?.modifying ?? false),
    contentAccessibility: true,
  };
}

/** Narrow structural type for the encrypt-capable PDFDocument. pdf-lib's
 * public types don't expose `encrypt` directly, so we cast through this. */
export interface PdfDocumentLike {
  encrypt: (opts: {
    userPassword: string;
    ownerPassword: string;
    permissions?: Record<string, unknown>;
  }) => void;
}
