import { useEffect, useRef, useState } from 'react';

import type { Signature } from '~shared/types/signatures.js';

import { useSignaturesStore } from '../stores/signatures.js';

type Tab = 'draw' | 'type' | 'image';

interface SignatureEditorProps {
  onClose(): void;
  /** Fires when a new signature has been persisted; parent typically
   * auto-selects it for placement. */
  onCreated(signature: Signature): void;
}

const TYPED_FONTS = [
  { id: 'caveat', label: 'Caveat', css: "'Caveat', cursive" },
  { id: 'dancing', label: 'Dancing Script', css: "'Dancing Script', cursive" },
  { id: 'vibes', label: 'Great Vibes', css: "'Great Vibes', cursive" },
] as const;

/** Drawing-canvas backing-store dimensions, in PHYSICAL pixels. Independent
 * of the canvas's CSS size and the device pixel ratio — the browser scales
 * the 2400×900 backing-store to fit whatever CSS box the canvas occupies.
 * Why hardcoded:
 *
 *  - Earlier versions sized the backing store from `getBoundingClientRect()`
 *    at setup time. That sometimes returned 0 width when the modal had
 *    just mounted and layout wasn't flushed, so the canvas kept its HTML
 *    default 300×150 and signatures came out painfully pixelated.
 *  - A fixed high-DPI backing store is also nicer downstream: the saved
 *    PNG always has enough detail (>1500 px wide after crop) to stay crisp
 *    when the signed PDF is viewed at 300%+ zoom on a Retina screen.
 *
 * 900 height matches a ~2.67:1 aspect (~520×200 CSS). The browser stretches
 * the backing store to whatever CSS height the canvas actually has, with
 * smooth interpolation. */
const CANVAS_BACKING_WIDTH = 2400;
const CANVAS_BACKING_HEIGHT = 900;

/** Stroke thickness in BACKING-STORE pixels (canvas.width units). With the
 * 2400×900 backing store displayed at ~520×200 CSS, the on-screen stroke
 * appears ~2 CSS pixels wide — same visual weight as the previous version
 * that drew at lineWidth=2.2 in CSS units. */
const CANVAS_LINE_WIDTH = 10;

function setupCanvas(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  canvas.width = CANVAS_BACKING_WIDTH;
  canvas.height = CANVAS_BACKING_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context unavailable');
  ctx.lineWidth = CANVAS_LINE_WIDTH;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#111';
  return ctx;
}

/** Convert a pointer event's clientX/clientY into backing-store pixel
 * coords for the given canvas. Measures the canvas's CSS rect lazily on
 * each call so we always get a valid layout (vs measuring once at setup
 * time when layout might not be flushed yet). */
function pointerToCanvas(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / (rect.width || 1);
  const scaleY = canvas.height / (rect.height || 1);
  return {
    x: (clientX - rect.left) * scaleX,
    y: (clientY - rect.top) * scaleY,
  };
}

/** Crop a canvas to the bounding box of opaque pixels, leaving a small
 * margin. Returns a NEW canvas — the input is unchanged. If the canvas is
 * entirely transparent, returns null. */
function cropToContent(source: HTMLCanvasElement): HTMLCanvasElement | null {
  const ctx = source.getContext('2d');
  if (!ctx) return null;
  const { width, height } = source;
  const { data } = ctx.getImageData(0, 0, width, height);

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = data[(y * width + x) * 4 + 3] ?? 0;
      if (alpha > 8) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;

  const margin = 8;
  minX = Math.max(0, minX - margin);
  minY = Math.max(0, minY - margin);
  maxX = Math.min(width - 1, maxX + margin);
  maxY = Math.min(height - 1, maxY + margin);

  const out = document.createElement('canvas');
  out.width = maxX - minX + 1;
  out.height = maxY - minY + 1;
  const outCtx = out.getContext('2d');
  if (!outCtx) return null;
  outCtx.drawImage(source, -minX, -minY);
  return out;
}

/** Convert a canvas-on-white drawing to a transparent-bg PNG by treating
 * near-white pixels as transparent. Keeps the ink color (typically near
 * #111) intact and softens the edge by scaling alpha with darkness. This
 * is far cheaper than a true matting algorithm and good enough for
 * signatures. */
function rasterToTransparentPng(source: HTMLCanvasElement): HTMLCanvasElement {
  const ctx = source.getContext('2d');
  if (!ctx) return source;
  const img = ctx.getImageData(0, 0, source.width, source.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i] ?? 255;
    const g = d[i + 1] ?? 255;
    const b = d[i + 2] ?? 255;
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    // White (255) → alpha 0, black (0) → alpha 255. Linear ramp.
    const alpha = Math.max(0, Math.min(255, 255 - Math.round(luma)));
    d[i + 3] = alpha;
  }
  ctx.putImageData(img, 0, 0);
  return source;
}

