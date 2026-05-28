import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Document, Outline, Page, pdfjs } from 'react-pdf';
import { Rnd } from 'react-rnd';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import type { PDFDocumentProxy } from 'pdfjs-dist';

import 'react-pdf/dist/Page/TextLayer.css';
import 'react-pdf/dist/Page/AnnotationLayer.css';

import { ipc } from '../lib/ipc.js';
import { ZOOM_DEFAULT, ZOOM_STEP, clampZoom } from '../lib/zoom.js';
import { useSignaturesStore } from '../stores/signatures.js';
import { useStampsStore } from '../stores/stamps.js';
import { useTabsStore } from '../stores/tabs.js';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

import type { FormInfo } from '~shared/types/forms.js';
import type { ProtectInput, SplitInput } from '~shared/types/ipc.js';
import type {
  ExistingSignatureInfo,
  SignDigitalInput,
} from '~shared/types/signatures.js';

import { DigitalSignDialog } from './DigitalSignDialog.js';
import { PasswordDialog } from './PasswordDialog.js';
import { PrintDialog } from './PrintDialog.js';
import { ProtectDialog } from './ProtectDialog.js';
import { SplitDialog } from './SplitDialog.js';
import { SaveFormDialog } from './SaveFormDialog.js';
import { SignaturePanel } from './SignaturePanel.js';
import { SignaturesMenu } from './SignaturesMenu.js';
import { StampsMenu } from './StampsMenu.js';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

// NOTE on PDF JavaScript: react-pdf 10.x does NOT forward
// `enableScripting` to pdf.js's AnnotationLayer (verified in
// node_modules/react-pdf/dist/Page/AnnotationLayer.js — the
// `enableScripting` parameter is absent from the renderParameters
// object passed to `new pdfjs.AnnotationLayer().render(...)`).
// Without it, PDFs with auto-calculated fields, format validators,
// or show/hide button actions render as static widgets — the user
// can fill them but live JS-driven behavior is inert. Fixing this
// requires either (a) forking react-pdf to expose enableScripting +
// the sandbox setup, or (b) replacing the annotation layer with a
// custom one that wires pdf.js's PDFScriptingManager. Both are
// substantial; deferred for a future phase.

interface PdfViewProps {
  filePath: string;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; data: Uint8Array }
  | { kind: 'error'; message: string }
  /** User cancelled the password prompt — show an inline "enter password"
   * prompt with a retry button instead of failing the tab. */
  | { kind: 'locked' };

interface Placement {
  pageIndex: number;
  rect: { x: number; y: number; w: number; h: number };
}

interface PageSize {
  w: number;
  h: number;
}

/** Default A4-ish ratio used while we haven't measured page sizes yet. */
const FALLBACK_PAGE_RATIO = 1.41;

const THUMB_WIDTH = 140;
const WHEEL_ZOOM_FACTOR = 1.1;
const STAMP_INIT_MAX_W = 300;
const STAMP_INIT_PAGE_FRACTION = 0.4;

/** Compute the initial placement rect for a stamp/signature being armed for
 * the user to drag/resize. Horizontally centered on the page; vertically
 * positioned at the center of whatever portion of the page is currently
 * visible in the scroller — so it shows up "where the user is reading"
 * rather than always at the bottom or top. */
function initialPlacementRect(
  pageEl: HTMLElement,
  scrollerEl: HTMLElement | null,
  imgW: number,
  imgH: number,
  pageFraction: number,
): { x: number; y: number; w: number; h: number } {
  const pw = pageEl.clientWidth;
  const ph = pageEl.clientHeight;
  const ratio = imgW / imgH || 1;
  const w = Math.min(STAMP_INIT_MAX_W, pw * pageFraction);
  const h = w / ratio;

  const x = Math.max(0, (pw - w) / 2);

  let y: number;
  if (scrollerEl) {
    const pageRect = pageEl.getBoundingClientRect();
    const scrollRect = scrollerEl.getBoundingClientRect();
    // Intersection of the scroller viewport with the page rect — the
    // currently-visible band of the page in screen coords.
    const visibleTop = Math.max(scrollRect.top, pageRect.top);
    const visibleBottom = Math.min(scrollRect.bottom, pageRect.bottom);
    if (visibleBottom > visibleTop) {
      const viewportCenterY = (visibleTop + visibleBottom) / 2;
      // Convert viewport-Y into page-local-Y by subtracting the page's top.
      const yInPage = viewportCenterY - pageRect.top;
      y = yInPage - h / 2;
    } else {
      // Page isn't visible at all (edge case) → fall back to vertical center.
      y = (ph - h) / 2;
    }
  } else {
    y = (ph - h) / 2;
  }
  y = Math.max(0, Math.min(ph - h, y));

  return { x, y, w, h };
}
// Short enough to feel instant, long enough to coalesce a rapid burst of
// +/-/wheel events into a single canvas re-render.
const ZOOM_RENDER_DEBOUNCE_MS = 60;
const PAGE_OVERSCAN_PX = 3000;
const THUMB_OVERSCAN_PX = 500;
// JPEG quality for stale-while-revalidate snapshots — balances size vs blur.
const SNAPSHOT_QUALITY = 0.6;
// Max pages to keep snapshots for; LRU eviction beyond this.
const SNAPSHOT_CACHE_SIZE = 50;
// Width (px) of the JPEG saved next to each PDF for the recents carousel.
// 3x of the on-screen thumbnail width (130) for sharpness on hidpi screens
// even at heavy zoom — bumped from 2x along with the quality boost.
const RECENT_THUMB_WIDTH = 390;
const RECENT_THUMB_QUALITY = 0.85;

function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

/**
 * Stale-while-revalidate snapshot cache for rendered PDF pages.
 *
 * When a page leaves the virtuoso viewport, we snapshot its canvas to a JPEG
 * blob and keep the URL here keyed by page index. When the page comes back
 * (or just re-renders in place because of zoom), the wrapper gets the snapshot
 * as a background-image: it shows immediately while pdfjs paints the new
 * canvas on top — no white flash.
 */
class SnapshotCache {
  private map = new Map<number, string>();
  constructor(private maxSize: number) {}

  get(key: number): string | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  set(key: number, url: string): void {
    const prev = this.map.get(key);
    if (prev !== undefined) {
      this.map.delete(key);
      URL.revokeObjectURL(prev);
    }
    this.map.set(key, url);
    while (this.map.size > this.maxSize) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.map.get(oldestKey);
      this.map.delete(oldestKey);
      if (oldest) URL.revokeObjectURL(oldest);
    }
  }

  clear(): void {
    for (const url of this.map.values()) URL.revokeObjectURL(url);
    this.map.clear();
  }
}

