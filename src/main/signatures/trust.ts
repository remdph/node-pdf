import forge from 'node-forge';

// Vite inlines the .pem as a string at build time so we don't need to ship
// it as a runtime resource. ~250 KB of root certs — Mozilla's curated list,
// distributed by curl.se. Refreshing it is a manual operation:
//   curl -sL -o src/main/signatures/ca-bundle.pem https://curl.se/ca/cacert.pem
import bundlePem from './ca-bundle.pem?raw';

/**
 * Build a CA store once per process from the Mozilla root bundle. Parsing
 * 100+ certs is expensive (~80-150 ms on a modern laptop), so we lazy-load
 * on the first verifyChain call and cache forever.
 *
 * NOTE: this bundle reflects MOZILLA'S trust decisions, not the host OS'.
 * Enterprise-managed root CAs (corp PKI, custom roots) that a user added to
 * their Windows / macOS / Linux trust store will NOT be honored here. That
 * gap requires native bindings per platform (Fase 5+).
 */
let cachedStore: forge.pki.CAStore | null = null;
function caStore(): forge.pki.CAStore {
  if (cachedStore) return cachedStore;
  // Split on BEGIN markers and feed each block to forge separately so a
  // single malformed entry doesn't tank the whole bundle.
  const pems: string[] = [];
  const re = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(bundlePem)) !== null) {
    pems.push(match[0]);
  }
  const store = forge.pki.createCaStore();
  for (const pem of pems) {
    try {
      store.addCertificate(forge.pki.certificateFromPem(pem));
    } catch {
      // Skip unparseable entries silently — Mozilla occasionally ships
      // experimental encodings forge doesn't grok.
    }
  }
  cachedStore = store;
  return store;
}

export type TrustResult =
  /** Chain verified against a Mozilla-trusted root. */
  | { status: 'trusted'; rootCN: string | null }
  /** Subject == issuer on the signer cert — no third party vouches for it. */
  | { status: 'self-signed' }
  /** Signer cert exists but its chain couldn't be verified against any
   * trusted root (issuer unknown to Mozilla, or chain is broken). */
  | { status: 'untrusted' }
  /** Couldn't even attempt verification (parse failure / no certs). */
  | { status: 'unknown' };

/** Assemble a chain from a leaf cert + a pool of certs (intermediates, plus
 * potentially the root and unrelated certs from the CMS bag). We walk up
 * from the leaf, picking at each step the cert whose subject DN matches the
 * current issuer DN. Stops when we hit a self-signed cert or run out. */
function buildChain(
  leaf: forge.pki.Certificate,
  pool: forge.pki.Certificate[],
): forge.pki.Certificate[] {
  const chain: forge.pki.Certificate[] = [leaf];
  let current = leaf;
  // Cap depth to avoid pathological loops in malformed bags.
  for (let depth = 0; depth < 16; depth++) {
    // Self-signed leaf has nothing above; we're done.
    if (current.subject.hash === current.issuer.hash) break;
    const next = pool.find(
      (c) => c !== current && c.subject.hash === current.issuer.hash,
    );
    if (!next) break;
    chain.push(next);
    current = next;
  }
  return chain;
}

function getCN(attrs: forge.pki.CertificateField[]): string | null {
  const cn = attrs.find((a) => a.shortName === 'CN');
  if (cn && typeof cn.value === 'string') return cn.value;
  const first = attrs[0];
  return first && typeof first.value === 'string' ? first.value : null;
}

/**
 * Verify a signer cert (with optional intermediates from the CMS) against
 * the bundled Mozilla root store. Returns a structured verdict — never
 * throws; caller treats failures as `untrusted` / `unknown`.
 */
export function verifyTrustChain(
  signerCert: forge.pki.Certificate,
  bagCerts: forge.pki.Certificate[],
): TrustResult {
  // Self-signed shortcut: subject DN == issuer DN. forge exposes the
  // pre-computed DN hash for O(1) comparison.
  if (signerCert.subject.hash === signerCert.issuer.hash) {
    return { status: 'self-signed' };
  }

  let store: forge.pki.CAStore;
  try {
    store = caStore();
  } catch {
    return { status: 'unknown' };
  }

  const chain = buildChain(signerCert, bagCerts);

  try {
    // forge's verifyCertificateChain throws on failure with a tagged error
    // object. The success case returns true. Either way we wrap it.
    forge.pki.verifyCertificateChain(store, chain);
    // The root we trusted is the issuer of the last cert in the chain.
    const top = chain[chain.length - 1]!;
    const rootInStore = store.getIssuer(top);
    return {
      status: 'trusted',
      rootCN: rootInStore ? getCN(rootInStore.subject.attributes) : null,
    };
  } catch {
    return { status: 'untrusted' };
  }
}
