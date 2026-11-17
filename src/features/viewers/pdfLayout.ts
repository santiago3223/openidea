/** PDF viewer geometry: page stacking, fit zooms, scroll anchoring and canvas limits. */
import { stepZoom } from "./imageZoom";

/** CSS pixels per PDF point: at 100% a page shows at its physical size. */
export const CSS_UNITS = 96 / 72;

const MIN_PDF_ZOOM = 0.1;
const MAX_PDF_ZOOM = 8;
/** Opening zoom never upscales past this, so wide panes don't get billboard-sized pages. */
const MAX_AUTO_ZOOM = 1.25;
/** Past this the canvas gets softer rather than exhausting canvas memory. */
const MAX_CANVAS_PIXELS = 16 * 1024 * 1024;

export const PAGE_GAP = 12;

export interface PageSize {
  w: number;
  h: number;
}

export interface PageLayout {
  zoom: number;
  tops: number[];
  sizes: PageSize[];
  width: number;
  height: number;
}

/** Where the viewport points at: stays put across zoom changes. */
export interface ScrollAnchor {
  page: number;
  fraction: number;
  /** Viewport offset of the anchored point. */
  x: number;
  y: number;
  xFraction: number;
}

export type ZoomSpec = "auto" | "width" | number;

export const clampPdfZoom = (z: number) => Math.min(MAX_PDF_ZOOM, Math.max(MIN_PDF_ZOOM, z));

export const stepPdfZoom = (zoom: number, dir: 1 | -1) => clampPdfZoom(stepZoom(zoom, dir));

/** `sizes` are CSS pixels at 100%; `availW` is the pane width without the gaps. */
export function resolveZoom(spec: ZoomSpec, sizes: readonly PageSize[], availW: number): number {
  if (typeof spec === "number") return spec;
  const widest = sizes.reduce((max, s) => Math.max(max, s.w), 0);
  const fit = widest > 0 && availW > 0 ? availW / widest : 1;
  return clampPdfZoom(spec === "auto" ? Math.min(MAX_AUTO_ZOOM, fit) : fit);
}

export function layoutPages(sizes: readonly PageSize[], zoom: number): PageLayout {
  const tops: number[] = [];
  const scaled: PageSize[] = [];
  let y = PAGE_GAP;
  let width = 0;
  for (const s of sizes) {
    const size = { w: Math.round(s.w * zoom), h: Math.round(s.h * zoom) };
    tops.push(y);
    scaled.push(size);
    y += size.h + PAGE_GAP;
    width = Math.max(width, size.w);
  }
  return { zoom, tops, sizes: scaled, width, height: y };
}

/** Index of the page at or nearest above `y` (the gap above a page belongs to it). */
export function pageAt(layout: PageLayout, y: number): number {
  let lo = 0;
  let hi = layout.tops.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (layout.tops[mid]! - PAGE_GAP <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Pages to keep rendered around the viewport, half a screen ahead on both sides. */
export function visiblePages(layout: PageLayout, scrollTop: number, viewH: number): { first: number; last: number } {
  const margin = viewH / 2;
  return { first: pageAt(layout, scrollTop - margin), last: pageAt(layout, scrollTop + viewH + margin) };
}

export function anchorAt(layout: PageLayout, docY: number): Pick<ScrollAnchor, "page" | "fraction"> {
  const page = pageAt(layout, docY);
  const h = layout.sizes[page]?.h ?? 0;
  const fraction = h > 0 ? Math.min(1, Math.max(0, (docY - layout.tops[page]!) / h)) : 0;
  return { page, fraction };
}

export function anchorY(layout: PageLayout, anchor: Pick<ScrollAnchor, "page" | "fraction">): number {
  const page = Math.min(anchor.page, layout.tops.length - 1);
  return (layout.tops[page] ?? 0) + anchor.fraction * (layout.sizes[page]?.h ?? 0);
}

/** Canvas scale (per CSS pixel) for a page of `w × h` CSS pixels on this display. */
export function canvasScale(w: number, h: number, devicePixelRatio: number): number {
  const area = w * h * devicePixelRatio * devicePixelRatio;
  return area > MAX_CANVAS_PIXELS ? devicePixelRatio * Math.sqrt(MAX_CANVAS_PIXELS / area) : devicePixelRatio;
}
