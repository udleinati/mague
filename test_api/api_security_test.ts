// Security e2e: bateria abrangente de pentesting que NÃO PODE falhar.
//
// Cenários cobertos:
//   1. Cross-condo via path: occupant/manager tenta cid de outro condomínio.
//   2. Cross-unit (mesmo condo): occupant tenta unit do vizinho.
//   3. Cross-charge/receipt: occupant usa id de recurso doutra fração.
//   4. Cross-manager: manager de A tenta dados de B.
//   5. Header tampering: x-role, x-user-id, x-condominium-id.
//   6. Token tampering: sem token, garbage token, basic auth.
//   7. WRITE em /admin como occupant: 403 em tudo.
//   8. WRITE no /portal: rotas POST inexistentes retornam 404.
//   9. Auto-promoção: occupant tenta criar manager para si próprio.
//
// Esta suite é a "rede de segurança" - se algum destes deny falhar, é
// regressão crítica. NUNCA marcar como skip.

import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { afterAll, describe, it } from "@std/testing/bdd";
import { ApiError, Client, type Condominium, type Unit } from "$shared/client/mod.ts";
import { loginAs, loginAsSuper } from "./_helpers/auth.ts";
import { deleteTestUser, seedTestUser, sqlExec } from "./_helpers/db.ts";

const BASE_URL = "http://localhost:3000";
const client = new Client({ baseUrl: BASE_URL });
const SUPER = await loginAsSuper();