async function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), 'image/png'),
  );
  if (!blob) throw new Error('toBlob failed');
  const buf = await blob.arrayBuffer();
  return new Uint8Array(buf);
}

export function SignatureEditor({ onClose, onCreated }: SignatureEditorProps): JSX.Element {
  const [tab, setTab] = useState<Tab>('draw');
  const createFromBytes = useSignaturesStore((s) => s.createFromBytes);
  const createFromFile = useSignaturesStore((s) => s.createFromFile);

  // --- Draw tab state ---------------------------------------------------
  const drawCanvasRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const [hasDrawn, setHasDrawn] = useState(false);
  const [drawLabel, setDrawLabel] = useState('');

  // --- Type tab state ---------------------------------------------------
  const [typedText, setTypedText] = useState('');
  const [typedFontId, setTypedFontId] = useState<(typeof TYPED_FONTS)[number]['id']>('caveat');
  const typedFont = TYPED_FONTS.find((f) => f.id === typedFontId) ?? TYPED_FONTS[0];

  // --- Common --------------------------------------------------------------
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Initialize the draw canvas when entering the draw tab. We re-init on
  // tab change because the canvas is unmounted/remounted by the tab switch.
  useEffect(() => {
    if (tab !== 'draw') return;
    const canvas = drawCanvasRef.current;
    if (!canvas) return;
    setupCanvas(canvas);
    setHasDrawn(false);
    drawingRef.current = false;
    lastPointRef.current = null;
  }, [tab]);

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = drawCanvasRef.current;
    if (!canvas) return;
    canvas.setPointerCapture(e.pointerId);
    drawingRef.current = true;
    lastPointRef.current = pointerToCanvas(canvas, e.clientX, e.clientY);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    const canvas = drawCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { x, y } = pointerToCanvas(canvas, e.clientX, e.clientY);
    const last = lastPointRef.current;
    if (!last) {
      lastPointRef.current = { x, y };
      return;
    }
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    // Quadratic curve through the midpoint gives a smoother line than
    // straight segments without paying for full Bezier per stroke.
    const midX = (last.x + x) / 2;
    const midY = (last.y + y) / 2;
    ctx.quadraticCurveTo(last.x, last.y, midX, midY);
    ctx.stroke();
    lastPointRef.current = { x, y };
    if (!hasDrawn) setHasDrawn(true);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    drawingRef.current = false;
    lastPointRef.current = null;
    try {
      drawCanvasRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      // Pointer might not actually be captured if the down event was
      // swallowed; releasing throws DOMException — safe to ignore.
    }
  };

  const handleClearDraw = () => {
    const canvas = drawCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // Setup no longer applies ctx.scale — drawing uses backing-store coords
    // directly — so we can clearRect at canvas dims without saving/restoring
    // a transform.
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setHasDrawn(false);
  };

  const renderTypedToCanvas = (): HTMLCanvasElement | null => {
    if (!typedText.trim()) return null;
    // Render at a generous size so cropping leaves a high-res asset.
    const width = 1200;
    const height = 360;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#111';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    // Pick a font size that comfortably fits the input text width.
    let fontPx = 240;
    do {
      ctx.font = `${fontPx}px ${typedFont.css}`;
      if (ctx.measureText(typedText).width <= width - 80) break;
      fontPx -= 10;
    } while (fontPx > 60);
    ctx.fillText(typedText, width / 2, height / 2);
    return canvas;
  };

  const handleSaveDrawn = async () => {
    const canvas = drawCanvasRef.current;
    if (!canvas || !hasDrawn) return;
    setError(null);
    setSaving(true);
    try {
      // Clone first so cropping on the source doesn't mutate the user's
      // canvas while it's still visible behind the modal.
      const clone = document.createElement('canvas');
      clone.width = canvas.width;
      clone.height = canvas.height;
      const cctx = clone.getContext('2d');
      if (!cctx) throw new Error('clone canvas context unavailable');
      cctx.drawImage(canvas, 0, 0);

      // Skip the luma→alpha matting here: the draw canvas starts with a
      // transparent-black background (default for un-filled canvases), and
      // matting on that flips background pixels (RGB 0,0,0) to OPAQUE black
      // — turning the whole image into a black rectangle. The strokes are
      // drawn with #111 ink so their own anti-aliased alpha is already what
      // we want. The matting helper is only correct for the typed flow,
      // which paints a white background first.
      const cropped = cropToContent(clone);
      if (!cropped) {
        setError('Canvas is empty');
        return;
      }
      const bytes = await canvasToPngBytes(cropped);
      const sig = await createFromBytes({
        kind: 'drawn',
        label: drawLabel.trim() || 'Drawn signature',
        bytes,
      });
      onCreated(sig);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleSaveTyped = async () => {
    if (!typedText.trim()) return;
    setError(null);
    setSaving(true);
    try {
      // Wait until the chosen font has been loaded by the renderer; without
      // this, the very first signature with a given font may render in the
      // browser's fallback before the @font-face URL is fetched.
      if (document.fonts && document.fonts.load) {
        await document.fonts.load(`80px ${typedFont.css}`);
      }
      const rendered = renderTypedToCanvas();
      if (!rendered) {
        setError('Type something to render');
        return;
      }
      const transparent = rasterToTransparentPng(rendered);
      const cropped = cropToContent(transparent);
      if (!cropped) {
        setError('Nothing to render');
        return;
      }
      const bytes = await canvasToPngBytes(cropped);
      const sig = await createFromBytes({
        kind: 'typed',
        label: typedText.trim(),
        bytes,
      });
      onCreated(sig);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleImportImage = async () => {
    setError(null);
    setSaving(true);
    try {
      const sig = await createFromFile();
      if (!sig) return;
      onCreated(sig);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  // Close on ESC.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="signature-editor-backdrop" onMouseDown={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <div className="signature-editor" role="dialog" aria-label="Create signature">
        <div className="signature-editor-header">
          <span className="signature-editor-title">Create signature</span>
          <button
            type="button"
            className="signature-editor-close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="signature-editor-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'draw'}
            className={`signature-editor-tab${tab === 'draw' ? ' is-active' : ''}`}
            onClick={() => setTab('draw')}
          >
            Draw
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'type'}
            className={`signature-editor-tab${tab === 'type' ? ' is-active' : ''}`}
            onClick={() => setTab('type')}
          >
            Type
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'image'}
            className={`signature-editor-tab${tab === 'image' ? ' is-active' : ''}`}
            onClick={() => setTab('image')}
          >
            Upload image
          </button>
        </div>

        <div className="signature-editor-body">
          {tab === 'draw' && (
            <>
              <canvas
                ref={drawCanvasRef}
                className="signature-editor-canvas"
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
              />
              <div className="signature-editor-row">
                <input
                  type="text"
                  className="signature-editor-input"
                  placeholder="Label (optional)"
                  value={drawLabel}
                  onChange={(e) => setDrawLabel(e.target.value)}
                />
                <button
                  type="button"
                  className="signature-editor-btn"
                  onClick={handleClearDraw}
                  disabled={!hasDrawn || saving}
                >
                  Clear
                </button>
              </div>
              <div className="signature-editor-hint">
                Draw with mouse, pen or touch. White background is removed
                automatically when you save.
              </div>
            </>
          )}

          {tab === 'type' && (
            <>
              <div
                className="signature-editor-typed-preview"
                aria-label="Typed signature preview"
              >
                <span
                  className="signature-editor-typed-preview-text"
                  style={{ fontFamily: typedFont.css }}
                >
                  {typedText || 'Your name'}
                </span>
              </div>
              <div className="signature-editor-row">
                <input
                  type="text"
                  className="signature-editor-input"
                  placeholder="Type your name"
                  value={typedText}
                  onChange={(e) => setTypedText(e.target.value)}
                />
                <select
                  className="signature-editor-select"
                  value={typedFontId}
                  onChange={(e) => setTypedFontId(e.target.value as typeof typedFontId)}
                  aria-label="Font"
                >
                  {TYPED_FONTS.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </div>
            </>
          )}

          {tab === 'image' && (
            <>
              <div className="signature-editor-hint">
                Pick a PNG (with transparency) or JPG. Best results with a
                pre-cropped signature on a transparent background.
              </div>
              <div className="signature-editor-row">
                <button
                  type="button"
                  className="signature-editor-btn is-primary"
                  onClick={handleImportImage}
                  disabled={saving}
                  style={{ flex: 1 }}
                >
                  Choose file…
                </button>
              </div>
            </>
          )}

          {error && (
            <div className="signature-editor-hint" style={{ color: 'var(--danger)' }}>
              {error}
            </div>
          )}
        </div>

        <div className="signature-editor-footer">
          <button type="button" className="signature-editor-btn" onClick={onClose}>
            Cancel
          </button>
          {tab === 'draw' && (
            <button
              type="button"
              className="signature-editor-btn is-primary"
              onClick={handleSaveDrawn}
              disabled={!hasDrawn || saving}
            >
              {saving ? 'Saving…' : 'Save signature'}
            </button>
          )}
          {tab === 'type' && (
            <button
              type="button"
              className="signature-editor-btn is-primary"
              onClick={handleSaveTyped}
              disabled={!typedText.trim() || saving}
            >
              {saving ? 'Saving…' : 'Save signature'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
