/**
 * AcroForm types shared between main and renderer. XFA (Adobe's
 * XML-based form format used by some govt PDFs like Mexican SAT) is
 * intentionally out of scope — pdf.js supports it only partially and
 * @cantoo/pdf-lib doesn't expose a writer for it.
 */
export type FormFieldType =
  | 'text'
  | 'checkbox'
  | 'radio'
  | 'dropdown'
  | 'listbox'
  | 'signature'
  | 'unknown';

export interface FormFieldInfo {
  /** Fully-qualified field name (`/T`). Unique within the form. */
  name: string;
  type: FormFieldType;
  /** Whether the field is read-only (`/Ff` bit 1). UI should still show
   * the value but disable editing. */
  readOnly: boolean;
  /** Current value as a primitive — text fields return their string,
   * checkboxes return boolean, radio/dropdown return the selected
   * option label, listbox returns an array of selected labels. */
  value?: string | boolean | string[];
}

export interface FormInfo {
  /** True if the PDF carries any AcroForm fields. */
  hasForm: boolean;
  /** Field count. Useful for the status bar even when we don't ship
   * the full field list to the renderer. */
  fieldCount: number;
  /** Count of fields whose value differs from the empty/default state.
   * Drives the "X of Y filled" status bar pill. */
  filledCount: number;
  fields: FormFieldInfo[];
}

export interface FillFormInput {
  filePath: string;
  /** Map of field name → primitive value. Same primitive flavors as
   * `FormFieldInfo.value`. Fields not present in the map are left
   * untouched. */
  values: Record<string, string | boolean | string[]>;
  /** `keep` (default): incremental save, fields remain editable.
   * `flatten`: bakes the values into page graphics and removes the
   * form so the PDF prints/looks the same everywhere. */
  mode?: 'keep' | 'flatten';
  /** Password for source PDFs that are encrypted. */
  password?: string;
}

export interface FillFormResult {
  /** Number of fields actually written (skips unknown names and
   * signature fields). */
  written: number;
  /** Field names we skipped and why — surfaced so the renderer can
   * show a non-fatal warning toast. */
  skipped: Array<{ name: string; reason: string }>;
}
