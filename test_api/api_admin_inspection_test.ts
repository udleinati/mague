import { assertEquals, assertRejects } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { ApiError, Client } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";
import { deleteTestUser, seedTestUser, sqlExec } from "./_helpers/db.ts";
import { type ScenarioFixture, seedScenario } from "./_helpers/fixtures.ts";

const BASE_URL = "http://localhost:3000";
const client = new Client({ baseUrl: BASE_URL });
const MASTER = await loginAsSuper();

// PDF mínimo válido para upload (header + EOF). Suficiente para o handler
// aceitar (mime_type='application/pdf', size > 0).
const MIN_PDF_BYTES = new Uint8Array([
  0x25,
  0x50,
  0x44,
  0x46,
  0x2D,
  0x31,
  0x2E,
  0x34,
  0x0A,
  0x25,
  0xE2,
  0xE3,
  0xCF,
  0xD3,
  0x0A,
  0x25,
  0x25,
  0x45,
  0x4F,
  0x46,
  0x0A,
]);
// PNG 1x1 transparente para testar upload de imagem (mime_type qualquer).
const MIN_PNG_BYTES = new Uint8Array([
  0x89,
  0x50,
  0x4E,
  0x47,
  0x0D,
  0x0A,
  0x1A,
  0x0A,
  0x00,
  0x00,
  0x00,
  0x0D,
  0x49,
  0x48,
  0x44,
  0x52,
  0x00,
  0x00,
  0x00,
  0x01,
  0x00,
  0x00,
  0x00,
  0x01,
  0x08,
  0x06,
  0x00,
  0x00,
  0x00,
  0x1F,
  0x15,
  0xC4,
  0x89,
  0x00,
  0x00,
  0x00,
  0x0D,
  0x49,
  0x44,
  0x41,
  0x54,
  0x78,
  0x9C,
  0x62,
  0x00,
  0x01,
  0x00,
  0x00,
  0x05,
  0x00,
  0x01,
  0x0D,
  0x0A,
  0x2D,
  0xB4,
  0x00,
  0x00,
  0x00,
  0x00,
  0x49,
  0x45,
  0x4E,
  0x44,
  0xAE,
  0x42,
  0x60,
  0x82,
]);
const NON_EXISTENT_ID = "doesNotExst";

