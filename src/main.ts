/**
 * Application wiring: file open, toolbar, thumbnails, properties panel, save.
 */

import './style.css';
import { HandpressDocument, type OutlineEntry, type PageModel, type SearchMatch } from './app/model';
import { splitChunks } from './pdf/split';
import { Viewer } from './app/viewer';
import { LocalFontProvider, localFontsSupported } from './app/local-fonts';
import { DecryptionError } from './pdf/decrypt';
import { SignaturePad, signatureFromFile, type CapturedSignature } from './app/signature';
import {
  OCR_SCALE,
  availableLanguages,
  openRecogniser,
  wordsToInsertions,
  type Recogniser,
} from './app/ocr';
import { looksLikeImage, pdfFromImages } from './pdf/images';
import { compress } from './pdf/compress';
import { zip } from './pdf/zip';
import { encrypt } from './pdf/encrypt';
import { AUTOSAVE_LIMIT, forget, howLongAgo, keep, recover } from './app/autosave';
import { recompressInBrowser } from './app/recompress';
import { standardTextWidth } from './pdf/fonts';
import type { TextLine } from './pdf/content';

declare const __APP_VERSION__: string;

/**
 * Looks up an element that the page is required to contain.
 *
 * It throws rather than casting a null through, because it used to cast a null
 * through. Rearranging the toolbar dropped the zoom control out of the markup,
 * nothing said so, and the first sign of it was every document reporting
 * "Could not open that PDF" while opening perfectly well: a null read three
 * calls away from the missing tag. Everything here is built at startup, so a
 * throw stops the app on the first load with the id that is missing, which is
 * where the mistake actually is.
 */
const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`The page is missing #${id}`);
  return el as T;
};

/**
 * What went wrong, in a form fit to show someone.
 *
 * Not everything thrown is an Error. A worker that fails to start rejects with
 * nothing at all, and "Could not read that: undefined" tells nobody anything.
 */
const reason = (e: unknown): string => {
  const message = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  return message || 'something went wrong that did not say what it was';
};

const els = {
  docTitle: $('docTitle'),
  btnOpen: $<HTMLButtonElement>('btnOpen'),
  btnSave: $<HTMLButtonElement>('btnSave'),
  btnPrint: $<HTMLButtonElement>('btnPrint'),
  btnChoose: $<HTMLButtonElement>('btnChoose'),
  btnUndo: $<HTMLButtonElement>('btnUndo'),
  btnRedo: $<HTMLButtonElement>('btnRedo'),
  btnZoomIn: $<HTMLButtonElement>('btnZoomIn'),
  btnZoomOut: $<HTMLButtonElement>('btnZoomOut'),
  btnSidebar: $<HTMLButtonElement>('btnSidebar'),
  tabPages: $<HTMLButtonElement>('tabPages'),
  tabOutline: $<HTMLButtonElement>('tabOutline'),
  outline: $('outline'),
  btnPanel: $<HTMLButtonElement>('btnPanel'),
  btnLocalFonts: $<HTMLButtonElement>('btnLocalFonts'),
  btnModeEdit: $<HTMLButtonElement>('btnModeEdit'),
  btnModeSelect: $<HTMLButtonElement>('btnModeSelect'),
  btnModeAdd: $<HTMLButtonElement>('btnModeAdd'),
  addSize: $<HTMLSelectElement>('addSize'),
  addColor: $<HTMLInputElement>('addColor'),
  btnSign: $<HTMLButtonElement>('btnSign'),
  btnErase: $<HTMLButtonElement>('btnErase'),
  btnRedact: $<HTMLButtonElement>('btnRedact'),
  btnPen: $<HTMLButtonElement>('btnPen'),
  btnInkErase: $<HTMLButtonElement>('btnInkErase'),
  penColor: $<HTMLInputElement>('penColor'),
  penWidth: $<HTMLInputElement>('penWidth'),
  penWidthLabel: $('penWidthLabel'),
  penOpacity: $<HTMLInputElement>('penOpacity'),
  penOpacityLabel: $('penOpacityLabel'),
  btnLine: $<HTMLButtonElement>('btnLine'),
  btnArrow: $<HTMLButtonElement>('btnArrow'),
  btnRect: $<HTMLButtonElement>('btnRect'),
  btnEllipse: $<HTMLButtonElement>('btnEllipse'),
  btnHighlight: $<HTMLButtonElement>('btnHighlight'),
  btnNote: $<HTMLButtonElement>('btnNote'),
  btnOcr: $<HTMLButtonElement>('btnOcr'),
  ocrLang: $<HTMLSelectElement>('ocrLang'),
  highlightColor: $<HTMLInputElement>('highlightColor'),
  btnAddPages: $<HTMLButtonElement>('btnAddPages'),
  searchInput: $<HTMLInputElement>('searchInput'),
  searchCount: $('searchCount'),
  searchPrev: $<HTMLButtonElement>('searchPrev'),
  searchNext: $<HTMLButtonElement>('searchNext'),
  btnFind: $<HTMLButtonElement>('btnFind'),
  btnReplaceToggle: $<HTMLButtonElement>('btnReplaceToggle'),
  replaceBar: $('replaceBar'),
  replaceInput: $<HTMLInputElement>('replaceInput'),
  btnReplaceOne: $<HTMLButtonElement>('btnReplaceOne'),
  btnReplaceAll: $<HTMLButtonElement>('btnReplaceAll'),
  btnExtract: $<HTMLButtonElement>('btnExtract'),
  btnPageImage: $<HTMLButtonElement>('btnPageImage'),
  btnRotateLeft: $<HTMLButtonElement>('btnRotateLeft'),
  btnRotateRight: $<HTMLButtonElement>('btnRotateRight'),
  btnDeletePage: $<HTMLButtonElement>('btnDeletePage'),
  btnStamp: $<HTMLButtonElement>('btnStamp'),
  stampModal: $('stampModal'),
  stampPreset: $<HTMLSelectElement>('stampPreset'),
  stampText: $<HTMLInputElement>('stampText'),
  stampSize: $<HTMLInputElement>('stampSize'),
  stampRotate: $<HTMLInputElement>('stampRotate'),
  stampOpacity: $<HTMLInputElement>('stampOpacity'),
  stampColor: $<HTMLInputElement>('stampColor'),
  stampRange: $<HTMLInputElement>('stampRange'),
  stampHint: $('stampHint'),
  stampCancel: $<HTMLButtonElement>('stampCancel'),
  stampGo: $<HTMLButtonElement>('stampGo'),
  btnCrop: $<HTMLButtonElement>('btnCrop'),
  btnUncrop: $<HTMLButtonElement>('btnUncrop'),
  btnCompress: $<HTMLButtonElement>('btnCompress'),
  btnSplit: $<HTMLButtonElement>('btnSplit'),
  splitModal: $('splitModal'),
  splitEvery: $<HTMLInputElement>('splitEvery'),
  splitRange: $<HTMLInputElement>('splitRange'),
  splitHint: $('splitHint'),
  splitCancel: $<HTMLButtonElement>('splitCancel'),
  splitGo: $<HTMLButtonElement>('splitGo'),
  btnProtect: $<HTMLButtonElement>('btnProtect'),
  unlockModal: $('unlockModal'),
  unlockPassword: $<HTMLInputElement>('unlockPassword'),
  unlockHint: $('unlockHint'),
  unlockCancel: $<HTMLButtonElement>('unlockCancel'),
  unlockGo: $<HTMLButtonElement>('unlockGo'),
  protectModal: $('protectModal'),
  protectPassword: $<HTMLInputElement>('protectPassword'),
  protectConfirm: $<HTMLInputElement>('protectConfirm'),
  protectHint: $('protectHint'),
  protectCancel: $<HTMLButtonElement>('protectCancel'),
  protectGo: $<HTMLButtonElement>('protectGo'),
  mergeFileInput: $<HTMLInputElement>('mergeFileInput'),
  extractModal: $('extractModal'),
  extractRange: $<HTMLInputElement>('extractRange'),
  extractHint: $('extractHint'),
  extractCancel: $<HTMLButtonElement>('extractCancel'),
  extractGo: $<HTMLButtonElement>('extractGo'),
  sigModal: $('sigModal'),
  sigPad: $<HTMLCanvasElement>('sigPad'),
  sigTabDraw: $<HTMLButtonElement>('sigTabDraw'),
  sigTabUpload: $<HTMLButtonElement>('sigTabUpload'),
  sigDrawPanel: $('sigDrawPanel'),
  sigUploadPanel: $('sigUploadPanel'),
  sigChoose: $<HTMLButtonElement>('sigChoose'),
  sigRemoveBg: $<HTMLInputElement>('sigRemoveBg'),
  sigPreview: $('sigPreview'),
  sigFileInput: $<HTMLInputElement>('sigFileInput'),
  sigWidth: $<HTMLSelectElement>('sigWidth'),
  sigClear: $<HTMLButtonElement>('sigClear'),
  sigCancel: $<HTMLButtonElement>('sigCancel'),
  sigUse: $<HTMLButtonElement>('sigUse'),
  btnPrev: $<HTMLButtonElement>('btnPrev'),
  btnNext: $<HTMLButtonElement>('btnNext'),
  zoomSelect: $<HTMLSelectElement>('zoomSelect'),
  fileInput: $<HTMLInputElement>('fileInput'),
  viewer: $('viewer'),
  dropzone: $('dropzone'),
  workspace: document.querySelector('.workspace') as HTMLElement,
  thumbs: $('thumbs'),
  panelBody: $('panelBody'),
  statusMessage: $('statusMessage'),
  editCount: $('editCount'),
  pageInput: $<HTMLInputElement>('pageInput'),
  pageTotal: $('pageTotal'),
  busy: $('busy'),
  notice: $('notice'),
  noticeText: $('noticeText'),
  noticeClose: $<HTMLButtonElement>('noticeClose'),
  restoreBar: $('restoreBar'),
  restoreText: $('restoreText'),
  restoreGo: $<HTMLButtonElement>('restoreGo'),
  restoreDiscard: $<HTMLButtonElement>('restoreDiscard'),
  busyText: $('busyText'),
};

let doc: HandpressDocument | null = null;
let statusTimer: number | undefined;
/** Remembered so saving can repeat the warning at the moment it matters. */
let signedDocument = false;

function setStatus(message: string, tone: 'info' | 'warn' = 'info'): void {
  els.statusMessage.textContent = message;
  els.statusMessage.classList.toggle('warn', tone === 'warn');
  window.clearTimeout(statusTimer);
  if (message) {
    statusTimer = window.setTimeout(
      () => {
        els.statusMessage.textContent = '';
        els.statusMessage.classList.remove('warn');
      },
      tone === 'warn' ? 9000 : 4000,
    );
  }
}

