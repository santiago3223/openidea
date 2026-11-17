/**
 * Non-text editors and the Markdown preview: images open in an image viewer,
 * PDFs in a PDF viewer, binary and very large files in a read-only hex view (both through file
 * editor providers consulted by `openFile`), and Markdown files get IDEA's
 * Editor / Editor and Preview / Preview layouts around the text editor.
 */
import { registerActions, type Action } from "@/platform/actions";
import { call, commands, type FileProbe } from "@/platform/ipc";
import { getContext } from "@/platform/context";
import { openWithSystemApp } from "@/platform/fileManager";
import { basename, useProject } from "@/platform/project";
import { fileIconName, lazyComponent } from "@/ui";
import {
  registerEditorKind,
  registerExternalFileOpenHandler,
  registerFileEditorProvider,
  registerTextEditorWrapper,
  textEditorWrapperFor,
  useTextEditorWrappers,
  type EditorInput,
} from "@/workbench/contributions";
import {
  BINARY_KIND,
  IMAGE_KIND,
  associatedApplication,
  PDF_KIND,
  binaryInput,
  imageInput,
  isImagePath,
  isMarkdownPath,
  isPdfPath,
  pdfInput,
  wantsHexView,
} from "./fileKinds";
import { ImageViewer, toggleChessboard, useImageViewers } from "./ImageViewer";
import { HexViewer } from "./HexViewer";
import { usePdfViewers } from "./pdfStore";
import { registerMarkdownLiveSource } from "./markdown/live";
import { setMarkdownMode, type MarkdownMode } from "./markdown/modes";
import { MarkdownLayoutActions } from "./markdown/MarkdownLayoutActions";

const titleOf = (input: EditorInput) => basename(input.path ?? input.key);
const iconOf = (input: EditorInput) => fileIconName(titleOf(input));

function imageActions(): Action[] {
  const image = (id: string, title: string, run: () => void, extra: Partial<Action> = {}): Action => ({
    id,
    title,
    category: "Image",
    when: "imageViewerActive",
    keyWhen: "imageViewerFocus",
    run,
    ...extra,
  });
  const active = () => useImageViewers.getState().active;
  return [
    image("image.zoomIn", "Zoom In", () => active()?.zoom(1), { icon: "zoom-in" }),
    image("image.zoomOut", "Zoom Out", () => active()?.zoom(-1), { icon: "zoom-out" }),
    image("image.actualSize", "Actual Size", () => active()?.actualSize(), { icon: "actual-size" }),
    image("image.fitToWindow", "Fit Zoom to Window", () => active()?.fit(), { icon: "maximize" }),
    image("image.toggleChessboard", "Show Chessboard", toggleChessboard, {
      icon: "chessboard",
      keywords: ["transparency", "background"],
      toggled: () => useImageViewers.getState().chessboard,
    }),
  ];
}

function pdfActions(): Action[] {
  const pdf = (id: string, title: string, icon: string, run: () => void): Action => ({
    id,
    title,
    category: "PDF",
    icon,
    when: "pdfViewerActive",
    keyWhen: "pdfViewerFocus",
    run,
  });
  const active = () => usePdfViewers.getState().active;
  return [
    pdf("pdf.zoomIn", "Zoom In", "zoom-in", () => active()?.zoom(1)),
    pdf("pdf.zoomOut", "Zoom Out", "zoom-out", () => active()?.zoom(-1)),
    pdf("pdf.actualSize", "Actual Size", "actual-size", () => active()?.actualSize()),
    pdf("pdf.fitWidth", "Fit Width", "maximize", () => active()?.fitWidth()),
  ];
}

function markdownActions(): Action[] {
  const mode = (id: string, title: string, m: MarkdownMode, icon: string): Action => ({
    id,
    title,
    category: "Markdown",
    icon,
    keywords: ["markdown", "preview", "layout"],
    when: "textEditorActive && editorLangId == markdown",
    run: ({ arg }) => {
      const path = typeof arg === "string" ? arg : getContext().editorPath;
      if (typeof path === "string" && isMarkdownPath(path)) setMarkdownMode(path, m);
    },
  });
  return [
    mode("markdown.editorOnly", "Editor Only", "editor", "editor-only"),
    mode("markdown.editorAndPreview", "Editor and Preview", "split", "editor-preview"),
    mode("markdown.previewOnly", "Preview Only", "preview", "preview-only"),
  ];
}

export function activate(): () => void {
  const probes = new Map<string, Promise<FileProbe>>();
  const disposers = [
    // Files associated with another application (Settings › Editor › File Types)
    // win over the viewers below; a failed launch falls through to them.
    registerExternalFileOpenHandler({
      id: "viewers.associatedApps",
      order: 1,
      matches: (path) =>
        associatedApplication(path, useProject.getState().settings?.files?.associatedApplications ?? []),
      open: openWithSystemApp,
    }),
    registerEditorKind({ kind: IMAGE_KIND, component: ImageViewer, title: titleOf, icon: iconOf }),
    registerEditorKind({
      kind: PDF_KIND,
      component: lazyComponent(() => import("./PdfViewer").then((m) => m.PdfViewer)),
      title: titleOf,
      icon: iconOf,
    }),
    registerEditorKind({ kind: BINARY_KIND, component: HexViewer, title: titleOf, icon: iconOf }),
    registerFileEditorProvider({
      id: "viewers.image",
      order: 10,
      resolve: (path) =>
        isImagePath(path) && !textEditorWrapperFor(useTextEditorWrappers.getState().wrappers, path)
          ? imageInput(path)
          : null,
    }),
    registerFileEditorProvider({
      id: "viewers.pdf",
      order: 20,
      resolve: (path) => (isPdfPath(path) ? pdfInput(path) : null),
    }),
    registerFileEditorProvider({
      id: "viewers.hex",
      order: 50,
      resolve: async (path) => {
        let pending = probes.get(path);
        if (!pending) {
          pending = call(commands.fsProbe(path)).finally(() => probes.delete(path));
          probes.set(path, pending);
        }
        const probe = await pending;
        return wantsHexView(probe) ? binaryInput(path, probe) : null;
      },
    }),
    registerTextEditorWrapper({
      id: "viewers.markdown",
      matches: isMarkdownPath,
      component: lazyComponent(() => import("./markdown/MarkdownEditor").then((m) => m.MarkdownEditor)),
      tabActions: MarkdownLayoutActions,
    }),
    registerMarkdownLiveSource(),
    registerActions([...imageActions(), ...pdfActions(), ...markdownActions()]),
  ];
  return () => disposers.reverse().forEach((d) => d());
}
