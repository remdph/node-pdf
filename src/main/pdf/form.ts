import fs from 'node:fs/promises';
import {
  PDFArray,
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFDropdown,
  PDFName,
  PDFOptionList,
  PDFRadioGroup,
  PDFRef,
  PDFSignature,
  PDFTextField,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
  rotateInPlace,
  translate,
  type PDFField,
  type PDFForm,
  type PDFPage,
} from '@cantoo/pdf-lib';

import { NodePdfError } from '~shared/types/errors.js';
import type {
  FillFormInput,
  FillFormResult,
  FormFieldInfo,
  FormFieldType,
  FormInfo,
} from '~shared/types/forms.js';
import { captureEncryptionRef, restoreEncryptionRef } from './encryption-preserve.js';
import { safeWritePdf } from './safe-write.js';

function classifyField(field: PDFField): FormFieldType {
  if (field instanceof PDFTextField) return 'text';
  if (field instanceof PDFCheckBox) return 'checkbox';
  if (field instanceof PDFRadioGroup) return 'radio';
  if (field instanceof PDFDropdown) return 'dropdown';
  if (field instanceof PDFOptionList) return 'listbox';
  if (field instanceof PDFSignature) return 'signature';
  return 'unknown';
}

function readFieldValue(field: PDFField): FormFieldInfo['value'] {
  try {
    if (field instanceof PDFTextField) return field.getText() ?? '';
    if (field instanceof PDFCheckBox) return field.isChecked();
    if (field instanceof PDFRadioGroup) return field.getSelected() ?? '';
    if (field instanceof PDFDropdown) return field.getSelected()[0] ?? '';
    if (field instanceof PDFOptionList) return field.getSelected();
    // Signature: getValue() would return its dict ref, not useful for
    // the renderer. Skip and let the signature inspection flow handle it.
    if (field instanceof PDFSignature) return undefined;
  } catch {
    // Some PDFs have malformed appearance streams or value entries
    // that pdf-lib's getters throw on. Don't let one bad field kill
    // the whole inspection — fall through to undefined.
    return undefined;
  }
  return undefined;
}

function isFieldFilled(field: PDFField): boolean {
  const v = readFieldValue(field);
  if (typeof v === 'string') return v.length > 0;
  if (typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.length > 0;
  return false;
}

/**
 * Cheap-ish read-only inspection. Loads the PDF, walks the AcroForm
 * field list, returns metadata + counts. Doesn't write anything.
 *
 * Returns hasForm=false (with empty fields[]) when the doc has no
 * /AcroForm catalog entry — that's the common path so we want to
 * surface it without making the renderer crash on "no form" PDFs.
 */
export async function inspectForm(filePath: string, password?: string): Promise<FormInfo> {
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(filePath);
  } catch (err) {
    throw new NodePdfError('READ_FAILED', `Failed to read PDF: ${filePath}`, err);
  }

  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, password ? { password } : undefined);
  } catch (err) {
    // Encrypted-without-password is a real outcome (the renderer's
    // unlock dialog will pass us the password and re-call); not an
    // exceptional condition for the form flow, just a "no info".
    throw new NodePdfError('INVALID_PDF', 'PDF could not be parsed', err);
  }

  let form;
  try {
    form = doc.getForm();
  } catch {
    return { hasForm: false, fieldCount: 0, filledCount: 0, fields: [] };
  }

  const rawFields = form.getFields();
  if (rawFields.length === 0) {
    return { hasForm: false, fieldCount: 0, filledCount: 0, fields: [] };
  }

  const fields: FormFieldInfo[] = [];
  let filledCount = 0;
  for (const f of rawFields) {
    const type = classifyField(f);
    const info: FormFieldInfo = {
      name: f.getName(),
      type,
      readOnly: f.isReadOnly(),
      value: readFieldValue(f),
    };
    fields.push(info);
    // Signatures don't count as fillable for the "X of Y" pill.
    if (type !== 'signature' && isFieldFilled(f)) filledCount += 1;
  }

  return {
    hasForm: true,
    fieldCount: fields.filter((f) => f.type !== 'signature').length,
    filledCount,
    fields,
  };
}