export function PdfView({ filePath }: PdfViewProps): JSX.Element {
  const sidePanel = useTabsStore((s) => s.sidePanel);
  const toggleSidePanel = useTabsStore((s) => s.toggleSidePanel);
  const thumbsOpen = sidePanel === 'thumbs';
  const outlineOpen = sidePanel === 'outline';

  // Per-tab local state — survives tab switches because the host keeps the
  // PdfView mounted (display:none on inactive tabs).
  const [zoom, setZoomState] = useState(ZOOM_DEFAULT);
  const setZoom = useCallback((z: number) => setZoomState(clampZoom(z)), []);
  const zoomIn = useCallback(
    () => setZoomState((z) => clampZoom(z * ZOOM_STEP)),
    [],
  );
  const zoomOut = useCallback(
    () => setZoomState((z) => clampZoom(z / ZOOM_STEP)),
    [],
  );
  const zoomReset = useCallback(() => setZoomState(ZOOM_DEFAULT), []);

  const selectedStampId = useStampsStore((s) => s.selectedId);
  const selectStamp = useStampsStore((s) => s.select);
  const selectedSignatureId = useSignaturesStore((s) => s.selectedId);
  const selectSignature = useSignaturesStore((s) => s.select);

  const [load, setLoad] = useState<LoadState>({ kind: 'loading' });
  const [numPages, setNumPages] = useState(0);
  const [activePage, setActivePage] = useState(1);
  const [reloadKey, setReloadKey] = useState(0);
  // AcroForm state: populated by an IPC inspection after the document
  // loads. `null` while we don't know yet; `hasForm:false` for plain PDFs.
  const [formInfo, setFormInfo] = useState<FormInfo | null>(null);
  const [formDirty, setFormDirty] = useState(false);
  const [savingForm, setSavingForm] = useState(false);
  const [saveFormDialogOpen, setSaveFormDialogOpen] = useState(false);
  // Live filled-count override that reflects in-progress edits in
  // pdf.js's annotationStorage. Falls back to `formInfo.filledCount`
  // (the disk snapshot) when null, which covers the initial paint
  // before the first poll lands.
  const [liveFilledCount, setLiveFilledCount] = useState<number | null>(null);
  // Cache the annotation-id → fieldName mapping per document load.
  // Cleared on filePath / reloadKey change so we re-walk pages after
  // the bytes change.
  const fieldNameByIdRef = useRef<Map<string, string> | null>(null);
  const [stampMenuAnchor, setStampMenuAnchor] = useState<HTMLElement | null>(null);
  const [signatureMenuAnchor, setSignatureMenuAnchor] = useState<HTMLElement | null>(null);
  // Fase 2: existing /Sig fields found in the current PDF + the side panel.
  const [existingSignatures, setExistingSignatures] = useState<ExistingSignatureInfo[]>([]);
  const [signaturesLoading, setSignaturesLoading] = useState(false);
  const [signaturePanelOpen, setSignaturePanelOpen] = useState(false);
  // Fase 3: cryptographic signing dialog state.
  const [digitalSignOpen, setDigitalSignOpen] = useState(false);
  const [digitalSigning, setDigitalSigning] = useState(false);
  // Fase 5a: when the user picks "visible appearance" in the digital-sign
  // dialog, we close the dialog and arm a placement overlay. The pending
  // signing parameters (cert + reason/etc) are stashed here until the user
  // confirms placement on the page; then applyPlacement reads them and
  // calls signDigital with the page+rect filled in. `lockForm` is bundled
  // so the user's "Lock form before signing" choice survives the
  // dialog-close → placement → apply round-trip.
  const [pendingDigitalSign, setPendingDigitalSign] = useState<
    | (Omit<SignDigitalInput, 'filePath' | 'pageIndex' | 'rect'> & {
        lockForm?: boolean;
      })
    | null
  >(null);
  // Set when the user clicks an existing empty /Sig widget. The next
  // sign through the dialog skips the drag-placement step and uses
  // this rect verbatim, since the field already declared where its
  // signature appearance should live.
  const [signTargetField, setSignTargetField] = useState<
    { pageIndex: number; rect: { x: number; y: number; w: number; h: number } } | null
  >(null);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [applying, setApplying] = useState(false);
  const [restoring, setRestoring] = useState(false);
  /** Last error from applyPlacement / signDigital. Surfaced in the action
   * bar so the user sees WHY signing failed instead of nothing happening. */
  const [placementError, setPlacementError] = useState<string | null>(null);
  const [printOpen, setPrintOpen] = useState(false);
  const [protectOpen, setProtectOpen] = useState(false);
  const [protecting, setProtecting] = useState(false);
  const [splitOpen, setSplitOpen] = useState(false);
  const [splitting, setSplitting] = useState(false);
  /** True once pdfjs has signalled the file is encrypted — used to decide
   * whether the protect dialog should ask for the current password and
   * whether to forward the password to PDF-mutating IPC calls. */
  const [isEncrypted, setIsEncrypted] = useState(false);
  /** The password the user successfully unlocked the PDF with (or set when
   * adding protection). Null when the file is plain. */
  const [unlockedPassword, setUnlockedPassword] = useState<string | null>(null);
  /** The password the unlock dialog last submitted — promoted to
   * `unlockedPassword` once `onLoadSuccess` fires (signalling the password
   * was correct). */
  const lastTriedPasswordRef = useRef<string | null>(null);
  // Pending password prompt from pdfjs while opening an encrypted PDF.
  const [unlockPrompt, setUnlockPrompt] = useState<{
    callback: (password: string) => void;
    error: boolean;
  } | null>(null);
  // Per-page dimensions in PDF user units. Populated after Document loads;
  // used to size the loading placeholders so we don't render zero-sized
  // empty boxes while pdfjs paints the canvas.
  const [pageSizes, setPageSizes] = useState<PageSize[]>([]);
  // Captured before handing the buffer to pdfjs — pdfjs transfers the
  // ArrayBuffer to its worker which detaches it, after which `byteLength`
  // becomes 0.
  const [fileSize, setFileSize] = useState<number | null>(null);
  // null = unknown (not yet loaded); true/false once pdf.getOutline() resolves.
  const [hasOutline, setHasOutline] = useState<boolean | null>(null);
  // Filepath we've already auto-opened the outline panel for. Prevents
  // re-opening the panel on every render or after the user closes it.
  const autoOpenedOutlineForRef = useRef<string | null>(null);

  // --- Search state ----------------------------------------------------
  const pdfRef = useRef<PDFDocumentProxy | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMatches, setSearchMatches] = useState<Array<{ pageIndex: number }>>([]);
  const [searchIdx, setSearchIdx] = useState(-1);
  const [searching, setSearching] = useState(false);
  /** Last query for which we have results — Enter advances when the
   * input still matches it, otherwise it triggers a fresh search. */
  const lastSearchedRef = useRef('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  // --- Page input (paginator in toolbar) ------------------------------
  const [pageInput, setPageInput] = useState('1');
  const pageInputFocusedRef = useRef(false);

  // --- Right-click context menu (over selected text) ------------------
  const [textMenu, setTextMenu] = useState<{
    x: number;
    y: number;
    text: string;
  } | null>(null);

  const stampBtnRef = useRef<HTMLButtonElement>(null);
  const signatureBtnRef = useRef<HTMLButtonElement>(null);
  const [pagesEl, setPagesEl] = useState<HTMLElement | null>(null);
  const pagesVirtuosoRef = useRef<VirtuosoHandle>(null);
  const thumbsVirtuosoRef = useRef<VirtuosoHandle>(null);
  const pageRefs = useRef<Array<HTMLDivElement | null>>([]);
  const [pageWidth, setPageWidth] = useState<number | undefined>(undefined);
  const restorePageRef = useRef<number | null>(null);
  const restoringRef = useRef(false);
  restoringRef.current = restoring;
  // Map of mounted page index → its current visibility ratio inside the
  // scroller. The IntersectionObserver below populates this and we pick the
  // page with the highest ratio as the "active" one — much more stable than
  // relying on virtuoso's topmost-visible index.
  const ratiosRef = useRef<Map<number, number>>(new Map());
  const [pageObserver, setPageObserver] = useState<IntersectionObserver | null>(null);

  // Lazy-init the snapshot cache. Lives across re-renders, cleared when the
  // user opens a different PDF or unmounts the view.
  const snapshotCacheRef = useRef<SnapshotCache | null>(null);
  if (!snapshotCacheRef.current) {
    snapshotCacheRef.current = new SnapshotCache(SNAPSHOT_CACHE_SIZE);
  }

  useEffect(() => {
    return () => snapshotCacheRef.current?.clear();
  }, [filePath]);

  const isReady = load.kind === 'ready';
  const isFit = Math.abs(zoom - ZOOM_DEFAULT) < 0.001;
  const renderedZoom = useDebouncedValue(zoom, ZOOM_RENDER_DEBOUNCE_MS);
  const effectivePageWidth =
    pageWidth !== undefined ? pageWidth * renderedZoom : undefined;

  // Load (or reload) PDF bytes from disk.
  useEffect(() => {
    let cancelled = false;
    setLoad({ kind: 'loading' });
    setNumPages(0);
    setPageSizes([]);
    setFileSize(null);
    if (restorePageRef.current === null) setActivePage(1);
    ipc.pdf
      .read(filePath)
      .then((data) => {
        if (cancelled) return;
        // Capture size BEFORE handing the buffer to pdfjs — pdfjs transfers
        // and detaches the underlying ArrayBuffer in its worker.
        setFileSize(data.byteLength);
        setLoad({ kind: 'ready', data });
      })
      .catch((err: Error) => {
        if (!cancelled) setLoad({ kind: 'error', message: err.message });
      });
    return () => {
      cancelled = true;
    };
  }, [filePath, reloadKey]);

  // Prefetch every page's viewport once the Document is parsed, so we know
  // each page's natural aspect ratio for the loading placeholder.
  const handleDocumentLoadSuccess = useCallback(async (pdf: PDFDocumentProxy) => {
    pdfRef.current = pdf;
    setNumPages(pdf.numPages);
    // Load outline upfront so we can disable the index button (or show the
    // empty-state message inside the panel) without waiting on a click.
    pdf
      .getOutline()
      .then((outline) => {
        setHasOutline(Array.isArray(outline) && outline.length > 0);
      })
      .catch(() => setHasOutline(false));
    try {
      const first = await pdf.getPage(1);
      const fv = first.getViewport({ scale: 1 });
      setPageSizes(new Array(pdf.numPages).fill({ w: fv.width, h: fv.height }));

      if (pdf.numPages > 1) {
        const all = await Promise.all(
          Array.from({ length: pdf.numPages }, (_, i) =>
            pdf.getPage(i + 1).then((p) => {
              const v = p.getViewport({ scale: 1 });
              return { w: v.width, h: v.height };
            }),
          ),
        );
        setPageSizes(all);
      }
    } catch (err) {
      console.warn('[PdfView] failed to prefetch page sizes', err);
    }
  }, []);

  // A different document was opened — abort any pending restore.
  useEffect(() => {
    restorePageRef.current = null;
    setRestoring(false);
    // Encryption state is per-file; reset when the file changes.
    setIsEncrypted(false);
    setUnlockedPassword(null);
    lastTriedPasswordRef.current = null;
    setUnlockPrompt(null);
    setHasOutline(null);
    pdfRef.current = null;
    setSearchOpen(false);
    setSearchQuery('');
    setSearchMatches([]);
    setSearchIdx(-1);
    lastSearchedRef.current = '';
    // Existing-signatures cache is per-file; clear it and let the inspect
    // effect below re-populate when the file is ready.
    setExistingSignatures([]);
    setSignaturePanelOpen(false);
    // Reset AcroForm state — the form effect re-populates on file change
    // (encryption-gated, same as the signatures effect).
    setFormInfo(null);
    setFormDirty(false);
    setLiveFilledCount(null);
    fieldNameByIdRef.current = null;
  }, [filePath]);

  // Inspect existing /Sig fields for the current document. Triggers on file
  // load and whenever the on-disk bytes change (reloadKey ticks after our
  // own write operations) so the panel reflects newly-applied signatures
  // once Fase 3 lands. Encryption-aware: we wait until we have the password
  // before inspecting an encrypted PDF so signer attributes parse cleanly.
  useEffect(() => {
    if (load.kind !== 'ready') return;
    if (isEncrypted && !unlockedPassword) return;
    let cancelled = false;
    setSignaturesLoading(true);
    ipc.signatures
      .inspect(filePath, unlockedPassword ?? undefined)
      .then((result) => {
        if (cancelled) return;
        setExistingSignatures(result.signatures);
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn('[PdfView] signatures.inspect failed', err);
        setExistingSignatures([]);
      })
      .finally(() => {
        if (!cancelled) setSignaturesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filePath, reloadKey, load.kind, isEncrypted, unlockedPassword]);

  // Inspect AcroForm fields. Same encryption gate as the signatures
  // effect — wait until we have the password before parsing. Updates
  // when the bytes change (reloadKey ticks after our writes) so the
  // "X of Y filled" count reflects the latest save.
  useEffect(() => {
    if (load.kind !== 'ready') return;
    if (isEncrypted && !unlockedPassword) return;
    let cancelled = false;
    ipc.pdf
      .getFormInfo(filePath, unlockedPassword ?? undefined)
      .then((info) => {
        if (cancelled) return;
        setFormInfo(info);
        setFormDirty(false);
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn('[PdfView] form inspection failed', err);
        setFormInfo({ hasForm: false, fieldCount: 0, filledCount: 0, fields: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [filePath, reloadKey, load.kind, isEncrypted, unlockedPassword]);

  // Poll pdf.js's annotationStorage to drive two pieces of live UI:
  //   - `formDirty`: flips true the first time any field is changed,
  //     enabling the Save button.
  //   - `liveFilledCount`: count of filled fields, recomputed from the
  //     union of the initial values (formInfo.fields) and the live
  //     storage map. Without this the status bar pill is frozen at
  //     the disk snapshot until the user actually saves.
  // pdf.js doesn't emit change events, so polling at 400ms is the
  // cheapest reliable approach. We keep polling forever once a form
  // is detected because the user can both fill AND clear fields.
  useEffect(() => {
    if (!formInfo?.hasForm) return;
    let cancelled = false;
    const fieldsByName = new Map<string, (typeof formInfo.fields)[number]>();
    for (const f of formInfo.fields) fieldsByName.set(f.name, f);

    const ensureIdToName = async (
      pdf: PDFDocumentProxy,
    ): Promise<Map<string, string>> => {
      if (fieldNameByIdRef.current) return fieldNameByIdRef.current;
      const map = new Map<string, string>();
      for (let i = 1; i <= pdf.numPages; i += 1) {
        const page = await pdf.getPage(i);
        const annotations = (await page.getAnnotations()) as Array<{
          id?: string;
          fieldName?: string;
          subtype?: string;
        }>;
        for (const ann of annotations) {
          if (ann.subtype === 'Widget' && ann.id && ann.fieldName) {
            map.set(String(ann.id), ann.fieldName);
          }
        }
      }
      fieldNameByIdRef.current = map;
      return map;
    };

    const isFilledValue = (v: unknown): boolean => {
      if (typeof v === 'string') return v.length > 0 && v !== 'Off';
      if (typeof v === 'boolean') return v;
      if (Array.isArray(v)) return v.length > 0;
      return false;
    };

    const tick = async (): Promise<void> => {
      const pdf = pdfRef.current;
      const storage = pdf?.annotationStorage;
      if (!pdf || !storage || cancelled) return;

      if (storage.size > 0 && !formDirty) setFormDirty(true);

      const idToName = await ensureIdToName(pdf);
      if (cancelled) return;
      const serial = storage.serializable;
      const storedMap = serial.map as Map<string, { value?: unknown }> | null;

      // Build a name → "live value" override from the storage edits.
      const liveByName = new Map<string, unknown>();
      if (storedMap) {
        for (const [id, entry] of storedMap) {
          const name = idToName.get(String(id));
          if (name) liveByName.set(name, entry?.value);
        }
      }

      let count = 0;
      for (const field of formInfo.fields) {
        if (field.type === 'signature') continue;
        const value = liveByName.has(field.name)
          ? liveByName.get(field.name)
          : field.value;
        if (isFilledValue(value)) count += 1;
      }
      if (!cancelled) {
        setLiveFilledCount((prev) => (prev === count ? prev : count));
      }
    };

    void tick();
    const interval = setInterval(() => void tick(), 400);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [formInfo, formDirty]);

  // Auto-open the outline panel the first time we discover a doc has one,
  // but only if the side panel is currently collapsed — never override an
  // explicit user choice (thumbs already open, or they toggled it shut).
  useEffect(() => {
    if (hasOutline !== true) return;
    if (autoOpenedOutlineForRef.current === filePath) return;
    autoOpenedOutlineForRef.current = filePath;
    if (useTabsStore.getState().sidePanel === null) {
      toggleSidePanel('outline');
    }
  }, [hasOutline, filePath, toggleSidePanel]);

  // Measure container, recompute on resize.
  useLayoutEffect(() => {
    if (!pagesEl) return;
    const update = () => {
      const max = 1100;
      setPageWidth(Math.min(max, Math.max(320, pagesEl.clientWidth * 0.8)));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(pagesEl);
    return () => ro.disconnect();
  }, [pagesEl]);

  // Build the IntersectionObserver that drives active-page detection.
  useLayoutEffect(() => {
    if (!pagesEl) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (restoringRef.current) return;
        const ratios = ratiosRef.current;
        for (const entry of entries) {
          const idx = Number((entry.target as HTMLElement).dataset.pageIndex);
          if (Number.isNaN(idx)) continue;
          if (entry.intersectionRatio > 0) {
            ratios.set(idx, entry.intersectionRatio);
          } else {
            ratios.delete(idx);
          }
        }
        if (ratios.size === 0) return;
        let bestIdx = -1;
        let bestRatio = -1;
        for (const [idx, ratio] of ratios) {
          if (ratio > bestRatio) {
            bestRatio = ratio;
            bestIdx = idx;
          }
        }
        if (bestIdx >= 0) setActivePage(bestIdx + 1);
      },
      { root: pagesEl, threshold: [0, 0.25, 0.5, 0.75, 1] },
    );
    setPageObserver(observer);
    return () => {
      observer.disconnect();
      ratiosRef.current.clear();
      setPageObserver(null);
    };
  }, [pagesEl]);

  // Delegated click handler on the pages container: when the user
  // clicks a /Sig form widget, arm the next dialog with that widget's
  // page + normalized rect so signing skips the manual placement
  // drag step. pdf.js renders signature widgets as plain divs with
  // class `signatureWidgetAnnotation`; we read their on-page
  // position from the DOM since we don't get an event from pdf.js
  // for clicks on inert widgets.
  useEffect(() => {
    const root = pagesEl;
    if (!root) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const widget = target.closest<HTMLElement>('.signatureWidgetAnnotation');
      if (!widget) return;
      const pageWrap = widget.closest<HTMLElement>('.pdf-page-wrap');
      if (!pageWrap) return;
      const pageIndexAttr = pageWrap.dataset.pageIndex;
      const pageIndex = pageIndexAttr != null ? Number(pageIndexAttr) : NaN;
      if (!Number.isInteger(pageIndex) || pageIndex < 0) return;
      // Use the .pdf-page (canvas wrapper) as the reference frame —
      // its bounding box matches the rendered page exactly, vs the
      // .pdf-page-wrap which may include extra padding.
      const pageBoxEl = pageWrap.querySelector<HTMLElement>('.pdf-page') ?? pageWrap;
      const widgetBox = widget.getBoundingClientRect();
      const pageBox = pageBoxEl.getBoundingClientRect();
      if (pageBox.width === 0 || pageBox.height === 0) return;
      const rect = {
        x: (widgetBox.left - pageBox.left) / pageBox.width,
        y: (widgetBox.top - pageBox.top) / pageBox.height,
        w: widgetBox.width / pageBox.width,
        h: widgetBox.height / pageBox.height,
      };
      e.preventDefault();
      e.stopPropagation();
      setSignTargetField({ pageIndex, rect });
      setDigitalSignOpen(true);
    };
    root.addEventListener('click', onClick);
    return () => root.removeEventListener('click', onClick);
  }, [pagesEl]);

  const file = useMemo(
    () => (load.kind === 'ready' ? { data: load.data } : null),
    [load],
  );

  const scrollToPage = useCallback((page: number) => {
    pagesVirtuosoRef.current?.scrollToIndex({
      index: page - 1,
      align: 'start',
    });
    setActivePage(page);
  }, []);

  // --- Search ----------------------------------------------------------
  /** When set, the next rebuild that finds a Range for this match index
   * will scroll it into view. Cleared once the scroll fires. */
  const pendingScrollMatchRef = useRef<number | null>(null);

  const goToMatch = useCallback(
    (next: number, matches: Array<{ pageIndex: number }>) => {
      if (matches.length === 0) return;
      const wrapped = ((next % matches.length) + matches.length) % matches.length;
      const target = matches[wrapped];
      if (!target) return;
      pendingScrollMatchRef.current = wrapped;
      setSearchIdx(wrapped);
      // Only have virtuoso jump pages if we actually need to leave the
      // current one — otherwise the rebuild's scroll-into-view will land
      // right on the new match without yanking back to page start.
      if (target.pageIndex + 1 !== activePage) {
        scrollToPage(target.pageIndex + 1);
      }
    },
    [activePage, scrollToPage],
  );

  const runSearch = useCallback(
    async (rawQuery: string) => {
      const query = rawQuery.trim();
      const pdf = pdfRef.current;
      if (!pdf || query.length === 0) {
        setSearchMatches([]);
        setSearchIdx(-1);
        lastSearchedRef.current = query;
        return;
      }
      setSearching(true);
      try {
        const lower = query.toLowerCase();
        const results: Array<{ pageIndex: number }> = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const tc = await page.getTextContent();
          const text = tc.items
            .map((it) => ('str' in it ? it.str : ''))
            .join(' ')
            .toLowerCase();
          let from = 0;
          while (true) {
            const at = text.indexOf(lower, from);
            if (at === -1) break;
            results.push({ pageIndex: i - 1 });
            from = at + lower.length;
          }
        }
        setSearchMatches(results);
        lastSearchedRef.current = query;
        if (results.length > 0) {
          goToMatch(0, results);
        } else {
          setSearchIdx(-1);
        }
      } finally {
        setSearching(false);
      }
    },
    [goToMatch],
  );

  // Build Range objects for every occurrence of `query` inside a text layer.
  // Walks all text nodes, concatenates their data so multi-span matches work,
  // then maps the substring offsets back to (textNode, offset) pairs.
  const findRangesInLayer = useCallback(
    (layer: Element, query: string): Range[] => {
      if (!query) return [];
      const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      while (walker.nextNode()) nodes.push(walker.currentNode as Text);
      if (nodes.length === 0) return [];

      let combined = '';
      const offsets: Array<{ node: Text; start: number; end: number }> = [];
      for (const n of nodes) {
        const start = combined.length;
        combined += n.data;
        offsets.push({ node: n, start, end: combined.length });
      }

      const lower = combined.toLowerCase();
      const ranges: Range[] = [];
      let from = 0;
      while (true) {
        const at = lower.indexOf(query, from);
        if (at === -1) break;
        const endAt = at + query.length;
        const startPos = offsets.find((p) => at >= p.start && at < p.end);
        const endPos = offsets.find((p) => endAt > p.start && endAt <= p.end);
        if (startPos && endPos) {
          try {
            const r = document.createRange();
            r.setStart(startPos.node, at - startPos.start);
            r.setEnd(endPos.node, endAt - endPos.start);
            ranges.push(r);
          } catch {
            // ignore — DOM may have shifted between builds
          }
        }
        from = endAt;
      }
      return ranges;
    },
    [],
  );

  // Rebuild the two CSS Highlights ('pdf-search' = all matches,
  // 'pdf-search-current' = the active one) by walking every mounted text
  // layer. Called whenever search state changes OR a new text layer renders.
  const rebuildHighlightsRef = useRef<() => void>(() => {});
  rebuildHighlightsRef.current = () => {
    if (typeof CSS === 'undefined' || !('highlights' in CSS)) return;
    const query = lastSearchedRef.current.toLowerCase();
    if (!query || searchMatches.length === 0) {
      CSS.highlights.delete('pdf-search');
      CSS.highlights.delete('pdf-search-current');
      return;
    }
    const all = new Highlight();
    const current = new Highlight();
    const target = searchIdx >= 0 ? searchMatches[searchIdx] : undefined;

    const wraps = pagesEl?.querySelectorAll<HTMLElement>('.pdf-page-wrap') ?? [];
    wraps.forEach((wrap) => {
      const pageIndex = Number(wrap.dataset.pageIndex);
      if (Number.isNaN(pageIndex)) return;
      const layer = wrap.querySelector('.react-pdf__Page__textContent');
      if (!layer) return;

      // Local index of the active match within this page (if any).
      let activeLocalIdx = -1;
      if (target && target.pageIndex === pageIndex) {
        activeLocalIdx = 0;
        for (let i = 0; i < searchIdx; i++) {
          const m = searchMatches[i];
          if (m && m.pageIndex === pageIndex) activeLocalIdx++;
        }
      }

      const ranges = findRangesInLayer(layer, query);
      ranges.forEach((r, i) => {
        all.add(r);
        if (i === activeLocalIdx) current.add(r);
      });
    });

    CSS.highlights.set('pdf-search', all);
    CSS.highlights.set('pdf-search-current', current);

    // If the user just navigated to a match, scroll its first Range into
    // view. We can't do this until the page's text layer has rendered (and
    // the Range has actual layout) — that's why this lives inside the
    // rebuild rather than next to `goToMatch`.
    if (
      pendingScrollMatchRef.current === searchIdx &&
      pagesEl &&
      current.size > 0
    ) {
      const firstRange = Array.from(current as unknown as Iterable<Range>)[0];
      if (firstRange) {
        const rect = firstRange.getBoundingClientRect();
        const cont = pagesEl.getBoundingClientRect();
        const fullyVisible =
          rect.top >= cont.top + 40 && rect.bottom <= cont.bottom - 20;
        if (!fullyVisible) {
          // Position the match ~120px below the toolbar for breathing room.
          const delta = rect.top - cont.top - 120;
          pagesEl.scrollBy({ top: delta, behavior: 'smooth' });
        }
        pendingScrollMatchRef.current = null;
      }
    }
  };

  // Re-run the rebuild whenever the result set or active match changes.
  useEffect(() => {
    rebuildHighlightsRef.current();
  }, [searchMatches, searchIdx, pagesEl]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery('');
    setSearchMatches([]);
    setSearchIdx(-1);
    lastSearchedRef.current = '';
    if (typeof CSS !== 'undefined' && 'highlights' in CSS) {
      CSS.highlights.delete('pdf-search');
      CSS.highlights.delete('pdf-search-current');
    }
  }, []);

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    // focus on next paint, after the input has mounted
    requestAnimationFrame(() => searchInputRef.current?.focus());
  }, []);

  // Debounce the thumbs auto-scroll: while the user is dragging through the
  // main viewer, activePage updates several times per second. Scrolling the
  // thumbs panel on every change mounts/unmounts thumbnail <Page> components
  // and floods the pdfjs worker, which competes with the main render. Wait
  // until the user pauses, then snap.
  const debouncedActivePageForThumbs = useDebouncedValue(activePage, 120);
  useEffect(() => {
    if (!thumbsOpen) return;
    thumbsVirtuosoRef.current?.scrollToIndex({
      index: debouncedActivePageForThumbs - 1,
      align: 'center',
    });
  }, [debouncedActivePageForThumbs, thumbsOpen]);

  // After a reload triggered by Apply, restore the previously active page.
  useLayoutEffect(() => {
    if (!isReady || numPages === 0 || restorePageRef.current === null) return;
    const target = restorePageRef.current;
    const idx = target - 1;
    if (idx < 0 || idx >= numPages) {
      restorePageRef.current = null;
      setRestoring(false);
      return;
    }
    setActivePage(target);
    let frame1 = 0;
    let frame2 = 0;
    frame1 = requestAnimationFrame(() => {
      pagesVirtuosoRef.current?.scrollToIndex({ index: idx, align: 'start' });
      frame2 = requestAnimationFrame(() => {
        restorePageRef.current = null;
        setRestoring(false);
      });
    });
    return () => {
      cancelAnimationFrame(frame1);
      cancelAnimationFrame(frame2);
    };
  }, [isReady, numPages]);

  // Keep the page input in sync with the active page, but don't clobber
  // what the user is mid-typing.
  useEffect(() => {
    if (!pageInputFocusedRef.current) {
      setPageInput(String(activePage));
    }
  }, [activePage]);

  const commitPageInput = useCallback(() => {
    const parsed = Number.parseInt(pageInput, 10);
    if (Number.isFinite(parsed) && numPages > 0) {
      const clamped = Math.min(Math.max(1, parsed), numPages);
      scrollToPage(clamped);
      setPageInput(String(clamped));
    } else {
      setPageInput(String(activePage));
    }
  }, [pageInput, numPages, scrollToPage, activePage]);

  // Right-click over selected text → custom menu with a Copy entry.
  // We only intercept when there's a non-empty selection — otherwise the
  // user gets the native menu (or nothing) for plain right-clicks.
  useEffect(() => {
    if (!pagesEl) return;
    const onContextMenu = (e: MouseEvent) => {
      const sel = window.getSelection();
      const text = sel?.toString() ?? '';
      if (text.length === 0) return;
      e.preventDefault();
      setTextMenu({ x: e.clientX, y: e.clientY, text });
    };
    pagesEl.addEventListener('contextmenu', onContextMenu);
    return () => pagesEl.removeEventListener('contextmenu', onContextMenu);
  }, [pagesEl]);

  // Dismiss the text context menu on outside click, scroll, or Escape.
  useEffect(() => {
    if (!textMenu) return;
    const dismiss = () => setTextMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss();
    };
    window.addEventListener('mousedown', dismiss);
    window.addEventListener('wheel', dismiss, { passive: true });
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', dismiss);
      window.removeEventListener('wheel', dismiss);
      window.removeEventListener('keydown', onKey);
    };
  }, [textMenu]);

  // Ctrl + wheel inside the pages container = zoom in/out. Use a ref so the
  // listener always reads the latest zoom without re-attaching.
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  useEffect(() => {
    if (!pagesEl) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? WHEEL_ZOOM_FACTOR : 1 / WHEEL_ZOOM_FACTOR;
      setZoom(zoomRef.current * factor);
    };
    pagesEl.addEventListener('wheel', onWheel, { passive: false });
    return () => pagesEl.removeEventListener('wheel', onWheel);
  }, [pagesEl, setZoom]);

  // When the user picks a stamp, anchor placement on the currently visible page.
  useEffect(() => {
    if (!selectedStampId) {
      // Only clear placement if the cause is "no stamp AND no signature";
      // otherwise the signature effect owns it.
      if (!selectedSignatureId) setPlacement(null);
      return;
    }
    // Stamps and signatures share the placement state — selecting a stamp
    // clears any armed signature so the overlay routes to the stamp.
    if (selectedSignatureId) selectSignature(null);
    const idx = activePage - 1;
    // Don't scrollToIndex any more — the user's current page IS the active
    // page by definition, and yanking the scroll position so they suddenly
    // see the top of the page is jarring. initialPlacementRect picks a Y
    // based on whatever portion of the page is currently visible.

    let cancelled = false;
    const tryInit = (attempts: number) => {
      const pageEl = pageRefs.current[idx];
      if (!pageEl || pageEl.clientWidth === 0) {
        if (attempts >= 10) {
          console.error('[PdfView] could not measure page for stamp placement');
          return;
        }
        requestAnimationFrame(() => !cancelled && tryInit(attempts + 1));
        return;
      }
      const img = new Image();
      img.onload = () => {
        if (cancelled) return;
        setPlacement({
          pageIndex: idx,
          rect: initialPlacementRect(
            pageEl,
            pagesEl,
            img.naturalWidth,
            img.naturalHeight,
            STAMP_INIT_PAGE_FRACTION,
          ),
        });
      };
      img.onerror = () => {
        if (cancelled) return;
        console.error('[PdfView] failed to load stamp image for placement');
      };
      img.src = `stamp://${selectedStampId}`;
    };
    requestAnimationFrame(() => !cancelled && tryInit(0));

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedStampId]);

  // Same flow for signatures: arms the placement overlay using the signature
  // image's intrinsic aspect ratio. Wider default (60% of page) since visual
  // signatures are typically taller-than-wide and read better when bigger.
  useEffect(() => {
    if (!selectedSignatureId) {
      if (!selectedStampId) setPlacement(null);
      return;
    }
    if (selectedStampId) selectStamp(null);
    const idx = activePage - 1;
    // Same rationale as the stamps effect — let initialPlacementRect anchor
    // to wherever the user is currently looking in the page.

    let cancelled = false;
    const tryInit = (attempts: number) => {
      const pageEl = pageRefs.current[idx];
      if (!pageEl || pageEl.clientWidth === 0) {
        if (attempts >= 10) {
          console.error('[PdfView] could not measure page for signature placement');
          return;
        }
        requestAnimationFrame(() => !cancelled && tryInit(attempts + 1));
        return;
      }
      const img = new Image();
      img.onload = () => {
        if (cancelled) return;
        setPlacement({
          pageIndex: idx,
          // Signatures default a bit smaller than stamps — typically placed
          // inline next to a printed name rather than as a page-spanning mark.
          rect: initialPlacementRect(
            pageEl,
            pagesEl,
            img.naturalWidth,
            img.naturalHeight,
            0.35,
          ),
        });
      };
      img.onerror = () => {
        if (cancelled) return;
        console.error('[PdfView] failed to load signature image for placement');
      };
      img.src = `signature://${selectedSignatureId}`;
    };
    requestAnimationFrame(() => !cancelled && tryInit(0));

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSignatureId]);

  // Generate a hidden JPEG sibling of the PDF (`.<name>.thumb.jpg`) when the
  // first page renders. The recents carousel uses it as a fast-path; without
  // it, opening the picker would re-parse every recent PDF from scratch.
  const savedThumbKeyRef = useRef<string | null>(null);
  useEffect(() => {
    savedThumbKeyRef.current = null;
  }, [filePath, reloadKey]);

  const saveRecentThumb = useCallback(
    (canvas: HTMLCanvasElement) => {
      const key = `${filePath}:${reloadKey}`;
      if (savedThumbKeyRef.current === key) return;
      if (!canvas.width || !canvas.height) return;
      savedThumbKeyRef.current = key;

      const targetW = RECENT_THUMB_WIDTH;
      const ratio = canvas.height / canvas.width;
      const targetH = Math.max(1, Math.round(targetW * ratio));
      const off = document.createElement('canvas');
      off.width = targetW;
      off.height = targetH;
      const ctx = off.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(canvas, 0, 0, targetW, targetH);

      off.toBlob(
        async (blob) => {
          if (!blob) return;
          try {
            const bytes = new Uint8Array(await blob.arrayBuffer());
            await ipc.recents.saveThumb({ filePath, bytes });
          } catch (err) {
            console.warn('[PdfView] failed to save recent thumb', err);
            savedThumbKeyRef.current = null;
          }
        },
        'image/jpeg',
        RECENT_THUMB_QUALITY,
      );
    },
    [filePath, reloadKey],
  );

  // Walk pdf.js's per-page annotation lists and build a
  //   pdfjs annotation-id  →  { fieldName, buttonValue?, options? }
  // map. Form save needs more than just the field name:
  //   - Radio buttons: pdf.js stores `{ value: true/false }` per widget,
  //     so we need the widget's `buttonValue` (the /Opt entry the radio
  //     fires when selected) to translate true → the export value
  //     pdf-lib's `field.select(...)` expects.
  //   - Listbox / dropdown: pdf.js stores the export value (the
  //     `<option value>` attribute), but pdf-lib's
  //     `PDFOptionList.select` / `PDFDropdown.select` validate
  //     against the DISPLAY values returned by `getOptions()`. For
  //     PDFs whose /Opt entries are `[exportValue, displayValue]`
  //     pairs (common in govt / Apryse sample forms) those two
  //     differ and pdf-lib throws "InvalidFieldValueError" — which
  //     surfaces as a silent skip and the selection is lost. Carry
  //     pdf.js's per-widget `options` map so the harvest step below
  //     can translate export → display before sending.
  type WidgetMeta = {
    fieldName: string;
    buttonValue?: string;
    options?: Array<{ exportValue?: string; displayValue?: string }>;
  };
  const buildWidgetMeta = useCallback(async (): Promise<Map<string, WidgetMeta>> => {
    const pdf = pdfRef.current;
    if (!pdf) return new Map();
    const map = new Map<string, WidgetMeta>();
    for (let i = 1; i <= pdf.numPages; i += 1) {
      const page = await pdf.getPage(i);
      const annotations = (await page.getAnnotations()) as Array<{
        id?: string;
        fieldName?: string;
        subtype?: string;
        buttonValue?: string;
        options?: Array<{ exportValue?: string; displayValue?: string }>;
      }>;
      for (const ann of annotations) {
        if (ann.subtype === 'Widget' && ann.id && ann.fieldName) {
          map.set(String(ann.id), {
            fieldName: ann.fieldName,
            buttonValue: ann.buttonValue,
            options: ann.options,
          });
        }
      }
    }
    return map;
  }, []);

  // Read every pending edit out of annotationStorage and translate it
  // into the `{ fieldName: value }` shape pdf-lib expects. Dispatches
  // by field type from `formInfo` so each kind gets the right
  // marshaling — without this, radios save as the literal `true`
  // (pdf.js's per-widget value) instead of the export string
  // pdf-lib needs to call `radioGroup.select(value)`.
  // Returns null when there's nothing to ship so callers early-exit.
  const harvestFormValues = useCallback(async (): Promise<
    Record<string, string | boolean | string[]> | null
  > => {
    const pdf = pdfRef.current;
    if (!pdf || !formInfo?.hasForm) return null;
    const serial = pdf.annotationStorage.serializable;
    const storedMap = serial.map as Map<string, { value?: unknown }> | null;
    if (!storedMap || storedMap.size === 0) return null;

    const meta = await buildWidgetMeta();

    // Group raw storage entries by fieldName. Radios have multiple
    // widgets per group (one per option), so collecting per-name lets
    // us pick the selected one below.
    type RawEntry = { id: string; value: unknown };
    const entriesByField = new Map<string, RawEntry[]>();
    for (const [id, entry] of storedMap) {
      const widget = meta.get(String(id));
      if (!widget) continue;
      const list = entriesByField.get(widget.fieldName) ?? [];
      list.push({ id: String(id), value: entry?.value });
      entriesByField.set(widget.fieldName, list);
    }

    const fieldByName = new Map(formInfo.fields.map((f) => [f.name, f]));
    const values: Record<string, string | boolean | string[]> = {};

    // Build an exportValue → displayValue map for any choice widget
    // in the entries. pdf-lib's `PDFOptionList.select` / `PDFDropdown
    // .select` only accept display values; pdf.js stores export
    // values. Without translating we'd lose every selection on PDFs
    // whose /Opt entries are `[exportValue, displayValue]` pairs.
    const toDisplay = (
      exportVal: string,
      options?: Array<{ exportValue?: string; displayValue?: string }>,
    ): string => {
      if (!options || options.length === 0) return exportVal;
      for (const opt of options) {
        if (opt.exportValue === exportVal) {
          return opt.displayValue ?? exportVal;
        }
      }
      return exportVal;
    };

    for (const [fieldName, entries] of entriesByField) {
      const fieldInfo = fieldByName.get(fieldName);
      const fieldType = fieldInfo?.type ?? 'unknown';

      if (fieldType === 'radio') {
        // pdf.js sets `{ value: true }` on the selected radio's widget
        // and `{ value: false }` (or omits) for the others. Find the
        // true one, look up its buttonValue, send that to pdf-lib.
        const selected = entries.find((e) => e.value === true);
        if (selected) {
          const widget = meta.get(selected.id);
          const exportValue = widget?.buttonValue;
          if (exportValue) values[fieldName] = exportValue;
        }
        continue;
      }

      if (fieldType === 'listbox') {
        const last = entries[entries.length - 1];
        const raw = last?.value;
        // Widget options come from any of the entries — they're all
        // copies of the same field's /Opt.
        const widgetOptions = last ? meta.get(last.id)?.options : undefined;
        if (Array.isArray(raw)) {
          values[fieldName] = raw.map((v) => toDisplay(String(v), widgetOptions));
        } else if (typeof raw === 'string' && raw.length > 0) {
          values[fieldName] = [toDisplay(raw, widgetOptions)];
        }
        continue;
      }

      if (fieldType === 'checkbox') {
        const last = entries[entries.length - 1];
        const raw = last?.value;
        if (typeof raw === 'boolean') values[fieldName] = raw;
        else if (typeof raw === 'string') values[fieldName] = raw.length > 0 && raw !== 'Off';
        continue;
      }

      if (fieldType === 'dropdown') {
        const last = entries[entries.length - 1];
        const raw = last?.value;
        const widgetOptions = last ? meta.get(last.id)?.options : undefined;
        if (typeof raw === 'string') {
          values[fieldName] = toDisplay(raw, widgetOptions);
        } else if (Array.isArray(raw) && raw.length > 0) {
          values[fieldName] = toDisplay(String(raw[0]), widgetOptions);
        }
        continue;
      }

      // text, unknown: take the latest entry as a primitive.
      const last = entries[entries.length - 1];
      const raw = last?.value;
      if (typeof raw === 'string' || typeof raw === 'boolean') {
        values[fieldName] = raw;
      } else if (Array.isArray(raw)) {
        if (raw.length > 0) values[fieldName] = String(raw[0]);
      } else if (raw != null) {
        values[fieldName] = String(raw);
      }
    }

    return Object.keys(values).length > 0 ? values : null;
  }, [buildWidgetMeta, formInfo]);

  // Persist pending form edits. `mode='keep'` (default) keeps the
  // form editable for future fills; `mode='flatten'` bakes the values
  // into page graphics so the form is locked. Triggers a reload so
  // the post-save snapshot becomes the new annotationStorage baseline.
  //
  // Flatten can run even when there are NO live edits — the user might
  // open a pre-filled PDF and click Save → "Lock form" to flatten the
  // existing values into the page. Keep-mode with no edits is a no-op
  // (early return) since there's nothing to persist.
  const handleSaveForm = useCallback(
    async (mode: 'keep' | 'flatten' = 'keep'): Promise<void> => {
      if (!formInfo?.hasForm) return;
      setSavingForm(true);
      try {
        const values = await harvestFormValues();
        if (!values && mode !== 'flatten') return;
        const result = await ipc.pdf.fillForm({
          filePath,
          values: values ?? {},
          mode,
          password: unlockedPassword ?? undefined,
        });
        if (result.skipped.length > 0) {
          console.warn('[PdfView] fillForm skipped fields', result.skipped);
        }
        snapshotCacheRef.current?.clear();
        restorePageRef.current = activePage;
        setRestoring(true);
        setFormDirty(false);
        setReloadKey((k) => k + 1);
      } catch (err) {
        console.error('[PdfView] fillForm failed', err);
      } finally {
        setSavingForm(false);
      }
    },
    [activePage, filePath, formInfo, harvestFormValues, unlockedPassword],
  );

  // Silently persist pending form edits before any mutation that
  // would otherwise read a stale on-disk version (stamps, visual
  // signatures, cert signatures). The mutation's own reload will
  // pick up the saved values on the next pass, so we deliberately
  // do NOT tick reloadKey here. Pass `mode: 'flatten'` to lock the
  // form before a cert signature ("Lock form fields" checkbox).
  const saveFormIfDirty = useCallback(
    async (mode: 'keep' | 'flatten' = 'keep'): Promise<void> => {
      if (!formDirty) return;
      const values = await harvestFormValues();
      if (!values) return;
      try {
        await ipc.pdf.fillForm({
          filePath,
          values,
          mode,
          password: unlockedPassword ?? undefined,
        });
        setFormDirty(false);
      } catch (err) {
        // Don't block the caller's mutation — they may still want to
        // proceed (e.g. user explicitly chose to sign anyway). Log so
        // the failure isn't invisible.
        console.error('[PdfView] auto-save form failed', err);
      }
    },
    [filePath, formDirty, harvestFormValues, unlockedPassword],
  );

  const handleProtect = useCallback(
    async (payload: Omit<ProtectInput, 'filePath'>) => {
      setProtecting(true);
      try {
        await ipc.pdf.protect({ filePath, ...payload });
        // The on-disk bytes changed (encrypted/decrypted). Stash the new
        // password (or clear it if we removed protection) so subsequent
        // operations can include it.
        if (payload.newPassword && payload.newPassword.length > 0) {
          setUnlockedPassword(payload.newPassword);
          setIsEncrypted(true);
          // pdfjs will re-prompt on reload — mark the new password as the
          // one we're about to try so onLoadSuccess promotes it correctly.
          lastTriedPasswordRef.current = payload.newPassword;
        } else {
          setUnlockedPassword(null);
          setIsEncrypted(false);
          lastTriedPasswordRef.current = null;
        }
        snapshotCacheRef.current?.clear();
        restorePageRef.current = activePage;
        setRestoring(true);
        setReloadKey((k) => k + 1);
        setProtectOpen(false);
      } catch (err) {
        console.error('[PdfView] protect failed', err);
      } finally {
        setProtecting(false);
      }
    },
    [activePage, filePath],
  );

  const handleSplit = useCallback(
    async (payload: { input: SplitInput; openAfterSave: boolean }) => {
      setSplitting(true);
      try {
        const result = await ipc.pdf.split(payload.input);
        if (payload.openAfterSave) {
          const { openPdf } = useTabsStore.getState();
          for (const p of result.savedPaths) {
            openPdf({ filePath: p });
          }
        }
        setSplitOpen(false);
      } catch (err) {
        console.error('[PdfView] split failed', err);
      } finally {
        setSplitting(false);
      }
    },
    [],
  );

  const handlePassword = useCallback(
    (callback: (password: string) => void, reason: number) => {
      // pdfjs uses reason === 2 for "incorrect password" retries.
      setIsEncrypted(true);
      setUnlockPrompt({ callback, error: reason === 2 });
    },
    [],
  );

  const cancelPlacement = useCallback(() => {
    selectStamp(null);
    selectSignature(null);
    setPlacement(null);
    // Also drop any half-armed digital sign — if the user backed out at the
    // placement stage, they need to reopen the dialog to start over.
    setPendingDigitalSign(null);
    setPlacementError(null);
  }, [selectStamp, selectSignature]);

  const handleDigitalSign = useCallback(
    async (
      input: Omit<SignDigitalInput, 'filePath' | 'pageIndex' | 'rect'> & {
        // UI-only flag from the dialog: "Lock form fields before signing".
        // Drives the auto-save mode (flatten vs keep); never reaches the
        // signDigital IPC.
        lockForm?: boolean;
      },
    ) => {
      const { lockForm, ...signInput } = input;
      const formMode: 'keep' | 'flatten' = lockForm ? 'flatten' : 'keep';

      // Fast-path: the dialog was opened by clicking an existing /Sig
      // widget. The widget's own rect IS the placement, so skip the
      // drag-overlay step and sign immediately whether visual or not.
      if (signTargetField) {
        setDigitalSigning(true);
        try {
          // Flush pending form edits first so the sign IPC reads the
          // user's typing, not the stale on-disk values.
          await saveFormIfDirty(formMode);
          const result = await ipc.signatures.signDigital({
            filePath,
            ...signInput,
            pageIndex: signTargetField.pageIndex,
            rect: signTargetField.rect,
            ...(unlockedPassword ? { password: unlockedPassword } : {}),
          });
          if (result.applied) {
            restorePageRef.current = activePage;
            setRestoring(true);
            snapshotCacheRef.current?.clear();
            setReloadKey((k) => k + 1);
            setDigitalSignOpen(false);
            setSignTargetField(null);
          }
        } finally {
          setDigitalSigning(false);
        }
        return;
      }

      // Branch on visible vs invisible. For visible signatures we don't sign
      // here — we stash the params, close the dialog, and select the visual
      // signature so the placement overlay activates. applyPlacement reads
      // pendingDigitalSign and routes to signDigital with the page+rect.
      // For visible sigs the form is auto-saved inside applyPlacement so it
      // happens immediately before the actual write — same window as here.
      if (signInput.visualSignatureId) {
        // Re-attach the UI-only lockForm flag so applyPlacement can
        // honor the user's "Lock form fields" choice when it does its
        // own saveFormIfDirty call.
        setPendingDigitalSign({ ...signInput, ...(lockForm ? { lockForm: true } : {}) });
        setDigitalSignOpen(false);
        // Activating the visual signature shows the existing placement
        // overlay UI — we get drag/resize + the action bar for free.
        selectSignature(signInput.visualSignatureId);
        return;
      }

      setDigitalSigning(true);
      try {
        await saveFormIfDirty(formMode);
        const result = await ipc.signatures.signDigital({
          filePath,
          ...signInput,
          // Pass the unlocked password through for encrypted PDFs — the
          // backend uses incremental update, so the original encrypted
          // content stays intact; we just need the password to read the
          // existing object table.
          ...(unlockedPassword ? { password: unlockedPassword } : {}),
        });
        if (result.applied) {
          // Force a full reload so the signature panel + integrity status
          // pick up the new /Sig field; clear snapshots so we don't briefly
          // show the un-signed page bitmap.
          restorePageRef.current = activePage;
          setRestoring(true);
          snapshotCacheRef.current?.clear();
          setReloadKey((k) => k + 1);
          setDigitalSignOpen(false);
        }
      } finally {
        setDigitalSigning(false);
      }
    },
    [
      activePage,
      filePath,
      saveFormIfDirty,
      selectSignature,
      signTargetField,
      unlockedPassword,
    ],
  );

  const applyPlacement = useCallback(async () => {
    if (!placement || applying) return;
    if (!selectedStampId && !selectedSignatureId) return;

    let pageEl = pageRefs.current[placement.pageIndex];
    if (!pageEl) {
      pagesVirtuosoRef.current?.scrollToIndex({
        index: placement.pageIndex,
        align: 'start',
      });
      for (let i = 0; i < 20; i++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        pageEl = pageRefs.current[placement.pageIndex];
        if (pageEl && pageEl.clientHeight > 0) break;
      }
      if (!pageEl) return;
    }

    const pw = pageEl.clientWidth;
    const ph = pageEl.clientHeight;
    if (!pw || !ph) return;

    const normRect = {
      x: placement.rect.x / pw,
      y: placement.rect.y / ph,
      w: placement.rect.w / pw,
      h: placement.rect.h / ph,
    };

    setApplying(true);
    setPlacementError(null);
    try {
      // Flush pending form edits to disk BEFORE the mutation reads
      // the file. Without this, in-memory pdf.js form state is lost
      // when the renderer reloads after the stamp / signature is
      // applied. For cert-signs the user can opt into 'flatten' via
      // the dialog's "Lock form fields" checkbox; everything else
      // keeps the form editable.
      const formMode: 'keep' | 'flatten' =
        pendingDigitalSign?.lockForm ? 'flatten' : 'keep';
      await saveFormIfDirty(formMode);

      // Routing rules (mutually exclusive):
      //   1. Pending digital sign + visual selected → signDigital with the
      //      visualSignatureId + page + rect. Cryptographic + visible mark
      //      in the same /Sig field.
      //   2. Only stamp selected → applyStamp (Fase 0).
      //   3. Only visual signature selected → signatures.apply (Fase 1).
      let applied = false;
      if (pendingDigitalSign && selectedSignatureId) {
        // Strip the UI-only lockForm flag before forwarding to the
        // IPC — the signDigital handler doesn't know about it.
        const { lockForm: _lockForm, ...sigInput } = pendingDigitalSign;
        applied = (
          await ipc.signatures.signDigital({
            ...sigInput,
            filePath,
            pageIndex: placement.pageIndex,
            rect: normRect,
            password: unlockedPassword ?? undefined,
          })
        ).applied;
      } else if (selectedStampId) {
        applied = (
          await ipc.pdf.applyStamp({
            filePath,
            pageIndex: placement.pageIndex,
            stampId: selectedStampId,
            rect: normRect,
            password: unlockedPassword ?? undefined,
          })
        ).applied;
      } else if (selectedSignatureId) {
        applied = (
          await ipc.signatures.apply({
            filePath,
            pageIndex: placement.pageIndex,
            signatureId: selectedSignatureId,
            rect: normRect,
            password: unlockedPassword ?? undefined,
          })
        ).applied;
      }
      if (applied) {
        restorePageRef.current = activePage;
        setRestoring(true);
        snapshotCacheRef.current?.clear();
        selectStamp(null);
        selectSignature(null);
        setPlacement(null);
        setPendingDigitalSign(null);
        setReloadKey((k) => k + 1);
      }
    } catch (err) {
      console.error('[PdfView] applyPlacement failed', err);
      setPlacementError(err instanceof Error ? err.message : String(err));
    } finally {
      setApplying(false);
    }
  }, [
    activePage,
    applying,
    filePath,
    pendingDigitalSign,
    placement,
    saveFormIfDirty,
    selectSignature,
    selectStamp,
    selectedSignatureId,
    selectedStampId,
    unlockedPassword,
  ]);

  return (
    <div className="pdf-view">
      <div className="pdf-toolbar" role="toolbar" aria-label="PDF controls">
        <div className="pdf-toolbar-group pdf-toolbar-left">
          <button
            type="button"
            className={`pdf-tool${thumbsOpen ? ' pdf-tool-active' : ''}`}
            onClick={() => toggleSidePanel('thumbs')}
            aria-label="Toggle thumbnails"
            aria-pressed={thumbsOpen}
            title="Toggle thumbnails"
            disabled={!isReady}
          >
            <ThumbnailsIcon />
          </button>
          <button
            type="button"
            className={`pdf-tool${outlineOpen ? ' pdf-tool-active' : ''}`}
            onClick={() => toggleSidePanel('outline')}
            aria-label="Toggle document outline"
            aria-pressed={outlineOpen}
            title="Toggle outline"
            disabled={!isReady}
          >
            <OutlineIcon />
          </button>
          <div className="pdf-paginator">
            <span className="pdf-paginator-sep" aria-hidden />
            <button
              type="button"
              className="pdf-tool pdf-paginator-nav"
              onClick={() => scrollToPage(1)}
              aria-label="First page"
              title="First page"
              disabled={!isReady || activePage <= 1}
            >
              <FirstPageIcon />
            </button>
            <button
              type="button"
              className="pdf-tool pdf-paginator-nav"
              onClick={() => scrollToPage(Math.max(1, activePage - 1))}
              aria-label="Previous page"
              title="Previous page"
              disabled={!isReady || activePage <= 1}
            >
              <ChevronUpIcon />
            </button>
            <form
              className="pdf-paginator-form"
              onSubmit={(e) => {
                e.preventDefault();
                commitPageInput();
                (e.currentTarget.elements.namedItem('page') as HTMLInputElement | null)?.blur();
              }}
            >
              <input
                name="page"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                className="pdf-paginator-input"
                value={pageInput}
                onChange={(e) =>
                  setPageInput(e.target.value.replace(/[^0-9]/g, ''))
                }
                onFocus={(e) => {
                  pageInputFocusedRef.current = true;
                  e.target.select();
                }}
                onBlur={() => {
                  pageInputFocusedRef.current = false;
                  setPageInput(String(activePage));
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    (e.target as HTMLInputElement).blur();
                  }
                }}
                aria-label="Current page"
                disabled={!isReady}
              />
            </form>
            <span className="pdf-paginator-total" aria-hidden>
              / {numPages || '—'}
            </span>
            <button
              type="button"
              className="pdf-tool pdf-paginator-nav"
              onClick={() => scrollToPage(Math.min(numPages, activePage + 1))}
              aria-label="Next page"
              title="Next page"
              disabled={!isReady || activePage >= numPages}
            >
              <ChevronDownIcon />
            </button>
            <button
              type="button"
              className="pdf-tool pdf-paginator-nav"
              onClick={() => scrollToPage(numPages)}
              aria-label="Last page"
              title="Last page"
              disabled={!isReady || activePage >= numPages}
            >
              <LastPageIcon />
            </button>
          </div>
        </div>

        <div className="pdf-toolbar-group pdf-toolbar-center">
          <button
            type="button"
            className="pdf-tool"
            onClick={zoomOut}
            aria-label="Zoom out"
            title="Zoom out"
            disabled={!isReady}
          >
            <ZoomOutIcon />
          </button>
          <button
            type="button"
            className="pdf-tool pdf-tool-zoom"
            onClick={zoomReset}
            aria-label={`Zoom: ${Math.round(zoom * 100)}% (click to reset)`}
            title="Reset zoom (fit width)"
            disabled={!isReady}
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            className="pdf-tool"
            onClick={zoomIn}
            aria-label="Zoom in"
            title="Zoom in"
            disabled={!isReady}
          >
            <ZoomInIcon />
          </button>
          <button
            type="button"
            className={`pdf-tool${isFit ? ' pdf-tool-active' : ''}`}
            onClick={zoomReset}
            aria-label="Fit width"
            aria-pressed={isFit}
            title="Fit width"
            disabled={!isReady}
          >
            <FitWidthIcon />
          </button>
          {formInfo?.hasForm && ((liveFilledCount ?? formInfo.filledCount) > 0 || formDirty) && (
            <button
              type="button"
              className={`pdf-tool${formDirty ? ' pdf-tool-active' : ''}`}
              onClick={() => setSaveFormDialogOpen(true)}
              aria-label="Save form"
              title={
                formDirty
                  ? 'Save form changes'
                  : 'Save or lock form'
              }
              // Stay enabled even when nothing's dirty — opening a PDF
              // with pre-filled fields, the user can click here just
              // to flatten the existing values into the page (via the
              // dialog's "Lock form" radio).
              disabled={!isReady || savingForm}
            >
              {/* Always the floppy disk now: the button is actionable
               * the moment a form has any filled values (the user can
               * lock/flatten without typing anything), so a neutral
               * "form indicator" icon would understate it. */}
              <SaveIcon />
            </button>
          )}
        </div>

        <div className="pdf-toolbar-group pdf-toolbar-right">
          {!searchOpen ? (
            <button
              type="button"
              className="pdf-tool"
              onClick={openSearch}
              aria-label="Find in document"
              title="Find in document"
              disabled={!isReady}
            >
              <SearchIcon />
            </button>
          ) : (
            <div className="pdf-search" role="search">
              <SearchIcon />
              <input
                ref={searchInputRef}
                type="text"
                className="pdf-search-input"
                value={searchQuery}
                placeholder="Find"
                aria-label="Search query"
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  // Stale results once the query no longer matches what was searched.
                  if (e.target.value.trim() !== lastSearchedRef.current) {
                    setSearchMatches([]);
                    setSearchIdx(-1);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    if (
                      searchQuery.trim() === lastSearchedRef.current &&
                      searchMatches.length > 0
                    ) {
                      goToMatch(searchIdx + (e.shiftKey ? -1 : 1), searchMatches);
                    } else {
                      void runSearch(searchQuery);
                    }
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    closeSearch();
                  }
                }}
              />
              <span className="pdf-search-count" aria-live="polite">
                {searching
                  ? '…'
                  : searchMatches.length > 0
                    ? `${searchIdx + 1}/${searchMatches.length}`
                    : lastSearchedRef.current && searchQuery.trim() === lastSearchedRef.current
                      ? '0/0'
                      : ''}
              </span>
              <button
                type="button"
                className="pdf-tool pdf-search-nav"
                onClick={() => goToMatch(searchIdx - 1, searchMatches)}
                disabled={searchMatches.length === 0}
                aria-label="Previous match"
                title="Previous match"
              >
                <ChevronUpIcon />
              </button>
              <button
                type="button"
                className="pdf-tool pdf-search-nav"
                onClick={() => goToMatch(searchIdx + 1, searchMatches)}
                disabled={searchMatches.length === 0}
                aria-label="Next match"
                title="Next match (Enter)"
              >
                <ChevronDownIcon />
              </button>
              <button
                type="button"
                className="pdf-tool pdf-search-nav"
                onClick={closeSearch}
                aria-label="Close search"
                title="Close (Esc)"
              >
                <CloseIcon />
              </button>
            </div>
          )}
          <button
            ref={stampBtnRef}
            type="button"
            className={`pdf-tool${
              stampMenuAnchor || selectedStampId ? ' pdf-tool-active' : ''
            }`}
            onClick={() =>
              setStampMenuAnchor((cur) => (cur ? null : stampBtnRef.current))
            }
            aria-label="Stamps"
            aria-pressed={!!stampMenuAnchor}
            title="Stamps"
            disabled={!isReady}
          >
            <StampIcon />
          </button>
          <button
            ref={signatureBtnRef}
            type="button"
            className={`pdf-tool${
              signatureMenuAnchor || selectedSignatureId ? ' pdf-tool-active' : ''
            }`}
            onClick={() =>
              setSignatureMenuAnchor((cur) => (cur ? null : signatureBtnRef.current))
            }
            aria-label="Signatures"
            aria-pressed={!!signatureMenuAnchor}
            title="Signatures"
            disabled={!isReady}
          >
            <SignatureIcon />
          </button>
          <button
            type="button"
            className={`pdf-tool${digitalSignOpen ? ' pdf-tool-active' : ''}`}
            onClick={() => setDigitalSignOpen(true)}
            aria-label="Digitally sign"
            title={
              isEncrypted
                ? 'Digital signing unavailable for encrypted PDFs — remove protection first'
                : 'Digitally sign with a certificate'
            }
            aria-pressed={digitalSignOpen}
            disabled={!isReady}
          >
            <DigitalSignIcon />
          </button>
          <button
            type="button"
            className={`pdf-tool${printOpen ? ' pdf-tool-active' : ''}`}
            onClick={() => setPrintOpen(true)}
            aria-label="Print"
            title="Print"
            aria-pressed={printOpen}
            disabled={!isReady}
          >
            <PrintIcon />
          </button>
          <button
            type="button"
            className={`pdf-tool${protectOpen ? ' pdf-tool-active' : ''}`}
            onClick={() => setProtectOpen(true)}
            aria-label="Protect with password"
            title="Protect with password"
            aria-pressed={protectOpen}
            disabled={!isReady}
          >
            <LockIcon />
          </button>
          <button
            type="button"
            className={`pdf-tool${splitOpen ? ' pdf-tool-active' : ''}`}
            onClick={() => setSplitOpen(true)}
            aria-label="Split PDF"
            title="Split PDF"
            aria-pressed={splitOpen}
            disabled={!isReady}
          >
            <SplitIcon />
          </button>
        </div>
      </div>

      <div className="pdf-body">
        {load.kind === 'loading' && (
          <div className="pdf-view-status muted">Loading PDF…</div>
        )}
        {load.kind === 'error' && (
          <div className="pdf-view-status">
            <strong>Could not open PDF</strong>
            <p className="muted small">{load.message}</p>
          </div>
        )}
        {load.kind === 'locked' && (
          <div className="pdf-view-status">
            <strong>This PDF is locked</strong>
            <p className="muted small">Enter the password to open it.</p>
            <button
              type="button"
              className="primary"
              onClick={() => setReloadKey((k) => k + 1)}
            >
              Enter password
            </button>
          </div>
        )}

        {load.kind === 'ready' && file && (
          <Document
            file={file}
            onLoadSuccess={(pdf) => {
              setUnlockPrompt(null);
              // Promote the password we just used to the "unlocked" state so
              // edit operations (stamps, protect changes) can include it.
              if (lastTriedPasswordRef.current) {
                setUnlockedPassword(lastTriedPasswordRef.current);
              }
              return handleDocumentLoadSuccess(pdf);
            }}
            onLoadError={(err) => setLoad({ kind: 'error', message: err.message })}
            onPassword={handlePassword}
            onItemClick={({ pageNumber }) => scrollToPage(pageNumber)}
            loading={<div className="pdf-view-status muted">Parsing…</div>}
            error={<div className="pdf-view-status">Failed to render</div>}
          >
            {thumbsOpen && (
              <aside className="pdf-thumbs" aria-label="Page thumbnails">
                <Virtuoso
                  ref={thumbsVirtuosoRef}
                  totalCount={numPages}
                  overscan={THUMB_OVERSCAN_PX}
                  style={{ height: '100%' }}
                  components={THUMBS_COMPONENTS}
                  itemContent={(index) => (
                    <ThumbItem
                      index={index}
                      active={index + 1 === activePage}
                      size={pageSizes[index]}
                      onClick={() => scrollToPage(index + 1)}
                    />
                  )}
                />
              </aside>
            )}

            {outlineOpen && (
              <aside className="pdf-outline" aria-label="Document outline">
                {hasOutline === null ? (
                  <p className="pdf-outline-empty muted small">Loading outline…</p>
                ) : hasOutline ? (
                  <Outline
                    onItemClick={({ pageNumber }) => scrollToPage(pageNumber)}
                  />
                ) : (
                  <p className="pdf-outline-empty muted small">
                    This document has no outline.
                  </p>
                )}
              </aside>
            )}

            <Virtuoso
              ref={pagesVirtuosoRef}
              scrollerRef={(el) => setPagesEl(el as HTMLElement | null)}
              totalCount={numPages}
              overscan={PAGE_OVERSCAN_PX}
              components={PAGES_COMPONENTS}
              className={`pdf-pages${restoring ? ' pdf-pages-restoring' : ''}`}
              itemContent={(index) => (
                <PageItem
                  index={index}
                  pageRefs={pageRefs}
                  width={effectivePageWidth}
                  size={pageSizes[index]}
                  placement={placement}
                  selectedStampId={selectedStampId}
                  selectedSignatureId={selectedSignatureId}
                  onPlacementChange={setPlacement}
                  cacheRef={snapshotCacheRef}
                  observer={pageObserver}
                  ratiosRef={ratiosRef}
                  onFirstPageRendered={saveRecentThumb}
                  onTextLayerRendered={() => rebuildHighlightsRef.current()}
                />
              )}
            />
          </Document>
        )}

        {placement && (selectedStampId || selectedSignatureId) && (
          <div className="stamp-action-bar">
            {placementError && (
              <span
                style={{
                  color: 'var(--danger)',
                  fontSize: '0.78rem',
                  maxWidth: '320px',
                  whiteSpace: 'normal',
                  textAlign: 'right',
                  paddingRight: '0.5rem',
                  lineHeight: 1.3,
                }}
                role="alert"
              >
                {placementError}
              </span>
            )}
            <button type="button" onClick={cancelPlacement} disabled={applying}>
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              onClick={applyPlacement}
              disabled={applying}
            >
              {(() => {
                if (applying) {
                  return pendingDigitalSign || selectedSignatureId
                    ? 'Signing…'
                    : 'Applying…';
                }
                if (pendingDigitalSign) return 'Sign digitally';
                if (selectedSignatureId) return 'Sign';
                return 'Apply';
              })()}
            </button>
          </div>
        )}
      </div>

      <div className="pdf-statusbar" role="status" aria-label="Document status">
        <span className="pdf-status-item">
          {isReady && numPages > 0 ? (
            <>
              Page <strong>{activePage}</strong> of <strong>{numPages}</strong>
            </>
          ) : (
            <span aria-hidden>—</span>
          )}
        </span>
        {existingSignatures.length > 0 && (
          <>
            <span className="pdf-status-sep" aria-hidden />
            <span
              className={`status-signed${
                existingSignatures.some((s) => s.integrity === 'invalid')
                  ? ' is-bad'
                  : existingSignatures.some((s) => s.integrity === 'modified-after')
                    ? ' is-warn'
                    : ''
              }`}
              role="button"
              tabIndex={0}
              onClick={() => setSignaturePanelOpen((v) => !v)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setSignaturePanelOpen((v) => !v);
                }
              }}
              title="Show signature details"
            >
              Signed ({existingSignatures.length})
            </span>
          </>
        )}
        {formInfo?.hasForm && (liveFilledCount ?? formInfo.filledCount) > 0 && (
          <>
            <span className="pdf-status-sep" aria-hidden />
            <span
              className="pdf-status-item status-form"
              title="AcroForm fields filled in this document"
            >
              Form · {liveFilledCount ?? formInfo.filledCount} filled
            </span>
          </>
        )}
        <span className="pdf-status-spacer" aria-hidden />
        <span className="pdf-status-item" title="Zoom level">
          {Math.round(zoom * 100)}%
        </span>
        <span className="pdf-status-sep" aria-hidden />
        <span className="pdf-status-item" title="File size on disk">
          {fileSize !== null ? formatBytes(fileSize) : '—'}
        </span>
      </div>

      {signaturePanelOpen && (
        <SignaturePanel
          signatures={existingSignatures}
          loading={signaturesLoading}
          onClose={() => setSignaturePanelOpen(false)}
        />
      )}

      {stampMenuAnchor && (
        <StampsMenu
          anchor={stampMenuAnchor}
          onClose={() => setStampMenuAnchor(null)}
          onSelect={(id) => selectStamp(id)}
        />
      )}

      {signatureMenuAnchor && (
        <SignaturesMenu
          anchor={signatureMenuAnchor}
          onClose={() => setSignatureMenuAnchor(null)}
          onSelect={(id) => selectSignature(id)}
        />
      )}

      {digitalSignOpen && (
        <DigitalSignDialog
          filePath={filePath}
          isEncrypted={isEncrypted}
          busy={digitalSigning}
          hasDirtyForm={formDirty}
          onClose={() => {
            if (digitalSigning) return;
            setDigitalSignOpen(false);
            // Drop any pre-armed /Sig widget target so the next time
            // the dialog is opened "normally" (via toolbar) it goes
            // through the drag-placement flow instead of trying to
            // reuse a stale rect.
            setSignTargetField(null);
          }}
          onSign={handleDigitalSign}
        />
      )}

      {printOpen && (
        <PrintDialog
          filePath={filePath}
          title={filePath.split(/[\\/]/).pop() ?? filePath}
          onClose={() => setPrintOpen(false)}
        />
      )}

      {saveFormDialogOpen && (
        <SaveFormDialog
          busy={savingForm}
          onClose={() => setSaveFormDialogOpen(false)}
          onSave={async (mode) => {
            await handleSaveForm(mode);
            setSaveFormDialogOpen(false);
          }}
        />
      )}

      {protectOpen && (
        <ProtectDialog
          title={filePath.split(/[\\/]/).pop() ?? filePath}
          encrypted={isEncrypted}
          knownCurrentPassword={unlockedPassword ?? undefined}
          busy={protecting}
          onSubmit={handleProtect}
          onCancel={() => setProtectOpen(false)}
        />
      )}

      {splitOpen && (
        <SplitDialog
          filePath={filePath}
          totalPages={numPages}
          isEncrypted={isEncrypted}
          unlockedPassword={unlockedPassword ?? undefined}
          busy={splitting}
          onSubmit={handleSplit}
          onCancel={() => setSplitOpen(false)}
        />
      )}

      {unlockPrompt && (
        <PasswordDialog
          title={filePath.split(/[\\/]/).pop() ?? filePath}
          error={unlockPrompt.error}
          onSubmit={(pwd) => {
            lastTriedPasswordRef.current = pwd;
            unlockPrompt.callback(pwd);
          }}
          onCancel={() => {
            // Park the document in a `locked` state so the user can retry
            // without losing the tab.
            setUnlockPrompt(null);
            lastTriedPasswordRef.current = null;
            setLoad({ kind: 'locked' });
          }}
        />
      )}

      {textMenu && (
        <div
          className="text-context-menu"
          role="menu"
          style={{ top: textMenu.y, left: textMenu.x }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            className="text-context-item"
            onClick={() => {
              void navigator.clipboard.writeText(textMenu.text);
              setTextMenu(null);
            }}
          >
            Copy
          </button>
        </div>
      )}
    </div>
  );
}

