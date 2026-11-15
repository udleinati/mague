// Unit tests para parseFlashFromQuery - mapeia o vocabulário da querystring
// (success|warning|info|danger) para Flash.type (success|error|warning|info).
// Correr:  deno test --allow-env src/apps/panel/routes/_flash_test.ts

import { assertEquals } from "@std/assert";
import { parseFlashFromQuery } from "./_flash.ts";

function fakeCtx(url: string) {
  return {
    req: { url },
    // deno-lint-ignore no-explicit-any
  } as any;
}

Deno.test("parseFlashFromQuery: sem ?flash devolve null", () => {
  assertEquals(parseFlashFromQuery(fakeCtx("https://x.pt/admin")), null);
});

Deno.test("parseFlashFromQuery: danger mapeia para error (vocabulário diverge)", () => {
  // A querystring usa daisyUI 'danger'; o Flash interno usa 'error'.
  assertEquals(
    parseFlashFromQuery(fakeCtx("https://x.pt/?flash=Falhou&flashType=danger")),
    { type: "error", message: "Falhou" },
  );
});

Deno.test("parseFlashFromQuery: success e warning passam diretos", () => {
  assertEquals(
    parseFlashFromQuery(fakeCtx("https://x.pt/?flash=Ok&flashType=success")),
    { type: "success", message: "Ok" },
  );
  assertEquals(
    parseFlashFromQuery(fakeCtx("https://x.pt/?flash=Atencao&flashType=warning")),
    { type: "warning", message: "Atencao" },
  );
});

Deno.test("parseFlashFromQuery: sem flashType cai para info (default)", () => {
  assertEquals(
    parseFlashFromQuery(fakeCtx("https://x.pt/?flash=Nota")),
    { type: "info", message: "Nota" },
  );
});

Deno.test("parseFlashFromQuery: flashType desconhecido cai para info (não vaza 'error')", () => {
  // Um valor fora do conjunto não pode escalar para 'error' nem rebentar.
  assertEquals(
    parseFlashFromQuery(fakeCtx("https://x.pt/?flash=Oi&flashType=zzz")),
    { type: "info", message: "Oi" },
  );
});

Deno.test("parseFlashFromQuery: mensagem URL-encoded é descodificada", () => {
  assertEquals(
    parseFlashFromQuery(fakeCtx("https://x.pt/?flash=Quota%20paga&flashType=success")),
    { type: "success", message: "Quota paga" },
  );
});