function showNotice(message: string | null): void {
  els.noticeText.textContent = message ?? '';
  els.notice.hidden = !message;
}

els.noticeClose.addEventListener('click', () => {
  els.notice.hidden = true;
});

function setBusy(on: boolean, text = 'Working…'): void {
  els.busyText.textContent = text;
  els.busy.hidden = !on;
}

const viewer = new Viewer(els.viewer, {
  onSelect: showProperties,
  onEdited: () => {
    syncEditState();
    if (matches.length) void runSearch();
    scheduleAutosave();
    void renderThumbs();
  },
  onStatus: setStatus,
  onZoomedByHand: (zoom) => {
    els.zoomSelect.value = nearestZoom(zoom);
  },
  onPagesChanged(message) {
    void applyPageChange(true).then(() => setStatus(message));
  },
});

/* ---------------- opening ---------------- */

async function openFile(file: File, password?: string): Promise<void> {
  const isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
  if (!isPdf && !looksLikeImage(file)) {
    setStatus('That is not a PDF or an image.', 'warn');
    return;
  }

  setBusy(true, `Opening ${file.name}…`);
  // Declared out here so it is released whether the open succeeds or not.
  let previous: HandpressDocument | null = null;
  try {
    let bytes: Uint8Array<ArrayBuffer> = new Uint8Array(await file.arrayBuffer());
    let name = file.name;

    // A picture becomes a one page PDF of its own size. Turning an image into a
    // PDF is one of the most common things anyone wants, and once it is a page
    // every other tool here applies to it.
    if (!isPdf) {
      bytes = (await pdfFromImages([{ name: file.name, bytes }])) as Uint8Array<ArrayBuffer>;
      name = file.name.replace(/\.[^.]+$/, '') + '.pdf';
    }
    const { doc: opened, report } = await HandpressDocument.open(name, bytes, password);
    // Held, not closed. Closing here destroyed the pdf.js document while the
    // viewer was still drawing from it, and the cancelled render was reported
    // as the new file failing to open. It is released below, after the viewer
    // has let go of it. Nothing is closed before this line, so a file that
    // fails to open does not take the working document down with it.
    previous = doc;
    doc = opened;
    signedDocument = report.signatures.signatures.length > 0;
    if (localFonts.enabled) doc.fontProvider = localFonts;

    els.dropzone.hidden = true;
    els.restoreBar.hidden = true;
    document.getElementById('app')?.classList.remove('no-document');
    // Only worth showing when there is a scan to read, and only when there is
    // more than one language to choose between.
    els.ocrLang.hidden = !report.scannedPages.length || els.ocrLang.options.length < 2;
    showNotice(report.signatureWarning);
    els.docTitle.textContent = name;
    els.docTitle.classList.remove('dirty');
    els.pageTotal.textContent = `/ ${report.pageCount}`;
    els.pageInput.value = '1';

    await viewer.load(doc);
    await applyZoomChoice();
    // Thumbnails fill in behind the document rather than holding it up. On a
    // long file they take far longer than the first page does, and waiting for
    // them made opening look stuck when the document was already usable.
    void renderThumbs();
    void renderOutline();
    syncEditState();


    if (!report.canEdit) {
      // Viewable but not rewritable. Saying so at the door is kinder than
      // letting somebody edit for ten minutes and fail at the save, and the
      // tools that would fail are turned off in syncEditState above. Splitting
      // and extracting are not offered here: both rebuild the file, which is
      // the thing that cannot be done.
      showNotice(
        'This file is damaged in a way the editor cannot work with. Handpress can show it, its text can be ' +
          'selected and copied, and its pages can be saved as images, but it cannot be changed or saved as a PDF.',
      );
      // The status line should not then suggest recognition would help,
      // because nothing can be written back.
      setStatus(`Opened ${report.pageCount} page${report.pageCount === 1 ? '' : 's'}, for reading only.`);
    } else if (report.scannedPages.length) {
      setStatus(
        report.scannedPages.length === report.pageCount
          ? 'This PDF has no text layer. It looks like a scan, so there is no text to edit; it would need OCR first.'
          : `Page ${report.scannedPages[0] + 1} has no text layer and looks scanned.`,
        'warn',
      );
    } else if (report.wasEncrypted) {
      // Two different locks, and confusing them would matter: one was opened
      // without asking, the other took the password just typed in. Either way
      // the copy comes out unlocked, which is the part worth saying, because
      // quietly handing back an unprotected file would be worse than useless.
      setStatus(
        `Opened ${report.pageCount} page${report.pageCount === 1 ? '' : 's'}. ` +
          (password === undefined
            ? 'This PDF was permission locked; it has been unlocked and the copy you save will not be locked.'
            : 'The copy you save will not ask for that password. Use Protect to put one back on it.'),
      );
    } else if (doc.hasForm()) {
      setStatus(
        `Opened ${report.pageCount} page${report.pageCount === 1 ? '' : 's'}. ` +
          'This is a fillable form, so its fields are highlighted and ready to type into.',
      );
    } else {
      setStatus(`Opened ${report.pageCount} page${report.pageCount === 1 ? '' : 's'}. Click any line to edit it.`);
    }
  } catch (e) {
    if (e instanceof DecryptionError) {
      // Handpress can put a password on a document, so it had better be able to
      // take one off. Asking is the whole of it: the file is already in hand.
      askForPassword(file, password !== undefined);
    } else {
      setStatus(`Could not open that PDF: ${reason(e)}`, 'warn');
    }
  } finally {
    // After the viewer has settled its renders and pointed itself at the new
    // document, so nothing is still reading from the old one.
    void previous?.close();
    setBusy(false);
  }
}

/**
 * Asks for the password of a document that will not open without one.
 *
 * The file is held only for as long as the question is on screen, and the
 * password is passed straight to the opener and never stored. `again` is true
 * when a password was already tried, which is the difference between asking
 * and saying it was wrong.
 */
let lockedFile: File | null = null;

function askForPassword(file: File, again: boolean): void {
  lockedFile = file;
  els.unlockHint.textContent = again ? 'That password did not open it. Try another.' : '';
  els.unlockPassword.value = '';
  els.unlockModal.hidden = false;
  els.unlockPassword.focus();
}

function closeUnlock(): void {
  els.unlockModal.hidden = true;
  els.unlockPassword.value = '';
  lockedFile = null;
}

els.unlockCancel.addEventListener('click', () => {
  closeUnlock();
  setStatus('That document stays locked.');
});

els.unlockGo.addEventListener('click', () => {
  const file = lockedFile;
  const password = els.unlockPassword.value;
  if (!file) return;
  if (!password) {
    els.unlockHint.textContent = 'A password with nothing in it will not open it.';
    return;
  }
  els.unlockModal.hidden = true;
  els.unlockPassword.value = '';
  lockedFile = null;
  void openFile(file, password);
});

els.unlockPassword.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') els.unlockGo.click();
  if (e.key === 'Escape') els.unlockCancel.click();
});

els.btnOpen.addEventListener('click', () => els.fileInput.click());
els.btnChoose.addEventListener('click', () => els.fileInput.click());
els.fileInput.addEventListener('change', () => {
  const f = els.fileInput.files?.[0];
  if (f) void openFile(f);
  els.fileInput.value = '';
});

for (const type of ['dragenter', 'dragover']) {
  window.addEventListener(type, (e) => {
    e.preventDefault();
    if (!doc) els.dropzone.classList.add('dragging');
  });
}
for (const type of ['dragleave', 'drop']) {
  window.addEventListener(type, (e) => {
    e.preventDefault();
    els.dropzone.classList.remove('dragging');
  });
}
window.addEventListener('drop', (e) => {
  const files = [...((e as DragEvent).dataTransfer?.files ?? [])];
  if (!files.length) return;

  // Several images at once become one PDF, a page each, in the order they were
  // dropped. Dropping a folder of scans and getting a document is the whole
  // point of the gesture.
  const images = files.filter(looksLikeImage);
  if (images.length > 1 && images.length === files.length) {
    void openImages(images);
    return;
  }
  void openFile(files[0]);
});

/** Builds one PDF from several dropped images and opens it. */
async function openImages(files: File[]): Promise<void> {
  setBusy(true, `Making a PDF from ${files.length} images…`);
  try {
    const images = await Promise.all(
      files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })),
    );
    const bytes = await pdfFromImages(images);
    const name = `${files.length} images.pdf`;
    await openFile(new File([bytes as BlobPart], name, { type: 'application/pdf' }));
  } catch (e) {
    setStatus(`Could not make a PDF from those images: ${reason(e)}`, 'warn');
  } finally {
    setBusy(false);
  }
}

/* ---------------- keeping the work ---------------- */

/**
 * Writes the document aside a moment after the last change.
 *
 * Debounced because a rewrap touches a dozen lines at once and a save on each
 * would copy the whole file a dozen times. Two seconds of quiet is long enough
 * to be past the burst and short enough that little is at risk.
 */
let autosaveTimer: number | undefined;

function scheduleAutosave(): void {
  window.clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(() => {
    if (!doc?.hasEdits()) return;
    void keep(doc.name, doc.bytes).then((kept) => {
      if (!kept && doc && doc.bytes.length > AUTOSAVE_LIMIT) {
        setStatus('This document is too large to keep for you, so save a copy before closing the tab.', 'warn');
      }
    });
  }, 2000);
}

/** Offers back whatever the last session left behind. */
async function offerRecovery(): Promise<void> {
  const saved = await recover();
  if (!saved || doc) return;

  els.restoreText.textContent =
    `Handpress still has ${saved.name}, as it stood ${howLongAgo(saved.saved)}. ` +
    'Restoring reopens the document with those changes already in it; the undo history is not kept.';
  els.restoreBar.hidden = false;

  els.restoreGo.addEventListener('click', () => {
    els.restoreBar.hidden = true;
    void openFile(new File([saved.bytes as BlobPart], saved.name, { type: 'application/pdf' })).then(() =>
      setStatus('Restored the document from your last session.'),
    );
  });
  els.restoreDiscard.addEventListener('click', () => {
    els.restoreBar.hidden = true;
    void forget();
  });
}

void offerRecovery();

/* ---------------- saving ---------------- */

/* ---------------- printing ---------------- */

/**
 * Prints the document as a PDF, rather than printing the page it is shown on.
 *
 * The browser's own print command would print this app: toolbar, sidebar,
 * thumbnails and a canvas cropped to the window. What anyone means by printing
 * a PDF is the PDF, so the edited bytes are built and handed to the browser's
 * PDF viewer in an offscreen frame, which prints paper-sized pages at full
 * resolution with the edits in them.
 *
 * A document too damaged to rebuild is printed from the bytes it arrived as.
 * It cannot be saved, but there is nothing stopping it being printed.
 */