interface PageItemProps {
  index: number;
  pageRefs: React.MutableRefObject<Array<HTMLDivElement | null>>;
  width: number | undefined;
  size: PageSize | undefined;
  placement: Placement | null;
  selectedStampId: string | null;
  selectedSignatureId: string | null;
  onPlacementChange: React.Dispatch<React.SetStateAction<Placement | null>>;
  cacheRef: React.MutableRefObject<SnapshotCache | null>;
  observer: IntersectionObserver | null;
  ratiosRef: React.MutableRefObject<Map<number, number>>;
  /** Called once on each successful render of page 1, used to refresh the
   * cached recents thumbnail next to the PDF. */
  onFirstPageRendered?: (canvas: HTMLCanvasElement) => void;
  /** Fires after the page's text layer is rendered — the search-highlight
   * machinery uses this to re-apply highlights to newly-mounted pages. */
  onTextLayerRendered?: () => void;
}

function PageItem({
  index,
  pageRefs,
  width,
  size,
  placement,
  selectedStampId,
  selectedSignatureId,
  onPlacementChange,
  cacheRef,
  observer,
  ratiosRef,
  onFirstPageRendered,
  onTextLayerRendered,
}: PageItemProps): JSX.Element {
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Subscribe this wrap to the parent's IntersectionObserver. On unmount we
  // unobserve AND drop the entry from the ratios map — the IO doesn't fire a
  // final "ratio = 0" event when an element is removed from the DOM.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || !observer) return;
    observer.observe(wrap);
    return () => {
      observer.unobserve(wrap);
      ratiosRef.current.delete(index);
    };
  }, [observer, index, ratiosRef]);

  // Initialize from cache so the first paint already has the snapshot.
  const [bgImage, setBgImage] = useState<string | null>(
    () => cacheRef.current?.get(index) ?? null,
  );

  const setRef = useCallback(
    (el: HTMLDivElement | null) => {
      wrapRef.current = el;
      pageRefs.current[index] = el;
    },
    [index, pageRefs],
  );

  // Snapshot the canvas after each successful render. The new URL replaces
  // the previous one in the cache; we also update local state so subsequent
  // in-place re-renders (e.g. zoom) display the most recent snapshot.
  const handleRenderSuccess = useCallback(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const canvas = wrap.querySelector<HTMLCanvasElement>('.react-pdf__Page__canvas');
    if (!canvas || canvas.width === 0) return;
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        cacheRef.current?.set(index, url);
        setBgImage(url);
      },
      'image/jpeg',
      SNAPSHOT_QUALITY,
    );
    if (index === 0 && onFirstPageRendered) {
      onFirstPageRendered(canvas);
    }
  }, [index, cacheRef, onFirstPageRendered]);

  // On unmount (virtuoso scroll-out), capture a final snapshot so the page
  // shows up immediately if the user scrolls back.
  useEffect(() => {
    return () => {
      const wrap = wrapRef.current;
      if (!wrap) return;
      const canvas = wrap.querySelector<HTMLCanvasElement>('.react-pdf__Page__canvas');
      if (!canvas || canvas.width === 0) return;
      canvas.toBlob(
        (blob) => {
          if (!blob) return;
          const url = URL.createObjectURL(blob);
          cacheRef.current?.set(index, url);
        },
        'image/jpeg',
        SNAPSHOT_QUALITY,
      );
    };
  }, [index, cacheRef]);

  const wrapStyle = bgImage
    ? {
        backgroundImage: `url(${bgImage})`,
        backgroundSize: '100% 100%',
        backgroundRepeat: 'no-repeat',
      }
    : undefined;

  // Compute placeholder dimensions so the loading state has the correct
  // height — keeps virtuoso's layout stable and avoids the zero-sized flash.
  const placeholderHeight =
    width !== undefined
      ? Math.round(width * (size ? size.h / size.w : FALLBACK_PAGE_RATIO))
      : undefined;

  return (
    <div
      ref={setRef}
      data-page-index={index}
      className="pdf-page-wrap"
      style={wrapStyle}
    >
      <Page
        pageNumber={index + 1}
        width={width}
        className="pdf-page"
        renderAnnotationLayer
        renderForms
        renderTextLayer
        onRenderSuccess={handleRenderSuccess}
        onRenderTextLayerSuccess={onTextLayerRendered}
        loading={
          width !== undefined && placeholderHeight !== undefined ? (
            <div
              className="pdf-page-placeholder"
              style={{ width, height: placeholderHeight }}
            />
          ) : null
        }
      />
      {placement?.pageIndex === index && (selectedStampId || selectedSignatureId) && (
        <Rnd
          size={{ width: placement.rect.w, height: placement.rect.h }}
          position={{ x: placement.rect.x, y: placement.rect.y }}
          bounds="parent"
          lockAspectRatio
          className={selectedSignatureId ? 'signature-overlay' : 'stamp-overlay'}
          onDragStop={(_, d) =>
            onPlacementChange((p) =>
              p ? { ...p, rect: { ...p.rect, x: d.x, y: d.y } } : p,
            )
          }
          onResizeStop={(_, __, ref, ___, pos) =>
            onPlacementChange((p) =>
              p
                ? {
                    ...p,
                    rect: {
                      x: pos.x,
                      y: pos.y,
                      w: ref.offsetWidth,
                      h: ref.offsetHeight,
                    },
                  }
                : p,
            )
          }
        >
          <img
            src={
              selectedSignatureId
                ? `signature://${selectedSignatureId}`
                : `stamp://${selectedStampId}`
            }
            alt=""
            className={
              selectedSignatureId ? 'signature-overlay-img' : 'stamp-overlay-img'
            }
            draggable={false}
          />
        </Rnd>
      )}
    </div>
  );
}

