// E2E security: cross-tenant IDOR no scope de fração do admin (regressão).
//
// Threat model: handlers sob `/admin/condominiums/:cid/units/:unitId/...`
// que carreguem fração/ocupante por id/unitId sem o cruzar com o `:cid`
// (`requireAdminRole` só valida o cid) permitem a um manager ativo só do
// condo A ler ocupantes, apagar ocupantes e apagar frações do condo B.
// Defesa: middleware `requireUnitInCondo` → 404 / sem fuga.
//
// Fixtures `secdel*` criadas e apagadas pelo próprio teste; não dependem do
// seed nem tocam em dados existentes. Requer a API em :3000.

import { assert, assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { loginAs } from "./_helpers/auth.ts";
import { deleteTestUser, seedTestUser, sqlExec } from "./_helpers/db.ts";

const BASE_URL = "http://localhost:3000";

const A = "secdelA"; // condomínio do atacante
const B = "secdelB"; // condomínio vítima
const UA = "secdelUA"; // fração de A (controlo)
const UB = "secdelUB"; // fração de B (alvo do delete de fração)
const UB2 = "secdelUB2"; // fração de B (alvo dos testes de ocupante)
const OCC = "secdelOccB"; // ocupante de B
const OCC_NAME = "Vitima Cross Tenant B"; // PII que NÃO deve vazar para admin de A
const UO = "secdelUOB"; // unit_occupant de B (liga OCC a UB2)
const MGR = "usr_secdel_mgr";
const MGR_EMAIL = "secdel_mgr@test.invalid";
const MGR_PASS = "secdel-pass-12345";

async function cleanup() {
  await sqlExec(`DELETE FROM core.unit_occupant WHERE unit_id IN ('${UA}','${UB}','${UB2}')`)
    .catch(() => {});
  await sqlExec(`DELETE FROM core.occupant WHERE condominium_id IN ('${A}','${B}')`).catch(
    () => {},
  );
  await sqlExec(
    `DELETE FROM core.manager WHERE condominium_id IN ('${A}','${B}') OR user_id='${MGR}'`,
  )
    .catch(() => {});
  await sqlExec(`DELETE FROM core.unit WHERE condominium_id IN ('${A}','${B}')`).catch(() => {});
  await sqlExec(`DELETE FROM core.condominium WHERE id IN ('${A}','${B}')`).catch(() => {});
  await deleteTestUser(MGR).catch(() => {});
}

describe("security - cross-tenant no scope de fração do admin", () => {
  let mgr: { Authorization: string };

  it("setup", async () => {
    await cleanup(); // idempotente
    await sqlExec(
      `INSERT INTO core.condominium (id, name) VALUES ('${A}','SEC Del A'),('${B}','SEC Del B')`,
    );
    await sqlExec(
      `INSERT INTO core.unit (id, condominium_id, designation, permillage) VALUES
         ('${UA}','${A}','UA',100),('${UB}','${B}','UB',100),('${UB2}','${B}','UB2',100)`,
    );
    await sqlExec(
      `INSERT INTO core.occupant (id, condominium_id, name) VALUES ('${OCC}','${B}','${OCC_NAME}')`,
    );
    await sqlExec(
      `INSERT INTO core.unit_occupant (id, unit_id, occupant_id, start_date)
       VALUES ('${UO}','${UB2}','${OCC}', CURRENT_DATE)`,
    );
    await seedTestUser({ id: MGR, email: MGR_EMAIL, password: MGR_PASS });
    await sqlExec(
      `INSERT INTO core.manager (condominium_id, user_id, is_active) VALUES ('${A}','${MGR}',true)`,
    );
    mgr = await loginAs(MGR_EMAIL, MGR_PASS);
  });

  it("LEITURA: admin de A lista ocupantes de fração de B -> não deve vazar a relação", async () => {
    // A projeção de unit_occupant expõe occupantId + tipo de relação + datas (não
    // o nome). Cross-tenant, nada disto devia aparecer: esperado 404 ou lista vazia.
    const res = await fetch(`${BASE_URL}/v1/admin/condominiums/${A}/units/${UB2}/occupants`, {
      headers: { ...mgr },
    });
    const status = res.status;
    const text = await res.text();
    assert(
      !text.includes(OCC) && !text.includes(UO),
      `VULN cross-tenant (leitura): admin do condo A listou unit_occupant (occupantId=${OCC}) ` +
        `de fração do condo B (HTTP ${status}): ${text.slice(0, 160)}`,
    );
  });

  it("controlo: admin de A lista ocupantes da SUA fração -> 200 (legítimo não é bloqueado)", async () => {
    const res = await fetch(`${BASE_URL}/v1/admin/condominiums/${A}/units/${UA}/occupants`, {
      headers: { ...mgr },
    });
    const status = res.status;
    await res.body?.cancel();
    assertEquals(
      status,
      200,
      `middleware bloqueou acesso legítimo à própria fração (HTTP ${status})`,
    );
  });

  it("DELETE ocupante: admin de A apaga ocupante de fração de B -> 404, ocupante intacto", async () => {
    const res = await fetch(
      `${BASE_URL}/v1/admin/condominiums/${A}/units/${UB2}/occupants/${UO}`,
      { method: "DELETE", headers: { ...mgr } },
    );
    const status = res.status;
    await res.body?.cancel();
    const deletedAt = await sqlExec(
      `SELECT COALESCE(deleted_at::text,'NULL') FROM core.unit_occupant WHERE id='${UO}'`,
    );
    assert(
      status === 404 || status === 403,
      `VULN cross-tenant: admin do condo A apagou ocupante de fração do condo B (HTTP ${status})`,
    );
    assertEquals(
      deletedAt,
      "NULL",
      `VULN cross-tenant: unit_occupant do condo B soft-deleted por admin do condo A (deleted_at=${deletedAt})`,
    );
  });

  it("DELETE fração: admin de A apaga fração de B -> 404, fração intacta", async () => {
    const res = await fetch(`${BASE_URL}/v1/admin/condominiums/${A}/units/${UB}`, {
      method: "DELETE",
      headers: { ...mgr },
    });
    const status = res.status;
    await res.body?.cancel();
    const deletedAt = await sqlExec(
      `SELECT COALESCE(deleted_at::text,'NULL') FROM core.unit WHERE id='${UB}'`,
    );
    assert(
      status === 404 || status === 403,
      `VULN cross-tenant: admin do condo A apagou fração do condo B (HTTP ${status})`,
    );
    assertEquals(
      deletedAt,
      "NULL",
      `VULN cross-tenant: fração do condo B soft-deleted por admin do condo A (deleted_at=${deletedAt})`,
    );
  });

  it("controlo: admin de A apaga a SUA fração -> 204 (setup é válido)", async () => {
    const res = await fetch(`${BASE_URL}/v1/admin/condominiums/${A}/units/${UA}`, {
      method: "DELETE",
      headers: { ...mgr },
    });
    const status = res.status;
    await res.body?.cancel();
    assertEquals(status, 204, `esperava 204 ao apagar a própria fração de A, veio ${status}`);
  });

  it("cleanup", async () => {
    await cleanup();
  });
});