async function printDocument(): Promise<void> {
  if (!doc) return;
  viewer.closeEditor(false);
  setBusy(true, 'Preparing to print…');

  let bytes: Uint8Array;
  try {
    if (doc.canEdit) {
      bytes = (await doc.build()).bytes;
    } else {
      bytes = doc.bytes;
    }
  } catch (e) {
    setBusy(false);
    setStatus(`Could not prepare that for printing: ${reason(e)}`, 'warn');
    return;
  }

  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  const url = URL.createObjectURL(new Blob([copy], { type: 'application/pdf' }));

  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  // Offscreen rather than hidden: a display:none frame is not rendered, and a
  // frame that was never rendered has nothing to print.
  frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;border:0;';

  // Some browsers will not print a PDF from a frame at all. There is no way to
  // ask beforehand, so the frame gets a moment to do it and the document opens
  // in a tab if nothing happened.
  let printed = false;
  const cleanUp = (): void => {
    frame.remove();
    URL.revokeObjectURL(url);
  };

  frame.addEventListener('load', () => {
    try {
      const win = frame.contentWindow;
      if (!win) throw new Error('the print frame did not open');
      // A frame fires load for the empty document it starts with as well as
      // for the one asked for, and printing the first one prints a blank
      // sheet. Only the document that was asked for counts, and only once.
      if (printed || win.location.href === 'about:blank') return;
      win.focus();
      win.print();
      printed = true;
      setBusy(false);
      setStatus(
        signedDocument
          ? 'Sent to the printer. The printed copy carries no digital signature.'
          : 'Sent to the printer.',
      );
      // Long enough for the print dialog to have taken what it needs. Revoking
      // underneath an open dialog leaves it printing a blank page.
      window.setTimeout(cleanUp, 60000);
    } catch {
      printed = false;
    }
  });

  // Source first, then attach: a frame attached empty loads its blank document
  // before anything else, and there is no reason to make it.
  frame.src = url;
  document.body.appendChild(frame);

  window.setTimeout(() => {
    if (printed) return;
    setBusy(false);
    // Opening it is the honest fallback: the document is right there and the
    // browser's own print command works on it.
    const opened = window.open(url, '_blank');
    setStatus(
      opened
        ? 'This browser will not print from inside the page, so the PDF is open in a new tab. Print it from there.'
        : 'This browser will not print from inside the page, and the new tab was blocked. Allow pop-ups, or save a copy and print that.',
      'warn',
    );
    frame.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60000);
  }, 3000);
}

els.btnPrint.addEventListener('click', () => void printDocument());

els.btnSave.addEventListener('click', async () => {
  if (!doc) return;
  viewer.closeEditor(false);
  setBusy(true, 'Preparing your PDF…');
  try {
    const { bytes, warnings } = await doc.build();
    // A fresh buffer keeps the Blob independent of the working document.
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    const blob = new Blob([copy], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    // A copy of an untouched document is a copy, not an edit. Saying otherwise
    // in the filename is a small lie that gets filed away and believed later.
    const suffix = doc.hasEdits() ? ' (edited)' : ' (copy)';
    a.download = doc.name.replace(/\.pdf$/i, '') + suffix + '.pdf';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 20000);

    const subs = warnings.filter((w) => w.kind === 'substituted-font').length;
    const parts = ['Saved.'];
    if (subs) parts.push(`${subs} run${subs === 1 ? '' : 's'} used a substitute font.`);
    if (signedDocument) parts.push('The saved copy no longer carries a valid digital signature.');
    setStatus(parts.join(' '), signedDocument ? 'warn' : 'info');
  } catch (e) {
    setStatus(`Could not build the PDF: ${reason(e)}`, 'warn');
  } finally {
    setBusy(false);
  }
});

/* ---------------- undo / redo ---------------- */

/**
 * Undo and redo pop state instantly but rebuilding the file takes real work, so
 * a held Cmd+Z would otherwise queue one full rebuild per repeated keystroke and
 * leave the window minutes behind the user. Only the newest state is worth
 * rebuilding: a run in flight is allowed to finish, anything that arrives while
 * it runs collapses into a single rebuild afterwards.
 */
let historyRunning = false;
let historyPending = false;

async function applyHistory(changed: boolean): Promise<void> {
  if (!changed || !doc) return;
  if (historyRunning) {
    historyPending = true;
    return;
  }
  historyRunning = true;
  setBusy(true, 'Updating…');
  try {
    const pagesBefore = doc.pageCount;
    await doc.refresh();
    // A page operation changes how many pages exist, so the viewer is rebuilt.
    if (doc.pageCount !== pagesBefore) {
      await viewer.load(doc);
      await applyZoomChoice();
      els.pageTotal.textContent = `/ ${doc.pageCount}`;
    } else {
      await viewer.refreshRendered();
    }
    await renderThumbs();
    syncEditState();

  } finally {
    historyRunning = false;
    setBusy(false);
  }

  if (historyPending) {
    historyPending = false;
    // The state has already moved on; this rebuild catches the file up to it.
    await applyHistory(true);
  }
}

els.btnUndo.addEventListener('click', () => void applyHistory(doc?.undo() ?? false));
els.btnRedo.addEventListener('click', () => void applyHistory(doc?.redo() ?? false));

window.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;
  const key = e.key.toLowerCase();
  if (key === 'z') {
    e.preventDefault();
    void applyHistory(e.shiftKey ? (doc?.redo() ?? false) : (doc?.undo() ?? false));
  } else if (key === 's') {
    e.preventDefault();
    els.btnSave.click();
  } else if (key === 'p') {
    // Taken over deliberately. The browser would print this app rather than
    // the document it is showing.
    e.preventDefault();
    if (doc) void printDocument();
  } else if (key === 'o') {
    e.preventDefault();
    els.fileInput.click();
  } else if (key === 'a' && viewer.currentMode() === 'select') {
    // Only in the select tool, and only the page: the browser's own select all
    // would take the toolbar and the status line with it.
    if (viewer.selectPageText()) e.preventDefault();
  } else if (key === 'f') {
    e.preventDefault();
    openFind();
  } else if (key === 'g') {
    e.preventDefault();
    void step(e.shiftKey ? -1 : 1);
  }
});

/**
 * Everything that needs to write a PDF back out.
 *
 * All of it goes through the same parser, so on a document that parser could
 * not read, all of it fails. Reading the file, selecting its text and saving a
 * page as a picture go through pdf.js instead and keep working.
 */
const WRITERS = [
  'btnSave',
  'btnModeEdit',
  'btnModeAdd',
  'btnErase',
  'btnHighlight',
  'btnNote',
  'btnRedact',
  'btnPen',
  'btnInkErase',
  'btnLine',
  'btnArrow',
  'btnRect',
  'btnEllipse',
  'btnSign',
  'btnOcr',
  'btnLocalFonts',
  'btnAddPages',
  'btnProtect',
  'btnSplit',
  'btnCompress',
  'btnExtract',
  'btnReplaceOne',
  'btnReplaceAll',
  'btnStamp',
  'btnCrop',
  'btnUncrop',
  'btnRotateLeft',
  'btnRotateRight',
  'btnDeletePage',
] as const;

/* ---------------- the document's own table of contents ---------------- */

/** Every entry, flattened, so the one for the current page can be found. */
let outlineEntries: Array<{ button: HTMLButtonElement; pageIndex: number }> = [];

function showSidebarTab(which: 'pages' | 'outline'): void {
  const outline = which === 'outline';
  els.tabPages.classList.toggle('is-on', !outline);
  els.tabOutline.classList.toggle('is-on', outline);
  els.tabPages.setAttribute('aria-selected', String(!outline));
  els.tabOutline.setAttribute('aria-selected', String(outline));
  els.thumbs.hidden = outline;
  els.outline.hidden = !outline;
  if (outline) markOutlinePosition(viewer.currentPageIndex());
}

els.tabPages.addEventListener('click', () => showSidebarTab('pages'));
els.tabOutline.addEventListener('click', () => showSidebarTab('outline'));

/**
 * Builds the contents list, and offers the tab only when there is one.
 *
 * A document with no outline gets no tab rather than an empty panel: an empty
 * panel invites the question of whether something failed.
 */
async function renderOutline(): Promise<void> {
  outlineEntries = [];
  els.outline.replaceChildren();
  els.tabOutline.hidden = true;
  showSidebarTab('pages');
  if (!doc) return;

  const entries = await doc.outline();
  if (!entries.length) return;

  const add = (list: OutlineEntry[], depth: number): void => {
    for (const entry of list) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'outline-item';
      button.style.paddingLeft = `${8 + depth * 13}px`;

      if (entry.pageIndex === null) {
        button.classList.add('is-lost');
        button.disabled = true;
        button.title = 'This heading does not say which page it belongs to.';
      } else {
        const page = entry.pageIndex;
        const number = document.createElement('span');
        number.className = 'outline-page';
        number.textContent = String(page + 1);
        button.appendChild(number);
        button.addEventListener('click', () => {
          viewer.scrollToPage(page);
          els.pageInput.value = String(page + 1);
          markOutlinePosition(page);
        });
        outlineEntries.push({ button, pageIndex: page });
      }

      button.appendChild(document.createTextNode(entry.title));
      els.outline.appendChild(button);
      if (entry.children.length) add(entry.children, depth + 1);
    }
  };

  add(entries, 0);
  els.tabOutline.hidden = false;
}

/** Marks the last heading at or before the page being read. */
function markOutlinePosition(pageIndex: number): void {
  let best: HTMLButtonElement | null = null;
  for (const entry of outlineEntries) {
    if (entry.pageIndex <= pageIndex) best = entry.button;
    else break;
  }
  for (const entry of outlineEntries) entry.button.classList.toggle('is-here', entry.button === best);
}

/* ---------------- renaming the document ---------------- */

/**
 * Renames the open document by clicking its title.
 *
 * It only ever affects what the saved file is called: nothing inside the PDF
 * carries this name, so there is no document to change, and saying so in the
 * tooltip is cheaper than a dialog explaining it. The extension is kept out of
 * the way, since every save path adds its own.
 */
