/**
 * Putting new interactive fields onto a page.
 *
 * Reading and filling a form that already exists is `forms.ts`. This is the
 * other direction: turning a printed form, or a scan of one, into something
 * that can be typed into and sent back.
 *
 * pdf-lib builds the field objects and their appearance streams, so the work
 * here is mostly the things it will not decide: that a name has to be unique
 * across the whole document, that a field added to a page that was later
 * deleted has nowhere to go, and that one bad field must not take the save
 * down with it.
 */

import { PDFDict, PDFDocument, PDFFont, PDFName, PDFString, StandardFonts, rgb, type PDFPage } from 'pdf-lib';

export type NewFieldKind = 'text' | 'checkbox' | 'dropdown';

/** A field to be created, in the page's own coordinates. */
export interface NewField {
  id: string;
  kind: NewFieldKind;
  /** What the field is called in the saved file, and in any data exported from it. */
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Choices, for a dropdown. Ignored by the other kinds. */
  options?: string[];
  /** Point size for typed text. Zero means fit to the box, which pdf-lib supports. */
  size?: number;
}

export interface NewFieldWarning {
  field: string;
  detail: string;
}

/**
 * Creates the given fields on the given pages.
 *
 * Names are made unique against the fields the document already has and
 * against each other, because two fields sharing a name in a PDF are two
 * widgets of *one* field: typing in either fills both. That is occasionally
 * what somebody wants and never what they expect, so it is not done by
 * accident here.
 */
export async function addFields(
  doc: PDFDocument,
  byPage: Map<number, NewField[]>,
): Promise<NewFieldWarning[]> {
  const warnings: NewFieldWarning[] = [];
  if (!byPage.size) return warnings;

  let form;
  try {
    form = doc.getForm();
  } catch (e) {
    warnings.push({ field: '(form)', detail: `could not open the document's form: ${(e as Error).message}` });
    return warnings;
  }

  // A text field needs a default appearance, a default appearance names a
  // font, and the name it uses is resolved through the form's own resource
  // dictionary. A document that never had a form has neither, so both are put
  // in place here. Passing a font to addToPage is not enough on its own:
  // pdf-lib looks the appearance up on the field or the form before it ever
  // gets to the font, and every text field is rejected with "No /DA entry".
  let font: PDFFont;
  try {
    font = await doc.embedFont(StandardFonts.Helvetica);
    const acro = form.acroForm.dict;
    let dr = acro.lookup(PDFName.of('DR'));
    if (!(dr instanceof PDFDict)) {
      dr = doc.context.obj({}) as PDFDict;
      acro.set(PDFName.of('DR'), dr);
    }
    let fonts = (dr as PDFDict).lookup(PDFName.of('Font'));
    if (!(fonts instanceof PDFDict)) {
      fonts = doc.context.obj({}) as PDFDict;
      (dr as PDFDict).set(PDFName.of('Font'), fonts);
    }
    (fonts as PDFDict).set(PDFName.of('Helv'), font.ref);
    // Zero point size means "fit the box", which is what a field of unknown
    // content wants, and black text.
    if (!acro.lookup(PDFName.of('DA'))) acro.set(PDFName.of('DA'), PDFString.of('/Helv 0 Tf 0 g'));
  } catch (e) {
    warnings.push({ field: '(form)', detail: `could not prepare the form: ${(e as Error).message}` });
    return warnings;
  }

  const taken = new Set<string>();
  try {
    for (const f of form.getFields()) taken.add(f.getName());
  } catch {
    // A form too damaged to enumerate is still one new fields can be added to.
  }

  const unique = (want: string): string => {
    const base = want.trim() || 'Field';
    if (!taken.has(base)) {
      taken.add(base);
      return base;
    }
    for (let n = 2; ; n++) {
      const tryName = `${base} ${n}`;
      if (!taken.has(tryName)) {
        taken.add(tryName);
        return tryName;
      }
    }
  };

  for (const [pageIndex, fields] of byPage) {
    if (pageIndex < 0 || pageIndex >= doc.getPageCount()) {
      // The page it was drawn on is not in the output any more, which is what
      // deleting that page means. Saying so beats a field silently missing.
      for (const f of fields) {
        warnings.push({ field: f.name, detail: 'the page this field was on is no longer in the document' });
      }
      continue;
    }
    const page = doc.getPage(pageIndex);
    for (const field of fields) {
      try {
        addOne(form, page, field, unique(field.name), font);
      } catch (e) {
        // One bad field must not cost the save. Everything else still lands.
        warnings.push({ field: field.name, detail: `could not be created: ${(e as Error).message}` });
      }
    }
  }

  return warnings;
}

/** Writes the /DA a field needs before anything will draw or measure it. */
function setDefaultAppearance(dict: PDFDict, size: number): void {
  dict.set(PDFName.of('DA'), PDFString.of(`/Helv ${size} Tf 0 g`));
}

function addOne(
  form: ReturnType<PDFDocument['getForm']>,
  page: PDFPage,
  field: NewField,
  name: string,
  font: PDFFont,
): void {
  // A border, because an invisible field on a printed form is a field nobody
  // finds. Readers draw their own highlight over it; this is what survives
  // printing and what shows in readers that do not.
  const box = {
    x: field.x,
    y: field.y,
    width: Math.max(6, field.width),
    height: Math.max(6, field.height),
    borderColor: rgb(0.35, 0.4, 0.5),
    borderWidth: 1,
  };

  if (field.kind === 'checkbox') {
    const check = form.createCheckBox(name);
    // Square, and no bigger than the box drawn: a checkbox stretched to a wide
    // rectangle draws a tick that does not look like a tick.
    const side = Math.max(8, Math.min(box.width, box.height));
    check.addToPage(page, { ...box, width: side, height: side });
    return;
  }

  if (field.kind === 'dropdown') {
    const drop = form.createDropdown(name);
    setDefaultAppearance(drop.acroField.dict, field.size ?? 0);
    drop.addOptions(field.options?.length ? field.options : ['']);
    drop.addToPage(page, { ...box, font });
    return;
  }

  const text = form.createTextField(name);
  // The default appearance is written directly rather than through
  // setFontSize, which parses the field's existing one and throws on a field
  // that has never had it. Zero means fit the box, which is what a field of
  // unknown content wants; anything else is the size asked for.
  setDefaultAppearance(text.acroField.dict, field.size ?? 0);
  text.addToPage(page, { ...box, font });
}
