/**
 * Interactive form fields.
 *
 * A fillable PDF already knows where its boxes are, what they are called and
 * what may go in them. Typing over such a form as loose text works but throws
 * that away: the result no longer answers the questions it was asked, cannot be
 * read back by whoever sent it, and ignores the field's own rules about length,
 * options and whether it may be changed at all.
 *
 * Values are written through pdf-lib's form support, which also regenerates each
 * field's appearance stream. Setting a value without doing that leaves most
 * viewers showing the old contents, which is the classic way filled forms come
 * out blank.
 */

import {
  PDFArray,
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
  PDFSignature,
  PDFTextField,
} from 'pdf-lib';

export type FieldType = 'text' | 'checkbox' | 'radio' | 'dropdown' | 'optionlist' | 'signature' | 'other';

export interface FormField {
  name: string;
  type: FieldType;
  /** Current value: text, the selected option, or 'on' for a ticked box. */
  value: string;
  options: string[];
  readOnly: boolean;
  required: boolean;
  multiline: boolean;
  maxLength: number | null;
  pageIndex: number;
  /** Widget rectangle in PDF page coordinates, y measured upwards. */
  rect: { x: number; y: number; width: number; height: number };
}

export interface FormReport {
  fields: FormField[];
  /** True when the document uses XFA, whose fields this cannot drive. */
  isXfa: boolean;
}

function classify(field: unknown): FieldType {
  if (field instanceof PDFTextField) return 'text';
  if (field instanceof PDFCheckBox) return 'checkbox';
  if (field instanceof PDFRadioGroup) return 'radio';
  if (field instanceof PDFDropdown) return 'dropdown';
  if (field instanceof PDFOptionList) return 'optionlist';
  if (field instanceof PDFSignature) return 'signature';
  return 'other';
}

function currentValue(field: unknown): string {
  try {
    if (field instanceof PDFTextField) return field.getText() ?? '';
    if (field instanceof PDFCheckBox) return field.isChecked() ? 'on' : '';
    if (field instanceof PDFRadioGroup) return field.getSelected() ?? '';
    if (field instanceof PDFDropdown) return field.getSelected()[0] ?? '';
    if (field instanceof PDFOptionList) return field.getSelected()[0] ?? '';
  } catch {
    // A field that will not report its value is shown as empty.
  }
  return '';
}

function optionsOf(field: unknown): string[] {
  try {
    if (field instanceof PDFRadioGroup) return field.getOptions();
    if (field instanceof PDFDropdown) return field.getOptions();
    if (field instanceof PDFOptionList) return field.getOptions();
  } catch {
    // Not fatal; the field is simply offered without a list.
  }
  return [];
}

/** Reads every fillable field, with where it sits on the page. */
export function readForm(doc: PDFDocument): FormReport {
  // A damaged form must leave the document usable for everything else.
  try {
    return readFormUnsafe(doc);
  } catch {
    return { fields: [], isXfa: false };
  }
}

function readFormUnsafe(doc: PDFDocument): FormReport {
  let form;
  try {
    form = doc.getForm();
  } catch {
    return { fields: [], isXfa: false };
  }

  let isXfa = false;
  try {
    isXfa = form.hasXFA();
  } catch {
    isXfa = false;
  }

  // Which page a widget sits on is worked out from each page's own annotation
  // list. pdf-lib can answer this too, but only through a private method, and a
  // widget is on a page precisely because that page lists it.
  const pageOfWidget = new Map<unknown, number>();
  doc.getPages().forEach((page, i) => {
    const annots = page.node.Annots();
    if (!(annots instanceof PDFArray)) return;
    for (let k = 0; k < annots.size(); k++) {
      const annot = annots.lookup(k);
      if (annot) pageOfWidget.set(annot, i);
    }
  });

  const fields: FormField[] = [];

  for (const field of form.getFields()) {
    const type = classify(field);
    if (type === 'other') continue;

    let widgets;
    try {
      widgets = field.acroField.getWidgets();
    } catch {
      continue;
    }

    const value = currentValue(field);
    const options = optionsOf(field);
    let readOnly = false;
    let required = false;
    try {
      readOnly = field.isReadOnly();
      required = field.isRequired();
    } catch {
      // Flags are advisory here; absence is treated as permissive.
    }
    const multiline = field instanceof PDFTextField ? safe(() => field.isMultiline(), false) : false;
    const maxLength = field instanceof PDFTextField ? safe(() => field.getMaxLength() ?? null, null) : null;

    for (const widget of widgets) {
      const pageIndex = pageOfWidget.get(widget.dict) ?? -1;
      if (pageIndex < 0) continue;

      let rect;
      try {
        rect = widget.getRectangle();
      } catch {
        continue;
      }
      // A zero sized widget is a hidden field, not something to offer.
      if (!rect || rect.width < 1 || rect.height < 1) continue;

      fields.push({
        name: field.getName(),
        type,
        value,
        options,
        readOnly,
        required,
        multiline,
        maxLength,
        pageIndex,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      });
    }
  }

  return { fields, isXfa };
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export interface FormWarning {
  field: string;
  detail: string;
}

/**
 * Writes values into a document's fields and regenerates their appearances.
 *
 * Read-only fields are refused rather than forced, because a form marks them
 * that way for a reason and a recipient's software may reject a file that
 * changed them.
 */
export function applyFormValues(doc: PDFDocument, values: Map<string, string>): FormWarning[] {
  const warnings: FormWarning[] = [];
  if (!values.size) return warnings;

  let form;
  try {
    form = doc.getForm();
  } catch {
    return [{ field: '(document)', detail: 'this PDF has no interactive form' }];
  }

  for (const [name, value] of values) {
    let field;
    try {
      field = form.getFieldMaybe(name);
    } catch {
      field = undefined;
    }
    if (!field) {
      warnings.push({ field: name, detail: 'field is no longer present' });
      continue;
    }
    if (safe(() => field.isReadOnly(), false)) {
      warnings.push({ field: name, detail: 'field is read only and was left alone' });
      continue;
    }

    try {
      if (field instanceof PDFTextField) {
        const max = field.getMaxLength();
        field.setText(max && value.length > max ? value.slice(0, max) : value);
      } else if (field instanceof PDFCheckBox) {
        if (value) field.check();
        else field.uncheck();
      } else if (field instanceof PDFRadioGroup) {
        if (value) field.select(value);
        else field.clear();
      } else if (field instanceof PDFDropdown) {
        if (value) field.select(value);
        else field.clear();
      } else if (field instanceof PDFOptionList) {
        if (value) field.select(value);
        else field.clear();
      } else {
        warnings.push({ field: name, detail: 'this kind of field cannot be filled here' });
      }
    } catch (e) {
      warnings.push({ field: name, detail: (e as Error).message });
    }
  }

  // Without this, most viewers keep showing whatever the field looked like
  // before, which is why filled forms so often open blank.
  try {
    form.updateFieldAppearances();
  } catch (e) {
    warnings.push({ field: '(appearances)', detail: (e as Error).message });
  }

  return warnings;
}
