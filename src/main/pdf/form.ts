import fs from 'node:fs/promises';
import {
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
  PDFSignature,
  PDFTextField,
  type PDFField,
} from '@cantoo/pdf-lib';

import { NodePdfError } from '~shared/types/errors.js';
import type {
  FillFormInput,
  FillFormResult,
  FormFieldInfo,
  FormFieldType,
  FormInfo,
} from '~shared/types/forms.js';
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

  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, {
      forIncrementalUpdate: true,
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

  if (mode === 'flatten') {
    try {
      form.flatten();
    } catch (err) {
      throw new NodePdfError('READ_FAILED', 'Form flatten failed', err);
    }
  }

  let outBytes: Uint8Array;
  try {
    outBytes = await doc.commit({ useObjectStreams: false });
  } catch (err) {
    console.error('[fillForm] commit failed:', err);
    throw new NodePdfError('READ_FAILED', 'Failed to serialize PDF', err);
  }

  await safeWritePdf(filePath, outBytes, { password, context: 'fillForm' });

  return { written, skipped };
}
