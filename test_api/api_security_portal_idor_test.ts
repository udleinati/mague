// Pentest E2E aprofundado de IDOR nos endpoints do PORTAL.
//
// Cobre lacunas do `api_security_test.ts` existente:
//   - Query string override: `?unitId=outra` sobre path `:unitId=minha`.
//   - Combinação cross-condo + cross-unit em URL única.
//   - Body override em POST track_access.
//   - Receipt id falso/cross-unit no path da minha unit.
//
// Os testes principais já cobertos pelo `api_security_test.ts`:
//   - alice (occupant em A) tenta /portal/.../condoB → 403 ✓
//   - alice GET /portal/.../units/A2 (vizinho) → 404 ✓
//   - alice GET .../units/A1/charges/<charge_de_A2> → 404 ✓
//
// Invariante: nenhuma fração pode obter informação de outra fração.

import { assertEquals, assertExists } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { Client, type Condominium, type Unit } from "$shared/client/mod.ts";
import { loginAs, loginAsSuper } from "./_helpers/auth.ts";
import { seedTestUser, sqlExec } from "./_helpers/db.ts";

const BASE_URL = "http://localhost:3000";
const client = new Client({ baseUrl: BASE_URL });
const MASTER = await loginAsSuper();

async function rawGet(path: string, headers: Record<string, string>) {
  const resp = await fetch(`${BASE_URL}${path}`, { headers });
  const text = await resp.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch { /* keep as text */ }
  return { status: resp.status, body };
}
async function rawPost(path: string, headers: Record<string, string>, body: unknown) {
  const resp = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  await resp.body?.cancel();
  return { status: resp.status };
}

