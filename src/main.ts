/**
 * Application wiring: file open, toolbar, thumbnails, properties panel, save.
 */

import './style.css';
import { VellumDocument, type PageModel, type SearchMatch } from './app/model';
import { Viewer } from './app/viewer';
import { LocalFontProvider, localFontsSupported } from './app/local-fonts';
import { DecryptionError } from './pdf/decrypt';
import { SignaturePad, signatureFromFile, type CapturedSignature } from './app/signature';
import { OCR_SCALE, openRecogniser, wordsToInsertions, type Recogniser } from './app/ocr';
import { looksLikeImage, pdfFromImages } from './pdf/images';
import { compress } from './pdf/compress';
import { AUTOSAVE_LIMIT, forget, howLongAgo, keep, recover } from './app/autosave';
import { recompressInBrowser } from './app/recompress';
import type { TextLine } from './pdf/content';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const els = {
  docTitle: $('docTitle'),
  btnOpen: $<HTMLButtonElement>('btnOpen'),
  btnSave: $<HTMLButtonElement>('btnSave'),
  btnChoose: $<HTMLButtonElement>('btnChoose'),
  btnUndo: $<HTMLButtonElement>('btnUndo'),
  btnRedo: $<HTMLButtonElement>('btnRedo'),
  btnZoomIn: $<HTMLButtonElement>('btnZoomIn'),
  btnZoomOut: $<HTMLButtonElement>('btnZoomOut'),
  btnSidebar: $<HTMLButtonElement>('btnSidebar'),
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
  btnHighlight: $<HTMLButtonElement>('btnHighlight'),
  btnNote: $<HTMLButtonElement>('btnNote'),
  btnOcr: $<HTMLButtonElement>('btnOcr'),
  highlightColor: $<HTMLInputElement>('highlightColor'),
  btnAddPages: $<HTMLButtonElement>('btnAddPages'),
  searchInput: $<HTMLInputElement>('searchInput'),
  searchCount: $('searchCount'),
  searchPrev: $<HTMLButtonElement>('searchPrev'),
  searchNext: $<HTMLButtonElement>('searchNext'),
  btnExtract: $<HTMLButtonElement>('btnExtract'),
  btnPageImage: $<HTMLButtonElement>('btnPageImage'),
  btnCompress: $<HTMLButtonElement>('btnCompress'),
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

let doc: VellumDocument | null = null;
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
});

/* ---------------- opening ---------------- */

async function openFile(file: File): Promise<void> {
  const isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
  if (!isPdf && !looksLikeImage(file)) {
    setStatus('That is not a PDF or an image.', 'warn');
    return;
  }

  setBusy(true, `Opening ${file.name}…`);
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
    const { doc: opened, report } = await VellumDocument.open(name, bytes);
    doc = opened;
    signedDocument = report.signatures.signatures.length > 0;
    if (localFonts.enabled) doc.fontProvider = localFonts;

    els.dropzone.hidden = true;
    els.restoreBar.hidden = true;
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
    syncEditState();


    if (report.scannedPages.length) {
      setStatus(
        report.scannedPages.length === report.pageCount
          ? 'This PDF has no text layer. It looks like a scan, so there is no text to edit; it would need OCR first.'
          : `Page ${report.scannedPages[0] + 1} has no text layer and looks scanned.`,
        'warn',
      );
    } else if (report.wasEncrypted) {
      setStatus(
        `Opened ${report.pageCount} page${report.pageCount === 1 ? '' : 's'}. This PDF was permission locked; ` +
          'it has been unlocked and the copy you save will not be locked.',
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
      setStatus(e.message, 'warn');
    } else {
      setStatus(`Could not open that PDF: ${(e as Error).message}`, 'warn');
    }
  } finally {
    setBusy(false);
  }
}

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
    setStatus(`Could not make a PDF from those images: ${(e as Error).message}`, 'warn');
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
    `Vellum still has ${saved.name}, as it stood ${howLongAgo(saved.saved)}. ` +
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
    setStatus(`Could not build the PDF: ${(e as Error).message}`, 'warn');
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
  } else if (key === 'o') {
    e.preventDefault();
    els.fileInput.click();
  } else if (key === 'a' && viewer.currentMode() === 'select') {
    // Only in the select tool, and only the page: the browser's own select all
    // would take the toolbar and the status line with it.
    if (viewer.selectPageText()) e.preventDefault();
  } else if (key === 'f') {
    e.preventDefault();
    els.searchInput.focus();
    els.searchInput.select();
  } else if (key === 'g') {
    e.preventDefault();
    void step(e.shiftKey ? -1 : 1);
  }
});

