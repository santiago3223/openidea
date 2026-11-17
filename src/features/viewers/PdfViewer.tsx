/**
 * PDF editor kind: continuous scroll, zoom and selectable text. Only the pages
 * near the viewport hold a canvas and a text layer.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { TextLayer, type PDFDocumentProxy, type RenderTask } from "pdfjs-dist/legacy/build/pdf.mjs";
import { setContext } from "@/platform/context";
import { tx } from "@/platform/i18n";
import type { EditorInput } from "@/workbench/contributions";
import { IconButton, T } from "@/ui";
import { formatSize } from "./fileKinds";
import { useForwardFocus } from "./forwardFocus";
import { zoomLabel } from "./imageZoom";
import { openPdf, pdfErrorMessage, readPdfBytes } from "./pdfDocument";
import {
  CSS_UNITS,
  PAGE_GAP,
  anchorAt,
  anchorY,
  canvasScale,
  clampPdfZoom,
  layoutPages,
  pageAt,
  resolveZoom,
  stepPdfZoom,
  visiblePages,
  type PageSize,
  type ScrollAnchor,
  type ZoomSpec,
} from "./pdfLayout";
import { usePdfViewers, type PdfViewerHandle } from "./pdfStore";
import styles from "./Viewers.module.css";

/** Zoom gestures fire continuously; the stretched old canvas stands in meanwhile. */
const RENDER_DELAY_MS = 120;

interface PdfPageProps {
  doc: PDFDocumentProxy;
  number: number;
  zoom: number;
  width: number;
  height: number;
  left: number;
  top: number;
}

const PdfPage = memo(function PdfPage({ doc, number, zoom, width, height, left, top }: PdfPageProps) {
  const canvasHost = useRef<HTMLDivElement>(null);
  const textHost = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    let render: RenderTask | null = null;
    let text: TextLayer | null = null;
    const timer = setTimeout(() => {
      void (async () => {
        const page = await doc.getPage(number);
        if (!live) return;
        const viewport = page.getViewport({ scale: zoom * CSS_UNITS });
        const scale = canvasScale(viewport.width, viewport.height, window.devicePixelRatio || 1);
        const pixels = page.getViewport({ scale: zoom * CSS_UNITS * scale });
        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(pixels.width);
        canvas.height = Math.floor(pixels.height);
        render = page.render({ canvas, viewport: pixels });
        await render.promise;
        if (!live) return;
        canvasHost.current?.replaceChildren(canvas);

        const layer = document.createElement("div");
        layer.className = styles.pdfText!;
        layer.style.setProperty("--total-scale-factor", String(viewport.scale * viewport.userUnit));
        text = new TextLayer({
          textContentSource: page.streamTextContent({ includeMarkedContent: true, disableNormalization: true }),
          container: layer,
          viewport,
        });
        await text.render();
        if (!live) return;
        const end = document.createElement("div");
        end.className = "endOfContent";
        layer.append(end);
        // Dragging past the text would otherwise extend the selection to the page start.
        layer.addEventListener("pointerdown", () => layer.classList.add("selecting"));
        layer.addEventListener("pointerup", () => layer.classList.remove("selecting"));
        layer.addEventListener("pointercancel", () => layer.classList.remove("selecting"));
        textHost.current?.replaceChildren(layer);
      })().catch((e: unknown) => {
        if (live) console.warn(`PDF page ${number} failed to render`, e);
      });
    }, RENDER_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
      render?.cancel();
      text?.cancel();
    };
  }, [doc, number, zoom]);

  return (
    <div className={styles.pdfPage} style={{ left, top, width, height }} aria-label={tx`Page ${number}`} role="img">
      <div ref={canvasHost} className={styles.pdfCanvas} />
      <div ref={textHost} />
    </div>
  );
});

interface Loaded {
  doc: PDFDocumentProxy;
  sizes: PageSize[];
  bytes: number;
}

