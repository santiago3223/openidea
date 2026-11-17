import { describe, expect, it } from "vitest";
import { registerTextEditorWrapper, resolveFileEditor } from "@/workbench/contributions";
import { activate as activateViewers } from "./index";
import {
  associatedApplication,
  binaryInput,
  formatSize,
  imageInput,
  isImagePath,
  isMarkdownPath,
  isPdfPath,
  isSvgPath,
  pdfInput,
  wantsHexView,
} from "./fileKinds";
import {
  BYTES_PER_ROW,
  MAX_SCROLL_PX,
  PAGE_SIZE,
  asciiChar,
  decodeBase64,
  formatOffset,
  hexViewport,
  offsetDigits,
  pagesForRows,
  rowBytes,
  rowCount,
  scrollTopForRow,
} from "./hex";
import { fitZoom, initialZoom, stepZoom, zoomAt, zoomLabel } from "./imageZoom";
import {
  PAGE_GAP,
  anchorAt,
  anchorY,
  canvasScale,
  layoutPages,
  pageAt,
  resolveZoom,
  stepPdfZoom,
  visiblePages,
} from "./pdfLayout";

describe("file kinds", () => {
  it("routes by extension", () => {
    expect(isImagePath("/p/a.PNG")).toBe(true);
    expect(isImagePath("/p/icon.svg")).toBe(true);
    expect(isImagePath("/p/png")).toBe(false);
    expect(isImagePath("/p/.png")).toBe(false);
    expect(isSvgPath("/p/x.svg")).toBe(true);
    expect(isMarkdownPath("/p/README.md")).toBe(true);
    expect(isMarkdownPath("/p/notes.txt")).toBe(false);
    expect(isPdfPath("/p/Report.PDF")).toBe(true);
    expect(isPdfPath("/p/pdf")).toBe(false);
  });

  it("matches files opened with an associated application", () => {
    const office = ["*.xlsx", "*.pdf"];
    expect(associatedApplication("/p/a.xlsx", office, "windows")).toBe(true);
    expect(associatedApplication("/p/A.XLSX", office, "macos")).toBe(true);
    expect(associatedApplication("/p/A.XLSX", office, "linux")).toBe(false);
    expect(associatedApplication("/p/a.txt", office, "windows")).toBe(false);
    expect(associatedApplication("/p/a.xlsx.bak", office, "windows")).toBe(false);
    // Only the file name matches, not a directory that looks like a pattern.
    expect(associatedApplication("/p/*.xlsx/report.txt", office, "windows")).toBe(false);
  });

  it("builds viewer inputs keyed apart from text tabs", () => {
    expect(imageInput("/a/b.png")).toEqual({ kind: "image", key: "image:/a/b.png", path: "/a/b.png" });
    expect(pdfInput("/a/b.pdf")).toEqual({ kind: "pdf", key: "pdf:/a/b.pdf", path: "/a/b.pdf" });
    const input = binaryInput("/a/b.bin", { size: 10, binary: true, tooLarge: false });
    expect(input.key).toBe("binary:/a/b.bin");
    expect(input.data).toEqual({ size: 10, binary: true });
  });

  it("uses the hex view for binary or huge files", () => {
    expect(wantsHexView({ size: 1, binary: true, tooLarge: false })).toBe(true);
    expect(wantsHexView({ size: 1, binary: false, tooLarge: true })).toBe(true);
    expect(wantsHexView({ size: 1, binary: false, tooLarge: false })).toBe(false);
  });

  it("formats sizes", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(300 * 1024 * 1024)).toBe("300 MB");
  });

  it("lets a text editor wrapper take precedence over the image viewer", async () => {
    const offViewers = activateViewers();
    const offWrapper = registerTextEditorWrapper({
      id: "plugin.acme.diagram.canvas",
      matches: (p) => p.endsWith(".diagram.svg"),
      component: () => null,
    });
    try {
      expect((await resolveFileEditor("/p/icon.svg"))?.input.kind).toBe("image");
      expect(await resolveFileEditor("/p/arch.diagram.svg")).toBeNull();
    } finally {
      offWrapper();
      offViewers();
    }
  });
});

