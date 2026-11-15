// Regressão: occupants estão bloqueados de endpoints admin do insurance.
//
// Contexto histórico (relevante para futuros refactors):
//
// `insurance/_helpers.ts` tinha `userCanAccessUnit(postgres, userId, unitId)`
// - duplicado partido do `assertUserCanAccessUnit` em `libs/shared`. Bug:
// usava `with: { occupant: { where, columns } }` numa relation `one`, mas
// Drizzle ignora `where` em relations `one` → o filtro `userId` nunca era
// aplicado e a função devolvia true para qualquer occupant na unit,
// permitindo (em teoria) que um occupant da unit A confirmasse apólices
// da unit B.
//
// Na prática nunca foi exploitável: o middleware `requireAdminRole`
// bloqueia role=occupant em `/v1/admin/*` antes de qualquer handler correr.
// Mas o código morto + erro TS pré-existente justificaram a remoção; o
// caminho correcto via `assertUserCanAccessUnit` (libs/shared) ficou para
// o caso de o middleware vir a abrir excepções no futuro.
//
// Este teste guarda a invariante: ocupant não passa o middleware para
// nenhum endpoint admin de insurance. Se alguém alguma vez relaxar o
// middleware para "occupant write in own unit", isto falha e força revisão.

import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { Client, type Condominium, type Unit } from "$shared/client/mod.ts";
import { loginAs, loginAsSuper } from "./_helpers/auth.ts";
import { seedTestUser, sqlExec } from "./_helpers/db.ts";

const BASE_URL = "http://localhost:3000";
const client = new Client({ baseUrl: BASE_URL });
const MASTER = await loginAsSuper();

async function rawRequest(
  path: string,
  init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string },
) {
  const resp = await fetch(`${BASE_URL}${path}`, {
    method: init.method,
    headers: init.body ? { ...init.headers, "Content-Type": "application/json" } : init.headers,
    body: init.body,
  });
  await resp.body?.cancel();
  return resp.status;
}

describe("insurance admin endpoints - occupant gate", () => {
  let condo: Condominium;
  let unitA: Unit;
  let policyId = "";
  let aliceHeaders: { Authorization: string };
  const aliceUserIdRef = { id: "" };
  const aliceOccupantIdRef = { id: "" };

  it("setup: condo + unitA + occupant Alice + 1 apólice na unitA", async () => {
    const ts = Date.now();

    condo = (await client.super.createCondominium(
      { name: `Insurance gate ${ts}` },
      { headers: MASTER },
    )).data;

    unitA = (await client.super.createUnit(
      condo.id,
      { designation: "A", permillage: 1000 },
      { headers: MASTER },
    )).data;

    const aliceEmail = `alice-ins-${ts}@example.pt`;
    aliceUserIdRef.id = await seedTestUser({
      email: aliceEmail,
      password: "test12345",
      name: "Alice",

      active: true,
    });

    aliceOccupantIdRef.id = (await sqlExec(`
      INSERT INTO core.occupant (user_id, name, email, condominium_id)
      VALUES ('${aliceUserIdRef.id}', 'Alice', '${aliceEmail}', '${condo.id}')
      RETURNING id`)).split("\n")[0].trim();

    await sqlExec(`
      INSERT INTO core.unit_occupant (unit_id, occupant_id, relationship_type, start_date)
      VALUES ('${unitA.id}', '${aliceOccupantIdRef.id}', 'owner', CURRENT_DATE)`);

    // A apólice não tem `storage_key` (ficheiros em `core.attachment`).
    // `valid_from`/`valid_to` são NOT NULL.
    policyId = (await sqlExec(`
      INSERT INTO core.insurance_policy (
        condominium_id, unit_id, valid_from, valid_to, status, uploaded_by
      ) VALUES (
        '${condo.id}', '${unitA.id}', '2026-01-01', '2027-01-01', 'pending_review',
        '{"id":"system","name":"Test","role":"system"}'::jsonb
      ) RETURNING id`)).split("\n")[0].trim();

    aliceHeaders = await loginAs(aliceEmail, "test12345");
  });

  // POST .../insurance/:id/confirm não existe no admin (ADR 0016 -
  // confirm vive só no portal). Não testamos 403 numa rota que não
  // existe; o IDOR para confirm está coberto no portal test.

  it("Alice (occupant) → GET .../insurance/:id/pdf → 403", async () => {
    const status = await rawRequest(
      `/v1/admin/condominiums/${condo.id}/insurance/${policyId}/pdf`,
      { method: "GET", headers: aliceHeaders },
    );
    assertEquals(status, 403);
  });

  it("Alice (occupant) → GET .../insurance (lista) → 403", async () => {
    const status = await rawRequest(
      `/v1/admin/condominiums/${condo.id}/insurance`,
      { method: "GET", headers: aliceHeaders },
    );
    assertEquals(status, 403);
  });

  it("Super → POST .../insurance/:id/approve → 200 (gate só fecha para occupant)", async () => {
    // Marca a policy como confirmada para ser aprovável (admin approve só
    // funciona após condómino ter confirmado). Em produção este UPDATE é
    // feito pelo portal `confirmInsurancePolicy` handler.
    await sqlExec(`
      UPDATE core.insurance_policy
         SET confirmed_at = now(),
             confirmed_by = '{"id":"sys"}'::jsonb,
             policy_number = 'POL-IDOR',
             insurer = 'Fidelidade'
       WHERE id = '${policyId}'`);

    // body `{}` vazio mas com Content-Type - `approve` não exige body mas o
    // server rejeita com 415 se falta o header em POST.
    const status = await rawRequest(
      `/v1/admin/condominiums/${condo.id}/insurance/${policyId}/approve`,
      { method: "POST", headers: MASTER, body: "{}" },
    );
    assertEquals(status, 200);
  });

  it("teardown", async () => {
    await sqlExec(`DELETE FROM core.insurance_policy WHERE id = '${policyId}'`);
    await sqlExec(`DELETE FROM core.unit_occupant WHERE occupant_id = '${aliceOccupantIdRef.id}'`);
    await sqlExec(`DELETE FROM core.occupant WHERE id = '${aliceOccupantIdRef.id}'`);
    await sqlExec(`DELETE FROM core."user" WHERE id = '${aliceUserIdRef.id}'`);
    await client.super.deleteCondominium(condo.id, { headers: MASTER });
  });
});
