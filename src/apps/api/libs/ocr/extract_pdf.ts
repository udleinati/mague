// OCR de PDFs de apólices de seguro, em 2 passos: `pdftotext` (PDFs digitais,
// rápido) e fallback Tesseract (PDF scaneado, pouco texto). Binários no
// container API (poppler-utils + tesseract-ocr-por). Output: candidatos a
// `validUntil` + raw text; decisão final é do utilizador no form.

const PDFTOTEXT_MIN_CHARS = 200;
const TIMEOUT_MS = 30000;

export interface OcrResult {
  rawText: string;
  candidatesValidUntil: string[]; // ISO YYYY-MM-DD, ordenadas por probabilidade
  candidatesValidFrom: string[];
  policyNumberCandidate?: string;
  insurerCandidate?: string;
  confidence: "high" | "medium" | "low";
  source: "pdftotext" | "tesseract";
}

// Best-effort: nunca atira - em falha devolve `confidence: 'low'` + listas
// vazias para o user preencher.
export async function extractInsuranceFields(pdfBytes: Uint8Array): Promise<OcrResult> {
  // Escreve bytes para stdin via tmpfile no host; lê stdout do container.
  const tmpFile = await Deno.makeTempFile({ prefix: "ocr_", suffix: ".pdf" });
  try {
    await Deno.writeFile(tmpFile, pdfBytes);
    let raw = await runPdfToText(tmpFile);
    let source: "pdftotext" | "tesseract" = "pdftotext";

    if (raw.length < PDFTOTEXT_MIN_CHARS) {
      // PDF scaneado ou sem texto selecionável → tenta Tesseract.
      const ocred = await runTesseract(tmpFile);
      if (ocred.length > raw.length) {
        raw = ocred;
        source = "tesseract";
      }
    }

    // Normaliza acentos (PDFs scaneados perdem-nos) para a regex matchar
    // "vigência" e "vigencia"; guardamos o raw original à parte.
    const norm = stripAccents(raw);
    const candidatesValidUntil = findDateCandidates(norm, validUntilHints);
    const candidatesValidFrom = findDateCandidates(norm, validFromHints);
    const policyNumberCandidate = findPolicyNumber(norm);
    const insurerCandidate = findInsurer(norm);

    let confidence: OcrResult["confidence"] = "low";
    if (candidatesValidUntil.length === 1) confidence = "high";
    else if (candidatesValidUntil.length >= 2) confidence = "medium";

    return {
      rawText: raw.substring(0, 5000),
      candidatesValidUntil,
      candidatesValidFrom,
      policyNumberCandidate,
      insurerCandidate,
      confidence,
      source,
    };
  } catch (e) {
    console.error("[ocr] falhou:", (e as Error).message);
    return {
      rawText: "",
      candidatesValidUntil: [],
      candidatesValidFrom: [],
      confidence: "low",
      source: "pdftotext",
    };
  } finally {
    await Deno.remove(tmpFile).catch(() => {});
  }
}

async function runPdfToText(file: string): Promise<string> {
  return await runBinary("pdftotext", ["-layout", file, "-"]);
}

async function runTesseract(file: string): Promise<string> {
  // pdftoppm gera 1 PNG por página em /tmp/<base>-NN.png; tesseract corre
  // em cada e concatenamos. Em apólices PT a página crítica é geralmente a 1ª
  // (resumo), então limitamos a 3 páginas para não inchar - chega para datas.
  const pages = await pdfToImages(file, 3);
  const texts: string[] = [];
  for (const png of pages) {
    try {
      const t = await runBinary("tesseract", [png, "-", "-l", "por"]);
      texts.push(t);
    } finally {
      await Deno.remove(png).catch(() => {});
    }
  }
  return texts.join("\n");
}

async function pdfToImages(pdfFile: string, maxPages: number): Promise<string[]> {
  const tmpDir = await Deno.makeTempDir({ prefix: "ocr_pages_" });
  const prefix = `${tmpDir}/p`;
  await runBinary("pdftoppm", ["-r", "200", "-l", String(maxPages), pdfFile, prefix, "-png"]);
  const files: string[] = [];
  for await (const e of Deno.readDir(tmpDir)) {
    if (e.isFile && e.name.endsWith(".png")) files.push(`${tmpDir}/${e.name}`);
  }
  files.sort();
  return files;
}

async function runBinary(bin: string, args: string[]): Promise<string> {
  const cmd = new Deno.Command(bin, {
    args,
    stdout: "piped",
    stderr: "piped",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const { stdout, stderr, code } = await cmd.output();
  if (code !== 0) {
    throw new Error(`${bin} exit ${code}: ${new TextDecoder().decode(stderr).substring(0, 200)}`);
  }
  return new TextDecoder().decode(stdout);
}

// ─── Heurísticas de extração ─────────────────────────────────────────────
// Regexes operam no texto SEM acentos (ver stripAccents). Mantemos as
// palavras-chave sem acento aqui para legibilidade.

export const validUntilHints = [
  // "vigencia ate 31/12/2027", "validade: 31/12/2027", "fim de cobertura..."
  /(?:vigencia|validade|cobertura|seguro)\s*(?:ate|fim|termino|de\s+cobertura)?\s*[:\-]?\s*(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4})/gi,
  /(?:fim|ate|termino|fim de cobertura)\s*(?:da\s+(?:apolice|cobertura))?\s*[:\-]?\s*(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4})/gi,
];

export const validFromHints = [
  /(?:inicio|inicio de cobertura|desde|de)\s*[:\-]?\s*(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4})/gi,
];

export function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// Candidatos de data únicos em ISO; ano de 2 dígitos assume `20XX`.
export function findDateCandidates(text: string, patterns: RegExp[]): string[] {
  const found = new Set<string>();
  for (const re of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const iso = normalizeDate(m[1]);
      if (iso) found.add(iso);
    }
  }
  return [...found];
}

export function normalizeDate(s: string): string | null {
  const parts = s.split(/[\/.\-]/);
  if (parts.length !== 3) return null;
  let [d, mo, y] = parts.map((p) => p.trim());
  if (y.length === 2) y = "20" + y;
  if (y.length !== 4) return null;
  const dn = +d, mn = +mo, yn = +y;
  if (!dn || !mn || !yn) return null;
  if (dn > 31 || mn > 12) return null;
  return `${yn}-${String(mn).padStart(2, "0")}-${String(dn).padStart(2, "0")}`;
}

export function findPolicyNumber(text: string): string | undefined {
  const m =
    /(?:nº|n\.º|número|policy)\s*(?:da\s+)?(?:apólice|policy)?\s*[:\-]?\s*([A-Z0-9.\/-]{6,30})/i
      .exec(text);
  return m?.[1];
}

export function findInsurer(text: string): string | undefined {
  const known = [
    "Fidelidade",
    "Allianz",
    "Tranquilidade",
    "Lusitania",
    "Generali",
    "Liberty",
    "Zurich",
    "AXA",
    "Ageas",
    "Mapfre",
    "Real Vida",
    "Logo",
    "OK!",
    "MetLife",
    "Cosec",
  ];
  for (const ins of known) {
    if (new RegExp(`\\b${ins}\\b`, "i").test(text)) return ins;
  }
  return undefined;
}
