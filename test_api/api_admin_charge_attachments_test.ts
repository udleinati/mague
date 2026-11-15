// E2E: anexos de charges (fatura/recibo/comprovativo).
//
// Cobre o lifecycle completo: list (vazio) → upload → list (com 1) →
// download bytes → delete → list (vazio de novo). Confirma que o filtro
// por entity_type funciona - soft-delete é honrado.

import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { ApiError, Client } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";
import { type ScenarioFixture, seedScenario } from "./_helpers/fixtures.ts";

const BASE_URL = "http://localhost:3000";
const client = new Client({ baseUrl: BASE_URL });
const MASTER = await loginAsSuper();

// 1×1 PNG transparente - ~70 bytes, MIME-detectável pelo S3.
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

describe("admin charges - attachments lifecycle", () => {
  let fx: ScenarioFixture;
  let chargeId = "";
  let attachmentId = "";

  const hdr = () => fx.hdr();

  it("setup - condominium + charge", async () => {
    fx = await seedScenario(client, MASTER)
      .withCondo("ChargeAtt Test Condo")
      .build();

    const { data: ch } = await client.admin.createCharge(
      {
        kind: "payable",
        chargeType: "expense",
        description: "EDP Março 2026",
        issueDate: "2026-03-15",
        dueDate: "2026-04-01",
        competencePeriod: "2026-03-01",
        amountCents: 12500,
      },
      { headers: hdr() },
    );
    chargeId = ch.id as string;
  });

  it("listChargeAttachments - empty returns []", async () => {
    const { data, status } = await client.admin.listChargeAttachments(chargeId, { headers: hdr() });
    assertEquals(status, 200);
    assertEquals(data, []);
  });

  it("addChargeAttachment - upload PDF retorna 201 + metadata", async () => {
    const { data, status } = await client.admin.addChargeAttachment(
      chargeId,
      pngBytes,
      "fatura-edp.png",
      "image/png",
      { headers: hdr() },
    );
    assertEquals(status, 201);
    assertEquals(data.filename, "fatura-edp.png");
    assertEquals(data.mimeType, "image/png");
    assertExists(data.id);
    assertEquals(data.fileSize, pngBytes.byteLength);
    assertEquals(data.chargeId, chargeId);
    attachmentId = data.id;
  });

  it("listChargeAttachments - inclui o uploaded", async () => {
    const { data } = await client.admin.listChargeAttachments(chargeId, { headers: hdr() });
    assertEquals(data.length, 1);
    assertEquals(data[0].id, attachmentId);
    assertEquals(data[0].filename, "fatura-edp.png");
  });

  it("serve attachment - GET retorna bytes", async () => {
    const url =
      `${BASE_URL}/v1/admin/condominiums/${fx.condominium.id}/charges/${chargeId}/attachments/${attachmentId}`;
    const res = await fetch(url, { headers: MASTER });
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("content-type"), "image/png");
    const bytes = new Uint8Array(await res.arrayBuffer());
    assertEquals(bytes.byteLength, pngBytes.byteLength);
    // Magic number do PNG (89 50 4E 47).
    assertEquals(bytes[0], 137);
    assertEquals(bytes[1], 80);
  });

  it("upload - ficheiro vazio falha 400", async () => {
    const e = await assertRejects(
      () =>
        client.admin.addChargeAttachment(
          chargeId,
          new Uint8Array(0),
          "vazio.pdf",
          "application/pdf",
          { headers: hdr() },
        ),
      ApiError,
    );
    assertEquals(e.statusCode, 400);
  });

  it("upload em charge inexistente retorna 404", async () => {
    const e = await assertRejects(
      () =>
        client.admin.addChargeAttachment(
          "ch_inexistente",
          pngBytes,
          "x.png",
          "image/png",
          { headers: hdr() },
        ),
      ApiError,
    );
    assertEquals(e.statusCode, 404);
  });

  it("deleteChargeAttachment - 204 + serve passa a 404", async () => {
    const { status } = await client.admin.deleteChargeAttachment(
      chargeId,
      attachmentId,
      { headers: hdr() },
    );
    assertEquals(status, 204);

    // Confirma que o GET deixou de servir.
    const url =
      `${BASE_URL}/v1/admin/condominiums/${fx.condominium.id}/charges/${chargeId}/attachments/${attachmentId}`;
    const res = await fetch(url, { headers: MASTER });
    assertEquals(res.status, 404);
    await res.body?.cancel();
  });

  it("listChargeAttachments após delete - volta a []", async () => {
    const { data } = await client.admin.listChargeAttachments(chargeId, { headers: hdr() });
    assertEquals(data, []);
  });

  it("delete idempotente - segundo DELETE retorna 404", async () => {
    const e = await assertRejects(
      () => client.admin.deleteChargeAttachment(chargeId, attachmentId, { headers: hdr() }),
      ApiError,
    );
    assertEquals(e.statusCode, 404);
  });

  it("teardown - delete condominium", async () => {
    await fx.cleanup();
  });
});