function beginRename(): void {
  if (!doc || els.docTitle.querySelector('input')) return;

  const current = doc.name.replace(/\.pdf$/i, '');
  const input = document.createElement('input');
  input.className = 'doc-title-input';
  input.value = current;
  input.setAttribute('aria-label', 'Document name');

  const finish = (keep: boolean): void => {
    if (!input.isConnected) return;
    const typed = input.value.trim();
    input.remove();
    if (keep && typed && typed !== current && doc) {
      doc.name = `${typed}.pdf`;
      setStatus(`Renamed to ${doc.name}. The name is used the next time you save.`);
    }
    els.docTitle.textContent = doc?.name ?? 'No document open';
    syncEditState();
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
    e.stopPropagation();
  });
  input.addEventListener('blur', () => finish(true));

  els.docTitle.textContent = '';
  els.docTitle.appendChild(input);
  input.focus();
  input.select();
}

els.docTitle.addEventListener('click', () => beginRename());

/* ---------------- drawing on the page ---------------- */

/** Reads a colour input's #rrggbb into the 0 to 1 triples the writer wants. */
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  return {
    r: parseInt(hex.slice(1, 3), 16) / 255,
    g: parseInt(hex.slice(3, 5), 16) / 255,
    b: parseInt(hex.slice(5, 7), 16) / 255,
  };
}

const readPenColor = (): void => {
  viewer.penColor = hexToRgb(els.penColor.value);
};

els.penColor.addEventListener('input', readPenColor);
const readPenWidth = (): void => {
  viewer.penWidth = parseFloat(els.penWidth.value) || 2.5;
  els.penWidthLabel.textContent = String(viewer.penWidth);
};

const readPenOpacity = (): void => {
  const pct = parseInt(els.penOpacity.value, 10) || 100;
  viewer.penOpacity = pct / 100;
  els.penOpacityLabel.textContent = `${pct}%`;
};

els.penWidth.addEventListener('input', readPenWidth);
els.penOpacity.addEventListener('input', readPenOpacity);
readPenColor();
readPenWidth();
readPenOpacity();

els.btnPen.addEventListener('click', () => setMode('pen'));
els.btnInkErase.addEventListener('click', () => setMode('inkErase'));
els.btnLine.addEventListener('click', () => setMode('line'));
els.btnArrow.addEventListener('click', () => setMode('arrow'));
els.btnRect.addEventListener('click', () => setMode('rect'));
els.btnEllipse.addEventListener('click', () => setMode('ellipse'));

/* ---------------- tool groups ---------------- */

/**
 * Shows one group of tools at a time.
 *
 * The flat strip was wider than any screen and scrolled past its own contents,
 * so tools existed that nobody would ever find. Choosing a group is not
 * choosing a tool: the active tool keeps working while another group is on
 * screen, which matters because the width and colour of the pen live in the
 * draw group and somebody may well go and change the zoom halfway through.
 */
function showToolGroup(name: string): void {
  for (const tab of document.querySelectorAll<HTMLElement>('.tool-tab')) {
    tab.classList.toggle('is-on', tab.dataset.group === name);
  }
  for (const group of document.querySelectorAll<HTMLElement>('.tool-group')) {
    group.classList.toggle('is-hidden', group.dataset.group !== name);
  }
  localStorage.setItem(TOOL_GROUP_KEY, name);
}

const TOOL_GROUP_KEY = 'handpress.toolgroup';

for (const tab of document.querySelectorAll<HTMLElement>('.tool-tab')) {
  tab.addEventListener('click', () => showToolGroup(tab.dataset.group ?? 'text'));
}

showToolGroup(localStorage.getItem(TOOL_GROUP_KEY) ?? 'text');

/**
 * Brings a tool's own group forward when the tool is chosen another way.
 *
 * A keyboard shortcut or a status message can put the app into a mode whose
 * button is in a group nobody is looking at, and a mode with no visible tool
 * is how somebody ends up drawing on a page by accident.
 */
function revealGroupOf(id: string): void {
  const button = document.getElementById(id);
  // Only when it cannot already be seen, so choosing a tool that is right
  // there does not shuffle the toolbar underneath the pointer.
  if (!button || button.offsetParent !== null) return;
  const group = button.closest<HTMLElement>('.tool-group')?.dataset.group;
  if (group) showToolGroup(group);
}

/** Which button belongs to each tool, for bringing its group forward. */
const MODE_BUTTONS: Record<string, string> = {
  edit: 'btnModeEdit',
  select: 'btnModeSelect',
  add: 'btnModeAdd',
  sign: 'btnSign',
  note: 'btnNote',
  erase: 'btnErase',
  redact: 'btnRedact',
  highlight: 'btnHighlight',
  pen: 'btnPen',
  inkErase: 'btnInkErase',
  line: 'btnLine',
  arrow: 'btnArrow',
  rect: 'btnRect',
  ellipse: 'btnEllipse',
  crop: 'btnCrop',
};

function syncEditState(): void {
  const dirty = doc?.hasEdits() ?? false;
  // Nothing can be written back from a document the editor's parser could not
  // read, so the tools that would try are turned off rather than left to fail
  // one at a time, each in its own words. Saying so at the door only helps if
  // the door is actually shut.
  const readOnly = !doc || !doc.canEdit;
  for (const id of WRITERS) {
    const button = document.getElementById(id) as HTMLButtonElement | null;
    if (!button) continue;
    // The tool's own description is kept the first time it is seen and put
    // back afterwards. Overwriting the title outright threw away sentences
    // like "Drag over text to highlight it" the moment a document opened, and
    // left every tool on the empty page announcing that a file that does not
    // exist cannot be saved.
    if (button.dataset.title === undefined) button.dataset.title = button.title;
    button.disabled = readOnly;
    button.title = !doc
      ? (button.dataset.title ?? '')
      : readOnly
        ? 'This file cannot be changed or saved.'
        : (button.dataset.title ?? '');
  }
  // Printing is not writing. A document that cannot be rebuilt can still be
  // put on paper, from the bytes it arrived as.
  els.btnPrint.disabled = !doc;
  els.btnUndo.disabled = !doc?.canUndo();
  els.btnRedo.disabled = !doc?.canRedo();
  if (!els.docTitle.querySelector('input')) els.docTitle.classList.toggle('dirty', dirty);
  const n = doc?.editCount() ?? 0;
  els.editCount.textContent = n ? `${n} edit${n === 1 ? '' : 's'}` : '';
}

/* ---------------- editing mode ---------------- */

function setMode(
  mode:
    | 'edit'
    | 'select'
    | 'add'
    | 'sign'
    | 'note'
    | 'erase'
    | 'redact'
    | 'highlight'
    | 'pen'
    | 'inkErase'
    | 'line'
    | 'arrow'
    | 'rect'
    | 'ellipse'
    | 'crop',
): void {
  viewer.setMode(mode);
  els.btnModeEdit.classList.toggle('tool-active', mode === 'edit');
  els.btnModeSelect.classList.toggle('tool-active', mode === 'select');
  els.btnModeAdd.classList.toggle('tool-active', mode === 'add');
  els.btnSign.classList.toggle('tool-active', mode === 'sign');
  els.btnErase.classList.toggle('tool-active', mode === 'erase');
  els.btnRedact.classList.toggle('tool-active', mode === 'redact');
  els.btnHighlight.classList.toggle('tool-active', mode === 'highlight');
  els.btnNote.classList.toggle('tool-active', mode === 'note');
  els.btnPen.classList.toggle('tool-active', mode === 'pen');
  els.btnInkErase.classList.toggle('tool-active', mode === 'inkErase');
  els.btnLine.classList.toggle('tool-active', mode === 'line');
  els.btnArrow.classList.toggle('tool-active', mode === 'arrow');
  els.btnRect.classList.toggle('tool-active', mode === 'rect');
  els.btnEllipse.classList.toggle('tool-active', mode === 'ellipse');
  els.btnCrop.classList.toggle('tool-active', mode === 'crop');
  revealGroupOf(MODE_BUTTONS[mode] ?? '');
  const messages = {
    edit: 'Click any line of text to edit it, or drag it to move it.',
    pen: 'Draw anywhere on the page. What you draw becomes part of it.',
    inkErase: 'Drag over anything you have drawn to rub it out.',
    line: 'Drag from one point to another.',
    arrow: 'Drag from the tail to the point.',
    rect: 'Drag out a box around something.',
    ellipse: 'Drag out an oval around something.',
    crop: 'Drag out the part of the page to keep.',
    select: 'Drag across the text to select it, then copy it with Cmd or Ctrl and C.',
    add: 'Click anywhere on the page to add text. Shift+Enter for a new line, Enter to finish.',
    sign: 'Click where the signature should go.',
    erase: 'Drag over anything to cover it. This hides the text; it does not delete it.',
    redact: 'Drag over text to delete it from the saved file. This is not reversible once saved.',
    highlight: 'Drag over text to highlight it. The words stay readable underneath.',
    note: 'Click where the comment belongs. It is attached as a note any PDF reader can open.',
  };
  setStatus(messages[mode]);
}

els.btnErase.addEventListener('click', () => {
  if (!doc) {
    setStatus('Open a PDF first.', 'warn');
    return;
  }
  setMode('erase');
});

els.btnHighlight.addEventListener('click', () => {
  if (!doc) {
    setStatus('Open a PDF first.', 'warn');
    return;
  }
  setMode('highlight');
});

els.btnModeSelect.addEventListener('click', () => {
  if (!doc) {
    setStatus('Open a PDF first.', 'warn');
    return;
  }
  setMode('select');
});

els.btnNote.addEventListener('click', () => {
  if (!doc) {
    setStatus('Open a PDF first.', 'warn');
    return;
  }
  setMode('note');
});

els.highlightColor.addEventListener('change', () => {
  viewer.highlightColor = hexToRgb(els.highlightColor.value);
});

els.btnRedact.addEventListener('click', () => {
  if (!doc) {
    setStatus('Open a PDF first.', 'warn');
    return;
  }
  setMode('redact');
});

els.btnModeEdit.addEventListener('click', () => setMode('edit'));
els.btnModeAdd.addEventListener('click', () => setMode('add'));

els.addSize.addEventListener('change', () => {
  viewer.addSize = parseFloat(els.addSize.value);
});
els.addColor.addEventListener('change', () => {
  viewer.addColor = hexToRgb(els.addColor.value);
});

/* ---------------- signature ---------------- */

let pad: SignaturePad | null = null;
let uploaded: CapturedSignature | null = null;

function openSignatureDialog(): void {
  els.sigModal.hidden = false;
  showSignatureTab('draw');
  // The pad can only size itself once it is actually laid out.
  if (!pad) pad = new SignaturePad(els.sigPad);
  pad.resize();
}

function closeSignatureDialog(): void {
  els.sigModal.hidden = true;
}

