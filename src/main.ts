/**
 * Application wiring: file open, toolbar, thumbnails, properties panel, save.
 */

import './style.css';
import { VellumDocument, type PageModel } from './app/model';
import { Viewer } from './app/viewer';
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
  busyText: $('busyText'),
};

let doc: VellumDocument | null = null;
let statusTimer: number | undefined;

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

function setBusy(on: boolean, text = 'Working…'): void {
  els.busyText.textContent = text;
  els.busy.hidden = !on;
}

const viewer = new Viewer(els.viewer, {
  onSelect: showProperties,
  onEdited: () => {
    syncEditState();

    void renderThumbs();
  },
  onStatus: setStatus,
});

/* ---------------- opening ---------------- */

async function openFile(file: File): Promise<void> {
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
    setStatus('That does not look like a PDF.', 'warn');
    return;
  }

  setBusy(true, `Opening ${file.name}…`);
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());

    if (await VellumDocument.isEncrypted(bytes)) {
      setBusy(false);
      setStatus(
        'This PDF is password protected or permission locked. Vellum cannot edit encrypted files yet.',
        'warn',
      );
      return;
    }

    const { doc: opened, report } = await VellumDocument.open(file.name, bytes);
    doc = opened;

    els.dropzone.hidden = true;
    els.docTitle.textContent = file.name;
    els.docTitle.classList.remove('dirty');
    els.pageTotal.textContent = `/ ${report.pageCount}`;
    els.pageInput.value = '1';

    await viewer.load(doc);
    await applyZoomChoice();
    await renderThumbs();
    syncEditState();


    if (report.scannedPages.length) {
      setStatus(
        report.scannedPages.length === report.pageCount
          ? 'This PDF has no text layer. It looks like a scan, so there is no text to edit; it would need OCR first.'
          : `Page ${report.scannedPages[0] + 1} has no text layer and looks scanned.`,
        'warn',
      );
    } else {
      setStatus(`Opened ${report.pageCount} page${report.pageCount === 1 ? '' : 's'}. Click any line to edit it.`);
    }
  } catch (e) {
    setStatus(`Could not open that PDF: ${(e as Error).message}`, 'warn');
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
  const f = (e as DragEvent).dataTransfer?.files?.[0];
  if (f) void openFile(f);
});

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
    a.download = doc.name.replace(/\.pdf$/i, '') + ' (edited).pdf';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 20000);

    const subs = warnings.filter((w) => w.kind === 'substituted-font').length;
    setStatus(subs ? `Saved. ${subs} run${subs === 1 ? '' : 's'} used a substitute font.` : 'Saved.');
  } catch (e) {
    setStatus(`Could not build the PDF: ${(e as Error).message}`, 'warn');
  } finally {
    setBusy(false);
  }
});

/* ---------------- undo / redo ---------------- */

async function applyHistory(page: number | null): Promise<void> {
  if (page === null || !doc) return;
  setBusy(true, 'Updating…');
  try {
    await doc.refresh();
    await viewer.refreshRendered();
    await renderThumbs();
    syncEditState();

  } finally {
    setBusy(false);
  }
}

els.btnUndo.addEventListener('click', () => void applyHistory(doc?.undo() ?? null));
els.btnRedo.addEventListener('click', () => void applyHistory(doc?.redo() ?? null));

window.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;
  const key = e.key.toLowerCase();
  if (key === 'z') {
    e.preventDefault();
    void applyHistory(e.shiftKey ? (doc?.redo() ?? null) : (doc?.undo() ?? null));
  } else if (key === 's') {
    e.preventDefault();
    els.btnSave.click();
  } else if (key === 'o') {
    e.preventDefault();
    els.fileInput.click();
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

els.btnSidebar.addEventListener('click', () => {
  els.workspace.classList.toggle('no-sidebar');
  els.btnSidebar.classList.toggle('tool-active');
});
els.btnPanel.addEventListener('click', () => {
  els.workspace.classList.toggle('no-panel');
  els.btnPanel.classList.toggle('tool-active');
});

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
    if (i === viewer.currentPageIndex()) wrap.classList.add('current');
    const canvas = document.createElement('canvas');
    const num = document.createElement('span');
    num.className = 'thumb-num';
    num.textContent = String(i + 1);
    wrap.append(canvas, num);
    wrap.addEventListener('click', () => viewer.scrollToPage(i));
    els.thumbs.appendChild(wrap);
  }

  // Thumbnails render one at a time so they never contend with the main view.
  for (let i = 0; i < doc.pageCount; i++) {
    if (token !== thumbToken) return;
    try {
      const page = await doc.pdfjs.getPage(i + 1);
      const base = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: 150 / base.width });
      const canvas = els.thumbs.children[i]?.querySelector('canvas');
      if (!canvas) continue;
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      const ctx = canvas.getContext('2d')!;
      await page.render({ canvasContext: ctx, viewport: vp, canvas }).promise;
    } catch {
      // A thumbnail that will not render is not worth failing the session over.
    }
  }
}

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
      .then((b) => openFile(new File([b], sample.split('/').pop() ?? 'sample.pdf', { type: 'application/pdf' })))
      .catch((e) => setStatus(`Could not load sample: ${e.message}`, 'warn'));
  }
}
