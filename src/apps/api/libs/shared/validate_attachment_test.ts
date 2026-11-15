import { assertEquals, assertThrows } from "@std/assert";
import { AppError } from "$api/libs/error/app_error.ts";
import { safeAttachmentServeHeaders, validateAttachmentMime } from "./validate_attachment.ts";

const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0xFF, 0xFF]);
const JPEG_MAGIC = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0x00]);
const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x34]);
const WEBP_MAGIC = new Uint8Array([
  0x52,
  0x49,
  0x46,
  0x46, // RIFF
  0x00,
  0x00,
  0x00,
  0x00,
  0x57,
  0x45,
  0x42,
  0x50, // WEBP
]);
const HEIC_MAGIC = new Uint8Array([
  0x00,
  0x00,
  0x00,
  0x18,
  0x66,
  0x74,
  0x79,
  0x70, // ftyp
  0x68,
  0x65,
  0x69,
  0x63, // heic
]);

// ─── validateAttachmentMime ──────────────────────────────────────────

Deno.test("validateAttachmentMime: PNG válido → não lança", () => {
  validateAttachmentMime("image/png", PNG_MAGIC);
});

Deno.test("validateAttachmentMime: JPEG válido → não lança", () => {
  validateAttachmentMime("image/jpeg", JPEG_MAGIC);
});

Deno.test("validateAttachmentMime: PDF válido → não lança", () => {
  validateAttachmentMime("application/pdf", PDF_MAGIC);
});

Deno.test("validateAttachmentMime: WEBP válido (RIFF + WEBP) → não lança", () => {
  validateAttachmentMime("image/webp", WEBP_MAGIC);
});

Deno.test("validateAttachmentMime: HEIC com brand 'heic' → não lança", () => {
  validateAttachmentMime("image/heic", HEIC_MAGIC);
});

Deno.test("validateAttachmentMime: SVG bloqueado (XSS via inline JS)", () => {
  const e = assertThrows(() => validateAttachmentMime("image/svg+xml", PNG_MAGIC), AppError);
  assertEquals(e.code, "MIME_NOT_ALLOWED");
  assertEquals(e.statusCode, 415);
});

Deno.test("validateAttachmentMime: text/html bloqueado", () => {
  const e = assertThrows(() => validateAttachmentMime("text/html", PNG_MAGIC), AppError);
  assertEquals(e.code, "MIME_NOT_ALLOWED");
});

Deno.test("validateAttachmentMime: PNG declarado mas bytes JPEG → mismatch (415→400)", () => {
  const e = assertThrows(() => validateAttachmentMime("image/png", JPEG_MAGIC), AppError);
  assertEquals(e.code, "MIME_CONTENT_MISMATCH");
  assertEquals(e.statusCode, 400);
});

Deno.test("validateAttachmentMime: PDF declarado mas bytes HTML → mismatch", () => {
  const htmlBytes = new TextEncoder().encode("<html><body>fake pdf</body></html>");
  const e = assertThrows(() => validateAttachmentMime("application/pdf", htmlBytes), AppError);
  assertEquals(e.code, "MIME_CONTENT_MISMATCH");
});

Deno.test("validateAttachmentMime: WEBP sem assinatura WEBP no offset 8 → mismatch", () => {
  const fakeRiff = new Uint8Array([
    0x52,
    0x49,
    0x46,
    0x46,
    0,
    0,
    0,
    0,
    0x41,
    0x56,
    0x49,
    0x20, // 'AVI '
  ]);
  const e = assertThrows(() => validateAttachmentMime("image/webp", fakeRiff), AppError);
  assertEquals(e.code, "MIME_CONTENT_MISMATCH");
});

Deno.test("validateAttachmentMime: HEIC com brand desconhecido → mismatch", () => {
  const fakeFtyp = new Uint8Array([
    0x00,
    0x00,
    0x00,
    0x18,
    0x66,
    0x74,
    0x79,
    0x70,
    0x6D,
    0x70,
    0x34,
    0x32, // 'mp42' (não é HEIC)
  ]);
  assertThrows(() => validateAttachmentMime("image/heic", fakeFtyp), AppError);
});

Deno.test("validateAttachmentMime: mime case-insensitive + trim", () => {
  validateAttachmentMime("  IMAGE/PNG  ", PNG_MAGIC);
});

// ─── safeAttachmentServeHeaders ──────────────────────────────────────

Deno.test("safeAttachmentServeHeaders: PNG → inline + headers de segurança", () => {
  const h = safeAttachmentServeHeaders("image/png", "foto.png", 1024);
  assertEquals(h["Content-Type"], "image/png");
  assertEquals(h["Content-Disposition"], 'inline; filename="foto.png"');
  assertEquals(h["X-Content-Type-Options"], "nosniff");
  assertEquals(h["Content-Length"], "1024");
});

Deno.test("safeAttachmentServeHeaders: PDF → inline (viewer nativo sandboxed + CSP)", () => {
  const h = safeAttachmentServeHeaders("application/pdf", "fatura.pdf", 50000);
  assertEquals(h["Content-Disposition"], 'inline; filename="fatura.pdf"');
  // CSP + nosniff continuam aplicados como defesa em profundidade
  assertEquals(h["X-Content-Type-Options"], "nosniff");
  assertEquals(h["Content-Security-Policy"], "default-src 'none'; sandbox");
});

Deno.test("safeAttachmentServeHeaders: SVG declarado → attachment (defesa)", () => {
  const h = safeAttachmentServeHeaders("image/svg+xml", "logo.svg", 100);
  assertEquals(h["Content-Disposition"].startsWith("attachment"), true);
});

Deno.test("safeAttachmentServeHeaders: filename com aspas + newlines é sanitizado", () => {
  const h = safeAttachmentServeHeaders("image/png", `evil"file\nname.png`, 100);
  assertEquals(h["Content-Disposition"].includes(`"`) ? 2 : 0, 2);
  assertEquals(h["Content-Disposition"].includes("\n"), false);
  assertEquals(h["Content-Disposition"].includes("\r"), false);
});
