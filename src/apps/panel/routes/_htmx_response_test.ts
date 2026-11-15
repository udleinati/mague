// Test unitário para `htmxOrRedirect` (ADR 0026). Mocka o Context do Hono (só
// header check + html/redirect). Cobre as 2 ramificações: HX-Request -> HTML;
// sem header -> redirect com flash query string.

import { assertEquals, assertStringIncludes } from "@std/assert";
import type { Context } from "hono";
import { htmxOrRedirect } from "./_htmx_response.ts";

interface MockResponse {
  kind: "html" | "redirect";
  body?: string;
  url?: string;
}

function mockContext(opts: {
  hxRequest?: boolean;
  cid?: string;
}): { ctx: Context; getLast: () => MockResponse | null } {
  let last: MockResponse | null = null;
  const ctx = {
    req: {
      header: (name: string) =>
        name === "HX-Request" ? (opts.hxRequest ? "true" : undefined) : undefined,
      param: (name: string) => name === "cid" ? (opts.cid ?? "TEST_CID") : undefined,
    },
    html: (body: string) => {
      last = { kind: "html", body };
      return new Response(body, { headers: { "content-type": "text/html" } });
    },
    redirect: (url: string) => {
      last = { kind: "redirect", url };
      return new Response(null, { status: 302, headers: { location: url } });
    },
  } as unknown as Context;
  return { ctx, getLast: () => last };
}

Deno.test("htmxOrRedirect - HX-Request: true → c.html(renderFragment(flash))", async () => {
  const { ctx, getLast } = mockContext({ hxRequest: true, cid: "C1" });

  let receivedFlash: { type: string; message: string } | null = null;
  await htmxOrRedirect(ctx, {
    message: "Anexo carregado.",
    flashType: "success",
    redirectPath: "tickets/abc123",
    renderFragment: (flash) => {
      receivedFlash = flash;
      return Promise.resolve("<div>partial html</div>");
    },
  });

  const last = getLast();
  assertEquals(last?.kind, "html");
  assertEquals(last?.body, "<div>partial html</div>");
  // renderFragment recebe o flash exato (type + message).
  assertEquals(receivedFlash, { type: "success", message: "Anexo carregado." });
});

Deno.test("htmxOrRedirect - sem HX-Request → c.redirect com flash query string", async () => {
  const { ctx, getLast } = mockContext({ hxRequest: false, cid: "C1" });

  await htmxOrRedirect(ctx, {
    message: "Anexo removido.",
    flashType: "success",
    redirectPath: "tickets/abc123",
    renderFragment: () => Promise.resolve("ignored"),
  });

  const last = getLast();
  assertEquals(last?.kind, "redirect");
  // O cid vem do ALS (via condoUrl), não do mock; validamos só a forma do path.
  assertStringIncludes(last?.url ?? "", "/admin/c/");
  assertStringIncludes(last?.url ?? "", "/tickets/abc123");
  assertStringIncludes(last?.url ?? "", "flash=Anexo%20removido.");
  assertStringIncludes(last?.url ?? "", "flashType=success");
});

Deno.test("htmxOrRedirect - flashType danger → query string flashType=danger", async () => {
  const { ctx, getLast } = mockContext({ hxRequest: false, cid: "C1" });

  await htmxOrRedirect(ctx, {
    message: "Erro a carregar anexo.",
    flashType: "danger",
    redirectPath: "tickets/abc123",
    renderFragment: () => Promise.resolve("ignored"),
  });

  const last = getLast();
  assertStringIncludes(last?.url ?? "", "flashType=danger");
});

Deno.test("htmxOrRedirect - flashType default é success", async () => {
  const { ctx, getLast } = mockContext({ hxRequest: false, cid: "C1" });

  await htmxOrRedirect(ctx, {
    message: "ok",
    redirectPath: "tickets/abc123",
    renderFragment: () => Promise.resolve("ignored"),
  });

  assertStringIncludes(getLast()?.url ?? "", "flashType=success");
});

Deno.test("htmxOrRedirect - flashType passa corretamente em HX-Request também", async () => {
  const { ctx } = mockContext({ hxRequest: true, cid: "C1" });

  let receivedType: string | null = null;
  await htmxOrRedirect(ctx, {
    message: "Erro!",
    flashType: "danger",
    redirectPath: "tickets/abc123",
    renderFragment: (flash) => {
      receivedType = flash.type;
      return Promise.resolve("html");
    },
  });

  assertEquals(receivedType, "danger");
});

Deno.test("htmxOrRedirect - redirectPath com query existente preserva-a (usa & em vez de ?)", async () => {
  const { ctx, getLast } = mockContext({ hxRequest: false, cid: "C1" });

  await htmxOrRedirect(ctx, {
    message: "ok",
    redirectPath: "tickets?filter=open",
    renderFragment: () => Promise.resolve("ignored"),
  });

  const url = getLast()?.url ?? "";
  // Query original preservada + flash adicionado com `&`.
  assertStringIncludes(url, "filter=open");
  assertStringIncludes(url, "&flash=");
  assertStringIncludes(url, "&flashType=success");
});

Deno.test("htmxOrRedirect - message com caracteres especiais é URL-encoded", async () => {
  const { ctx, getLast } = mockContext({ hxRequest: false, cid: "C1" });

  await htmxOrRedirect(ctx, {
    message: "Erro: ficheiro com & caracteres?",
    flashType: "danger",
    redirectPath: "tickets/abc",
    renderFragment: () => Promise.resolve("ignored"),
  });

  const url = getLast()?.url ?? "";
  // `&` e `?` devem estar encoded para não quebrar a query string.
  assertStringIncludes(url, "Erro%3A%20ficheiro%20com%20%26%20caracteres%3F");
});
