import { expect, test } from "./fixtures";

/** A three-page PDF using a non-embedded standard font, so it needs pdf.js' bundled font data. */
function samplePdf(): string {
  const pages = [1, 2, 3];
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((n) => `${3 + (n - 1) * 2} 0 R`).join(" ")}] >>`,
    ...pages.flatMap((n) => {
      const content = `BT /F1 24 Tf 72 700 Td (Sample page ${n}) Tj ET`;
      return [
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + (n - 1) * 2} 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>`,
        `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
      ];
    }),
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((body, i) => {
    const offset = pdf.length;
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  const entries = offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${entries}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1").toString("base64");
}

test("opens a PDF as rendered pages with selectable text and zoom", async ({ workbench: page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(async (base64) => {
    const { commands } = await import("/src/platform/ipc.ts" as string);
    const { editorService } = await import("/src/workbench/contributions.ts" as string);
    const bytes = atob(base64);
    commands.fsReadRange = async (_path: string, offset: number, len: number) => ({
      status: "ok",
      data: { offset, data: btoa(bytes.slice(offset, offset + len)), total: bytes.length },
    });
    await editorService().openFile("/acme-api/sample.pdf");
  }, samplePdf());

  const viewer = page.getByRole("toolbar", { name: "PDF viewer" });
  await expect(viewer).toBeVisible();
  await expect(viewer.getByText(/^1 \/ 3 · [1-9]/)).toBeVisible();

  const first = page.getByRole("img", { name: "Page 1" });
  await expect(first.getByText("Sample page 1")).toBeAttached();
  const inked = await first.locator("canvas").evaluate((el) => {
    const canvas = el as HTMLCanvasElement;
    const { data } = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height);
    return data.some((v, i) => i % 4 !== 3 && v < 128);
  });
  expect(inked, "the page canvas has dark text on it").toBe(true);

  await expect(page.locator("body > canvas")).toBeHidden();

  const before = (await first.boundingBox())!.width;
  await viewer.getByRole("button", { name: "Zoom In" }).click();
  await expect.poll(async () => (await first.boundingBox())!.width).toBeGreaterThan(before);
  await viewer.getByRole("button", { name: "Actual Size" }).click();
  await expect(viewer.getByText(/· 100%$/)).toBeVisible();
  // A US Letter page is 816 CSS pixels wide at physical size.
  await expect.poll(async () => (await first.boundingBox())!.width).toBe(816);

  // Shortcuts apply while the viewer has focus, and selected text copies like any other.
  await first.getByText("Sample page 1").selectText();
  // Native copy on the Linux CI; the specs' macOS keymap leaves Ctrl+C unbound.
  await page.keyboard.press("Control+c");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("Sample page 1");
  await page.keyboard.press("Meta+=");
  await expect(viewer.getByText(/· 125%$/)).toBeVisible();
});