describe("hex model", () => {
  it("decodes base64 and formats bytes", () => {
    expect([...decodeBase64("AAH/")]).toEqual([0, 1, 255]);
    expect(formatOffset(255, 8)).toBe("000000FF");
    expect(offsetDigits(16)).toBe(8);
    expect(offsetDigits(2 ** 36)).toBe(9);
    expect(asciiChar(0x41)).toBe("A");
    expect(asciiChar(0)).toBe(".");
    expect(asciiChar(0x7f)).toBe(".");
  });

  it("slices rows out of loaded pages", () => {
    const total = PAGE_SIZE + 20;
    const pages = new Map([[0, new Uint8Array(PAGE_SIZE).map((_, i) => i % 256)]]);
    expect(rowCount(total)).toBe(PAGE_SIZE / BYTES_PER_ROW + 2);
    expect([...rowBytes(pages, 1, total)!]).toEqual([16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31]);
    expect(rowBytes(pages, PAGE_SIZE / BYTES_PER_ROW, total)).toBeNull();
    pages.set(1, new Uint8Array(20).fill(7));
    expect(rowBytes(pages, PAGE_SIZE / BYTES_PER_ROW + 1, total)!.length).toBe(4);
    expect(pagesForRows(0, PAGE_SIZE / BYTES_PER_ROW)).toEqual([0, 1]);
  });

  it("maps a capped scroll range onto all rows", () => {
    const rows = 50_000_000;
    const top = hexViewport(0, 400, rows, 20);
    expect(top).toEqual({ spacer: MAX_SCROLL_PX, first: 0, shift: 0 });
    const end = hexViewport(MAX_SCROLL_PX - 400, 400, rows, 20);
    expect(end.first).toBe(rows - 20);
    const st = scrollTopForRow(rows / 2, 400, rows, 20);
    expect(Math.abs(hexViewport(st, 400, rows, 20).first - rows / 2)).toBeLessThanOrEqual(1);
    // Small files scroll 1:1.
    expect(hexViewport(45, 400, 100, 20)).toEqual({ spacer: 2000, first: 2, shift: 5 });
  });
});

describe("image zoom", () => {
  it("steps through 100%", () => {
    expect(stepZoom(1, 1)).toBe(1.25);
    expect(stepZoom(0.9, 1)).toBe(1);
    expect(stepZoom(1.1, -1)).toBe(1);
    expect(stepZoom(64, 1)).toBe(64);
  });

  it("fits and starts at actual size when possible", () => {
    expect(fitZoom(200, 100, 100, 100)).toBe(0.5);
    expect(initialZoom(50, 50, 100, 100)).toBe(1);
    expect(initialZoom(400, 100, 100, 100)).toBe(0.25);
    expect(zoomLabel(0.333)).toBe("33%");
  });

  it("keeps the point under the cursor fixed when zooming", () => {
    const v = { z: 1, x: 10, y: 20 };
    const next = zoomAt(v, 2, 110, 70);
    // Image point under (110, 70) before: ((110-10)/1, (70-20)/1) = (100, 50).
    expect(next).toEqual({ z: 2, x: -90, y: -30 });
    expect(next.x + 100 * next.z).toBe(110);
    expect(next.y + 50 * next.z).toBe(70);
  });
});

describe("PDF layout", () => {
  const sizes = [
    { w: 800, h: 1000 },
    { w: 600, h: 500 },
    { w: 800, h: 1000 },
  ];

  it("resolves fit zooms from the widest page and caps the opening zoom", () => {
    expect(resolveZoom("width", sizes, 1600)).toBe(2);
    expect(resolveZoom("auto", sizes, 1600)).toBe(1.25);
    expect(resolveZoom("auto", sizes, 400)).toBe(0.5);
    expect(resolveZoom(3, sizes, 400)).toBe(3);
    expect(stepPdfZoom(8, 1)).toBe(8);
  });

  it("stacks pages with gaps", () => {
    const layout = layoutPages(sizes, 0.5);
    expect(layout.tops).toEqual([PAGE_GAP, 512 + PAGE_GAP, 762 + PAGE_GAP + PAGE_GAP]);
    expect(layout.width).toBe(400);
    expect(layout.height).toBe(1250 + 4 * PAGE_GAP);
  });

  it("finds the pages around the viewport", () => {
    const layout = layoutPages(sizes, 1);
    expect(pageAt(layout, -50)).toBe(0);
    expect(pageAt(layout, 500)).toBe(0);
    expect(pageAt(layout, 1100)).toBe(1);
    expect(pageAt(layout, 99999)).toBe(2);
    expect(visiblePages(layout, 0, 100)).toEqual({ first: 0, last: 0 });
    expect(visiblePages(layout, 1000, 400)).toEqual({ first: 0, last: 2 });
  });

  it("keeps the anchored page point across zooms", () => {
    const before = layoutPages(sizes, 1);
    const anchor = anchorAt(before, before.tops[1]! + 250);
    expect(anchor).toEqual({ page: 1, fraction: 0.5 });
    const after = layoutPages(sizes, 2);
    expect(anchorY(after, anchor)).toBe(after.tops[1]! + 500);
  });

  it("caps the canvas area but keeps display density for normal pages", () => {
    expect(canvasScale(800, 1000, 2)).toBe(2);
    const capped = canvasScale(8000, 10000, 2);
    expect(8000 * capped * 10000 * capped).toBeCloseTo(16 * 1024 * 1024);
  });
});