/**
 * Apply a `{ name: value }` map to the form fields. Unknown names and
 * signature fields are skipped (reported in `skipped[]`); type
 * coercion is permissive (checkbox accepts boolean OR truthy
 * primitive, dropdown accepts string).
 *
 * Save mode:
 *  - `keep` (default): incremental save. Existing signatures stay
 *    valid (their byte ranges still point at unchanged original bytes)
 *    and the form remains editable for future fills.
 *  - `flatten`: still incremental, but calls `form.flatten()` first
 *    which generates new page content with the field appearances
 *    baked in and removes the widget annotations. WARNING: this
 *    changes the page content streams, which may invalidate visible
 *    signature widgets even though their byte ranges are intact.
 */
export async function fillForm(input: FillFormInput): Promise<FillFormResult> {
  const { filePath, values, mode = 'keep', password } = input;

  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new NodePdfError('INVALID_PATH', 'A file path is required');
  }
  if (!values || typeof values !== 'object') {
    throw new NodePdfError('VALIDATION_ERROR', 'values must be an object');
  }

  let bytes: Buffer;
  try {
    bytes = await fs.readFile(filePath);
  } catch (err) {
    throw new NodePdfError('READ_FAILED', `Failed to read PDF: ${filePath}`, err);
  }

  // Load strategy depends on mode:
  //   - 'keep': incremental save preserves existing signatures and
  //     leaves the form editable. `forIncrementalUpdate: true`
  //     arms pdf-lib's snapshot tracker so `commit()` writes a delta.
  //   - 'flatten': full save. Background — pdf-lib's
  //     `form.flatten()` combined with `commit({useObjectStreams:
  //     false})` is a known-broken combo: it mutates the catalog
  //     while writing an incremental section, leaving pdf.js with an
  //     "Invalid Root reference" on the next open (Hopding/pdf-lib
  //     issues #1267, #1482, #1224, #1485; cantoo fork inherits
  //     them and adds new ones because commit() layers a fresh
  //     xref over a partially-mutated catalog). The verified fix
  //     is to skip pdf-lib's flatten entirely (we draw widget
  //     appearances onto pages manually in `manualFlatten` below)
  //     and full-save with `doc.save()`. Flatten already invalidates
  //     any prior form-aware signatures, so giving up incremental
  //     preservation costs nothing.
  const isFlatten = mode === 'flatten';

  // Capture original /Encrypt trailer ref so we can re-attach it
  // before save — pdf-lib strips it when decrypting with a password,
  // which would leave the saved file looking unencrypted to viewers
  // (blank pages because content streams stay encrypted).
  const encryptRef = password ? await captureEncryptionRef(bytes) : null;

  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, {
      ...(isFlatten ? {} : { forIncrementalUpdate: true }),
      ...(password ? { password } : {}),
    });
  } catch (err) {
    throw new NodePdfError('INVALID_PDF', 'PDF could not be parsed', err);
  }

  let form;
  try {
    form = doc.getForm();
  } catch (err) {
    throw new NodePdfError('VALIDATION_ERROR', 'PDF has no AcroForm to fill', err);
  }

  const skipped: FillFormResult['skipped'] = [];
  let written = 0;

  for (const [name, rawValue] of Object.entries(values)) {
    const field = form.getFieldMaybe(name);
    if (!field) {
      skipped.push({ name, reason: 'unknown field' });
      continue;
    }
    if (field.isReadOnly()) {
      skipped.push({ name, reason: 'read-only' });
      continue;
    }

    try {
      if (field instanceof PDFTextField) {
        field.setText(rawValue == null ? '' : String(rawValue));
        written += 1;
      } else if (field instanceof PDFCheckBox) {
        // pdf.js's annotationStorage returns the export value of the
        // checked option (or `Off`) — treat any truthy non-"Off"
        // string as checked.
        const checked =
          typeof rawValue === 'boolean'
            ? rawValue
            : typeof rawValue === 'string'
              ? rawValue.length > 0 && rawValue !== 'Off'
              : Boolean(rawValue);
        if (checked) field.check();
        else field.uncheck();
        written += 1;
      } else if (field instanceof PDFRadioGroup) {
        const selected = Array.isArray(rawValue) ? rawValue[0] : rawValue;
        if (selected != null && String(selected).length > 0) {
          field.select(String(selected));
          written += 1;
        } else {
          field.clear();
          written += 1;
        }
      } else if (field instanceof PDFDropdown) {
        const selected = Array.isArray(rawValue) ? rawValue[0] : rawValue;
        if (selected != null && String(selected).length > 0) {
          field.select(String(selected));
          written += 1;
        } else {
          field.clear();
          written += 1;
        }
      } else if (field instanceof PDFOptionList) {
        const selections = Array.isArray(rawValue)
          ? rawValue.map(String)
          : rawValue != null
            ? [String(rawValue)]
            : [];
        if (selections.length > 0) {
          field.select(selections);
        } else {
          field.clear();
        }
        written += 1;
      } else if (field instanceof PDFSignature) {
        skipped.push({ name, reason: 'signature field (use the sign flow)' });
      } else {
        skipped.push({ name, reason: 'unsupported field type' });
      }
    } catch (err) {
      skipped.push({
        name,
        reason: `write failed: ${(err as Error).message ?? 'unknown'}`,
      });
    }
  }

  if (isFlatten) {
    try {
      manualFlatten(doc, form);
    } catch (err) {
      throw new NodePdfError('READ_FAILED', 'Form flatten failed', err);
    }
  }

  // Re-attach /Encrypt to the trailer BEFORE serializing so the
  // emitted output still flags the file as encrypted.
  restoreEncryptionRef(doc, encryptRef);

  let outBytes: Uint8Array;
  try {
    outBytes = isFlatten
      ? await doc.save({ useObjectStreams: false })
      : await doc.commit({ useObjectStreams: false });
  } catch (err) {
    console.error('[fillForm] serialize failed:', err);
    throw new NodePdfError('READ_FAILED', 'Failed to serialize PDF', err);
  }

  await safeWritePdf(filePath, outBytes, { password, context: 'fillForm' });

  return { written, skipped };
}