function showSignatureTab(which: 'draw' | 'upload'): void {
  const drawing = which === 'draw';
  els.sigDrawPanel.hidden = !drawing;
  els.sigUploadPanel.hidden = drawing;
  els.sigTabDraw.classList.toggle('modal-tab-active', drawing);
  els.sigTabUpload.classList.toggle('modal-tab-active', !drawing);
  els.sigClear.hidden = !drawing;
  if (drawing) pad?.resize();
}

els.btnSign.addEventListener('click', () => {
  if (!doc) {
    setStatus('Open a PDF first.', 'warn');
    return;
  }
  openSignatureDialog();
});

els.sigTabDraw.addEventListener('click', () => showSignatureTab('draw'));
els.sigTabUpload.addEventListener('click', () => showSignatureTab('upload'));
els.sigClear.addEventListener('click', () => pad?.clear());
els.sigCancel.addEventListener('click', closeSignatureDialog);
els.sigModal.addEventListener('click', (e) => {
  if (e.target === els.sigModal) closeSignatureDialog();
});

els.sigChoose.addEventListener('click', () => els.sigFileInput.click());
els.sigFileInput.addEventListener('change', async () => {
  const file = els.sigFileInput.files?.[0];
  els.sigFileInput.value = '';
  if (!file) return;
  try {
    uploaded = await signatureFromFile(file, els.sigRemoveBg.checked);
    const blob = new Blob([uploaded.png.slice()], { type: 'image/png' });
    const img = document.createElement('img');
    img.src = URL.createObjectURL(blob);
    img.alt = 'Signature preview';
    els.sigPreview.replaceChildren(img);
  } catch (e) {
    setStatus(`Could not read that image: ${reason(e)}`, 'warn');
  }
});

// Re-running the background removal on the same file needs the file again, so
// the checkbox only takes effect on the next choice; say so rather than lie.
els.sigRemoveBg.addEventListener('change', () => {
  if (uploaded) setStatus('Choose the image again to apply that change.');
});

els.sigUse.addEventListener('click', async () => {
  const drawn = els.sigDrawPanel.hidden ? null : await pad?.capture();
  const signature = drawn ?? (els.sigDrawPanel.hidden ? uploaded : null);
  if (!signature) {
    setStatus(els.sigDrawPanel.hidden ? 'Choose an image first.' : 'Draw your signature first.', 'warn');
    return;
  }
  viewer.pendingSignature = signature;
  viewer.signatureWidth = parseFloat(els.sigWidth.value);
  closeSignatureDialog();
  setMode('sign');
});

/* ---------------- local font matching ---------------- */

const localFonts = new LocalFontProvider();

els.btnLocalFonts.addEventListener('click', async () => {
  if (localFonts.enabled) {
    setStatus(`Already matching against ${localFonts.familyCount} font families on this computer.`);
    return;
  }
  if (!localFontsSupported()) {
    setStatus(
      'Matching local fonts needs the Local Font Access API, which currently only Chromium browsers provide. Substitutions will use a standard font instead.',
      'warn',
    );
    return;
  }

  const ok = await localFonts.enable();
  if (!ok) {
    setStatus('Without access to local fonts, substitutions will use a standard font instead.', 'warn');
    return;
  }

  els.btnLocalFonts.classList.add('tool-active');
  setStatus(`Matching against ${localFonts.familyCount} font families on this computer.`);

  if (doc) {
    // Existing edits are rebuilt so any earlier substitution can improve.
    doc.fontProvider = localFonts;
    setBusy(true, 'Rebuilding with matched fonts…');
    try {
      await doc.refresh();
      await viewer.refreshRendered();
      await renderThumbs();
    } finally {
      setBusy(false);
    }
  }
});

/* ---------------- zoom ---------------- */

async function applyZoomChoice(): Promise<void> {
  const value = els.zoomSelect.value;
  if (value === 'fit') {
    if (!doc?.pdfjs) return;
    const page = await doc.pdfjs.getPage(1);
    const vp = page.getViewport({ scale: 1 });
    // The gutter is a comfort on a desk and a waste on a phone, where it would
    // spend an eighth of the screen on grey.
    const gutter = els.viewer.clientWidth < 700 ? 16 : 48;
    const available = els.viewer.clientWidth - gutter;
    await viewer.setZoom(Math.max(0.25, available / vp.width));
  } else {
    await viewer.setZoom(parseFloat(value));
  }
}

els.zoomSelect.addEventListener('change', () => void applyZoomChoice());
els.btnZoomIn.addEventListener('click', () => {
  els.zoomSelect.value = nearestZoom(viewer.currentZoom * 1.25);
  void applyZoomChoice();
});
els.btnZoomOut.addEventListener('click', () => {
  els.zoomSelect.value = nearestZoom(viewer.currentZoom / 1.25);
  void applyZoomChoice();
});

function nearestZoom(target: number): string {
  const options = [...els.zoomSelect.options].map((o) => o.value).filter((v) => v !== 'fit');
  let best = options[0];
  let bestD = Infinity;
  for (const o of options) {
    const d = Math.abs(parseFloat(o) - target);
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  return best;
}

/* ---------------- panels ---------------- */

/**
 * A narrow window hides both panels from the stylesheet, so whether one is on
 * screen cannot be read from a class alone. It is measured instead, and the
 * result is written both ways: `no-` hides it at a comfortable width, `show-`
 * is what lets it be asked for when the window is too narrow to hold it.
 */
function togglePanel(button: HTMLButtonElement, panel: HTMLElement, hide: string, show: string): void {
  const visible = panel.getBoundingClientRect().width > 2;
  els.workspace.classList.toggle(hide, visible);
  els.workspace.classList.toggle(show, !visible);
  button.classList.toggle('tool-active', visible);
  // Opening or closing a panel changes how much room the page has, and fit
  // width means nothing if it is not measured against the room it now has.
  void applyZoomChoice();
}

els.btnSidebar.addEventListener('click', () =>
  togglePanel(els.btnSidebar, els.thumbs.parentElement as HTMLElement, 'no-sidebar', 'show-sidebar'),
);
els.btnPanel.addEventListener('click', () =>
  togglePanel(els.btnPanel, els.panelBody.parentElement as HTMLElement, 'no-panel', 'show-panel'),
);

/* ---------------- page navigation ---------------- */

els.btnPrev.addEventListener('click', () => viewer.scrollToPage(Math.max(0, viewer.currentPageIndex() - 1)));
els.btnNext.addEventListener('click', () => {
  if (!doc) return;
  viewer.scrollToPage(Math.min(doc.pageCount - 1, viewer.currentPageIndex() + 1));
});
els.pageInput.addEventListener('change', () => {
  const n = parseInt(els.pageInput.value, 10);
  if (doc && Number.isFinite(n) && n >= 1 && n <= doc.pageCount) viewer.scrollToPage(n - 1);
});

let scrollRaf = 0;
els.viewer.addEventListener('scroll', () => {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    if (!doc) return;
    const idx = viewer.currentPageIndex();
    els.pageInput.value = String(idx + 1);
    for (const t of Array.from(els.thumbs.children)) {
      t.classList.toggle('current', Number((t as HTMLElement).dataset.page) === idx);
    }
    markOutlinePosition(idx);
  });
});

/* ---------------- thumbnails ---------------- */

let thumbToken = 0;
let thumbWatcher: IntersectionObserver | null = null;

/**
 * The gap between two pages, which is somewhere a page can be added.
 *
 * It lives between the thumbnails rather than floating over the document
 * because a gap says exactly where the new page goes, and a button over the
 * page does not: after this one, or before it?
 */
function insertHere(position: number): HTMLElement {
  const gap = document.createElement('div');
  gap.className = 'thumb-insert';
  const add = document.createElement('button');
  add.type = 'button';
  add.textContent = '+';
  add.title =
    position === 0 ? 'Add a blank page at the start' : `Add a blank page after page ${position}`;
  add.setAttribute('aria-label', add.title);
  add.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!doc) return;
    void applyPageChange(doc.insertBlankPage(position)).then(() =>
      setStatus(`Blank page added${position === 0 ? ' at the start' : ` after page ${position}`}.`),
    );
  });
  gap.appendChild(add);
  return gap;
}

async function renderThumbs(): Promise<void> {
  if (!doc?.pdfjs) return;
  const token = ++thumbToken;
  els.thumbs.innerHTML = '';
  els.thumbs.appendChild(insertHere(0));

  for (let i = 0; i < doc.pageCount; i++) {
    const wrap = document.createElement('div');
    wrap.className = 'thumb';
    wrap.dataset.page = String(i);
    wrap.draggable = true;
    if (i === viewer.currentPageIndex()) wrap.classList.add('current');
    const canvas = document.createElement('canvas');
    const num = document.createElement('span');
    num.className = 'thumb-num';
    num.textContent = String(i + 1);

    // Page controls live on the thumbnail, which is where people look for them.
    const tools = document.createElement('div');
    tools.className = 'thumb-tools';
    const button = (label: string, title: string, run: () => boolean): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.title = title;
      b.textContent = label;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        void applyPageChange(run());
      });
      return b;
    };
    tools.append(
      button('\u21ba', 'Rotate left', () => doc!.rotatePage(i, -90)),
      button('\u21bb', 'Rotate right', () => doc!.rotatePage(i, 90)),
      button('\u00d7', 'Delete this page', () => {
        if (doc!.pageCount <= 1) {
          setStatus('A document needs at least one page.', 'warn');
          return false;
        }
        return doc!.deletePage(i);
      }),
    );

    wrap.append(canvas, num, tools);
    wrap.addEventListener('click', () => viewer.scrollToPage(i));

    // Reordering by dragging one thumbnail onto another.
    wrap.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData('text/plain', String(i));
      wrap.classList.add('thumb-dragging');
    });
    wrap.addEventListener('dragend', () => wrap.classList.remove('thumb-dragging'));
    wrap.addEventListener('dragover', (e) => {
      e.preventDefault();
      wrap.classList.add('thumb-over');
    });
    wrap.addEventListener('dragleave', () => wrap.classList.remove('thumb-over'));
    wrap.addEventListener('drop', (e) => {
      e.preventDefault();
      wrap.classList.remove('thumb-over');
      const from = Number(e.dataTransfer?.getData('text/plain'));
      if (Number.isFinite(from) && doc) void applyPageChange(doc.movePage(from, i));
    });

    els.thumbs.appendChild(wrap);
    els.thumbs.appendChild(insertHere(i + 1));
  }

  // Thumbnails draw when they come into view, not all at once. Every edit
  // rebuilds this strip, and rasterising a whole document each time is what
  // made dragging an image feel like the picture arrived a second after the
  // outline did. Only what somebody can actually see is worth drawing.
  thumbWatcher?.disconnect();
  thumbWatcher = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target as HTMLElement;
        thumbWatcher?.unobserve(el);
        void drawThumb(Number(el.dataset.page), token);
      }
    },
    { root: els.thumbs, rootMargin: '200px 0px' },
  );
  for (const el of els.thumbs.querySelectorAll('.thumb')) thumbWatcher.observe(el);
}

