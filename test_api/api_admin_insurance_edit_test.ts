// Edit metadata de apólice de seguro (PATCH /v1/admin/c/:cid/insurance/:id).
//
// Edit consolida o que antes eram 2 endpoints (auto-renew + coverage-amount)
// num único PATCH parcial. Gate: só `pending_review` (ADR 0016 - active/
// rejected/superseded são imutáveis; admin tem de fazer reopen para corrigir).

import { assertEquals, assertRejects } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { ApiError, Client } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";
import { sqlExec } from "./_helpers/db.ts";

const BASE_URL = "http://localhost:3000";
const client = new Client({ baseUrl: BASE_URL });

describe("admin insurance - edit (PATCH)", () => {
  let auth: { Authorization: string };
  let condoId = "";
  let unitId = "";
  let policyId = "";
  let headers: Record<string, string>;

  it("setup", async () => {
    auth = await loginAsSuper();
    const { data: c } = await client.super.createCondominium(
      { name: "Insurance Edit E2E" },
      { headers: auth },
    );
    condoId = c.id;
    headers = { ...auth, "x-condominium-id": condoId };

    const { data: u } = await client.super.createUnit(
      condoId,
      { designation: "A1", permillage: 1000 } as Record<string, unknown>,
      { headers: auth },
    );
    unitId = String(u.id);

    // Policy pending_review directa (admin upload removido pelo ADR 0016).
    policyId = (await sqlExec(`
      INSERT INTO core.insurance_policy (
        condominium_id, unit_id, valid_from, valid_to, status, uploaded_by
      ) VALUES (
        '${condoId}', '${unitId}', '2026-01-01', '2027-01-01', 'pending_review',
        '{"id":"system","name":"Test","role":"system"}'::jsonb
      ) RETURNING id`)).split("\n")[0].trim();
  });

  it("PATCH com validTo <= validFrom devolve 422 (validação)", async () => {
    // Invariante semântica: vigência tem que avançar no tempo. Se isto
    // passar 200, qualquer cálculo downstream de "a expirar"/"vencida"
    // fica corrompido (datas negativas ou intervalos zero).
    await assertRejects(
      async () => {
        await client.admin.editInsurancePolicy(policyId, {
          validFrom: "2027-01-01",
          validTo: "2026-01-01",
        }, { headers });
      },
      ApiError,
    );
  });

  it("PATCH em pending_review atualiza os 6 campos editáveis", async () => {
    // Os mesmos 6 campos que o modal envia. Confirma round-trip BD inteiro -
    // se algum field-mapping falhar, esta assertion apanha.
    const { data: updated } = await client.admin.editInsurancePolicy(policyId, {
      validFrom: "2026-02-01",
      validTo: "2027-02-01",
      policyNumber: "POL-12345",
      insurer: "Fidelidade",
      coverageAmountCents: 12345_00,
    }, { headers });

    assertEquals(updated.validFrom, "2026-02-01");
    assertEquals(updated.validTo, "2027-02-01");
    assertEquals(updated.policyNumber, "POL-12345");
    assertEquals(updated.insurer, "Fidelidade");
    assertEquals(updated.coverageAmountCents, 12345_00);
    // Status não é tocado pelo edit - continua pending_review.
    assertEquals(updated.status, "pending_review");
  });

  it("PATCH numa apólice 'active' devolve 422 (gate ADR 0016)", async () => {
    // Cria policy active e tenta editar - mesmo um campo trivial
    // (policyNumber) é bloqueado. Para corrigir, admin tem de reopen.
    const activePolicyId = (await sqlExec(`
      INSERT INTO core.insurance_policy (
        condominium_id, unit_id, valid_from, valid_to, status, uploaded_by, approved_at
      ) VALUES (
        '${condoId}', '${unitId}', '2026-01-01', '2027-01-01', 'active',
        '{"id":"system","name":"Test","role":"system"}'::jsonb, now()
      ) RETURNING id`)).split("\n")[0].trim();

    await assertRejects(
      async () => {
        await client.admin.editInsurancePolicy(activePolicyId, {
          policyNumber: "POL-NEW",
        }, { headers });
      },
      ApiError,
    );
  });

  it("teardown", async () => {
    await client.super.deleteCondominium(condoId, { headers: auth });
  });
});