/**
 * Manual replacement for `form.flatten()`. Skips pdf-lib's flatten
 * entirely because the combination of `form.flatten()` +
 * `commit({ useObjectStreams: false })` is a known-bad combo that
 * leaves pdf.js with "Invalid Root reference" on the next open
 * (see issue thread links in the load comment above). What pdf-lib
 * does wrong:
 *   - The per-widget draw loop is wrapped in a try/catch but the
 *     subsequent `removeField` only PARTIALLY catches its own
 *     findWidgetPage throws — the dict-removal phase still mutates
 *     /AcroForm.Fields and deletes child refs even when the widget
 *     was orphan. The result is dangling refs in the trailer.
 *   - `commit({useObjectStreams:false})` layers a fresh xref over
 *     the partially-mutated catalog; pdf.js's strict parser bails.
 *
 * Our pipeline (qpdf's `--generate-appearances --flatten-annotations
 * --remove-acroform` recipe):
 *   1. `updateFieldAppearances()` — regenerate appearance streams
 *      while the form is still intact, using the default font
 *      pdf-lib embeds on demand.
 *   2. For each field's widgets, find its page (with the same
 *      two-step lookup pdf-lib uses internally); if found, register
 *      the widget's normal-appearance ref as an XObject on the
 *      page, then push draw operators onto the page content stream.
 *      Orphan widgets are silently skipped — no draw, no error.
 *   3. Remove the widget annotation from the page's /Annots so it
 *      doesn't render as an interactive overlay on top of the
 *      baked-in graphics.
 *   4. Clear `/AcroForm.Fields` on the catalog so readers don't see
 *      any fields anymore. We deliberately do NOT delete the field
 *      / widget dicts themselves — pdf-lib's full save will
 *      garbage-collect anything unreferenced, and leaving them
 *      alone avoids the dangling-ref class of corruption.
 *
 * Caller must use `doc.save()` (full save) afterwards — not
 * `doc.commit()` — because we've mutated the catalog.
 */