interface ThumbItemProps {
  index: number;
  active: boolean;
  size: PageSize | undefined;
  onClick: () => void;
}

function ThumbItem({ index, active, size, onClick }: ThumbItemProps): JSX.Element {
  const pageNumber = index + 1;
  const placeholderHeight = Math.round(
    THUMB_WIDTH * (size ? size.h / size.w : FALLBACK_PAGE_RATIO),
  );
  return (
    <button
      type="button"
      className={`pdf-thumb${active ? ' pdf-thumb-active' : ''}`}
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      aria-label={`Go to page ${pageNumber}`}
    >
      <Page
        pageNumber={pageNumber}
        width={THUMB_WIDTH}
        renderTextLayer={false}
        renderAnnotationLayer={false}
        loading={
          <div
            className="pdf-page-placeholder pdf-thumb-placeholder"
            style={{ width: THUMB_WIDTH, height: placeholderHeight }}
          />
        }
      />
      <span className="pdf-thumb-label">{pageNumber}</span>
    </button>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 2 : 1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
}

/** Stable spacer above the first page so it doesn't sit flush against the
 * toolbar. Virtuoso's `components.Header` accounts for this in its layout. */
function PagesHeader(): JSX.Element {
  return <div style={{ height: '1rem' }} aria-hidden />;
}

const PAGES_COMPONENTS = { Header: PagesHeader };

function ThumbsHeader(): JSX.Element {
  return <div style={{ height: '1rem' }} aria-hidden />;
}

const THUMBS_COMPONENTS = { Header: ThumbsHeader };

function SearchIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M10.4 10.4 L13.5 13.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ChevronUpIcon(): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path
        d="M3 7.5 L6 4.5 L9 7.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronDownIcon(): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path
        d="M3 4.5 L6 7.5 L9 4.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FirstPageIcon(): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path
        d="M3 3 L9 3 M3 8 L6 5 L9 8"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function LastPageIcon(): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path
        d="M3 4 L6 7 L9 4 M3 9 L9 9"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CloseIcon(): JSX.Element {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path
        d="M2,2 L10,10 M10,2 L2,10"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function OutlineIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="3" cy="3.5" r="0.9" fill="currentColor" />
      <circle cx="3" cy="8" r="0.9" fill="currentColor" />
      <circle cx="3" cy="12.5" r="0.9" fill="currentColor" />
      <path
        d="M6 3.5h8M6 8h6M6 12.5h8"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ThumbnailsIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect
        x="1.5"
        y="1.5"
        width="4"
        height="5"
        rx="0.6"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <rect
        x="1.5"
        y="9.5"
        width="4"
        height="5"
        rx="0.6"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path d="M8 3h6.5M8 6h5M8 11h6.5M8 14h5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function ZoomOutIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function ZoomInIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M8 3v10M3 8h10"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function FitWidthIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M2 8h12M2 8l2.5-2.5M2 8l2.5 2.5M14 8l-2.5-2.5M14 8l-2.5 2.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function LockIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect
        x="3"
        y="7"
        width="10"
        height="7"
        rx="1.2"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path
        d="M5 7V5a3 3 0 0 1 6 0v2"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <circle cx="8" cy="10.5" r="0.9" fill="currentColor" />
    </svg>
  );
}

function SplitIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="2" y="3" width="5" height="10" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <rect x="9" y="3" width="5" height="10" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <path d="M7 8H9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function PrintIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M4 2h8v3.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M3 5.5h10a1 1 0 0 1 1 1V10a1 1 0 0 1-1 1h-1V8.5H4V11H3a1 1 0 0 1-1-1V6.5a1 1 0 0 1 1-1z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <rect
        x="4"
        y="8.5"
        width="8"
        height="5"
        rx="0.4"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  );
}

function SignatureIcon(): JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
      <path
        d="M2 11c1.5-3 3-5 4.2-5 .7 0 .9.8.4 2.2-.6 1.6-1.4 3.3-1.4 4 0 .5.3.7.7.7 1.6 0 3.5-3.5 4.7-3.5.5 0 .7.4.7.9 0 .8-.4 1.7-.4 2.3 0 .4.2.6.6.6 1 0 2.3-1.6 3.4-1.6"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M2 15h14" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" opacity="0.55" />
    </svg>
  );
}

/** Rubber stamp silhouette — square pad, neck, and round handle on top,
 * plus the implied surface underline. Reads as "rubber stamp" at toolbar
 * size where finer detail would muddle. */
function SaveIcon(): JSX.Element {
  // Classic floppy disk: outer rounded square + notched top label
  // strip + inset bottom panel. Universally read as "save".
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
      <path
        d="M3.5 3h8.5L15 5.5V14a1 1 0 0 1 -1 1H4a1 1 0 0 1 -1 -1V4a1 1 0 0 1 0.5 -1z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      {/* Top label / metal slide */}
      <path
        d="M5.5 3v3.5h6V3"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      {/* Bottom write panel */}
      <rect
        x="5"
        y="9"
        width="8"
        height="6"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  );
}

function StampIcon(): JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
      {/* Handle */}
      <circle cx="9" cy="3" r="1.6" stroke="currentColor" strokeWidth="1.2" />
      {/* Neck connecting handle to pad */}
      <path
        d="M9 4.6V7"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      {/* Stamp pad (flares slightly wider than the neck) */}
      <path
        d="M5 11V8.5a1.5 1.5 0 0 1 1.5-1.5h5A1.5 1.5 0 0 1 13 8.5V11z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      {/* Base block — the bit that hits the paper */}
      <rect
        x="3.5"
        y="11"
        width="11"
        height="1.6"
        rx="0.3"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      {/* Surface line — the paper */}
      <path
        d="M2 15h14"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
        opacity="0.55"
      />
    </svg>
  );
}

/** Shield-with-checkmark — the conventional "cryptographically signed" mark
 * that pairs with our other signature icons without duplicating their look. */
function DigitalSignIcon(): JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
      <path
        d="M9 1.5 2.5 4v4.5c0 4 2.8 6.7 6.5 8 3.7-1.3 6.5-4 6.5-8V4z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path
        d="m6 9 2 2 4-4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

