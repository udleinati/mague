import { assertEquals } from "@std/assert";
import { Client } from "./mod.ts";

type Captured = { url: string; headers: Record<string, string> };

// Stub do fetch global: regista URL e headers enviados e devolve 200.
function withFetchSpy(fn: (calls: Captured[]) => Promise<void>) {
  return async () => {
    const original = globalThis.fetch;
    const calls: Captured[] = [];
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
      return Promise.resolve(
        new Response('{"data":{}}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof fetch;
    try {
      await fn(calls);
    } finally {
      globalThis.fetch = original;
    }
  };
}

const hasCidHeader = (h: Record<string, string>) =>
  Object.keys(h).some((k) => k.toLowerCase() === "x-condominium-id");

Deno.test(
  "client: o header x-condominium-id não troca o cid validado do panel",
  withFetchSpy(async (calls) => {
    // Um controller que reencaminhasse headers do browser mudava de condomínio fora do gate.
    const client = new Client({ baseUrl: "http://api", condominiumId: () => "A" });
    await client.admin.getMe({ headers: { "x-condominium-id": "B" } });
    await client.portal.getCondominium({ headers: { "X-Condominium-Id": "B" } });
    assertEquals(calls.map((c) => c.url), [
      "http://api/v1/admin/condominiums/A/condominiums/me",
      "http://api/v1/portal/condominiums/A",
    ]);
  }),
);

Deno.test(
  "client: sem resolver, o header escolhe o cid (e2e) mas não chega à API",
  withFetchSpy(async (calls) => {
    const client = new Client({ baseUrl: "http://api", defaultHeaders: { authorization: "t" } });
    await client.admin.getMe({ headers: { "x-condominium-id": "B" } });
    await client.portal.getCondominium({ headers: { "x-condominium-id": "B" } });
    assertEquals(calls.map((c) => c.url), [
      "http://api/v1/admin/condominiums/B/condominiums/me",
      "http://api/v1/portal/condominiums/B",
    ]);
    assertEquals(calls.map((c) => hasCidHeader(c.headers)), [false, false]);
    assertEquals(calls[0].headers.authorization, "t");
  }),
);

Deno.test(
  "client: forCondominium fixa o cid pedido, mesmo com outro no ALS",
  withFetchSpy(async (calls) => {
    // O seletor de condomínios pede o getMe de cada condomínio gerido dentro de uma página de A.
    const client = new Client({ baseUrl: "http://api", condominiumId: () => "A" });
    await client.admin.forCondominium("C").getMe();
    await client.admin.getMe();
    assertEquals(calls.map((c) => c.url), [
      "http://api/v1/admin/condominiums/C/condominiums/me",
      "http://api/v1/admin/condominiums/A/condominiums/me",
    ]);
  }),
);