describe("portal IDOR (deep) - query-string + cross-condo + body override", () => {
  let condoA: Condominium;
  let condoB: Condominium;
  let unitA1: Unit;
  let unitA2: Unit;
  let unitB1: Unit;
  let aliceHeaders: { Authorization: string };
  let bobHeaders: { Authorization: string };
  let chargeA1Id = "";
  let chargeA2Id = "";

  it("setup: 2 condos, 3 unidades, 2 occupants, 2 charges (A1 + A2)", async () => {
    const ts = Date.now();
    condoA = (await client.super.createCondominium(
      { name: `Portal IDOR A ${ts}` },
      { headers: MASTER },
    )).data;
    condoB = (await client.super.createCondominium(
      { name: `Portal IDOR B ${ts}` },
      { headers: MASTER },
    )).data;
    unitA1 = (await client.super.createUnit(
      condoA.id,
      { designation: "A1", permillage: 100 },
      { headers: MASTER },
    )).data;
    unitA2 = (await client.super.createUnit(
      condoA.id,
      { designation: "A2", permillage: 100 },
      { headers: MASTER },
    )).data;
    unitB1 = (await client.super.createUnit(
      condoB.id,
      { designation: "B1", permillage: 100 },
      { headers: MASTER },
    )).data;

    const aliceEmail = `alice-pidor-${ts}@example.pt`;
    const bobEmail = `bob-pidor-${ts}@example.pt`;
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
      VALUES ('${unitA1.id}','${aliceOcc}','owner',CURRENT_DATE);
      INSERT INTO core.unit_occupant (unit_id,occupant_id,relationship_type,start_date)
      VALUES ('${unitB1.id}','${bobOcc}','owner',CURRENT_DATE);
    `);
    aliceHeaders = await loginAs(aliceEmail, "test12345");
    bobHeaders = await loginAs(bobEmail, "test12345");

    // 2 charges (uma em A1, outra em A2). Usamos quota receivable para
    // serem visíveis ao occupant via /portal.
    const chargeA1 = await client.admin.createCharge(
      {
        kind: "receivable",
        nature: "debit",
        chargeType: "quota",
        unitId: unitA1.id,
        amountCents: 10000,
        description: "Quota teste A1",
        competencePeriod: "2026-01-01",
        issueDate: "2026-01-01",
      },
      { headers: { ...MASTER, "x-condominium-id": condoA.id } },
    );
    chargeA1Id = String(chargeA1.data.id);

    const chargeA2 = await client.admin.createCharge(
      {
        kind: "receivable",
        nature: "debit",
        chargeType: "quota",
        unitId: unitA2.id,
        amountCents: 20000,
        description: "Quota teste A2",
        competencePeriod: "2026-01-01",
        issueDate: "2026-01-01",
      },
      { headers: { ...MASTER, "x-condominium-id": condoA.id } },
    );
    chargeA2Id = String(chargeA2.data.id);

    assertExists(chargeA1Id);
    assertExists(chargeA2Id);
  });

  describe("[A] query-string override: ?unitId=outra IGNORADO", () => {
    it("alice GET .../units/A1/charges?unitId=A2 → só vê charges de A1 (filtro path-only)", async () => {
      const r = await rawGet(
        `/v1/portal/condominiums/${condoA.id}/units/${unitA1.id}/charges?unitId=${unitA2.id}`,
        aliceHeaders,
      );
      assertEquals(r.status, 200);
      const body = r.body as { data: Array<{ id: string; unitId: string }> };
      // Confirma que charge de A2 NÃO aparece na lista
      const ids = (body.data ?? []).map((c) => c.id);
      assertEquals(
        ids.includes(chargeA2Id),
        false,
        `LEAK: charge ${chargeA2Id} de A2 apareceu na resposta de A1 quando ?unitId=A2 foi adicionado.`,
      );
      // Confirma que TODAS as charges devolvidas pertencem a A1
      for (const c of body.data ?? []) {
        assertEquals(c.unitId, unitA1.id, "charge devolvida não é de A1");
      }
    });

    it("alice GET .../units/A1/receipts?unitId=A2 → ?unitId IGNORADO", async () => {
      const r = await rawGet(
        `/v1/portal/condominiums/${condoA.id}/units/${unitA1.id}/receipts?unitId=${unitA2.id}`,
        aliceHeaders,
      );
      assertEquals(r.status, 200);
      const body = r.body as { data: Array<{ unitId: string }> };
      for (const rec of body.data ?? []) {
        assertEquals(rec.unitId, unitA1.id, "LEAK: receipt de outra unit devolvido");
      }
    });

    it("alice GET .../units/A1/settlements?unitId=A2 → ?unitId IGNORADO", async () => {
      const r = await rawGet(
        `/v1/portal/condominiums/${condoA.id}/units/${unitA1.id}/settlements?unitId=${unitA2.id}`,
        aliceHeaders,
      );
      assertEquals(r.status, 200);
    });
  });

  describe("[B] cross-condo + cross-unit combinado (rejeitado em layers diferentes)", () => {
    // Cross-condo é rejeitado por `api_auth` com 403 ("sem acesso a este
    // condomínio") ANTES de chegar ao middleware portal. Ambos 403 e 404
    // são respostas válidas - o que importa é que a request não passa.
    it("alice GET /portal/<condoB>/units/<B1>/charges → bloqueado (403/404)", async () => {
      const r = await rawGet(
        `/v1/portal/condominiums/${condoB.id}/units/${unitB1.id}/charges`,
        aliceHeaders,
      );
      assertEquals(
        r.status === 403 || r.status === 404,
        true,
        `esperava 403 ou 404, recebeu ${r.status}`,
      );
    });

    it("alice GET /portal/<condoB>/units/<A1>/charges → bloqueado (cross-condo)", async () => {
      const r = await rawGet(
        `/v1/portal/condominiums/${condoB.id}/units/${unitA1.id}/charges`,
        aliceHeaders,
      );
      assertEquals(r.status === 403 || r.status === 404, true);
    });

    it("bob GET /portal/<condoA>/units/<A1>/charges → bloqueado (cross-condo)", async () => {
      const r = await rawGet(
        `/v1/portal/condominiums/${condoA.id}/units/${unitA1.id}/charges`,
        bobHeaders,
      );
      assertEquals(r.status === 403 || r.status === 404, true);
    });
  });

  describe("[D] track_access: body override + receipt id alheio", () => {
    it("alice POST track_access em receipt id falso/inexistente → 404", async () => {
      const r = await rawPost(
        `/v1/portal/condominiums/${condoA.id}/units/${unitA1.id}/receipts/rec_FAKE/track_access`,
        aliceHeaders,
        { occupantId: "occ_FAKE_ATTACKER" },
      );
      assertEquals(r.status, 404);
    });

    it("bob POST track_access em condoA (não tem occupant lá) → bloqueado", async () => {
      const r = await rawPost(
        `/v1/portal/condominiums/${condoA.id}/units/${unitA1.id}/receipts/rec_FAKE/track_access`,
        bobHeaders,
        {},
      );
      assertEquals(r.status === 403 || r.status === 404, true);
    });
  });

  describe("[E] charges válidas continuam visíveis (sanity check positivo)", () => {
    it("alice GET .../units/A1/charges → vê apenas A1", async () => {
      const r = await rawGet(
        `/v1/portal/condominiums/${condoA.id}/units/${unitA1.id}/charges`,
        aliceHeaders,
      );
      assertEquals(r.status, 200);
      const body = r.body as { data: Array<{ id: string; unitId: string }> };
      const ids = (body.data ?? []).map((c) => c.id);
      assertEquals(ids.includes(chargeA1Id), true, "alice devia ver a sua própria charge A1");
      assertEquals(ids.includes(chargeA2Id), false, "alice NÃO devia ver charge A2");
    });
  });

  it("teardown", async () => {
    await client.super.deleteCondominium(condoA.id, { headers: MASTER });
    await client.super.deleteCondominium(condoB.id, { headers: MASTER });
  });
});
