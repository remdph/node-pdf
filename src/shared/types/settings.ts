/**
 * App-wide user settings persisted in `userData/settings.json`.
 *
 * Kept intentionally flat: each field is either a primitive or a tagged union
 * so partial updates (`settings.set({ tsaUrl })`) round-trip cleanly through
 * JSON.stringify without surprises.
 *
 * New fields MUST be added to `DEFAULT_SETTINGS` so a settings.json written
 * by an older build picks up the default on read (the loader merges what's
 * on disk over the defaults).
 */
export interface AppSettings {
  /** RFC 3161 Timestamp Authority endpoint. Used by Fase 4 (PAdES-T). */
  tsaUrl: string;
  /** Default Subject CN for self-signed certs and the displayed signer
   * label on visual eSignatures. */
  defaultSignerName: string;
  /** Optional override for the on-disk signatures directory. Mostly an
   * escape hatch for tests / portable installs. */
  signaturesDirOverride?: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  tsaUrl: 'https://freetsa.org/tsr',
  defaultSignerName: '',
};
