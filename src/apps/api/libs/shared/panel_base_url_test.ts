import { assertEquals } from "@std/assert";
import type { Context } from "hono";
import { env } from "$config/env.ts";
import { safePanelBaseUrl } from "./panel_base_url.ts";

function ctxWithHeader(value: string | undefined): Context {
  return { req: { header: (_: string) => value } } as unknown as Context;
}

const allowed = new URL(env.panelBaseUrl).origin;

Deno.test("safePanelBaseUrl: origin fora da allowlist cai no env", () => {
  assertEquals(safePanelBaseUrl(ctxWithHeader("https://evil.example")), env.panelBaseUrl);
});

// O header é input do cliente e o valor vai para o `href` dos emails de reset:
// com path/query arrastados, uma aspa no path injetava um link para fora.
Deno.test("safePanelBaseUrl: origin allowlistado devolve só o origin (descarta path/query)", () => {
  const payload = `${allowed}/"></a><a href="https://evil.example/c?x=`;
  assertEquals(safePanelBaseUrl(ctxWithHeader(payload)), allowed);
  assertEquals(safePanelBaseUrl(ctxWithHeader(`${allowed}/extra/path?x=1`)), allowed);
});

Deno.test("safePanelBaseUrl: sem header usa o env", () => {
  assertEquals(safePanelBaseUrl(ctxWithHeader(undefined)), env.panelBaseUrl);
});
