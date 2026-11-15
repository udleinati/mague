// Wrapper sobre `astral` (Deno headless Chrome) para gerar PDFs de HTML
// (recibos). 1 browser partilhado/cached (abrir por PDF custa ~1s); cada
// render usa uma tab nova fechada no fim (evita leaks). ASTRAL_CHROMIUM_PATH
// aponta para o chromium do sistema em prod; em dev astral baixa-o sozinho.

import { launch } from "jsr:@astral/astral@0.5.4";

let cached: Awaited<ReturnType<typeof launch>> | null = null;
let initing: Promise<Awaited<ReturnType<typeof launch>>> | null = null;

async function browser() {
  if (cached) return cached;
  if (initing) return await initing;
  // ASTRAL_CHROMIUM_PATH reutiliza o chromium do sistema; sem ele astral
  // baixa o próprio (~150MB) para ~/.cache/astral.
  const path = Deno.env.get("ASTRAL_CHROMIUM_PATH") ?? undefined;
  initing = launch({
    path,
    args: [
      "--no-sandbox", // necessário em containers
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage", // evita /dev/shm overflow em containers
    ],
  });
  cached = await initing;
  initing = null;
  return cached;
}

export interface RenderPdfOptions {
  /** HTML completo (incluindo `<html>...</html>`). */
  html: string;
  /** Tamanho da página. Default A4. */
  format?: "A4" | "Letter";
  /** Margens em CSS (`"1cm"`, `"10mm"`). Default `1cm` em todos os lados. */
  margin?: { top?: string; right?: string; bottom?: string; left?: string };
  /** Print background (cores, gradientes). Default true. */
  printBackground?: boolean;
  /**
   * Rodapé com numeração de página (`<span class="pageNumber"></span>` /
   * `class="totalPages"`). Renderiza na margem inferior (garantir `margin.bottom`
   * suficiente). Cabeçalho fica vazio - o Chromium só mostra o rodapé.
   */
  footerTemplate?: string;
}

// A4 em polegadas (Chromium DevTools Protocol pede inches).
// 210 × 297 mm = 8.27 × 11.69 in.
const A4 = { width: 8.27, height: 11.69 };
const LETTER = { width: 8.5, height: 11 };

// Renderiza HTML para PDF (Uint8Array pronto para S3). Tab nova por chamada,
// browser fica vivo para a próxima.
export async function renderPdf(opts: RenderPdfOptions): Promise<Uint8Array> {
  const b = await browser();
  const page = await b.newPage();
  try {
    // Astral espera o load event; web fonts externas devem vir embutidas no
    // HTML para não ficarem gaps.
    await page.setContent(opts.html);
    const dim = opts.format === "Letter" ? LETTER : A4;
    const pdf = await page.pdf({
      paperWidth: dim.width,
      paperHeight: dim.height,
      printBackground: opts.printBackground ?? true,
      // Astral usa polegadas; converter cm → in (1cm = 0.3937in).
      marginTop: cmToIn(opts.margin?.top ?? "1cm"),
      marginRight: cmToIn(opts.margin?.right ?? "1cm"),
      marginBottom: cmToIn(opts.margin?.bottom ?? "1cm"),
      marginLeft: cmToIn(opts.margin?.left ?? "1cm"),
      // Rodapé opcional (numeração). Cabeçalho vazio para o Chromium não meter
      // o seu default (data/título). O rodapé vive na margem inferior.
      ...(opts.footerTemplate
        ? {
          displayHeaderFooter: true,
          headerTemplate: "<span></span>",
          footerTemplate: opts.footerTemplate,
        }
        : {}),
    });
    return pdf;
  } finally {
    await page.close();
  }
}

/** Converte string CSS-like (cm/mm/in) para inches numéricas. */
function cmToIn(s: string): number {
  const match = s.match(/^([\d.]+)\s*(cm|mm|in)?$/i);
  if (!match) return 0.3937; // 1cm fallback
  const value = parseFloat(match[1]);
  const unit = (match[2] ?? "cm").toLowerCase();
  if (unit === "in") return value;
  if (unit === "mm") return value / 25.4;
  return value / 2.54; // cm
}