describe("admin inspections", () => {
  let fx: ScenarioFixture;
  let inspectionId = "";
  let supplierId = "";
  let attachmentPdfId = "";

  it("setup - create condominium", async () => {
    fx = await seedScenario(client, MASTER)
      .withCondo("Inspection Test Condo")
      .build();
  });

  const hdr = () => fx.hdr();

  it("list - empty returns []", async () => {
    const { data, status } = await client.admin.listInspections({}, { headers: hdr() });
    assertEquals(status, 200);
    assertEquals(data, []);
  });

  // ═══ Validações Zod do create ═════════════════════════════════════════════════

  it("create - missing description returns 400", async () => {
    const e = await assertRejects(
      () =>
        client.admin.createInspection(
          { category: "fire_extinguisher", description: "", validUntil: "2099-12-31" },
          { headers: hdr() },
        ),
      ApiError,
    );
    assertEquals(e.statusCode, 400);
  });

  it("create - invalid category returns 400", async () => {
    const e = await assertRejects(
      () =>
        client.admin.createInspection(
          { category: "bogus_invalid", description: "X", validUntil: "2099-12-31" },
          { headers: hdr() },
        ),
      ApiError,
    );
    assertEquals(e.statusCode, 400);
  });

  it("create - invalid validUntil format returns 400", async () => {
    const e = await assertRejects(
      () =>
        client.admin.createInspection(
          { category: "elevator", description: "X", validUntil: "31-12-2099" },
          { headers: hdr() },
        ),
      ApiError,
    );
    assertEquals(e.statusCode, 400);
  });

  it("create - invalid lastDoneDate format returns 400", async () => {
    const e = await assertRejects(
      () =>
        client.admin.createInspection(
          { category: "gas", description: "X", validUntil: "2099-12-31", lastDoneDate: "ontem" },
          { headers: hdr() },
        ),
      ApiError,
    );
    assertEquals(e.statusCode, 400);
  });

  it("create - notifyDaysBefore > 365 returns 400", async () => {
    const e = await assertRejects(
      () =>
        client.admin.createInspection(
          { category: "gas", description: "X", validUntil: "2099-12-31", notifyDaysBefore: 400 },
          { headers: hdr() },
        ),
      ApiError,
    );
    assertEquals(e.statusCode, 400);
  });

  it("create - description > 500 chars returns 400", async () => {
    const e = await assertRejects(
      () =>
        client.admin.createInspection(
          { category: "elevator", description: "x".repeat(501), validUntil: "2099-12-31" },
          { headers: hdr() },
        ),
      ApiError,
    );
    assertEquals(e.statusCode, 400);
  });

  it("create - notes > 2000 chars returns 400", async () => {
    const e = await assertRejects(
      () =>
        client.admin.createInspection(
          {
            category: "elevator",
            description: "X",
            validUntil: "2099-12-31",
            notes: "n".repeat(2001),
          },
          { headers: hdr() },
        ),
      ApiError,
    );
    assertEquals(e.statusCode, 400);
  });

  it("create - empty body returns 400", async () => {
    const empty = {} as unknown as Parameters<typeof client.admin.createInspection>[0];
    const e = await assertRejects(
      () => client.admin.createInspection(empty, { headers: hdr() }),
      ApiError,
    );
    assertEquals(e.statusCode, 400);
  });

  // ═══ Happy path ═══════════════════════════════════════════════════════════════

  it("create - valid payload returns 201 with status=ok and isActive=true", async () => {
    const { data, status } = await client.admin.createInspection(
      {
        category: "fire_extinguisher",
        description: "Verificação anual de extintores",
        validUntil: "2099-12-31",
        notes: "Empresa XPTO",
      },
      { headers: hdr() },
    );
    assertEquals(status, 201);
    assertEquals(data.notifyDaysBefore, 30);
    assertEquals(data.lastDoneDate, null);
    assertEquals(data.isActive, true);
    assertEquals(data.attachments, []);
    assertEquals(data.status, "ok");
    // Sem fornecedor declarado: campos a null por defeito.
    assertEquals(data.supplierId, null);
    assertEquals(data.supplier, null);
    inspectionId = data.id;
  });

  it("get - returns inspection with empty attachments array", async () => {
    const { data, status } = await client.admin.getInspection(inspectionId, { headers: hdr() });
    assertEquals(status, 200);
    assertEquals(data.id, inspectionId);
    assertEquals(data.attachments.length, 0);
  });

  it("update - renovação (lastDone + novo validUntil)", async () => {
    const { data, status } = await client.admin.updateInspection(
      inspectionId,
      { lastDoneDate: "2026-04-15", validUntil: "2027-04-15" },
      { headers: hdr() },
    );
    assertEquals(status, 200);
    assertEquals(data.lastDoneDate, "2026-04-15");
    assertEquals(data.validUntil, "2027-04-15");
  });

  // ═══ Fornecedor (supplier FK) ════════════════════════════════════════════════

  it("setup - cria fornecedor para associar à inspeção", async () => {
    const { data, status } = await client.admin.createSupplier(
      { name: "Elevadores Teste, Lda", nif: "500000000" },
      { headers: hdr() },
    );
    assertEquals(status, 201);
    supplierId = data.id;
  });

  it("create - com supplierId guarda o FK (nested resolve-se no GET)", async () => {
    const { data, status } = await client.admin.createInspection(
      {
        category: "elevator",
        description: "Inspeção legal do elevador",
        validUntil: "2099-12-31",
        supplierId,
      },
      { headers: hdr() },
    );
    assertEquals(status, 201);
    // O create devolve `.returning()` (sem join): o id do fornecedor vem,
    // o objeto nested não - só se resolve na projeção do GET.
    assertEquals(data.supplierId, supplierId);
    assertEquals(data.supplier, null);

    const got = await client.admin.getInspection(data.id, { headers: hdr() });
    assertEquals(got.data.supplier?.id, supplierId);
    assertEquals(got.data.supplier?.name, "Elevadores Teste, Lda");

    // A listagem admin resolve o nested (withSupplier) - alimenta a coluna discreta.
    const listed = await client.admin.listInspections({}, { headers: hdr() });
    const row = listed.data.find((x) => x.id === data.id);
    assertEquals(row?.supplier?.name, "Elevadores Teste, Lda");

    // Limpa: esta inspeção "ok" poluiria a contagem dos testes de listagem.
    await client.admin.deleteInspection(data.id, { headers: hdr() });
  });

  it("update - supplierId: null limpa o fornecedor", async () => {
    const withSupplier = await client.admin.updateInspection(
      inspectionId,
      { supplierId },
      { headers: hdr() },
    );
    assertEquals(withSupplier.data.supplierId, supplierId);

    // O get re-projecta com o nested resolvido.
    const got = await client.admin.getInspection(inspectionId, { headers: hdr() });
    assertEquals(got.data.supplier?.name, "Elevadores Teste, Lda");

    const cleared = await client.admin.updateInspection(
      inspectionId,
      { supplierId: null },
      { headers: hdr() },
    );
    assertEquals(cleared.data.supplierId, null);

    const gotCleared = await client.admin.getInspection(inspectionId, { headers: hdr() });
    assertEquals(gotCleared.data.supplierId, null);
    assertEquals(gotCleared.data.supplier, null);
  });

  // ═══ Activate / Deactivate + counter ═════════════════════════════════════════

  it("create - inspeção vencida ativa para teste de badge", async () => {
    const { data } = await client.admin.createInspection(
      { category: "gas", description: "Gás vencido", validUntil: "2020-01-01" },
      { headers: hdr() },
    );
    assertEquals(data.status, "expired");
  });

  it("alerts/count - 1 vencida ativa conta", async () => {
    const { data } = await client.admin.countInspectionAlerts({ headers: hdr() });
    assertEquals(data.count, 1);
  });

  it("deactivate - status passa a inactive", async () => {
    const { data } = await client.admin.listInspections({ status: "expired" }, { headers: hdr() });
    const expiredId = data[0].id;
    const { data: deact } = await client.admin.deactivateInspection(expiredId, { headers: hdr() });
    assertEquals(deact.isActive, false);
    assertEquals(deact.status, "inactive");
  });

  it("alerts/count - desactivada já não conta", async () => {
    const { data } = await client.admin.countInspectionAlerts({ headers: hdr() });
    assertEquals(data.count, 0);
  });

  it("list - filtro status=inactive devolve a desactivada", async () => {
    const { data } = await client.admin.listInspections({ status: "inactive" }, { headers: hdr() });
    assertEquals(data.length, 1);
    assertEquals(data[0].isActive, false);
  });

  it("list - filtro status=ok devolve só a OK", async () => {
    const { data } = await client.admin.listInspections({ status: "ok" }, { headers: hdr() });
    assertEquals(data.length, 1);
    assertEquals(data[0].id, inspectionId);
  });

  it("list - filtro status=due_soon (criar uma a expirar dentro de 5 dias)", async () => {
    const today = new Date();
    const in5days = new Date(today.getTime() + 5 * 86_400_000);
    const iso = in5days.toISOString().slice(0, 10);
    const { data: created } = await client.admin.createInspection(
      { category: "hvac", description: "AVAC a vencer", validUntil: iso, notifyDaysBefore: 30 },
      { headers: hdr() },
    );
    assertEquals(created.status, "due_soon");
    const { data } = await client.admin.listInspections({ status: "due_soon" }, { headers: hdr() });
    assertEquals(data.length, 1);
    assertEquals(data[0].id, created.id);
  });

  it("activate - reverte para expired (estado real)", async () => {
    const { data: list } = await client.admin.listInspections({ status: "inactive" }, {
      headers: hdr(),
    });
    const id = list[0].id;
    const { data } = await client.admin.activateInspection(id, { headers: hdr() });
    assertEquals(data.isActive, true);
    assertEquals(data.status, "expired");
  });

  // ═══ 404 em mutações com ID inexistente ═══════════════════════════════════════

  it("update - inspection inexistente returns 404", async () => {
    const e = await assertRejects(
      () =>
        client.admin.updateInspection(NON_EXISTENT_ID, { description: "x" }, { headers: hdr() }),
      ApiError,
    );
    assertEquals(e.statusCode, 404);
  });

  it("activate - inspection inexistente returns 404", async () => {
    const e = await assertRejects(
      () => client.admin.activateInspection(NON_EXISTENT_ID, { headers: hdr() }),
      ApiError,
    );
    assertEquals(e.statusCode, 404);
  });

  it("deactivate - inspection inexistente returns 404", async () => {
    const e = await assertRejects(
      () => client.admin.deactivateInspection(NON_EXISTENT_ID, { headers: hdr() }),
      ApiError,
    );
    assertEquals(e.statusCode, 404);
  });

  it("delete - inspection inexistente returns 404", async () => {
    const e = await assertRejects(
      () => client.admin.deleteInspection(NON_EXISTENT_ID, { headers: hdr() }),
      ApiError,
    );
    assertEquals(e.statusCode, 404);
  });

  // ═══ Attachments ═════════════════════════════════════════════════════════════

  it("attachment - upload em inspection inexistente returns 404", async () => {
    const e = await assertRejects(
      () =>
        client.admin.addInspectionAttachment(
          NON_EXISTENT_ID,
          MIN_PDF_BYTES,
          "x.pdf",
          "application/pdf",
          { headers: hdr() },
        ),
      ApiError,
    );
    assertEquals(e.statusCode, 404);
  });

  it("attachment - upload PDF", async () => {
    const { data, status } = await client.admin.addInspectionAttachment(
      inspectionId,
      MIN_PDF_BYTES,
      "certificado-2026.pdf",
      "application/pdf",
      { headers: hdr() },
    );
    assertEquals(status, 201);
    assertEquals(data.attachments.length, 1);
    assertEquals(data.attachments[0].filename, "certificado-2026.pdf");
    assertEquals(data.attachments[0].mimeType, "application/pdf");
    assertEquals(data.attachments[0].fileSize, MIN_PDF_BYTES.byteLength);
    // Data de upload presente (o template da listagem mostra-a).
    assertEquals(typeof data.attachments[0].createdAt, "string");
    attachmentPdfId = data.attachments[0].id;
  });

  it("attachment - upload PNG (mime diferente, ainda aceita)", async () => {
    const { data } = await client.admin.addInspectionAttachment(
      inspectionId,
      MIN_PNG_BYTES,
      "foto-extintor.png",
      "image/png",
      { headers: hdr() },
    );
    assertEquals(data.attachments.length, 2);
    const png = data.attachments.find((a) => a.filename === "foto-extintor.png");
    assertEquals(png?.mimeType, "image/png");
  });

  it("attachment - upload empty file rejected (400)", async () => {
    const e = await assertRejects(
      () =>
        client.admin.addInspectionAttachment(
          inspectionId,
          new Uint8Array(0),
          "vazio.txt",
          "text/plain",
          { headers: hdr() },
        ),
      ApiError,
    );
    assertEquals(e.statusCode, 400);
  });

  it("attachment - file too large rejected (413)", async () => {
    // Acima do limite UPLOAD_MAX_MB (default 20MB, ver `config/env.ts`).
    // 21MB com prefixo PDF válido - o size check dispara antes do MIME
    // matching mas precisamos do magic bytes correctos caso o limite suba.
    const sizeMb = 21;
    const huge = new Uint8Array(sizeMb * 1024 * 1024).fill(0x41);
    huge.set(MIN_PDF_BYTES.subarray(0, 8), 0); // %PDF-1.4 prefix
    const e = await assertRejects(
      () =>
        client.admin.addInspectionAttachment(
          inspectionId,
          huge,
          "muito-grande.pdf",
          "application/pdf",
          { headers: hdr() },
        ),
      ApiError,
    );
    assertEquals(e.statusCode, 413);
  });

  it("attachment - download PDF returns content + correct mime", async () => {
    const r = await fetch(
      `${BASE_URL}/v1/admin/condominiums/${fx.condominium.id}/inspections/${inspectionId}/attachments/${attachmentPdfId}`,
      { headers: MASTER as HeadersInit },
    );
    assertEquals(r.status, 200);
    assertEquals(r.headers.get("content-type"), "application/pdf");
    const buf = new Uint8Array(await r.arrayBuffer());
    assertEquals(buf.byteLength, MIN_PDF_BYTES.byteLength);
  });

  it("attachment - delete one keeps the other", async () => {
    const { status } = await client.admin.deleteInspectionAttachment(
      inspectionId,
      attachmentPdfId,
      { headers: hdr() },
    );
    assertEquals(status, 204);
    const { data } = await client.admin.getInspection(inspectionId, { headers: hdr() });
    assertEquals(data.attachments.length, 1);
    assertEquals(data.attachments[0].mimeType, "image/png");
  });

  it("attachment - download deleted returns 404", async () => {
    const r = await fetch(
      `${BASE_URL}/v1/admin/condominiums/${fx.condominium.id}/inspections/${inspectionId}/attachments/${attachmentPdfId}`,
      { headers: MASTER as HeadersInit },
    );
    assertEquals(r.status, 404);
    await r.body?.cancel();
  });

  it("attachment - delete inexistente returns 404", async () => {
    const e = await assertRejects(
      () =>
        client.admin.deleteInspectionAttachment(
          inspectionId,
          "att_does_not_exist",
          { headers: hdr() },
        ),
      ApiError,
    );
    assertEquals(e.statusCode, 404);
  });

  // ═══ Cleanup principal ═══════════════════════════════════════════════════════

  it("delete inspection - returns 204", async () => {
    const { status } = await client.admin.deleteInspection(inspectionId, { headers: hdr() });
    assertEquals(status, 204);
  });

  it("get - deleted returns 404", async () => {
    const e = await assertRejects(
      () => client.admin.getInspection(inspectionId, { headers: hdr() }),
      ApiError,
    );
    assertEquals(e.statusCode, 404);
  });

  it("teardown - delete condominium", async () => {
    await fx.cleanup();
  });
});

