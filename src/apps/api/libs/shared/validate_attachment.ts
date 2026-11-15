// Validação de attachments uploaded: allowlist de mime (imagens bitmap + PDF),
// magic bytes (conteúdo bate com o mime declarado, contra spoof) e headers de
// serve restritivos (CSP + nosniff + Content-Disposition). Defende de XSS via
// SVG/HTML e de mime spoofing.

import { AppError } from "$api/libs/error/app_error.ts";
import { STATUS_CODE } from "@std/http";
import { ALLOWED_UPLOAD_MIME_TYPES } from "$shared/upload/mime.ts";

/**
 * Mime types aceites. Deriva da fonte única `$shared/upload/mime.ts` (mesmo
 * conjunto do `accept` dos dropzones). SVG excluído de propósito - XML com
 * `<script>`/`onload` executaria JS na renderização inline (XSS).
 */
export const ALLOWED_MIME_TYPES = new Set<string>(ALLOWED_UPLOAD_MIME_TYPES);

/** Magic bytes por mime - valida que o conteúdo bate com o mime declarado. */
const MAGIC_BYTES: Record<string, Uint8Array[]> = {
  "image/jpeg": [
    new Uint8Array([0xFF, 0xD8, 0xFF]), // JPEG SOI
  ],
  "image/png": [
    new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), // PNG signature
  ],
  "image/webp": [
    // WEBP: 'RIFF' .... 'WEBP'
    new Uint8Array([0x52, 0x49, 0x46, 0x46]), // RIFF (precisa também checar offset 8: 'WEBP')
  ],
  "image/heic": [
    // HEIC: ftyp box at offset 4 with 'heic'/'heix'/'hevc'/'mif1' brand
    new Uint8Array([0x00]), // placeholder - checked separately below
  ],
  "image/heif": [
    new Uint8Array([0x00]),
  ],
  "application/pdf": [
    new Uint8Array([0x25, 0x50, 0x44, 0x46]), // %PDF
  ],
};

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[i] !== prefix[i]) return false;
  }
  return true;
}

function isWebP(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  // 'RIFF' at 0..3, 'WEBP' at 8..11
  return (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  );
}

function isHeic(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  // ftyp box: at offset 4..7 = 'ftyp', then 4-byte brand at 8..11
  if (bytes[4] !== 0x66 || bytes[5] !== 0x74 || bytes[6] !== 0x79 || bytes[7] !== 0x70) {
    return false;
  }
  // Aceita brands HEIC: heic, heix, heim, hevc, mif1, msf1
  const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
  return ["heic", "heix", "heim", "hevc", "mif1", "msf1"].includes(brand);
}

/**
 * Valida o `mimeType` declarado contra a allowlist E contra os magic
 * bytes do ficheiro. Lança `AppError` se falha; em sucesso retorna void
 * (apanhado pelo `app.onError` da API).
 */
export function validateAttachmentMime(
  declaredMime: string,
  bytes: Uint8Array,
): void {
  const mime = declaredMime.toLowerCase().trim();

  if (!ALLOWED_MIME_TYPES.has(mime)) {
    throw new AppError({
      message: "Tipo de ficheiro não suportado. Aceites: imagens JPEG, PNG, WEBP, " +
        "HEIC (foto de iPhone) e PDF.",
      statusCode: STATUS_CODE.UnsupportedMediaType,
      code: "MIME_NOT_ALLOWED",
    });
  }

  // Magic bytes - verifica se o conteúdo bate com o mime declarado
  let magicMatches = false;
  if (mime === "image/webp") {
    magicMatches = isWebP(bytes);
  } else if (mime === "image/heic" || mime === "image/heif") {
    magicMatches = isHeic(bytes);
  } else {
    const expected = MAGIC_BYTES[mime] ?? [];
    magicMatches = expected.some((m) => startsWith(bytes, m));
  }

  if (!magicMatches) {
    throw new AppError({
      message: "O conteúdo do ficheiro não corresponde ao tipo indicado (pode estar " +
        "corrompido ou ter sido renomeado). Tenta exportar/gravar a imagem de novo.",
      statusCode: STATUS_CODE.BadRequest,
      code: "MIME_CONTENT_MISMATCH",
    });
  }
}

/**
 * Headers seguros para servir um attachment validado: nosniff + CSP sandbox +
 * `Content-Disposition` inline para imagens bitmap/PDF, `attachment` para o
 * resto (SVG inline = XSS via `<script>`). PDF inline é seguro: viewer nativo
 * sandboxed + CSP/nosniff neutralizam JS embebido.
 */
export function safeAttachmentServeHeaders(
  mimeType: string,
  filename: string,
  byteLength: number,
): Record<string, string> {
  const safeFilename = filename.replace(/"/g, "").replace(/[\r\n]/g, "");
  // Inline-safe: imagens bitmap + PDF. SVG fora (XSS via <script>).
  const isInlineSafe = mimeType === "application/pdf" ||
    (mimeType.startsWith("image/") && !mimeType.includes("svg") && !mimeType.includes("xml"));
  const disposition = isInlineSafe
    ? `inline; filename="${safeFilename}"`
    : `attachment; filename="${safeFilename}"`;

  return {
    "Content-Type": mimeType,
    "Content-Disposition": disposition,
    "Content-Length": String(byteLength),
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cache-Control": "private, max-age=3600",
  };
}
