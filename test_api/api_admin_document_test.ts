// E2E: documentos do condomínio.
//
// Cobre:
//   1. Admin CRUD (list/retrieve/create/update/delete).
//   2. Multi-tenant: documents de condo A não aparecem na lista de condo B.
//   3. Filtro is_public + categoria.
//   4. Soft-delete (delete não retorna o doc, lista não devolve).
//   5. Portal vê só is_public=true.
//   6. Categoria fora do allow-list devolve 400.

import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { ApiError, Client } from "$shared/client/mod.ts";
import { assertRejects } from "@std/assert";
import { loginAsSuper } from "./_helpers/auth.ts";

const BASE_URL = "http://localhost:3000";
const SUPER = await loginAsSuper();

describe("admin documents - CRUD + visibility", () => {
  const client = new Client({ baseUrl: BASE_URL });
  let condoAId = "";
  let condoBId = "";
  let publicDocId = "";
  let privateDocId = "";

  it("setup - 2 condos", async () => {
    const { data: cA } = await client.super.createCondominium(
      { name: "Doc Test A", fiscalNumber: "501600100" },
      { headers: SUPER },
    );
    condoAId = cA.id;
    const { data: cB } = await client.super.createCondominium(
      { name: "Doc Test B", fiscalNumber: "501600200" },
      { headers: SUPER },
    );
    condoBId = cB.id;
  });

  function hdr(cid: string) {
    return { ...SUPER, "x-condominium-id": cid };
  }

  it("createDocument - public minutes", async () => {
    const { data, status } = await client.admin.createDocument(
      {
        title: "Acta Assembleia 2026",
        description: "Reunião ordinária anual",
        category: "minutes",
        isPublic: true,
        publishedAt: "2026-03-15",
      },
      { headers: hdr(condoAId) },
    );
    assertEquals(status, 201);
    assertEquals(data.title, "Acta Assembleia 2026");
    assertEquals(data.category, "minutes");
    assertEquals(data.isPublic, true);
    publicDocId = data.id;
  });

  it("createDocument - private contract", async () => {
    const { data } = await client.admin.createDocument(
      { title: "Contrato Limpeza Confidencial", category: "contract", isPublic: false },
      { headers: hdr(condoAId) },
    );
    assertEquals(data.isPublic, false);
    privateDocId = data.id;
  });

  it("createDocument - categoria inválida → 400", async () => {
    const e = await assertRejects(
      () =>
        client.admin.createDocument(
          { title: "X", category: "invalid_cat" as unknown as "other" },
          { headers: hdr(condoAId) },
        ),
      ApiError,
    );
    assertEquals(e.statusCode, 400);
  });

  it("listDocuments - devolve os 2 do condo A", async () => {
    const { data } = await client.admin.listDocuments(undefined, { headers: hdr(condoAId) });
    assertEquals(data.length, 2);
  });

  it("listDocuments - filtro isPublic=true devolve só o público", async () => {
    const { data } = await client.admin.listDocuments(
      { isPublic: true },
      { headers: hdr(condoAId) },
    );
    assertEquals(data.length, 1);
    assertEquals(data[0].id, publicDocId);
  });

  it("listDocuments - filtro category=contract devolve só o contrato", async () => {
    const { data } = await client.admin.listDocuments(
      { category: "contract" },
      { headers: hdr(condoAId) },
    );
    assertEquals(data.length, 1);
    assertEquals(data[0].id, privateDocId);
  });

  it("multi-tenant - admin do condo B não vê documents do condo A", async () => {
    const { data } = await client.admin.listDocuments(undefined, { headers: hdr(condoBId) });
    assertEquals(data.length, 0);
  });

  it("getDocument - cross-tenant → 404", async () => {
    const e = await assertRejects(
      () => client.admin.getDocument(publicDocId, { headers: hdr(condoBId) }),
      ApiError,
    );
    assertEquals(e.statusCode, 404);
  });

  it("updateDocument - alterar visibilidade", async () => {
    const { data } = await client.admin.updateDocument(
      privateDocId,
      { isPublic: true, title: "Contrato Limpeza" },
      { headers: hdr(condoAId) },
    );
    assertEquals(data.isPublic, true);
    assertEquals(data.title, "Contrato Limpeza");
  });

  it("deleteDocument - soft-delete + lista não devolve", async () => {
    await client.admin.deleteDocument(privateDocId, { headers: hdr(condoAId) });
    const { data } = await client.admin.listDocuments(undefined, { headers: hdr(condoAId) });
    assertEquals(data.length, 1);
    assertEquals(data[0].id, publicDocId);
  });

  it("getDocument - após delete devolve 404", async () => {
    const e = await assertRejects(
      () => client.admin.getDocument(privateDocId, { headers: hdr(condoAId) }),
      ApiError,
    );
    assertEquals(e.statusCode, 404);
  });

  it("teardown", async () => {
    await client.super.deleteCondominium(condoAId, { headers: SUPER });
    await client.super.deleteCondominium(condoBId, { headers: SUPER });
  });
});
