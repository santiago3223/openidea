/** Target of the pdf.* actions; separate from the viewer so pdf.js stays out of the initial bundle. */
import { create } from "zustand";

export interface PdfViewerHandle {
  zoom(dir: 1 | -1): void;
  actualSize(): void;
  fitWidth(): void;
}

export const usePdfViewers = create<{ active: PdfViewerHandle | null }>(() => ({ active: null }));