export function PdfViewer({ input }: { input: EditorInput }) {
  const path = input.path!;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [spec, setSpec] = useState<ZoomSpec>("auto");
  const [avail, setAvail] = useState({ w: 0, h: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const anchor = useRef<ScrollAnchor | null>(null);

  useEffect(() => {
    let live = true;
    let task: ReturnType<typeof openPdf> | null = null;
    void (async () => {
      try {
        const data = await readPdfBytes(path, () => live);
        if (!data || !live) return;
        const bytes = data.length; // Opening transfers the buffer to the worker.
        task = openPdf(data);
        const doc = await task.promise;
        const pages = await Promise.all(Array.from({ length: doc.numPages }, (_, i) => doc.getPage(i + 1)));
        if (!live) return;
        const sizes = pages.map((page) => {
          const { width, height } = page.getViewport({ scale: CSS_UNITS });
          return { w: width, h: height };
        });
        setLoaded({ doc, sizes, bytes });
      } catch (e) {
        if (live) setError(pdfErrorMessage(e));
      }
    })();
    return () => {
      live = false;
      setLoaded(null);
      void task?.destroy();
    };
  }, [path, reload]);

  const showing = error === null;
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const measure = () => setAvail({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [showing]);

  const sizes = loaded?.sizes;
  const availW = avail.w - 2 * PAGE_GAP;
  const currentZoom = useCallback((s: ZoomSpec) => resolveZoom(s, sizes ?? [], availW), [sizes, availW]);
  const zoom = currentZoom(spec);
  const layout = useMemo(() => (sizes ? layoutPages(sizes, zoom) : null), [sizes, zoom]);
  const layoutRef = useRef(layout);

  const captureAnchor = useCallback((x: number, y: number) => {
    const el = scrollerRef.current;
    const current = layoutRef.current;
    if (!el || !current) return;
    anchor.current = {
      ...anchorAt(current, el.scrollTop + y),
      x,
      y,
      xFraction: el.scrollWidth > 0 ? (el.scrollLeft + x) / el.scrollWidth : 0,
    };
  }, []);

  useLayoutEffect(() => {
    layoutRef.current = layout;
    const el = scrollerRef.current;
    const a = anchor.current;
    if (!el || !layout || !a) return;
    el.scrollTop = anchorY(layout, a) - a.y;
    el.scrollLeft = a.xFraction * el.scrollWidth - a.x;
  }, [layout]);

  const handle: PdfViewerHandle = useMemo(
    () => ({
      zoom: (dir) => setSpec((s) => stepPdfZoom(currentZoom(s), dir)),
      actualSize: () => setSpec(1),
      fitWidth: () => setSpec("width"),
    }),
    [currentZoom],
  );

  useLayoutEffect(() => {
    usePdfViewers.setState({ active: handle });
    setContext("pdfViewerActive", true);
    return () => {
      if (usePdfViewers.getState().active !== handle) return;
      usePdfViewers.setState({ active: null });
      setContext("pdfViewerActive", false);
      setContext("pdfViewerFocus", false);
    };
  }, [handle]);

  useForwardFocus(scrollerRef);

  // Native listener: React's wheel handler is passive, so preventDefault would be ignored.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.metaKey && !e.ctrlKey) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      captureAnchor(e.clientX - rect.left, e.clientY - rect.top);
      const factor = Math.exp(-e.deltaY * (e.deltaMode === 0 ? 0.01 : 0.33));
      setSpec((s) => clampPdfZoom(currentZoom(s) * factor));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [showing, captureAnchor, currentZoom]);

  const range = layout ? visiblePages(layout, scrollTop, avail.h) : null;
  const contentWidth = layout ? Math.max(avail.w, layout.width + 2 * PAGE_GAP) : 0;
  const current = layout ? pageAt(layout, scrollTop + avail.h / 2) + 1 : 0;
  const info = loaded
    ? [`${current} / ${loaded.sizes.length}`, formatSize(loaded.bytes), zoomLabel(zoom)].join(" · ")
    : "";

  return (
    <div
      ref={rootRef}
      className={styles.root}
      onFocus={() => {
        usePdfViewers.setState({ active: handle });
        setContext("pdfViewerFocus", true);
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setContext("pdfViewerFocus", false);
      }}
    >
      <div className={styles.toolbar} role="toolbar" aria-label={tx("PDF viewer")}>
        <IconButton icon="zoom-in" size="small" action="pdf.zoomIn" />
        <IconButton icon="zoom-out" size="small" action="pdf.zoomOut" />
        <IconButton icon="actual-size" size="small" action="pdf.actualSize" />
        <IconButton icon="maximize" size="small" action="pdf.fitWidth" />
        <div className={styles.separator} />
        <IconButton
          icon="refresh"
          size="small"
          title="Reload from Disk"
          onClick={() => {
            setError(null);
            setReload((n) => n + 1);
          }}
        />
        <div className={styles.spacer} />
        <span className={styles.info}>{info}</span>
      </div>
      {error !== null ? (
        <div className={styles.message}>{tx`Cannot show the PDF: ${error}`}</div>
      ) : (
        <div
          ref={scrollerRef}
          className={styles.pdfScroll}
          tabIndex={-1}
          onScroll={(e) => {
            captureAnchor(e.currentTarget.clientWidth / 2, e.currentTarget.clientHeight / 2);
            setScrollTop(e.currentTarget.scrollTop);
          }}
        >
          {loaded && layout && range ? (
            <div className={styles.pdfPages} style={{ width: contentWidth, height: layout.height }}>
              {layout.sizes.slice(range.first, range.last + 1).map((size, i) => {
                const index = range.first + i;
                return (
                  <PdfPage
                    key={index}
                    doc={loaded.doc}
                    number={index + 1}
                    zoom={zoom}
                    width={size.w}
                    height={size.h}
                    left={Math.round((contentWidth - size.w) / 2)}
                    top={layout.tops[index]!}
                  />
                );
              })}
            </div>
          ) : (
            <div className={styles.message}>
              <T>Loading…</T>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