// Helper: GET cru com headers customizados (para testes de header tampering).
async function rawGet(
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE_URL}${path}`, { headers });
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = await res.text().catch(() => null);
  }
  return { status: res.status, body };
}

async function rawPost(
  path: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  let respBody: unknown;
  try {
    respBody = await res.json();
  } catch {
    respBody = await res.text().catch(() => null);
  }
  return { status: res.status, body: respBody };
}

async function rawPatch(
  path: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  let respBody: unknown;
  try {
    respBody = await res.json();
  } catch {
    respBody = await res.text().catch(() => null);
  }
  return { status: res.status, body: respBody };
}

describe("security pentesting - cross-tenant + cross-role + header tampering", () => {
  let condoA: Condominium;
  let condoB: Condominium;
  let unitA1: Unit;
  let unitA2: Unit;
  let unitB1: Unit;
  let aliceUserId = "";
  let bobUserId = "";
  let maryUserId = "";
  let aliceHeaders: { Authorization: string };
  let bobHeaders: { Authorization: string };
  let maryHeaders: { Authorization: string };
  let chargeInA1 = "";
  let chargeInA2 = "";

  it("setup: 2 condomínios + 3 unidades + 3 users (alice/bob occupants, mary manager)", async () => {
    // Cleanup eventual de runs anteriores que falharam a meio.
    await sqlExec(`DELETE FROM core."user" WHERE email LIKE '%-pentest@example.pt'`).catch(
      () => {},
    );

    const a = await client.super.createCondominium({ name: "Pentest A" }, { headers: SUPER });
    condoA = a.data;
    const b = await client.super.createCondominium({ name: "Pentest B" }, { headers: SUPER });
    condoB = b.data;

    unitA1 = (await client.super.createUnit(condoA.id, { designation: "A1", permillage: 100 }, {
      headers: SUPER,
    })).data;
    unitA2 = (await client.super.createUnit(condoA.id, { designation: "A2", permillage: 100 }, {
      headers: SUPER,
    })).data;
    unitB1 = (await client.super.createUnit(condoB.id, { designation: "B1", permillage: 100 }, {
      headers: SUPER,
    })).data;

    aliceUserId = await seedTestUser({
      email: `alice-pentest@example.pt`,
      name: "Alice",

      password: "test12345",
    });
    bobUserId = await seedTestUser({
      email: `bob-pentest@example.pt`,
      name: "Bob",

      password: "test12345",
    });
    maryUserId = await seedTestUser({
      email: `mary-pentest@example.pt`,
      name: "Mary",

      password: "test12345",
    });

    // Alice → unitA1 (occupant). Bob → unitB1 (occupant). Mary → manager A.
    const aliceOcc = (await sqlExec(`
      INSERT INTO core.occupant (user_id,name,email,condominium_id)
      VALUES ('${aliceUserId}','Alice','alice-pentest@example.pt','${condoA.id}')
      RETURNING id
    `)).split("\n")[0].trim();
    const bobOcc = (await sqlExec(`
      INSERT INTO core.occupant (user_id,name,email,condominium_id)
      VALUES ('${bobUserId}','Bob','bob-pentest@example.pt','${condoB.id}')
      RETURNING id
    `)).split("\n")[0].trim();
    // Donos desde antes das cobranças de teste: a janela do condómino esconde o resto.
    await sqlExec(`
      INSERT INTO core.unit_occupant (unit_id,occupant_id,relationship_type,start_date)
      VALUES ('${unitA1.id}','${aliceOcc}','owner','2020-01-01');
      INSERT INTO core.unit_occupant (unit_id,occupant_id,relationship_type,start_date)
      VALUES ('${unitB1.id}','${bobOcc}','owner','2020-01-01');
      INSERT INTO core.manager (condominium_id,user_id,is_active)
      VALUES ('${condoA.id}','${maryUserId}',true);
    `);

    aliceHeaders = await loginAs("alice-pentest@example.pt", "test12345");
    bobHeaders = await loginAs("bob-pentest@example.pt", "test12345");
    maryHeaders = await loginAs("mary-pentest@example.pt", "test12345");

    // Charges em cada unit (super cria).
    const cA1 = await client.admin.createCharge({
      kind: "receivable",
      nature: "debit",
      chargeType: "quota",
      unitId: unitA1.id,
      amountCents: 10000,
      description: "QA1",
      competencePeriod: "2026-04-01",
      issueDate: "2026-04-01",
    }, { headers: { ...SUPER, "x-condominium-id": condoA.id } });
    chargeInA1 = String((cA1.data as { id: string }).id);

    const cA2 = await client.admin.createCharge({
      kind: "receivable",
      nature: "debit",
      chargeType: "quota",
      unitId: unitA2.id,
      amountCents: 15000,
      description: "QA2",
      competencePeriod: "2026-04-01",
      issueDate: "2026-04-01",
    }, { headers: { ...SUPER, "x-condominium-id": condoA.id } });
    chargeInA2 = String((cA2.data as { id: string }).id);

    await client.admin.createCharge({
      kind: "receivable",
      nature: "debit",
      chargeType: "quota",
      unitId: unitB1.id,
      amountCents: 20000,
      description: "QB1",
      competencePeriod: "2026-04-01",
      issueDate: "2026-04-01",
    }, { headers: { ...SUPER, "x-condominium-id": condoB.id } });

    assertExists(condoA.id);
    assertExists(condoB.id);
    assertExists(unitA1.id);
    assertExists(unitA2.id);
    assertExists(unitB1.id);
    assertExists(aliceUserId);
    assertExists(bobUserId);
    assertExists(maryUserId);
  });

  // ── 1. CROSS-CONDO via path ────────────────────────────────────────────
  describe("[1] cross-condo via path: alice/bob/mary tentam outro cid", () => {
    it("alice (occupant em A) GET /admin/...condoB/units → 403", async () => {
      const r = await rawGet(`/v1/admin/condominiums/${condoB.id}/units`, aliceHeaders);
      assertEquals(r.status, 403);
    });

    it("alice GET /portal/...condoB → 403 (sem occupant em B)", async () => {
      const r = await rawGet(`/v1/portal/condominiums/${condoB.id}`, aliceHeaders);
      assertEquals(r.status, 403);
    });

    it("bob (occupant em B) GET /admin/...condoA/units → 403", async () => {
      const r = await rawGet(`/v1/admin/condominiums/${condoA.id}/units`, bobHeaders);
      assertEquals(r.status, 403);
    });

    it("mary (manager A) GET /admin/...condoB → 403", async () => {
      const r = await rawGet(`/v1/admin/condominiums/${condoB.id}/units`, maryHeaders);
      assertEquals(r.status, 403);
    });

    it("mary GET /portal/...condoB → 403 (mary não é occupant em B)", async () => {
      const r = await rawGet(`/v1/portal/condominiums/${condoB.id}`, maryHeaders);
      assertEquals(r.status, 403);
    });
  });

  // ── 2. CROSS-UNIT (mesmo condo) ────────────────────────────────────────
  describe("[2] cross-unit no mesmo condo: alice tenta unitA2 (vizinho)", () => {
    it("alice GET /portal/...units/A2 → 404 (não tem unit_occupant)", async () => {
      const r = await rawGet(
        `/v1/portal/condominiums/${condoA.id}/units/${unitA2.id}`,
        aliceHeaders,
      );
      assertEquals(r.status, 404);
    });

    it("alice GET /portal/...units/A2/charges → 404", async () => {
      const r = await rawGet(
        `/v1/portal/condominiums/${condoA.id}/units/${unitA2.id}/charges`,
        aliceHeaders,
      );
      assertEquals(r.status, 404);
    });

    it("alice GET /portal/...units/A2/settlements → 404", async () => {
      const r = await rawGet(
        `/v1/portal/condominiums/${condoA.id}/units/${unitA2.id}/settlements`,
        aliceHeaders,
      );
      assertEquals(r.status, 404);
    });

    it("alice GET /portal/...units/A2/receipts → 404", async () => {
      const r = await rawGet(
        `/v1/portal/condominiums/${condoA.id}/units/${unitA2.id}/receipts`,
        aliceHeaders,
      );
      assertEquals(r.status, 404);
    });
  });

  // ── 4. WRITE em /admin como occupant ───────────────────────────────────
  describe("[4] WRITE em /admin como occupant: tudo deve ser 403", () => {
    it("alice POST /admin/.../charges (própria unit) → 403", async () => {
      const r = await rawPost(
        `/v1/admin/condominiums/${condoA.id}/charges`,
        aliceHeaders,
        {
          kind: "receivable",
          nature: "debit",
          chargeType: "quota",
          unitId: unitA1.id,
          amountCents: 1,
          description: "hack",
          competencePeriod: "2026-01-01",
          issueDate: "2026-01-01",
        },
      );
      assertEquals(r.status, 403);
    });

    it("alice PATCH /admin/.../users/:id { isManager:true } (auto-promoção) → 403", async () => {
      // Pós-ADR 0002: o endpoint POST /managers já não existe; auto-promoção
      // via PATCH user com isManager=true é rejeitada pelo requireAdminRole.
      const r = await rawPatch(
        `/v1/admin/condominiums/${condoA.id}/users/${aliceUserId}`,
        aliceHeaders,
        { isManager: true },
      );
      assertEquals(r.status, 403);
    });

    it("alice POST /admin/.../units (criar fração) → 403", async () => {
      const r = await rawPost(
        `/v1/admin/condominiums/${condoA.id}/units`,
        aliceHeaders,
        { designation: "HACK", permillage: 1 },
      );
      assertEquals(r.status, 403);
    });

    it("alice POST /admin/.../suppliers → 403", async () => {
      const r = await rawPost(
        `/v1/admin/condominiums/${condoA.id}/suppliers`,
        aliceHeaders,
        { name: "hack" },
      );
      assertEquals(r.status, 403);
    });
  });

  // ── 5. READ em /admin como occupant ────────────────────────────────────
  describe("[5] READ em /admin como occupant: tudo deve ser 403", () => {
    const paths = [
      (cid: string, uid: string) => `/v1/admin/condominiums/${cid}/charges?unitId=${uid}`,
      (cid: string) => `/v1/admin/condominiums/${cid}/charges`,
      (cid: string) => `/v1/admin/condominiums/${cid}/charges/top_open_by_group`,
      (cid: string) => `/v1/admin/condominiums/${cid}/units`,
      (cid: string) => `/v1/admin/condominiums/${cid}/occupants`,
      (cid: string) => `/v1/admin/condominiums/${cid}/bank_transactions`,
      (cid: string) => `/v1/admin/condominiums/${cid}/suppliers`,
      (cid: string) => `/v1/admin/condominiums/${cid}/budgets`,
      (cid: string) => `/v1/admin/condominiums/${cid}/chart_of_accounts`,
      (cid: string) => `/v1/admin/condominiums/${cid}/recurring_templates`,
    ];

    for (const fn of paths) {
      const path = fn(":cid", ":uid").replace(":cid", "<cid>").replace(":uid", "<uid>");
      it(`alice GET ${path} → 403`, async () => {
        const r = await rawGet(fn(condoA.id, unitA1.id), aliceHeaders);
        assertEquals(r.status, 403);
      });
    }
  });

  // ── 6. HEADER TAMPERING ────────────────────────────────────────────────
  describe("[6] header tampering: pedidos a falsificar role/cid", () => {
    it("alice + x-role: master → ignorado, 403", async () => {
      const r = await rawGet(`/v1/admin/condominiums/${condoA.id}/units`, {
        ...aliceHeaders,
        "x-role": "master",
      });
      assertEquals(r.status, 403);
    });

    it("alice + x-role: super → ignorado, 403", async () => {
      const r = await rawGet(`/v1/admin/condominiums/${condoA.id}/units`, {
        ...aliceHeaders,
        "x-role": "super",
      });
      assertEquals(r.status, 403);
    });

    it("alice + x-user-id: u_super → ignorado, 403", async () => {
      const r = await rawGet(`/v1/admin/condominiums/${condoA.id}/units`, {
        ...aliceHeaders,
        "x-user-id": "u_super",
      });
      assertEquals(r.status, 403);
    });

    it("alice + x-user-email: super@mague.pt → ignorado, 403", async () => {
      const r = await rawGet(`/v1/admin/condominiums/${condoA.id}/units`, {
        ...aliceHeaders,
        "x-user-email": "super@mague.pt",
      });
      assertEquals(r.status, 403);
    });

    it("alice + x-condominium-id: condoB tenta acesso a B via /admin/...A/... → 403 (path manda)", async () => {
      // O cid efetivo vem do PATH, não do header. Path é A → ela passa o
      // gate de occupantCondos (alice é em A) mas requireAdminRole rejeita
      // (ela não é manager nem super) → 403.
      const r = await rawGet(`/v1/admin/condominiums/${condoA.id}/units`, {
        ...aliceHeaders,
        "x-condominium-id": condoB.id,
      });
      assertEquals(r.status, 403);
    });
  });

  // ── 7. TOKEN TAMPERING ─────────────────────────────────────────────────
  describe("[7] token tampering", () => {
    it("sem Authorization → 401", async () => {
      const r = await rawGet(`/v1/admin/condominiums/${condoA.id}/units`, {});
      assertEquals(r.status, 401);
    });

    it("garbage token → 401", async () => {
      const r = await rawGet(`/v1/admin/condominiums/${condoA.id}/units`, {
        Authorization: "Bearer garbage.token.here",
      });
      assertEquals(r.status, 401);
    });

    it("Basic auth em vez de Bearer → 401", async () => {
      const r = await rawGet(`/v1/admin/condominiums/${condoA.id}/units`, {
        Authorization: "Basic c3VwZXJAbWFndWUucHQ6dGVzdA==",
      });
      assertEquals(r.status, 401);
    });
  });

  // ── 8. WRITE no /portal: rotas POST inexistentes ───────────────────────
  describe("[8] WRITE no /portal: rotas POST não existem (404)", () => {
    it("alice POST /portal/...units/A1/charges → 404 (rota não existe)", async () => {
      const r = await rawPost(
        `/v1/portal/condominiums/${condoA.id}/units/${unitA1.id}/charges`,
        aliceHeaders,
        { description: "hack" },
      );
      assertEquals(r.status, 404);
    });

    it("alice POST /portal/.../assemblies → 404", async () => {
      const r = await rawPost(
        `/v1/portal/condominiums/${condoA.id}/assemblies`,
        aliceHeaders,
        { title: "hack", scheduledAt: "2027-01-01T10:00:00Z", type: "ordinary" },
      );
      assertEquals(r.status, 404);
    });
  });

  // ── 9. POSITIVOS: alice acede ao seu (validar não over-bloqueamos) ─────
  describe("[9] positivos: alice acede aos seus próprios dados", () => {
    it("alice GET /portal/.../units/A1 → 200", async () => {
      const r = await rawGet(
        `/v1/portal/condominiums/${condoA.id}/units/${unitA1.id}`,
        aliceHeaders,
      );
      assertEquals(r.status, 200);
    });

    it("alice GET /portal/.../units/A1/charges → 200, contém CH_A1, NÃO contém CH_A2", async () => {
      const r = await rawGet(
        `/v1/portal/condominiums/${condoA.id}/units/${unitA1.id}/charges`,
        aliceHeaders,
      );
      assertEquals(r.status, 200);
      const data = (r.body as { data: Array<{ id: string }> }).data;
      const ids = data.map((c) => c.id);
      assertEquals(ids.includes(chargeInA1), true);
      assertEquals(ids.includes(chargeInA2), false); // ← vizinho NÃO aparece
    });

    it("alice GET /portal/.../assemblies → 200 (assembleias do condo)", async () => {
      const r = await rawGet(`/v1/portal/condominiums/${condoA.id}/assemblies`, aliceHeaders);
      assertEquals(r.status, 200);
    });

    it("mary (manager A) GET /admin/...A/units → 200", async () => {
      const r = await rawGet(`/v1/admin/condominiums/${condoA.id}/units`, maryHeaders);
      assertEquals(r.status, 200);
    });

    it("super GET /admin/...A/units → 200", async () => {
      const r = await rawGet(`/v1/admin/condominiums/${condoA.id}/units`, SUPER);
      assertEquals(r.status, 200);
    });
  });

  // ── 10. Garantir que alice é REJEITADA em auto-promoção a admin ────────
  describe("[10] alice tenta promover-se a admin", () => {
    it("via PATCH user { isManager:true } → 403 (não é admin, não pode auto-promover)", async () => {
      // Pós-ADR 0002: o endpoint POST /managers desapareceu; o vector
      // equivalente é PATCH user com isManager=true. requireAdminRole
      // interceta antes do handler.
      const r = await rawPatch(
        `/v1/admin/condominiums/${condoA.id}/users/${aliceUserId}`,
        aliceHeaders,
        { isManager: true },
      );
      assertEquals(r.status, 403);
      // Confirma na DB que NÃO foi criada entry de manager para alice
      const count = (await sqlExec(
        `SELECT COUNT(*) FROM core.manager WHERE user_id='${aliceUserId}' AND condominium_id='${condoA.id}'`,
      )).trim();
      assertEquals(count, "0");
    });
  });

  // ── 11. assertRejects via client (ApiError) - confirma error mapping ──
  describe("[11] erros são mapeados como ApiError no client", () => {
    it("alice via client.admin.listUnits → ApiError 403", async () => {
      const e = await assertRejects(
        () =>
          client.admin.listUnits({ headers: { ...aliceHeaders, "x-condominium-id": condoA.id } }),
        ApiError,
      );
      assertEquals(e.statusCode, 403);
    });

    it("alice via client.portal.getUnit(A2) → ApiError 404", async () => {
      const e = await assertRejects(
        () =>
          client.portal.getUnit(unitA2.id, {
            headers: { ...aliceHeaders, "x-condominium-id": condoA.id },
          }),
        ApiError,
      );
      assertEquals(e.statusCode, 404);
    });
  });

  // ── Cleanup ────────────────────────────────────────────────────────────
  afterAll(async () => {
    if (condoA?.id || condoB?.id) {
      const ids = [condoA?.id, condoB?.id].filter(Boolean).map((s) => `'${s}'`).join(",");
      await sqlExec(`DELETE FROM finance.ledger WHERE condominium_id IN (${ids})`).catch(() => {});
      await sqlExec(`DELETE FROM finance.charge WHERE condominium_id IN (${ids})`).catch(() => {});
      await sqlExec(
        `DELETE FROM core.unit_occupant WHERE unit_id IN (SELECT id FROM core.unit WHERE condominium_id IN (${ids}))`,
      ).catch(() => {});
      await sqlExec(`DELETE FROM core.occupant WHERE condominium_id IN (${ids})`).catch(() => {});
      await sqlExec(`DELETE FROM core.manager WHERE condominium_id IN (${ids})`).catch(() => {});
      await sqlExec(`DELETE FROM core.unit WHERE condominium_id IN (${ids})`).catch(() => {});
      await sqlExec(`DELETE FROM core.condominium WHERE id IN (${ids})`).catch(() => {});
    }
    if (aliceUserId) await deleteTestUser(aliceUserId).catch(() => {});
    if (bobUserId) await deleteTestUser(bobUserId).catch(() => {});
    if (maryUserId) await deleteTestUser(maryUserId).catch(() => {});
  });
});
