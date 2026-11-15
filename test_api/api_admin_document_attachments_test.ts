// E2E: anexos de documentos.
//
// Cobre:
//   1. Upload PDF/imagem ao documento.
//   2. List inclui o uploaded.
//   3. Serve devolve bytes.
//   4. Cross-tenant 404.
//   5. Delete soft-removes.
//   6. Portal vê anexos de documento PUBLICO; 404 em privado.
//
// PDF mínimo válido (~270 bytes) - header `%PDF-1.4` + EOF é suficiente
// para passar o magic check do MIME detection.

import { assertEquals, assertExists } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import postgresjs from "postgresjs";
import bcrypt from "npm:bcryptjs@2.4.3";
import { ApiError, Client } from "$shared/client/mod.ts";
import { assertRejects } from "@std/assert";
import { loginAsSuper } from "./_helpers/auth.ts";

const BASE_URL = "http://localhost:3000";
const DATABASE_URL = Deno.env.get("DATABASE_URL") ??
  "postgres://mague:mague@localhost:5432/mague";
const SUPER = await loginAsSuper();
const sql = postgresjs(DATABASE_URL, { max: 2 });

// 1×1 PNG transparente (~70 bytes).
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

describe("admin documents - attachments lifecycle + portal access", () => {
  const stamp = Date.now();
  const ownerEmail = `doc-att-${stamp}@test.pt`;
  const password = "TestPass1234";
  let condoAId = "";
  let condoBId = "";
  let unitId = "";
  let publicDocId = "";
  let privateDocId = "";
  let attachmentId = "";
  let occupantId = "";
  let userId = "";
  let portalToken = "";
  const adm = new Client({ baseUrl: BASE_URL });

  function hdrA() {
    return { ...SUPER, "x-condominium-id": condoAId };
  }

  it("setup - 2 condos + unit + occupant + 1 public + 1 private doc", async () => {
    const { data: cA } = await adm.super.createCondominium(
      { name: "Doc Att A", fiscalNumber: "501800100" },
      { headers: SUPER },
    );
    condoAId = cA.id;
    const { data: cB } = await adm.super.createCondominium(
      { name: "Doc Att B", fiscalNumber: "501800200" },
      { headers: SUPER },
    );
    condoBId = cB.id;

    const { data: u } = await adm.super.createUnit(
      condoAId,
      { designation: "X", permillage: 1000 },
      { headers: SUPER },
    );
    unitId = u.id;

    // user + occupant + unit_occupant para portal access
    const hash = await bcrypt.hash(password, 10);
    const ur = await sql<{ id: string }[]>`
      INSERT INTO core.user (name, email, role, is_active, password_hash)
      VALUES ('Doc Att Owner', ${ownerEmail}, NULL, true, ${hash}) RETURNING id
    `;
    userId = ur[0].id;
    const { data: occ } = await adm.admin.createOccupant(
      { name: "Owner DocAtt", type: "owner", email: ownerEmail },
      { headers: hdrA() },
    );
    occupantId = occ.id;
    await sql`UPDATE core.occupant SET user_id = ${userId} WHERE id = ${occupantId}`;
    await adm.admin.createUnitOccupant(
      unitId,
      { unitId, occupantId, relationshipType: "owner", startDate: "2025-01-01" },
      { headers: hdrA() },
    );

    const pub = await adm.admin.createDocument(
      { title: "Acta Pública DocAtt", category: "minutes", isPublic: true },
      { headers: hdrA() },
    );
    publicDocId = pub.data.id;
    const priv = await adm.admin.createDocument(
      { title: "Contrato Privado DocAtt", category: "contract", isPublic: false },
      { headers: hdrA() },
    );
    privateDocId = priv.data.id;

    portalToken = (await adm.auth.login(ownerEmail, password)).data.token;
  });

  it("upload - anexo no documento público retorna 201 + metadata", async () => {
    const { data, status } = await adm.admin.uploadDocumentAttachment(
      publicDocId,
      pngBytes,
      "acta.png",
      "image/png",
      { headers: hdrA() },
    );
    assertEquals(status, 201);
    assertEquals(data.filename, "acta.png");
    assertEquals(data.mimeType, "image/png");
    assertExists(data.id);
    attachmentId = data.id as string;
  });

  it("getDocument - retrieve devolve doc + attachments[]", async () => {
    const { data } = await adm.admin.getDocument(publicDocId, { headers: hdrA() });
    type DocWithAtt = { attachments: Array<{ id: string; filename: string }> };
    const d = data as unknown as DocWithAtt;
    assertEquals(d.attachments.length, 1);
    assertEquals(d.attachments[0].id, attachmentId);
    assertEquals(d.attachments[0].filename, "acta.png");
  });

  it("serve attachment - admin GET devolve bytes", async () => {
    const url =
      `${BASE_URL}/v1/admin/condominiums/${condoAId}/documents/${publicDocId}/attachments/${attachmentId}`;
    const res = await fetch(url, { headers: SUPER });
    assertEquals(res.status, 200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    assertEquals(bytes.byteLength, pngBytes.byteLength);
    assertEquals(bytes[0], 137); // PNG magic
  });

  it("cross-tenant - admin do condo B não consegue serve attachment do A", async () => {
    const url =
      `${BASE_URL}/v1/admin/condominiums/${condoBId}/documents/${publicDocId}/attachments/${attachmentId}`;
    const res = await fetch(url, { headers: { ...SUPER, "x-condominium-id": condoBId } });
    await res.body?.cancel();
    assertEquals(res.status, 404);
  });

  it("portal - download attachment de documento público OK", async () => {
    const url =
      `${BASE_URL}/v1/portal/condominiums/${condoAId}/documents/${publicDocId}/attachments/${attachmentId}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${portalToken}` },
    });
    assertEquals(res.status, 200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    assertEquals(bytes.byteLength, pngBytes.byteLength);
  });

  it("portal - upload no documento privado bloqueado", async () => {
    // Upload anexo no privado (admin)
    const { data: privAtt } = await adm.admin.uploadDocumentAttachment(
      privateDocId,
      pngBytes,
      "contrato.png",
      "image/png",
      { headers: hdrA() },
    );
    const privAttId = privAtt.id as string;

    // Portal tenta servir → 404 (is_public=false)
    const url =
      `${BASE_URL}/v1/portal/condominiums/${condoAId}/documents/${privateDocId}/attachments/${privAttId}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${portalToken}` },
    });
    await res.body?.cancel();
    assertEquals(res.status, 404);
  });

  it("delete attachment - 204 + retrieve já não devolve", async () => {
    await adm.admin.deleteDocumentAttachment(publicDocId, attachmentId, { headers: hdrA() });
    const { data } = await adm.admin.getDocument(publicDocId, { headers: hdrA() });
    type DocWithAtt = { attachments: Array<{ id: string }> };
    const d = data as unknown as DocWithAtt;
    assertEquals(d.attachments.length, 0);
  });

  it("upload em documento inexistente retorna 404", async () => {
    const e = await assertRejects(
      () =>
        adm.admin.uploadDocumentAttachment(
          "ghostxyz12",
          pngBytes,
          "x.png",
          "image/png",
          { headers: hdrA() },
        ),
      ApiError,
    );
    assertEquals(e.statusCode, 404);
  });

  it("teardown", async () => {
    try {
      // Soft-deleted attachments may still exist; hard-delete to clear FK.
      await sql`DELETE FROM core.attachment WHERE condominium_id = ${condoAId}`;
      await sql`DELETE FROM core.unit_occupant WHERE unit_id = ${unitId}`;
      await sql`DELETE FROM core.occupant WHERE id = ${occupantId}`;
      await sql`DELETE FROM core.user WHERE id = ${userId}`;
      await sql`DELETE FROM core.document WHERE condominium_id IN (${condoAId}, ${condoBId})`;
      await sql`DELETE FROM core.unit WHERE id = ${unitId}`;
      await sql`DELETE FROM core.condominium WHERE id IN (${condoAId}, ${condoBId})`;
    } finally {
      await sql.end();
    }
  });
});
