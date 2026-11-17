/**
 * Opens PDFs with pdf.js. Webviews differ in native PDF support (WebKitGTK has
 * none), and the build targets older WebKit than pdf.js' modern build, hence
 * the legacy one. Fonts, CMaps and decoders are inlined into lazy chunks: the
 * CSP's `connect-src` doesn't allow fetching them.
 */
import { getDocument, GlobalWorkerOptions, type PDFDocumentLoadingTask } from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { call, commands } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { decodeBase64 } from "./hex";

GlobalWorkerOptions.workerSrc = workerUrl;

const ASSET_ROOT = "/node_modules/pdfjs-dist";
const ASSET_DIRS: Record<string, string> = { cMapUrl: "cmaps", standardFontDataUrl: "standard_fonts", wasmUrl: "wasm" };
const ASSETS = import.meta.glob<string>(
  [
    "/node_modules/pdfjs-dist/cmaps/*.bcmap",
    "/node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}",
    "/node_modules/pdfjs-dist/wasm/{openjpeg,jbig2,qcms_bg}.wasm",
  ],
  { query: "?url&inline", import: "default" },
);

/** Serves pdf.js' data files from the bundle, in place of its fetching factory. */
class BundledBinaryData {
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const load = ASSETS[`${ASSET_ROOT}/${ASSET_DIRS[kind]}/${filename}`];
    if (!load) throw new Error(`Unknown pdf.js asset: ${filename}`);
    const url = await load();
    return decodeBase64(url.slice(url.indexOf(",") + 1));
  }
}

/** The whole file is handed to the worker, so size is bounded to what fits in memory. */
const MAX_PDF_SIZE = 512 * 1024 * 1024;
const CHUNK = 1024 * 1024;

export async function readPdfBytes(path: string, live: () => boolean): Promise<Uint8Array | null> {
  const first = await call(commands.fsReadRange(path, 0, CHUNK));
  if (first.total > MAX_PDF_SIZE) throw new Error(tx("the file is too large to preview"));
  const out = new Uint8Array(first.total);
  let chunk = decodeBase64(first.data);
  out.set(chunk);
  let offset = chunk.length;
  while (offset < first.total && chunk.length > 0) {
    if (!live()) return null;
    chunk = decodeBase64((await call(commands.fsReadRange(path, offset, CHUNK))).data);
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out.subarray(0, offset);
}

export function openPdf(data: Uint8Array): PDFDocumentLoadingTask {
  return getDocument({
    data,
    BinaryDataFactory: BundledBinaryData,
    // Required to be set; BundledBinaryData resolves names without them.
    cMapUrl: "/",
    standardFontDataUrl: "/",
    wasmUrl: "/",
  });
}

export function pdfErrorMessage(e: unknown): string {
  if (e instanceof Error && e.name === "PasswordException") return tx("the file is password protected");
  return e instanceof Error ? e.message : String(e);
}