function manualFlatten(doc: PDFDocument, form: PDFForm): void {
  // Force every field to regenerate its appearance stream — NOT just
  // the dirty ones. pdf-lib's `updateFieldAppearances()` skips fields
  // whose widget already has a `/AP /N` stream on disk (the upstream
  // `needsAppearancesUpdate()` short-circuit). That breaks the
  // keep-then-flatten flow: the keep save wrote the field /V to disk
  // with a stub /AP /N, the renderer reloaded, the next-session
  // flatten finds the field "not dirty" and re-uses the stale
  // appearance — which for text fields is often empty, so flattened
  // text comes out blank. Marking everything dirty before update
  // forces regen from the current /V state for every field type.
  for (const field of form.getFields()) {
    if (field instanceof PDFSignature) continue;
    form.markFieldAsDirty(field.ref);
  }
  form.updateFieldAppearances();

  const pages = doc.getPages();
  const pageByRef = new Map<PDFRef, PDFPage>();
  for (const p of pages) pageByRef.set(p.ref, p);

  const fields = form.getFields();
  for (const field of fields) {
    const widgets = field.acroField.getWidgets();
    for (const widget of widgets) {
      const page = resolveWidgetPage(doc, widget, pageByRef);
      if (!page) continue;

      let appearanceRef: PDFRef | null = null;
      try {
        appearanceRef = resolveWidgetAppearanceRef(doc, field, widget);
      } catch {
        // No usable appearance (e.g. signature placeholder with no
        // /AP). Skip drawing but still remove the widget from the
        // page so it doesn't render as an interactive overlay.
        appearanceRef = null;
      }

      if (appearanceRef) {
        try {
          const xObjectKey = page.node.newXObject('FlatWidget', appearanceRef);
          const rect = widget.getRectangle();
          const ops = [
            pushGraphicsState(),
            translate(rect.x, rect.y),
            ...rotateInPlace({ ...rect, rotation: 0 }),
            drawObject(xObjectKey),
            popGraphicsState(),
          ];
          page.pushOperators(...ops);
        } catch (err) {
          // Drawing failed for this widget — log and continue. The
          // widget will end up un-baked but the rest of the flatten
          // proceeds. Better than throwing and aborting the save.
          console.warn(
            `[manualFlatten] draw failed for field "${field.getName()}"`,
            err,
          );
        }
      }

      // Remove the widget annotation from the page so the flattened
      // PDF doesn't render an interactive layer on top of our
      // baked-in graphics. Best-effort — guard against undefined ref.
      const widgetRef = doc.context.getObjectRef(widget.dict);
      if (widgetRef) {
        try {
          page.node.removeAnnot(widgetRef);
        } catch {
          // Annot wasn't in this page's /Annots — fine, nothing to do.
        }
      }
    }
  }

  // Clear /AcroForm.Fields so readers see "no form fields" but keep
  // the /AcroForm dict itself (some readers expect it). Deleting the
  // field dicts is what triggers pdf-lib's dangling-ref bug — leave
  // them alone and let `doc.save()`'s object collector decide what's
  // reachable.
  try {
    const acroFormRaw = doc.catalog.get(PDFName.of('AcroForm'));
    let acroForm: PDFDict | null = null;
    if (acroFormRaw instanceof PDFRef) {
      acroForm = doc.context.lookup(acroFormRaw, PDFDict);
    } else if (acroFormRaw instanceof PDFDict) {
      acroForm = acroFormRaw;
    }
    if (acroForm) {
      acroForm.set(PDFName.of('Fields'), doc.context.obj([]));
    }
  } catch (err) {
    console.warn('[manualFlatten] could not clear /AcroForm.Fields', err);
  }
}

/**
 * pdf-lib's two-step lookup, repackaged so callers get null instead
 * of a throw for orphan widgets:
 *   1. Match `widget.P()` against the page tree.
 *   2. Fall back to walking every page's /Annots for the widget's
 *      own ref.
 *   3. Return null if both fail.
 */
function resolveWidgetPage(
  doc: PDFDocument,
  widget: ReturnType<PDFField['acroField']['getWidgets']>[number],
  pageByRef: Map<PDFRef, PDFPage>,
): PDFPage | null {
  const p = widget.P();
  if (p instanceof PDFRef) {
    const direct = pageByRef.get(p);
    if (direct) return direct;
  }
  const widgetRef = doc.context.getObjectRef(widget.dict);
  if (!widgetRef) return null;
  try {
    const page = doc.findPageForAnnotationRef(widgetRef);
    return page ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve the widget's normal-appearance ref, with the special
 * handling pdf-lib applies to checkbox/radio widgets (where the
 * /AP/N dict is keyed by export value, and we pick the entry
 * matching the field's current selection or fall back to "Off").
 */
function resolveWidgetAppearanceRef(
  doc: PDFDocument,
  field: PDFField,
  widget: ReturnType<PDFField['acroField']['getWidgets']>[number],
): PDFRef {
  let refOrDict: unknown = widget.getNormalAppearance();
  if (field instanceof PDFCheckBox || field instanceof PDFRadioGroup) {
    if (refOrDict instanceof PDFRef) {
      refOrDict = doc.context.lookup(refOrDict, PDFDict);
    }
    if (refOrDict instanceof PDFDict) {
      const value = (field.acroField as { getValue(): PDFName }).getValue();
      const picked = refOrDict.get(value) ?? refOrDict.get(PDFName.of('Off'));
      if (picked instanceof PDFRef) refOrDict = picked;
    }
  }
  if (!(refOrDict instanceof PDFRef)) {
    throw new Error(`No appearance ref for field "${field.getName()}"`);
  }
  return refOrDict;
}

