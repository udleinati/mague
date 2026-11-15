import { assertEquals, assertRejects } from "@std/assert";
import { ApiError, HttpClient } from "./http.ts";

// Stub do fetch global: regista os URLs pedidos e devolve 200.
function withFetchSpy(fn: (urls: string[]) => Promise<void>) {
  return async () => {
    const original = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = ((input: string | URL | Request) => {
      urls.push(String(input));
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as typeof fetch;
    try {
      await fn(urls);
    } finally {
      globalThis.fetch = original;
    }
  };
}

Deno.test(
  "http: id com ../ não sai do condomínio do path",
  withFetchSpy(async (urls) => {
    // O panel valida o cid A e interpola o :id tal como o Hono o descodificou.
    // Sem o guard, o fetch normalizava para /condominiums/B/... e a página de A
    // mostrava dados de B.
    const http = new HttpClient("http://api");
    const e = await assertRejects(
      () => http.get("/v1/admin/condominiums/A/units/../../B/units/U"),
      ApiError,
    );
    assertEquals(e.statusCode, 404);
    assertEquals(urls.length, 0);
  }),
);

Deno.test(
  "http: variantes %2e também são recusadas",
  withFetchSpy(async (urls) => {
    // O WHATWG URL trata `%2e%2e` e `.%2e` como `..`: recusar só o literal deixava a porta aberta.
    const http = new HttpClient("http://api");
    for (const seg of ["%2e%2e", ".%2E", "%2e."]) {
      await assertRejects(
        () => http.get(`/v1/admin/condominiums/A/units/${seg}/${seg}/B/units/U`),
        ApiError,
      );
    }
    assertEquals(urls.length, 0);
  }),
);

Deno.test(
  "http: paths normais seguem para o fetch",
  withFetchSpy(async (urls) => {
    // Pontos dentro de um segmento (ficheiros, versões) e na query não são navegação.
    const http = new HttpClient("http://api");
    await http.get("/v1/admin/condominiums/A/documents/doc.v2/attachments/a.pdf?next=../x");
    assertEquals(urls, [
      "http://api/v1/admin/condominiums/A/documents/doc.v2/attachments/a.pdf?next=../x",
    ]);
  }),
);