/**
 * Draws one thumbnail.
 *
 * Through the viewer's own render queue rather than pdf.js directly: they draw
 * the same pages the main view is drawing, and pdf.js will not render one page
 * twice at once. A thumbnail of a page the viewer was already drawing never
 * returned, which left the whole open stuck behind it.
 */
async function drawThumb(index: number, token: number): Promise<void> {
  if (!doc?.pdfjs || token !== thumbToken || !Number.isFinite(index)) return;
  try {
    const page = await doc.pdfjs.getPage(index + 1);
    const base = page.getViewport({ scale: 1 });
    const canvas = els.thumbs
      .querySelectorAll('.thumb')
      [index]?.querySelector('canvas') as HTMLCanvasElement | null;
    if (!canvas) return;
    const image = await viewer.rasterise(index, 150 / base.width);
    if (token !== thumbToken) return;
    canvas.width = image.width;
    canvas.height = image.height;
    canvas.getContext('2d')!.drawImage(image, 0, 0);
  } catch {
    // A thumbnail that will not render is not worth failing the session over.
  }
}

/**
 * Applies a page operation. The page count can change, so the viewer is rebuilt
 * rather than merely repainted.
 */
async function applyPageChange(changed: boolean): Promise<void> {
  if (!changed || !doc) return;
  setBusy(true, 'Updating pages…');
  try {
    await doc.refresh();
    els.pageTotal.textContent = `/ ${doc.pageCount}`;
    els.pageInput.value = String(Math.min(Number(els.pageInput.value) || 1, doc.pageCount));
    syncEditState();
    setStatus(`Document now has ${doc.pageCount} page${doc.pageCount === 1 ? '' : 's'}.`);

    await viewer.load(doc);
    await applyZoomChoice();
    void renderThumbs();
  } catch (e) {
    setStatus(`Could not update pages: ${reason(e)}`, 'warn');
  } finally {
    setBusy(false);
  }
}

/* ---------------- recognising scanned pages ---------------- */

/**
 * Measures a word in the font the recognised text will actually be written in.
 *
 * This decides how far each recognised word is stretched to sit under the
 * scanned one it came from, so it has to be Helvetica's own metrics. Asking
 * the browser measures whatever it decided Helvetica meant on this machine,
 * and put the same scan's text in different places on different machines.
 */
function measureHelvetica(text: string, size: number): number {
  return standardTextWidth('Helvetica', text, size);
}

/* ---------------- the recogniser's language ---------------- */

const OCR_LANGUAGE_KEY = 'handpress.ocr.language';

/**
 * Fills the language picker with the languages this copy actually has.
 *
 * Hidden until a document with something to read is open. A picker for a tool
 * that does not apply is furniture, and the toolbar has enough of it. One
 * language installed means no choice to make, so it stays hidden then too.
 */
async function loadOcrLanguages(): Promise<void> {
  const languages = await availableLanguages();
  if (languages.length < 2) return;

  const remembered = localStorage.getItem(OCR_LANGUAGE_KEY);
  els.ocrLang.replaceChildren(
    ...languages.map((l) => {
      const option = document.createElement('option');
      option.value = l.code;
      option.textContent = l.name;
      // Said out loud, because choosing one downloads it.
      option.title = `${l.name}, ${(l.bytes / 1024 / 1024).toFixed(0)} MB to download the first time`;
      return option;
    }),
  );
  const wanted = remembered && languages.some((l) => l.code === remembered) ? remembered : 'eng';
  els.ocrLang.value = languages.some((l) => l.code === wanted) ? wanted : languages[0].code;
}

function ocrLanguage(): string {
  return els.ocrLang.value || 'eng';
}

els.ocrLang.addEventListener('change', () => {
  localStorage.setItem(OCR_LANGUAGE_KEY, els.ocrLang.value);
});

void loadOcrLanguages();

els.btnOcr.addEventListener('click', async () => {
  if (!doc?.pdfjs) {
    setStatus('Open a PDF first.', 'warn');
    return;
  }

  setBusy(true, 'Looking for pages to read…');
  const current = viewer.currentPageIndex();
  let targets: number[];
  try {
    targets = await doc.pagesNeedingRecognition();
  } catch {
    targets = [];
  }

  // A page with text on it has nothing to recognise, and one already read would
  // only gain a second copy of every word. Saying which of the two it is beats
  // a button that appears to do nothing.
  if (!targets.length) {
    setBusy(false);
    setStatus(
      doc.wasRecognised(current)
        ? 'This page has already been read.'
        : 'Every page already has text, so there is nothing to read.',
    );
    return;
  }

  const many = targets.length > 1;
  let recogniser: Recogniser | null = null;
  let wordsRead = 0;
  let pagesRead = 0;
  let confidenceTotal = 0;

  try {
    recogniser = await openRecogniser(ocrLanguage(), (fraction, label) => {
      setBusy(true, `${label}… ${Math.round(fraction * 100)}%`);
    });

    for (const [n, pageIndex] of targets.entries()) {
      const where = many ? `Page ${pageIndex + 1}, ${n + 1} of ${targets.length}` : 'Reading the page';
      setBusy(true, `${where}…`);

      const canvas = await viewer.rasterise(pageIndex, OCR_SCALE);
      const result = await recogniser.recognise(canvas, OCR_SCALE);
      if (!result.words.length) continue;

      const insertions = wordsToInsertions(result.words, measureHelvetica);
      for (const insertion of insertions) doc.addInsertion(pageIndex, insertion);
      wordsRead += insertions.length;
      confidenceTotal += result.confidence;
      pagesRead++;
    }

    if (!wordsRead) {
      setStatus('Nothing legible was found.', 'warn');
      return;
    }

    setBusy(true, 'Adding the text layer…');
    await doc.refresh();
    await viewer.refreshRendered();
    void renderThumbs();
    syncEditState();

    const pageNote = pagesRead === 1 ? '' : ` across ${pagesRead} pages`;
    setStatus(
      `Read ${wordsRead} word${wordsRead === 1 ? '' : 's'}${pageNote} at ` +
        `${Math.round(confidenceTotal / pagesRead)}% confidence. ` +
        'The text can now be searched and edited.',
    );
  } catch (e) {
    setStatus(`Could not read that: ${reason(e)}`, 'warn');
  } finally {
    await recogniser?.close();
    setBusy(false);
  }
});

/* ---------------- find ---------------- */

let matches: SearchMatch[] = [];
let matchIndex = -1;
let searchTimer: number | undefined;
let searchToken = 0;

function updateSearchUi(): void {
  const has = matches.length > 0;
  els.searchPrev.disabled = !has;
  els.searchNext.disabled = !has;
  els.searchCount.textContent = els.searchInput.value.trim()
    ? has
      ? `${matchIndex + 1} of ${matches.length}`
      : 'none'
    : '';
}

async function runSearch(): Promise<void> {
  const query = els.searchInput.value;
  const token = ++searchToken;

  if (!doc || !query.trim()) {
    matches = [];
    matchIndex = -1;
    viewer.setMatches([]);
    updateSearchUi();
    return;
  }

  els.searchCount.textContent = 'searching…';
  const found = await doc.search(query);
  // A newer keystroke has already superseded this search.
  if (token !== searchToken) return;

  matches = found;
  matchIndex = found.length ? 0 : -1;
  viewer.setMatches(matches, matchIndex);
  updateSearchUi();
  if (matchIndex >= 0) await viewer.revealMatch(matchIndex);
  if (!found.length) setStatus(`No match for ${JSON.stringify(query)}.`);
}

async function step(delta: number): Promise<void> {
  if (!matches.length) return;
  matchIndex = (matchIndex + delta + matches.length) % matches.length;
  updateSearchUi();
  await viewer.revealMatch(matchIndex);
}

/**
 * Puts the cursor in the find box, unfolding it first on a phone.
 *
 * On a wide screen the box is always there and this is just a focus. On a
 * narrow one it is folded away behind a button, because a permanently open
 * search field took enough of the bar to push Save off the edge.
 */
function openFind(): void {
  document.getElementById('app')?.classList.add('finding');
  els.searchInput.focus();
  els.searchInput.select();
}

/** Folds the find box away again, and clears whatever it was highlighting. */
function closeFind(): void {
  document.getElementById('app')?.classList.remove('finding');
  if (els.searchInput.value) {
    els.searchInput.value = '';
    void runSearch();
  }
  els.searchInput.blur();
}

els.btnFind.addEventListener('click', () => {
  if (document.getElementById('app')?.classList.contains('finding')) closeFind();
  else openFind();
});

els.searchInput.addEventListener('input', () => {
  // Searching every page is not free, so keystrokes are allowed to settle.
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => void runSearch(), 250);
});
els.searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (matches.length) void step(e.shiftKey ? -1 : 1);
    else void runSearch();
  } else if (e.key === 'Escape') {
    closeFind();
  }
  e.stopPropagation();
});
els.searchNext.addEventListener('click', () => void step(1));
els.searchPrev.addEventListener('click', () => void step(-1));

/**
 * Replacing what the search found.
 *
 * The search is re-run afterwards rather than the match list being patched up,
 * because a replacement changes the text every later offset was measured
 * against, and one that reflows a paragraph changes lines nobody searched for.
 * Re-reading is cheap next to being subtly wrong about where the next hit is.
 */
async function applyReplace(all: boolean): Promise<void> {
  if (!doc) return;
  const query = els.searchInput.value;
  if (!query.trim()) {
    setStatus('Type what to look for first.', 'warn');
    return;
  }
  if (!doc.canEdit) {
    setStatus('This file cannot be changed or saved.', 'warn');
    return;
  }
  const target = all ? undefined : matches[matchIndex];
  if (!all && !target) {
    setStatus('No match selected to replace.', 'warn');
    return;
  }

  setBusy(true, all ? 'Replacing…' : 'Replacing…');
  try {
    const done = await doc.replace(query, els.replaceInput.value, { only: target });
    if (!done) {
      setStatus('Nothing was replaced.', 'warn');
      return;
    }
    await doc.refresh();
    await viewer.refreshRendered();
    void renderThumbs();
    syncEditState();
    await runSearch();
    setStatus(`Replaced ${done} ${done === 1 ? 'occurrence' : 'occurrences'}.`);
  } catch (e) {
    setStatus(`Could not replace: ${reason(e)}`, 'warn');
  } finally {
    setBusy(false);
  }
}

