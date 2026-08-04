/**
 * Capturing a signature, either drawn by hand or from a photograph.
 *
 * Both paths end at the same place: a trimmed PNG with a transparent
 * background, so the page shows through around the strokes and the placed
 * result is the ink rather than a white rectangle sitting on the document.
 */

export interface CapturedSignature {
  png: Uint8Array;
  width: number;
  height: number;
}

async function canvasToPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('could not read the drawing');
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Crops away fully transparent margins.
 *
 * Without this, placement depends on where in the capture area someone happened
 * to sign, so the same signature would land differently every time.
 */
function trim(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return canvas;
  const { width, height } = canvas;
  if (!width || !height) return canvas;

  const data = ctx.getImageData(0, 0, width, height).data;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] < 8) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return canvas; // nothing drawn

  const pad = 4;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad);
  maxY = Math.min(height - 1, maxY + pad);

  const out = document.createElement('canvas');
  out.width = maxX - minX + 1;
  out.height = maxY - minY + 1;
  out.getContext('2d')!.drawImage(canvas, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

/**
 * Turns paper white into transparency.
 *
 * A photographed or scanned signature is dark ink on a bright page, and the page
 * is never evenly lit, so a hard threshold leaves grey blotches and jagged
 * edges. Alpha instead ramps across a band of brightness, which keeps the
 * anti-aliasing on the strokes and lets uneven lighting fade out smoothly.
 */
function dropBackground(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = image.data;

  const opaqueBelow = 110; // fully ink
  const clearAbove = 205; // fully paper

  for (let i = 0; i < d.length; i += 4) {
    const luminance = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    let alpha: number;
    if (luminance <= opaqueBelow) alpha = 255;
    else if (luminance >= clearAbove) alpha = 0;
    else alpha = Math.round(255 * (1 - (luminance - opaqueBelow) / (clearAbove - opaqueBelow)));

    d[i + 3] = Math.min(d[i + 3], alpha);
    if (alpha > 0) {
      // Push the surviving ink towards its own darkest value so a grey
      // photograph still reads as a confident pen stroke.
      const boost = 0.65;
      d[i] = Math.round(d[i] * boost);
      d[i + 1] = Math.round(d[i + 1] * boost);
      d[i + 2] = Math.round(d[i + 2] * boost);
    }
  }
  ctx.putImageData(image, 0, 0);
}

/** Reads an image file into a signature, optionally clearing its background. */
export async function signatureFromFile(file: File, removeBackground: boolean): Promise<CapturedSignature> {
  const bitmap = await createImageBitmap(file);

  // Very large photographs are pointless here and slow to process.
  const maxSide = 1600;
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  if (removeBackground) dropBackground(canvas);
  const trimmed = trim(canvas);
  return { png: await canvasToPng(trimmed), width: trimmed.width, height: trimmed.height };
}

/**
 * A canvas you can sign on with a mouse, pen or finger.
 *
 * Strokes are smoothed through the midpoint of each pair of samples, which turns
 * the coarse, jittery points a pointer actually reports into something that
 * looks handwritten rather than surveyed.
 */
export class SignaturePad {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private drawing = false;
  private points: Array<{ x: number; y: number }> = [];
  private dirty = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    this.resize();

    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointerleave', this.onUp);
  }

  /** Sizes the backing store to the element so strokes are not blurry. */
  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (this.canvas.width === w && this.canvas.height === h) return;
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';
    this.ctx.strokeStyle = '#111111';
    this.ctx.lineWidth = 2.4;
  }

  private position(e: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private onDown = (e: PointerEvent): void => {
    e.preventDefault();
    this.drawing = true;
    this.dirty = true;
    this.points = [this.position(e)];
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      // Capture is an optimisation; a pointer id the browser no longer tracks
      // must not stop somebody from signing.
    }
  };

  private onMove = (e: PointerEvent): void => {
    if (!this.drawing) return;
    e.preventDefault();
    this.points.push(this.position(e));
    const n = this.points.length;
    if (n < 3) return;

    const a = this.points[n - 3];
    const b = this.points[n - 2];
    const c = this.points[n - 1];
    const start = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const end = { x: (b.x + c.x) / 2, y: (b.y + c.y) / 2 };

    this.ctx.beginPath();
    this.ctx.moveTo(start.x, start.y);
    this.ctx.quadraticCurveTo(b.x, b.y, end.x, end.y);
    this.ctx.stroke();
  };

  private onUp = (): void => {
    if (!this.drawing) return;
    this.drawing = false;
    // A single tap still deserves a mark.
    if (this.points.length === 1) {
      const p = this.points[0];
      this.ctx.beginPath();
      this.ctx.arc(p.x, p.y, this.ctx.lineWidth / 2, 0, Math.PI * 2);
      this.ctx.fillStyle = this.ctx.strokeStyle as string;
      this.ctx.fill();
    }
    this.points = [];
  };

  clear(): void {
    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.restore();
    this.dirty = false;
  }

  isEmpty(): boolean {
    return !this.dirty;
  }

  async capture(): Promise<CapturedSignature | null> {
    if (this.isEmpty()) return null;
    const trimmed = trim(this.canvas);
    return { png: await canvasToPng(trimmed), width: trimmed.width, height: trimmed.height };
  }

  destroy(): void {
    this.canvas.removeEventListener('pointerdown', this.onDown);
    this.canvas.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    this.canvas.removeEventListener('pointerleave', this.onUp);
  }
}