// ═══ Auth: 401 sem Bearer + 403 manager doutro condo ════════════════════════

describe("admin inspections - auth", () => {
  let condoAId = "";
  let condoBId = "";
  const mgrId = "usr_insp_mgrA";
  const mgrEmail = `${mgrId}@test.pt`;
  const mgrPass = "mgr-pass-12345";
  let mgrToken = "";
  let superHeaders: { Authorization: string };

  it("setup: super cria 2 condomínios + manager ativo só de A", async () => {
    superHeaders = await loginAsSuper();
    const { data: a } = await client.super.createCondominium(
      { name: "Insp Auth A" },
      { headers: superHeaders },
    );
    const { data: b } = await client.super.createCondominium(
      { name: "Insp Auth B" },
      { headers: superHeaders },
    );
    condoAId = a.id;
    condoBId = b.id;

    await deleteTestUser(mgrId).catch(() => {});
    await seedTestUser({ id: mgrId, email: mgrEmail, password: mgrPass });
    await sqlExec(`
      INSERT INTO core.manager (id, condominium_id, user_id, is_active)
      VALUES ('mgrA_${condoAId}', '${condoAId}', '${mgrId}', true)
    `);
    const { data } = await client.auth.login(mgrEmail, mgrPass);
    mgrToken = data.token;
  });

  it("sem Bearer → 401", async () => {
    const r = await fetch(`${BASE_URL}/v1/admin/condominiums/${condoAId}/inspections`);
    assertEquals(r.status, 401);
    await r.body?.cancel();
  });

  it("Bearer inválido → 401", async () => {
    const r = await fetch(`${BASE_URL}/v1/admin/condominiums/${condoAId}/inspections`, {
      headers: { Authorization: "Bearer invalid_token_xyz" },
    });
    assertEquals(r.status, 401);
    await r.body?.cancel();
  });

  it("manager de A → list inspections de A retorna 200", async () => {
    const { status } = await client.admin.listInspections({}, {
      headers: { Authorization: `Bearer ${mgrToken}`, "x-condominium-id": condoAId },
    });
    assertEquals(status, 200);
  });

  it("manager de A → list inspections de B retorna 403", async () => {
    const e = await assertRejects(
      () =>
        client.admin.listInspections({}, {
          headers: { Authorization: `Bearer ${mgrToken}`, "x-condominium-id": condoBId },
        }),
      ApiError,
    );
    assertEquals(e.statusCode, 403);
  });

  it("manager de A → count alerts de B retorna 403", async () => {
    const e = await assertRejects(
      () =>
        client.admin.countInspectionAlerts({
          headers: { Authorization: `Bearer ${mgrToken}`, "x-condominium-id": condoBId },
        }),
      ApiError,
    );
    assertEquals(e.statusCode, 403);
  });

  it("teardown", async () => {
    await client.super.deleteCondominium(condoAId, { headers: superHeaders });
    await client.super.deleteCondominium(condoBId, { headers: superHeaders });
    await deleteTestUser(mgrId);
  });
});