function syncEditState(): void {
  const dirty = doc?.hasEdits() ?? false;
  els.btnSave.disabled = !doc;
  els.btnUndo.disabled = !doc?.canUndo();
  els.btnRedo.disabled = !doc?.canRedo();
  els.docTitle.classList.toggle('dirty', dirty);
  const n = doc?.editCount() ?? 0;
  els.editCount.textContent = n ? `${n} edit${n === 1 ? '' : 's'}` : '';
}

/* ---------------- editing mode ---------------- */

function setMode(mode: 'edit' | 'select' | 'add' | 'sign' | 'note' | 'erase' | 'redact' | 'highlight'): void {
  viewer.setMode(mode);
  els.btnModeEdit.classList.toggle('tool-active', mode === 'edit');
  els.btnModeSelect.classList.toggle('tool-active', mode === 'select');
  els.btnModeAdd.classList.toggle('tool-active', mode === 'add');
  els.btnSign.classList.toggle('tool-active', mode === 'sign');
  els.btnErase.classList.toggle('tool-active', mode === 'erase');
  els.btnRedact.classList.toggle('tool-active', mode === 'redact');
  els.btnHighlight.classList.toggle('tool-active', mode === 'highlight');
  els.btnNote.classList.toggle('tool-active', mode === 'note');
  const messages = {
    edit: 'Click any line of text to edit it, or drag it to move it.',
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
  const hex = els.highlightColor.value;
  viewer.highlightColor = {
    r: parseInt(hex.slice(1, 3), 16) / 255,
    g: parseInt(hex.slice(3, 5), 16) / 255,
    b: parseInt(hex.slice(5, 7), 16) / 255,
  };
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
  const hex = els.addColor.value;
  viewer.addColor = {
    r: parseInt(hex.slice(1, 3), 16) / 255,
    g: parseInt(hex.slice(3, 5), 16) / 255,
    b: parseInt(hex.slice(5, 7), 16) / 255,
  };
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
    setStatus(`Could not read that image: ${(e as Error).message}`, 'warn');
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
    const available = els.viewer.clientWidth - 48;
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
  });
});

/* ---------------- thumbnails ---------------- */

let thumbToken = 0;

async function renderThumbs(): Promise<void> {
  if (!doc?.pdfjs) return;
  const token = ++thumbToken;
  els.thumbs.innerHTML = '';

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
  }

  // Thumbnails go through the viewer's own render queue rather than calling
  // pdf.js directly. They draw the same pages the main view is drawing, and
  // pdf.js will not render one page twice at once: rendering a thumbnail of a
  // page the viewer was already drawing never returned, which left the whole
  // open stuck behind it.
  for (let i = 0; i < doc.pageCount; i++) {
    if (token !== thumbToken) return;
    try {
      const page = await doc.pdfjs.getPage(i + 1);
      const base = page.getViewport({ scale: 1 });
      const canvas = els.thumbs.children[i]?.querySelector('canvas');
      if (!canvas) continue;
      const image = await viewer.rasterise(i, 150 / base.width);
      if (token !== thumbToken) return;
      canvas.width = image.width;
      canvas.height = image.height;
      canvas.getContext('2d')!.drawImage(image, 0, 0);
    } catch {
      // A thumbnail that will not render is not worth failing the session over.
    }
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
    setStatus(`Could not update pages: ${(e as Error).message}`, 'warn');
  } finally {
    setBusy(false);
  }
}

/* ---------------- recognising scanned pages ---------------- */

/**
 * Measures a word using a canvas, which is close enough to Helvetica's own
 * metrics for deciding how far each recognised word has to be stretched.
 */
const measureCanvas = document.createElement('canvas');
const measureCtx = measureCanvas.getContext('2d')!;
function measureHelvetica(text: string, size: number): number {
  measureCtx.font = `${size}px Helvetica, Arial, sans-serif`;
  return measureCtx.measureText(text).width;
}

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
    recogniser = await openRecogniser((fraction, label) => {
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
    setStatus(`Could not read that: ${(e as Error).message}`, 'warn');
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
    els.searchInput.value = '';
    void runSearch();
    els.searchInput.blur();
  }
  e.stopPropagation();
});
els.searchNext.addEventListener('click', () => void step(1));
els.searchPrev.addEventListener('click', () => void step(-1));

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
    setStatus(`Could not add those pages: ${(e as Error).message}`, 'warn');
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
    setStatus(`Could not save that page as an image: ${(e as Error).message}`, 'warn');
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
    setStatus(`Could not compress that: ${(e as Error).message}`, 'warn');
  } finally {
    setBusy(false);
  }
});

function sizeOf(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

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
    setStatus(`Could not extract those pages: ${(e as Error).message}`, 'warn');
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
    ? '<p class="panel-note">This font has no reliable character mapping, so Vellum cannot tell which glyph is which. Editing is disabled here to avoid corrupting the page.</p>'
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
