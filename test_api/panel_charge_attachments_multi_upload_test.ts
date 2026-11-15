// Integration test do upload múltiplo de anexos via PANEL (port 3400).
//
// O modal `+ Adicionar anexo` no detalhe de charge passou a aceitar
// `multiple` (vários ficheiros num só submit). O handler do panel
// (`routes/admin/charges.ts` POST /attachments) lê via
// `formData.getAll("files")` - `parseBody` colapsaria duplicados ao último
// e perderíamos N-1 ficheiros. Cada file vai num POST sequencial à API.
//
// Estratégia:
//   1. Setup via API (port 3000, Bearer auth - mais rápido).
//   2. Login no PANEL (port 3400, cookie auth) para obter o cookie `token`.
//   3. POST multipart com 3 ficheiros (campo `files` repetido) → 302 com flash.
//   4. Verifica via API que 3 attachments foram criados.
//
// Anti-regressão: se voltarmos a usar `parseBody()` puro no panel, este
// teste falha (só 1 attachment é criado em vez de 3).

import { assertEquals, assertExists } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { Client } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";
import { type ScenarioFixture, seedScenario } from "./_helpers/fixtures.ts";

const API_URL = "http://localhost:3000";
const PANEL_URL = "http://localhost:3400";
const SUPER_PASSWORD = Deno.env.get("SUPER_PASSWORD") ?? "test";

const client = new Client({ baseUrl: API_URL });
const MASTER = await loginAsSuper();

// 1×1 PNG transparente - magic bytes válidos. Reutilizado para os 3 uploads
// (mesmo conteúdo, filenames diferentes).
const pngBytes = new Uint8Array([
  137,
  80,
  78,
  71,
  13,
  10,
  26,
  10,
  0,
  0,
  0,
  13,
  73,
  72,
  68,
  82,
  0,
  0,
  0,
  1,
  0,
  0,
  0,
  1,
  8,
  6,
  0,
  0,
  0,
  31,
  21,
  196,
  137,
  0,
  0,
  0,
  13,
  73,
  68,
  65,
  84,
  120,
  156,
  99,
  250,
  207,
  0,
  0,
  0,
  4,
  0,
  1,
  145,
  145,
  209,
  22,
  0,
  0,
  0,
  0,
  73,
  69,
  78,
  68,
  174,
  66,
  96,
  130,
]);

async function loginPanel(): Promise<string> {
  const fd = new URLSearchParams({
    identifier: "super@mague.pt",
    password: SUPER_PASSWORD,
  });
  const resp = await fetch(`${PANEL_URL}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: fd.toString(),
    redirect: "manual",
  });
  await resp.body?.cancel();
  if (resp.status !== 302) {
    throw new Error(
      `Login panel falhou: HTTP ${resp.status} (esperado 302). ` +
        `Confirma SUPER_PASSWORD (default "test", override via env var).`,
    );
  }
  // Extrai só o valor do cookie `token` da resposta Set-Cookie.
  const setCookie = resp.headers.get("set-cookie") ?? "";
  const match = setCookie.match(/token=([^;]+)/);
  if (!match) {
    throw new Error(`Cookie 'token' em falta no Set-Cookie: ${setCookie}`);
  }
  return match[1];
}

describe("panel multi-file upload - charge attachments", () => {
  let fx: ScenarioFixture;
  let chargeId = "";
  let token = "";
  const hdr = () => fx.hdr();

  it("setup - login panel + condo + charge via API", async () => {
    token = await loginPanel();
    assertExists(token);

    fx = await seedScenario(client, MASTER)
      .withCondo("Multi Upload Test")
      .build();

    const { data: ch } = await client.admin.createCharge(
      {
        kind: "payable",
        chargeType: "expense",
        description: "Test Multi Upload",
        issueDate: "2026-05-01",
        competencePeriod: "2026-05-01",
        amountCents: 10000,
      },
      { headers: hdr() },
    );
    chargeId = ch.id as string;
  });

  it("POST multipart com 3 ficheiros (campo `files` × 3) → cria 3 attachments", async () => {
    // Constrói multipart manualmente - o FormData do Deno aceita N entries
    // com o mesmo nome, e o boundary é gerido pelo runtime.
    const form = new FormData();
    form.append("files", new Blob([pngBytes], { type: "image/png" }), "a.png");
    form.append("files", new Blob([pngBytes], { type: "image/png" }), "b.png");
    form.append("files", new Blob([pngBytes], { type: "image/png" }), "c.png");

    const resp = await fetch(
      `${PANEL_URL}/admin/c/${fx.condominium.id}/charges/${chargeId}/attachments`,
      {
        method: "POST",
        headers: { Cookie: `token=${token}` },
        body: form,
        redirect: "manual",
      },
    );
    await resp.body?.cancel();
    assertEquals(resp.status, 302, "panel devia redirecionar após upload");
    const location = resp.headers.get("location") ?? "";
    // Flash de sucesso deve mencionar "3 anexos"
    assertEquals(
      decodeURIComponent(location).includes("3 anexos carregados"),
      true,
      `flash devia indicar 3 anexos; location=${location}`,
    );

    // Verifica via API que os 3 attachments existem.
    const { data: list } = await client.admin.listChargeAttachments(chargeId, {
      headers: hdr(),
    });
    assertEquals(list.length, 3, "3 attachments criados no S3+DB");
    // Os filenames devem bater (ordem preservada pelo sequencial upload).
    const filenames = list.map((a) => a.filename).sort();
    assertEquals(filenames, ["a.png", "b.png", "c.png"]);
  });

  it("POST sem `files` → 302 com flash de erro (não rebenta)", async () => {
    const form = new FormData();
    // Sem campos
    const resp = await fetch(
      `${PANEL_URL}/admin/c/${fx.condominium.id}/charges/${chargeId}/attachments`,
      {
        method: "POST",
        headers: { Cookie: `token=${token}` },
        body: form,
        redirect: "manual",
      },
    );
    await resp.body?.cancel();
    assertEquals(resp.status, 302);
    const location = decodeURIComponent(resp.headers.get("location") ?? "");
    assertEquals(
      location.includes("Seleciona pelo menos um ficheiro"),
      true,
      `flash devia indicar erro; location=${location}`,
    );
    // Garante que ninguém foi adicionado por engano
    const { data: list } = await client.admin.listChargeAttachments(chargeId, {
      headers: hdr(),
    });
    assertEquals(list.length, 3, "lista continua nos 3 anteriores, sem extras");
  });

  it("POST com 1 ficheiro - flash singular ('Anexo carregado.')", async () => {
    const form = new FormData();
    form.append("files", new Blob([pngBytes], { type: "image/png" }), "single.png");

    const resp = await fetch(
      `${PANEL_URL}/admin/c/${fx.condominium.id}/charges/${chargeId}/attachments`,
      {
        method: "POST",
        headers: { Cookie: `token=${token}` },
        body: form,
        redirect: "manual",
      },
    );
    await resp.body?.cancel();
    assertEquals(resp.status, 302);
    const location = decodeURIComponent(resp.headers.get("location") ?? "");
    assertEquals(
      location.includes("Anexo carregado") && !location.includes("anexos carregados"),
      true,
      `flash singular esperado; location=${location}`,
    );
    const { data: list } = await client.admin.listChargeAttachments(chargeId, {
      headers: hdr(),
    });
    assertEquals(list.length, 4);
  });

  it("teardown - delete condominium", async () => {
    await fx.cleanup();
  });
});