els.btnReplaceToggle.addEventListener('click', () => {
  els.replaceBar.hidden = !els.replaceBar.hidden;
  els.btnReplaceToggle.classList.toggle('tool-active', !els.replaceBar.hidden);
  if (!els.replaceBar.hidden) els.replaceInput.focus();
});

els.btnReplaceOne.addEventListener('click', () => void applyReplace(false));
els.btnReplaceAll.addEventListener('click', () => void applyReplace(true));
els.replaceInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    void applyReplace(e.shiftKey);
  } else if (e.key === 'Escape') {
    els.replaceBar.hidden = true;
    els.btnReplaceToggle.classList.remove('tool-active');
  }
  e.stopPropagation();
});

/* ---------------- combining and splitting ---------------- */

/**
 * Reads a page range the way people write one: "1-3, 5, 8-" and so on, with
 * an open ended last part meaning "to the end". Returns zero-based positions.
 */
function parseRange(text: string, pageCount: number): number[] {
  const out = new Set<number>();
  for (const part of text.split(',')) {
    const piece = part.trim();
    if (!piece) continue;
    const m = /^(\d+)?\s*(-)?\s*(\d+)?$/.exec(piece);
    if (!m) continue;
    const [, fromRaw, dash, toRaw] = m;
    if (!dash) {
      const n = Number(fromRaw);
      if (n >= 1 && n <= pageCount) out.add(n - 1);
      continue;
    }
    const from = fromRaw ? Number(fromRaw) : 1;
    const to = toRaw ? Number(toRaw) : pageCount;
    for (let n = Math.max(1, from); n <= Math.min(pageCount, to); n++) out.add(n - 1);
  }
  return [...out].sort((a, b) => a - b);
}

function downloadPdf(bytes: Uint8Array, filename: string): void {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  const url = URL.createObjectURL(new Blob([copy], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 20000);
}

els.btnAddPages.addEventListener('click', () => {
  if (!doc) {
    setStatus('Open a PDF first.', 'warn');
    return;
  }
  els.mergeFileInput.click();
});

els.mergeFileInput.addEventListener('change', async () => {
  const files = [...(els.mergeFileInput.files ?? [])];
  els.mergeFileInput.value = '';
  if (!files.length || !doc) return;

  setBusy(true, files.length === 1 ? `Adding ${files[0].name}…` : `Adding ${files.length} files…`);
  let added = 0;
  try {
    for (const file of files) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      added += await doc.mergeFile(file.name, bytes);
    }
    if (!added) {
      setStatus('Nothing to add: those files had no pages.', 'warn');
      return;
    }
    await doc.refresh();
    // The counts are what the user is waiting to see, so they are updated before
    // the expensive repaint rather than after it.
    els.pageTotal.textContent = `/ ${doc.pageCount}`;
    syncEditState();
    setStatus(`Added ${added} page${added === 1 ? '' : 's'}. The document now has ${doc.pageCount}.`);

    await viewer.load(doc);
    await applyZoomChoice();
    // Thumbnails for a long document take a while and nothing waits on them.
    void renderThumbs();
  } catch (e) {
    setStatus(`Could not add those pages: ${reason(e)}`, 'warn');
  } finally {
    setBusy(false);
  }
});

function openExtract(): void {
  if (!doc) {
    setStatus('Open a PDF first.', 'warn');
    return;
  }
  els.extractRange.value = `1-${doc.pageCount}`;
  els.extractHint.textContent = `This document has ${doc.pageCount} page${doc.pageCount === 1 ? '' : 's'}.`;
  els.extractModal.hidden = false;
  els.extractRange.focus();
  els.extractRange.select();
}

/**
 * Saves the page on screen as a PNG.
 *
 * Rendered at twice the page size, which is about 150 dots per inch: sharp
 * enough to read and to print small, without producing a file nobody can email.
 */
/**
 * Page operations for the page in view, rather than for a thumbnail.
 *
 * The same operations already sit on each thumbnail in the sidebar, which is
 * where they belong when the job is "turn pages 3, 7 and 12". They are here as
 * well because the far more common job is "turn this one", and that should not
 * require opening a panel and finding the right thumbnail in it.
 */
/* ---------- watermarks, headers, footers and page numbers ---------- */

/**
 * The four things one stamp can be.
 *
 * Presets rather than four buttons, because the difference between a watermark
 * and a footer is entirely where it sits and how big it is, and four separate
 * dialogs would be the same dialog four times.
 */
const STAMP_PRESETS: Record<
  string,
  {
    text: string;
    size: number;
    rotate: number;
    opacity: number;
    color: string;
    place: 'top-centre' | 'bottom-centre' | 'centre';
    /** Under the page rather than over it. Only a watermark wants this. */
    behind: boolean;
  }
> = {
  watermark: { text: 'DRAFT', size: 60, rotate: 45, opacity: 12, color: '#808080', place: 'centre', behind: true },
  header: { text: 'Confidential', size: 10, rotate: 0, opacity: 100, color: '#555555', place: 'top-centre', behind: false },
  footer: { text: 'Confidential', size: 10, rotate: 0, opacity: 100, color: '#555555', place: 'bottom-centre', behind: false },
  numbers: { text: '{page} of {pages}', size: 10, rotate: 0, opacity: 100, color: '#333333', place: 'bottom-centre', behind: false },
};

function fillStampPreset(): void {
  const preset = STAMP_PRESETS[els.stampPreset.value] ?? STAMP_PRESETS.watermark;
  els.stampText.value = preset.text;
  els.stampSize.value = String(preset.size);
  els.stampRotate.value = String(preset.rotate);
  els.stampOpacity.value = String(preset.opacity);
  els.stampColor.value = preset.color;
  els.stampHint.textContent = '';
}

els.stampPreset.addEventListener('change', fillStampPreset);

els.btnStamp.addEventListener('click', () => {
  if (!doc) return;
  fillStampPreset();
  els.stampRange.value = '';
  els.stampModal.hidden = false;
  els.stampText.focus();
  els.stampText.select();
});

els.stampCancel.addEventListener('click', () => {
  els.stampModal.hidden = true;
});

els.stampGo.addEventListener('click', async () => {
  if (!doc) return;
  const preset = STAMP_PRESETS[els.stampPreset.value] ?? STAMP_PRESETS.watermark;
  const wanted = els.stampRange.value.trim() ? parseRange(els.stampRange.value, doc.pageCount) : undefined;
  if (wanted && !wanted.length) {
    els.stampHint.textContent = 'That does not name any page in this document.';
    return;
  }

  els.stampModal.hidden = true;
  setBusy(true, 'Stamping the pages…');
  try {
    const done = await doc.stampEveryPage({
      text: els.stampText.value,
      size: Math.max(4, parseFloat(els.stampSize.value) || 12),
      color: hexToRgb(els.stampColor.value),
      opacity: Math.min(1, Math.max(0.05, (parseFloat(els.stampOpacity.value) || 100) / 100)),
      rotate: parseFloat(els.stampRotate.value) || 0,
      place: preset.place,
      margin: 36,
      bold: false,
      italic: false,
      behind: preset.behind,
      pages: wanted,
    });
    if (!done) {
      setStatus('Nothing was stamped.', 'warn');
      return;
    }
    await doc.refresh();
    await viewer.refreshRendered();
    void renderThumbs();
    syncEditState();
    setStatus(`Stamped ${done} page${done === 1 ? '' : 's'}. Each one can be dragged or retyped like any added text.`);
  } catch (e) {
    setStatus(`Could not stamp the pages: ${reason(e)}`, 'warn');
  } finally {
    setBusy(false);
  }
});

els.btnCrop.addEventListener('click', () => setMode('crop'));

els.btnUncrop.addEventListener('click', () => {
  if (!doc) return;
  if (!doc.uncropPage(viewer.currentPageIndex(), true)) {
    setStatus('No page is cropped.');
    return;
  }
  void applyPageChange(true).then(() => setStatus('Every page is showing in full again.'));
});

els.btnRotateLeft.addEventListener('click', () => {
  if (!doc) return;
  void applyPageChange(doc.rotatePage(viewer.currentPageIndex(), -90));
});

els.btnRotateRight.addEventListener('click', () => {
  if (!doc) return;
  void applyPageChange(doc.rotatePage(viewer.currentPageIndex(), 90));
});

els.btnDeletePage.addEventListener('click', () => {
  if (!doc) return;
  if (doc.pageCount <= 1) {
    setStatus('A document needs at least one page.', 'warn');
    return;
  }
  void applyPageChange(doc.deletePage(viewer.currentPageIndex()));
});

els.btnPageImage.addEventListener('click', async () => {
  if (!doc?.pdfjs) {
    setStatus('Open a PDF first.', 'warn');
    return;
  }
  const pageIndex = viewer.currentPageIndex();
  setBusy(true, 'Rendering the page…');
  try {
    const canvas = await viewer.rasterise(pageIndex, 2);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('the page could not be turned into an image');

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${doc.name.replace(/\.pdf$/i, '')} page ${pageIndex + 1}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 20000);
    setStatus(`Saved page ${pageIndex + 1} as a PNG.`);
  } catch (e) {
    setStatus(`Could not save that page as an image: ${reason(e)}`, 'warn');
  } finally {
    setBusy(false);
  }
});

/**
 * Saves a smaller copy.
 *
 * Every edit is applied first, so what is compressed is the document as it now
 * stands rather than the file as it arrived. The result is offered as a
 * download rather than swapped in: this throws detail away, and the version
 * being worked on should stay the good one.
 */
