export type StampExt = 'png' | 'jpg' | 'jpeg';

export interface Stamp {
  id: string;
  name: string;
  ext: StampExt;
  /** ISO timestamp. */
  addedAt: string;
}

/** Normalized rectangle on a PDF page (each value in [0, 1]). */
export interface NormRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ApplyStampInput {
  filePath: string;
  pageIndex: number;
  stampId: string;
  rect: NormRect;
  /** Required when the PDF is password-protected; used by the main process
   * to decrypt for editing and re-encrypt the modified bytes with the same
   * password so protection is preserved. */
  password?: string;
}

export interface ApplyStampResult {
  applied: boolean;
}
