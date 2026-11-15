// E2E: anexos de assembleias - admin (CRUD) + portal (read-only).
//
// Lifecycle admin: list (vazio) → upload → list → serve → delete.
// Lifecycle portal: occupant da fração lê os anexos da assembleia já
// realizada (status=held). Portal não pode upload nem delete.
//
// Anti-IDOR: occupant de outro condomínio recebe 403 ou 404.

import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { ApiError, Client, type Condominium, type Unit } from "$shared/client/mod.ts";
import { loginAs, loginAsSuper } from "./_helpers/auth.ts";
import { seedTestUser, sqlExec } from "./_helpers/db.ts";

const BASE_URL = "http://localhost:3000";
const client = new Client({ baseUrl: BASE_URL });
const MASTER = await loginAsSuper();

// 1×1 PNG mínimo.
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

describe("admin assembly - attachments lifecycle (admin + portal)", () => {
  let condoA: Condominium;
  let condoB: Condominium;
  let unitA: Unit;
  let unitB: Unit;
  let assemblyId = "";
  let attachmentId = "";
  let aliceHeaders: { Authorization: string };
  let bobHeaders: { Authorization: string };

  const hdrA = () => ({ ...MASTER, "x-condominium-id": condoA.id });

  it("setup - 2 condos, 2 units, 2 occupants, 1 assembly held em A", async () => {
    const ts = Date.now();
    condoA = (await client.super.createCondominium(
      { name: `AsmAtt A ${ts}` },
      { headers: MASTER },
    )).data;
    condoB = (await client.super.createCondominium(
      { name: `AsmAtt B ${ts}` },
      { headers: MASTER },
    )).data;
    unitA = (await client.super.createUnit(
      condoA.id,
      { designation: "A1", permillage: 100 },
      { headers: MASTER },
    )).data;
    unitB = (await client.super.createUnit(
      condoB.id,
      { designation: "B1", permillage: 100 },
      { headers: MASTER },
    )).data;

    const aliceEmail = `alice-asm-${ts}@example.pt`;
    const bobEmail = `bob-asm-${ts}@example.pt`;
    const aliceUid = await seedTestUser({
      email: aliceEmail,
      password: "test12345",
      name: "Alice",

      active: true,
    });
    const bobUid = await seedTestUser({
      email: bobEmail,
      password: "test12345",
      name: "Bob",

      active: true,
    });

    const aliceOcc = (await sqlExec(`
      INSERT INTO core.occupant (user_id,name,email,condominium_id)
      VALUES ('${aliceUid}','Alice','${aliceEmail}','${condoA.id}')
      RETURNING id`)).split("\n")[0].trim();
    const bobOcc = (await sqlExec(`
      INSERT INTO core.occupant (user_id,name,email,condominium_id)
      VALUES ('${bobUid}','Bob','${bobEmail}','${condoB.id}')
      RETURNING id`)).split("\n")[0].trim();
    await sqlExec(`
      INSERT INTO core.unit_occupant (unit_id,occupant_id,relationship_type,start_date)
      VALUES ('${unitA.id}','${aliceOcc}','owner',CURRENT_DATE);
      INSERT INTO core.unit_occupant (unit_id,occupant_id,relationship_type,start_date)
      VALUES ('${unitB.id}','${bobOcc}','owner',CURRENT_DATE);
    `);

    aliceHeaders = await loginAs(aliceEmail, "test12345");
    bobHeaders = await loginAs(bobEmail, "test12345");

    // Cria assembleia + marca held (para portal poder listar - já realizada).
    const { data: a } = await client.admin.createAssembly(
      {
        type: "ordinary",
        scheduledAt: "2026-06-15T19:00:00+00:00",
        location: "Zoom",
        notes: "Test held assembly",
      },
      { headers: hdrA() },
    );
    assemblyId = a.id as string;
    await client.admin.updateAssembly(
      assemblyId,
      { status: "held", heldAt: "2026-06-15T19:30:00+00:00" },
      { headers: hdrA() },
    );
  });

  // ─── ADMIN ───────────────────────────────────────────────────────────────

  it("admin: listAssemblyAttachments - empty returns []", async () => {
    const { data, status } = await client.admin.listAssemblyAttachments(
      assemblyId,
      { headers: hdrA() },
    );
    assertEquals(status, 200);
    assertEquals(data, []);
  });

  it("admin: uploadAssemblyAttachment - retorna 201", async () => {
    const file = new File([pngBytes], "acta.png", { type: "image/png" });
    const { data, status } = await client.admin.uploadAssemblyAttachment(
      assemblyId,
      file,
      { headers: hdrA() },
    );
    assertEquals(status, 201);
    assertEquals(data.filename, "acta.png");
    assertEquals(data.mimeType, "image/png");
    assertEquals(data.fileSize, pngBytes.byteLength);
    assertExists(data.id);
    attachmentId = String(data.id);
  });

  it("admin: list inclui o uploaded", async () => {
    const { data } = await client.admin.listAssemblyAttachments(
      assemblyId,
      { headers: hdrA() },
    );
    assertEquals(data.length, 1);
    assertEquals(data[0].id, attachmentId);
  });

  it("admin: serve attachment - retorna bytes", async () => {
    // Constrói path manualmente para garantir o cid (cidResolver fica
    // undefined em testes; `client.admin.assemblyAttachmentUrl` produz
    // ".../undefined/..." nessa situação).
    const path =
      `${BASE_URL}/v1/admin/condominiums/${condoA.id}/assemblies/${assemblyId}/attachments/${attachmentId}`;
    const res = await fetch(path, { headers: MASTER });
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("content-type"), "image/png");
    await res.body?.cancel();
  });

  // ─── PORTAL READ-ONLY ────────────────────────────────────────────────────

  it("portal: alice (owner unit A) consegue listar anexos da assembleia A", async () => {
    const path =
      `${BASE_URL}/v1/portal/condominiums/${condoA.id}/assemblies/${assemblyId}/attachments`;
    const res = await fetch(path, { headers: aliceHeaders });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(Array.isArray(body.data), true);
    assertEquals(body.data.length, 1);
    assertEquals(body.data[0].id, attachmentId);
  });

  it("portal: alice consegue baixar bytes do anexo da sua assembleia", async () => {
    const path =
      `${BASE_URL}/v1/portal/condominiums/${condoA.id}/assemblies/${assemblyId}/attachments/${attachmentId}`;
    const res = await fetch(path, { headers: aliceHeaders });
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("content-type"), "image/png");
    const bytes = new Uint8Array(await res.arrayBuffer());
    assertEquals(bytes.byteLength, pngBytes.byteLength);
  });

  it("portal: bob (owner unit B) tenta ler anexos da assembleia A → 403/404", async () => {
    const path =
      `${BASE_URL}/v1/portal/condominiums/${condoA.id}/assemblies/${assemblyId}/attachments`;
    const res = await fetch(path, { headers: bobHeaders });
    // Aceitamos 403 (cross-condo guard) ou 404 (assembly não visível).
    if (res.status !== 403 && res.status !== 404) {
      throw new Error(`Esperado 403 ou 404, recebido ${res.status}`);
    }
    await res.body?.cancel();
  });

  it("portal: POST upload retorna 404 (rota não existe no portal)", async () => {
    const form = new FormData();
    form.append("file", new Blob([pngBytes], { type: "image/png" }), "test.png");
    const path =
      `${BASE_URL}/v1/portal/condominiums/${condoA.id}/assemblies/${assemblyId}/attachments`;
    const res = await fetch(path, {
      method: "POST",
      headers: aliceHeaders,
      body: form,
    });
    // O portal não tem POST nesta rota. Hono devolve 404 ou 405.
    if (res.status !== 404 && res.status !== 405) {
      throw new Error(`Esperado 404/405, recebido ${res.status}`);
    }
    await res.body?.cancel();
  });

  it("portal: DELETE attachment retorna 404 (rota não existe)", async () => {
    const path =
      `${BASE_URL}/v1/portal/condominiums/${condoA.id}/assemblies/${assemblyId}/attachments/${attachmentId}`;
    const res = await fetch(path, {
      method: "DELETE",
      headers: aliceHeaders,
    });
    if (res.status !== 404 && res.status !== 405) {
      throw new Error(`Esperado 404/405, recebido ${res.status}`);
    }
    await res.body?.cancel();
  });

  // ─── ADMIN delete cleanup ────────────────────────────────────────────────

  it("admin: deleteAssemblyAttachment - 204 + serve passa a 404", async () => {
    const { status } = await client.admin.deleteAssemblyAttachment(
      assemblyId,
      attachmentId,
      { headers: hdrA() },
    );
    assertEquals(status, 204);

    const path =
      `${BASE_URL}/v1/admin/condominiums/${condoA.id}/assemblies/${assemblyId}/attachments/${attachmentId}`;
    const res = await fetch(path, { headers: MASTER });
    assertEquals(res.status, 404);
    await res.body?.cancel();
  });

  it("portal: alice já não vê o anexo eliminado", async () => {
    const path =
      `${BASE_URL}/v1/portal/condominiums/${condoA.id}/assemblies/${assemblyId}/attachments`;
    const res = await fetch(path, { headers: aliceHeaders });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.data.length, 0);
  });

  it("admin: delete idempotente - 2ª chamada retorna 404", async () => {
    const e = await assertRejects(
      () =>
        client.admin.deleteAssemblyAttachment(
          assemblyId,
          attachmentId,
          { headers: hdrA() },
        ),
      ApiError,
    );
    assertEquals(e.statusCode, 404);
  });

  it("teardown - cleanup", async () => {
    await sqlExec(`DELETE FROM core.unit_occupant WHERE unit_id IN ('${unitA.id}','${unitB.id}')`);
    await sqlExec(
      `DELETE FROM core.occupant WHERE condominium_id IN ('${condoA.id}','${condoB.id}')`,
    );
    await client.super.deleteCondominium(condoA.id, { headers: MASTER });
    await client.super.deleteCondominium(condoB.id, { headers: MASTER });
  });
});