els.btnCompress.addEventListener('click', async () => {
  if (!doc) {
    setStatus('Open a PDF first.', 'warn');
    return;
  }
  viewer.closeEditor(false);
  setBusy(true, 'Looking for oversized images…');
  try {
    const { bytes } = await doc.build();
    const result = await compress(bytes, recompressInBrowser);

    if (result.report.after >= result.report.before) {
      setStatus(
        `Nothing worth compressing: ${result.report.kept} image${result.report.kept === 1 ? '' : 's'} ` +
          'already fit the size the page shows them.',
      );
      return;
    }

    const copy = new Uint8Array(result.bytes.length);
    copy.set(result.bytes);
    const url = URL.createObjectURL(new Blob([copy], { type: 'application/pdf' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = doc.name.replace(/\.pdf$/i, '') + ' (smaller).pdf';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 20000);

    const saved = Math.round((1 - result.report.after / result.report.before) * 100);
    setStatus(
      `Saved a copy ${saved}% smaller, ${sizeOf(result.report.before)} down to ${sizeOf(result.report.after)}. ` +
        `${result.report.shrunk} image${result.report.shrunk === 1 ? '' : 's'} redrawn at the size the page shows.`,
    );
  } catch (e) {
    setStatus(`Could not compress that: ${reason(e)}`, 'warn');
  } finally {
    setBusy(false);
  }
});

function sizeOf(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

/**
 * Saves every page as its own PDF, gathered into one archive.
 *
 * One archive rather than a download each: browsers throttle a run of
 * downloads, ask about them, and scatter them through a folder in whatever
 * order they finish.
 */
/** What the dialog is currently asking for, and whether it makes sense. */
function splitPlan(): { pages: number[]; perFile: number; files: number } {
  const total = doc?.pageCount ?? 0;
  const typed = els.splitRange.value.trim();
  const pages = typed
    ? parseRange(typed, total)
    : Array.from({ length: total }, (_, i) => i);
  const perFile = Math.max(1, Math.floor(Number(els.splitEvery.value) || 1));
  // The same grouping the split itself uses, so the count promised here is the
  // count that comes out.
  return { pages, perFile, files: splitChunks(pages, perFile).length };
}

function describeSplit(): void {
  const { pages, perFile, files } = splitPlan();
  if (!pages.length) {
    els.splitHint.textContent = els.splitRange.value.trim()
      ? 'That range does not name any pages in this document.'
      : '';
    els.splitGo.disabled = true;
    return;
  }
  els.splitGo.disabled = false;
  els.splitHint.textContent =
    `${pages.length} page${pages.length === 1 ? '' : 's'} into ` +
    `${files} file${files === 1 ? '' : 's'}` +
    (perFile === 1 ? ', one page each.' : `, ${perFile} pages each.`);
}

els.splitEvery.addEventListener('input', describeSplit);
els.splitRange.addEventListener('input', describeSplit);
els.splitCancel.addEventListener('click', () => {
  els.splitModal.hidden = true;
});

els.btnSplit.addEventListener('click', () => {
  if (!doc) {
    setStatus('Open a PDF first.', 'warn');
    return;
  }
  if (doc.pageCount < 2) {
    setStatus('There is only one page, so there is nothing to split.', 'warn');
    return;
  }
  viewer.closeEditor(false);
  els.splitRange.value = '';
  els.splitEvery.value = '1';
  els.splitEvery.max = String(doc.pageCount);
  describeSplit();
  els.splitModal.hidden = false;
  els.splitEvery.focus();
});

els.splitGo.addEventListener('click', async () => {
  if (!doc) return;
  const { pages, perFile, files } = splitPlan();
  if (!pages.length) return;
  els.splitModal.hidden = true;

  setBusy(true, `Splitting ${pages.length} pages into ${files} files…`);
  try {
    const whole = pages.length === doc.pageCount;
    const pieces = await doc.splitPages(perFile, whole ? undefined : pages);
    const archive = zip(pieces.map((p) => ({ name: p.name, bytes: p.bytes })));

    const copy = new Uint8Array(archive.length);
    copy.set(archive);
    const url = URL.createObjectURL(new Blob([copy], { type: 'application/zip' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = doc.name.replace(/\.pdf$/i, '') + ' pages.zip';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 20000);

    setStatus(
      `Split into ${pieces.length} file${pieces.length === 1 ? '' : 's'}, saved as one zip.`,
    );
  } catch (e) {
    setStatus(`Could not split that: ${reason(e)}`, 'warn');
  } finally {
    setBusy(false);
  }
});

/* ---------------- password protection ---------------- */

els.btnProtect.addEventListener('click', () => {
  if (!doc) {
    setStatus('Open a PDF first.', 'warn');
    return;
  }
  els.protectPassword.value = '';
  els.protectConfirm.value = '';
  els.protectHint.textContent = 'Nobody can recover this password for you, not even Handpress.';
  els.protectModal.hidden = false;
  els.protectPassword.focus();
});

els.protectCancel.addEventListener('click', () => {
  els.protectModal.hidden = true;
  els.protectPassword.value = '';
  els.protectConfirm.value = '';
});

els.protectModal.addEventListener('click', (e) => {
  if (e.target === els.protectModal) els.protectCancel.click();
});

for (const field of [els.protectPassword, els.protectConfirm]) {
  field.addEventListener('input', () => {
    const password = els.protectPassword.value;
    const confirm = els.protectConfirm.value;
    els.protectHint.textContent = !password
      ? 'Nobody can recover this password for you, not even Handpress.'
      : confirm && password !== confirm
        ? 'The two do not match yet.'
        : password.length < 6
          ? 'Short passwords are guessed quickly. Six characters is a floor, not a target.'
          : 'Ready.';
  });
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') els.protectGo.click();
    if (e.key === 'Escape') els.protectCancel.click();
    e.stopPropagation();
  });
}

els.protectGo.addEventListener('click', async () => {
  if (!doc) return;
  const password = els.protectPassword.value;
  const confirm = els.protectConfirm.value;

  if (!password) {
    els.protectHint.textContent = 'A password with nothing in it protects nothing.';
    return;
  }
  if (password !== confirm) {
    els.protectHint.textContent = 'The two do not match.';
    return;
  }

  els.protectModal.hidden = true;
  viewer.closeEditor(false);
  setBusy(true, 'Locking a copy…');
  try {
    const { bytes } = await doc.build();
    const locked = await encrypt(bytes, { userPassword: password });

    const copy = new Uint8Array(locked.length);
    copy.set(locked);
    const url = URL.createObjectURL(new Blob([copy], { type: 'application/pdf' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = doc.name.replace(/\.pdf$/i, '') + ' (locked).pdf';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 20000);

    setStatus('Saved a locked copy. It needs that password to open, and there is no way back without it.');
  } catch (e) {
    setStatus(`Could not lock that: ${reason(e)}`, 'warn');
  } finally {
    // The password is not kept a moment longer than it is needed.
    els.protectPassword.value = '';
    els.protectConfirm.value = '';
    setBusy(false);
  }
});

els.btnExtract.addEventListener('click', openExtract);
els.extractCancel.addEventListener('click', () => {
  els.extractModal.hidden = true;
});
els.extractModal.addEventListener('click', (e) => {
  if (e.target === els.extractModal) els.extractModal.hidden = true;
});
els.extractRange.addEventListener('input', () => {
  if (!doc) return;
  const n = parseRange(els.extractRange.value, doc.pageCount).length;
  els.extractHint.textContent = n
    ? `${n} page${n === 1 ? '' : 's'} selected.`
    : 'That does not select any pages.';
});
els.extractRange.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') els.extractGo.click();
});

els.extractGo.addEventListener('click', async () => {
  if (!doc) return;
  const positions = parseRange(els.extractRange.value, doc.pageCount);
  if (!positions.length) {
    setStatus('That range does not select any pages.', 'warn');
    return;
  }
  els.extractModal.hidden = true;
  setBusy(true, 'Preparing those pages…');
  try {
    const bytes = await doc.extractPages(positions);
    const base = doc.name.replace(/\.pdf$/i, '');
    downloadPdf(bytes, `${base} (pages ${els.extractRange.value.trim()}).pdf`);
    setStatus(`Saved ${positions.length} page${positions.length === 1 ? '' : 's'} as a new PDF.`);
  } catch (e) {
    setStatus(`Could not extract those pages: ${reason(e)}`, 'warn');
  } finally {
    setBusy(false);
  }
});

/* ---------------- properties ---------------- */

function showProperties(line: TextLine | null, page: PageModel | null): void {
  if (!line || !page || !doc) {
    els.panelBody.innerHTML = '<p class="panel-empty">Select a line of text to see how it is set.</p>';
    return;
  }

  const fonts = [...new Set(line.segments.map((s) => s.font.family || s.font.baseFont || s.font.subtype))];
  const sizes = [...new Set(line.segments.map((s) => Math.round(s.fontSize * 10) / 10))];
  const f = line.font;
  const color = `rgb(${Math.round(line.fill.r * 255)}, ${Math.round(line.fill.g * 255)}, ${Math.round(line.fill.b * 255)})`;
  const style = [f.bold ? 'Bold' : '', f.italic ? 'Italic' : ''].filter(Boolean).join(' ') || 'Regular';

  const rows: Array<[string, string]> = [
    ['Font', escapeHtml(fonts.join(', '))],
    ['Style', style],
    ['Size', sizes.map((s) => `${s}pt`).join(', ')],
    ['Colour', `<span class="prop-swatch" style="background:${color}"></span>${color}`],
    ['Embedded', f.embedded ? `Yes (${f.fontFileKind.toUpperCase()})` : 'No'],
    ['Type', escapeHtml(f.subtype)],
    ['Runs', String(line.segments.length)],
  ];

  const edited = doc.isEdited(page.index, line.id);
  const note = !line.editable
    ? '<p class="panel-note">This font has no reliable character mapping, so Handpress cannot tell which glyph is which. Editing is disabled here to avoid corrupting the page.</p>'
    : edited
      ? '<p class="panel-note ok">Edited. The page above already shows the result that will be saved.</p>'
      : '';

  els.panelBody.innerHTML =
    rows
      .map(([k, v]) => `<div class="prop-row"><span class="prop-key">${k}</span><span class="prop-val">${v}</span></div>`)
      .join('') +
    note +
    `<div class="panel-text">${escapeHtml(doc.textFor(page.index, line))}</div>`;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

/* ---------------- misc ---------------- */

window.addEventListener('beforeunload', (e) => {
  if (doc?.hasEdits()) {
    e.preventDefault();
    e.returnValue = '';
  }
});

let resizeTimer: number | undefined;
window.addEventListener('resize', () => {
  if (els.zoomSelect.value !== 'fit') return;
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => void applyZoomChoice(), 180);
});

for (const id of ['appVersion', 'statusVersion']) {
  const label = document.getElementById(id);
  if (label) label.textContent = __APP_VERSION__;
}

syncEditState();

// Dev convenience: ?sample=<path> opens a local file on load so the editor can
// be exercised without a file picker. Never enabled in a production build.
if (import.meta.env.DEV) {
  const sample = new URLSearchParams(location.search).get('sample');
  if (sample) {
    void fetch(sample)
      .then((r) => r.arrayBuffer())
      .then((b) => {
        const name = sample.split('/').pop() ?? 'sample.pdf';
        const type = /\.png$/i.test(name)
          ? 'image/png'
          : /\.jpe?g$/i.test(name)
            ? 'image/jpeg'
            : 'application/pdf';
        return openFile(new File([b], name, { type }));
      })
      .catch((e) => setStatus(`Could not load sample: ${e.message}`, 'warn'));
  }
}
