// Multi-tenant isolation: garante que um manager de condomínio A não
// consegue aceder a dados de condomínio B através do path /admin/c/B/.
//
// O middleware `api_auth.ts:88` aplica a regra:
//   if (cid && role !== 'super' && !managed.includes(cid)) → 403
//
// Cobertura: `Authorization` correcto + `cid` correcto = OK.
//            Mesmo `Authorization` + `cid` de outro condomínio = 403.

import { assertEquals, assertRejects } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { ApiError, Client } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";
import { deleteTestUser, seedTestUser, sqlExec } from "./_helpers/db.ts";

const BASE_URL = "http://localhost:3000";
const client = new Client({ baseUrl: BASE_URL });

describe("multi-tenant isolation", () => {
  let condoAId = "";
  let condoBId = "";
  const mgrId = "usr_tenant_mgrA";
  const mgrEmail = `${mgrId}@test.pt`;
  const mgrPass = "mgr-pass-12345";
  let mgrToken = "";
  let superHeaders: { Authorization: string };

  it("setup: super cria 2 condomínios", async () => {
    superHeaders = await loginAsSuper();
    const { data: a } = await client.super.createCondominium(
      { name: "Tenant Iso A" },
      { headers: superHeaders },
    );
    const { data: b } = await client.super.createCondominium(
      { name: "Tenant Iso B" },
      { headers: superHeaders },
    );
    condoAId = a.id;
    condoBId = b.id;
  });

  it("setup: cria manager ativo só de condo A", async () => {
    await deleteTestUser(mgrId).catch(() => {});
    await seedTestUser({ id: mgrId, email: mgrEmail, password: mgrPass });
    await sqlExec(`
      INSERT INTO core.manager (id, condominium_id, user_id, is_active)
      VALUES ('mgrA_${condoAId}', '${condoAId}', '${mgrId}', true)
    `);
    const { data } = await client.auth.login(mgrEmail, mgrPass);
    mgrToken = data.token;
  });

  it("manager acede a condo A → 200", async () => {
    const { status } = await client.admin.listUnits({
      headers: { Authorization: `Bearer ${mgrToken}`, "x-condominium-id": condoAId },
    });
    assertEquals(status, 200);
  });

  it("manager tenta aceder a condo B → 403", async () => {
    const e = await assertRejects(
      () =>
        client.admin.listUnits({
          headers: { Authorization: `Bearer ${mgrToken}`, "x-condominium-id": condoBId },
        }),
      ApiError,
    );
    assertEquals(e.statusCode, 403);
  });

  it("manager tenta listar charges de condo B → 403", async () => {
    const e = await assertRejects(
      () =>
        client.admin.listCharges({}, {
          headers: { Authorization: `Bearer ${mgrToken}`, "x-condominium-id": condoBId },
        }),
      ApiError,
    );
    assertEquals(e.statusCode, 403);
  });

  it("super acede a ambos os condos → 200/200", async () => {
    const { status: sA } = await client.admin.listUnits({
      headers: { ...superHeaders, "x-condominium-id": condoAId },
    });
    const { status: sB } = await client.admin.listUnits({
      headers: { ...superHeaders, "x-condominium-id": condoBId },
    });
    assertEquals(sA, 200);
    assertEquals(sB, 200);
  });

  it("teardown", async () => {
    await client.super.deleteCondominium(condoAId, { headers: superHeaders });
    await client.super.deleteCondominium(condoBId, { headers: superHeaders });
    await deleteTestUser(mgrId);
  });
});
