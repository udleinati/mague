import { assertEquals } from "@std/assert";
import type { Context } from "hono";
import { refererQueryAppend } from "./_referer.ts";

// Stub com a única coisa que o helper consulta (`req.header`), em vez de um
// Hono Context real (custoso).
function ctxWithReferer(referer: string | null): Context {
  return {
    req: {
      header: (name: string) =>
        name.toLowerCase() === "referer" ? (referer ?? undefined) : undefined,
    },
  } as unknown as Context;
}

Deno.test("Referer com query string → devolve `?qs`", () => {
  const c = ctxWithReferer("http://localhost/admin/c/X/insurances?status=expired&year=2026");
  assertEquals(refererQueryAppend(c), "?status=expired&year=2026");
});

Deno.test('Referer sem query string → devolve `""`', () => {
  const c = ctxWithReferer("http://localhost/admin/c/X/insurances");
  assertEquals(refererQueryAppend(c), "");
});

Deno.test('Referer ausente → devolve `""`', () => {
  const c = ctxWithReferer(null);
  assertEquals(refererQueryAppend(c), "");
});

Deno.test('Referer inválido (não-URL) → devolve `""` (defensivo)', () => {
  const c = ctxWithReferer("not-a-valid-url-at-all");
  assertEquals(refererQueryAppend(c), "");
});

Deno.test("Filtra flash/flashType da request anterior - não duplicar flash", () => {
  // Caso real: o user clica em "lembrar" enquanto a página tem um flash da
  // ação anterior. Não queremos propagar esse flash velho.
  const c = ctxWithReferer(
    "http://localhost/admin/c/X/insurances?status=expired&flash=Old&flashType=success",
  );
  assertEquals(refererQueryAppend(c), "?status=expired");
});

Deno.test('Referer só com flash → devolve `""` (não há filtros úteis)', () => {
  const c = ctxWithReferer("http://localhost/admin/c/X/insurances?flash=Hi&flashType=info");
  assertEquals(refererQueryAppend(c), "");
});

Deno.test("Múltiplos params com encoding preservado", () => {
  // URLSearchParams.toString() reencoda os valores - verificar que
  // caracteres especiais (espaços, vírgulas) sobrevivem ao roundtrip.
  const c = ctxWithReferer(
    "http://localhost/x?search=foo%20bar&tags=a%2Cb",
  );
  // Ordem dos params preservada; encoding URL-safe.
  assertEquals(refererQueryAppend(c), "?search=foo+bar&tags=a%2Cb");
});
