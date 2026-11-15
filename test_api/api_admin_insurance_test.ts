// Insurance admin flow:
//   • Setup: SQL insert directo de uma policy `pending_review` (ADR 0016
//     removeu admin upload - evidência vem do portal).
//   • Lista units-status devolve a unit com o status agregado correcto.
//   • Approve / reject / reminder.
//
// Os fluxos de upload e confirm (com OCR e form do condómino) vivem agora no
// portal. Este teste foca-se nas operações que continuam no admin: classify,
// approve, reject, reminders.

import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { ApiError, Client } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";
import { sqlExec } from "./_helpers/db.ts";

const BASE_URL = "http://localhost:3000";
const client = new Client({ baseUrl: BASE_URL });

describe("admin insurance - units-status / approve / reject / reminder", () => {
  let auth: { Authorization: string };
  let condoId = "";
  let unitId = "";
  let policyId = "";

  it("setup", async () => {
    auth = await loginAsSuper();
    const { data: c } = await client.super.createCondominium({ name: "Insurance E2E" }, {
      headers: auth,
    });
    condoId = c.id;
    const { data: u } = await client.super.createUnit(
      condoId,
      { designation: "A1", permillage: 1000 } as Record<string, unknown>,
      { headers: auth },
    );
    unitId = String(u.id);

    // Occupant com email para receber lembretes. O tipo de relação vive em
    // `unit_occupant.relationship_type` (ADR 0018).
    await sqlExec(`
      INSERT INTO core.occupant (id, condominium_id, name, email)
      VALUES ('occ_ins_e2e', '${condoId}', 'Occupant E2E', 'occ-ins@test.pt');
      INSERT INTO core.unit_occupant (id, unit_id, occupant_id, relationship_type, start_date)
      VALUES ('uo_ins_e2e', '${unitId}', 'occ_ins_e2e', 'owner', '2025-01-01');
    `);

    // Cria policy `pending_review` diretamente (admin upload removido pelo
    // ADR 0016 - ficheiros vivem em `core.attachment` via portal upload).
    policyId = (await sqlExec(`
      INSERT INTO core.insurance_policy (
        condominium_id, unit_id, valid_from, valid_to, status, uploaded_by
      ) VALUES (
        '${condoId}', '${unitId}', '2026-01-01', '2027-01-01', 'pending_review',
        '{"id":"system","name":"Test","role":"system"}'::jsonb
      ) RETURNING id`)).split("\n")[0].trim();
  });

  it("units-status (sem confirmedAt) → awaiting_confirmation", async () => {
    const headers = { ...auth, "x-condominium-id": condoId };
    const { data } = await client.admin.listInsuranceUnitsStatus({}, { headers });
    const found = data.find((u) => u.unit.id === unitId);
    assertExists(found);
    assertEquals(found.status.kind, "awaiting_confirmation");
  });

  it("após condómino confirmar (SQL direct), units-status → awaiting_approval", async () => {
    // Em produção este UPDATE é feito pelo `confirmInsurancePolicy` portal
    // handler. Aqui simulamos directo para focar no efeito no admin.
    await sqlExec(`
      UPDATE core.insurance_policy
         SET confirmed_at = now(),
             confirmed_by = '{"id":"sys"}'::jsonb,
             policy_number = 'POL-0030',
             insurer = 'Fidelidade'
       WHERE id = '${policyId}'`);

    const headers = { ...auth, "x-condominium-id": condoId };
    const { data } = await client.admin.listInsuranceUnitsStatus({}, { headers });
    const found = data.find((u) => u.unit.id === unitId)!;
    assertEquals(found.status.kind, "awaiting_approval");
  });

  it("approve ativa a apólice", async () => {
    const headers = { ...auth, "x-condominium-id": condoId };
    const { data, status } = await client.admin.approveInsurancePolicy(
      policyId,
      { headers },
    );
    assertEquals(status, 200);
    assertEquals((data as { status?: string }).status, "active");
  });

  it("listInsurancePolicies - inclui a apólice ativa", async () => {
    const headers = { ...auth, "x-condominium-id": condoId };
    const { data, status } = await client.admin.listInsurancePolicies({}, { headers });
    assertEquals(status, 200);
    const found = data.find((p) => (p as { id?: string }).id === policyId);
    assertEquals((found as { status?: string })?.status, "active");
  });

  it("listInsurancePolicies - filtro por status=active funciona", async () => {
    const headers = { ...auth, "x-condominium-id": condoId };
    const { data } = await client.admin.listInsurancePolicies(
      { status: "active" },
      { headers },
    );
    for (const p of data) {
      assertEquals((p as { status?: string }).status, "active");
    }
  });

  it("getInsurancePolicy - devolve detalhes da apólice", async () => {
    const headers = { ...auth, "x-condominium-id": condoId };
    const { data, status } = await client.admin.getInsurancePolicy(
      policyId,
      { headers },
    );
    assertEquals(status, 200);
    assertEquals((data as { id?: string }).id, policyId);
    assertEquals((data as { status?: string }).status, "active");
    assertEquals((data as { insurer?: string }).insurer, "Fidelidade");
  });

  it("units-status agora marca como active", async () => {
    const headers = { ...auth, "x-condominium-id": condoId };
    const { data } = await client.admin.listInsuranceUnitsStatus({}, { headers });
    const found = data.find((u) => u.unit.id === unitId)!;
    assertEquals(found.status.kind, "active");
  });

  it("reject sem reason devolve 400", async () => {
    // Cria 2ª policy em pending_review (a 1ª está active e não pode ser
    // rejeitada). Mesmo padrão SQL-direct do setup.
    const newPolicyId = (await sqlExec(`
      INSERT INTO core.insurance_policy (
        condominium_id, unit_id, valid_from, valid_to, status, uploaded_by
      ) VALUES (
        '${condoId}', '${unitId}', '2026-06-01', '2027-06-01', 'pending_review',
        '{"id":"system"}'::jsonb
      ) RETURNING id`)).split("\n")[0].trim();

    const headers = { ...auth, "x-condominium-id": condoId };
    const e = await assertRejects(
      () => client.admin.rejectInsurancePolicy(newPolicyId, { reason: "" }, { headers }),
      ApiError,
    );
    assertEquals(e.statusCode, 400);
  });

  it("send reminder bulk → envia para occupants das units sem seguro", async () => {
    // Cria 2ª unit sem policy para forçar status 'never_submitted'.
    const { data: u2 } = await client.super.createUnit(
      condoId,
      { designation: "B2", permillage: 500 } as Record<string, unknown>,
      { headers: auth },
    );
    await sqlExec(`
      INSERT INTO core.occupant (id, condominium_id, name, email)
      VALUES ('occ_ins_e2e2', '${condoId}', 'Occ B2', 'occ-b2@test.pt');
      INSERT INTO core.unit_occupant (id, unit_id, occupant_id, relationship_type, start_date)
      VALUES ('uo_ins_e2e2', '${u2.id}', 'occ_ins_e2e2', 'owner', '2025-01-01');
    `);

    const headers = { ...auth, "x-condominium-id": condoId };
    const { data, status } = await client.admin.sendInsuranceRemindersBulk({ headers });
    assertEquals(status, 200);
    assertEquals(data.unitsTargeted >= 1, true);
  });

  it("reminder individual cria row em insurance_reminder", async () => {
    const headers = { ...auth, "x-condominium-id": condoId };
    const { status } = await client.admin.sendInsuranceReminder(unitId, { headers });
    assertEquals(status, 200);
    const count = await sqlExec(`
      SELECT count(*)::text FROM core.insurance_reminder
      WHERE unit_id='${unitId}' AND trigger='individual'
    `);
    assertEquals(count >= "1", true);
  });

  it("teardown", async () => {
    await sqlExec(`
      DELETE FROM core.insurance_reminder WHERE condominium_id='${condoId}';
      DELETE FROM core.insurance_policy WHERE condominium_id='${condoId}';
      DELETE FROM core.unit_occupant WHERE id IN ('uo_ins_e2e','uo_ins_e2e2');
      DELETE FROM core.occupant WHERE id IN ('occ_ins_e2e','occ_ins_e2e2');
    `);
    await client.super.deleteCondominium(condoId, { headers: auth });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Bulk reminders edge cases (skippedNoEmail, status filtering, perUnit)
// ═══════════════════════════════════════════════════════════════════════════
// O describe acima cobre o happy path (1 unit sem seguro recebe reminder).
// Aqui validamos os edge cases do response shape do bulk:
//   - units com policy active NÃO são targeted
//   - units sem occupant com email vão para `skippedNoEmail`
//   - `perUnit` regista cada target com sent/failed/skipped
//   - condo com TODAS as units active devolve unitsTargeted=0

describe("admin insurance - bulk reminders edge cases", () => {
  let auth: { Authorization: string };
  let condoId = "";
  // 4 units que cobrem combinações de status + email:
  //   uA = active (owner com email) → não conta
  //   uB = expired (owner com email) → recebe
  //   uC = sem policy (sem occupant) → skippedNoEmail
  //   uD = sem policy (owner SEM email) → skippedNoEmail
  let uA = "", uB = "", uC = "", uD = "";
  // IDs únicos por run para sobreviver a teardowns falhados em runs anteriores.
  const ts = Date.now();
  const oA = `o_bulk_a_${ts}`, oB = `o_bulk_b_${ts}`, oD = `o_bulk_d_${ts}`;
  const uoA = `uo_bulk_a_${ts}`, uoB = `uo_bulk_b_${ts}`, uoD = `uo_bulk_d_${ts}`;
  const polA = `pol_bulk_a_${ts}`,
    polB = `pol_bulk_b_${ts}`,
    polC = `pol_bulk_c_${ts}`,
    polD = `pol_bulk_d_${ts}`;

  it("setup: 4 units com status diferentes", async () => {
    auth = await loginAsSuper();
    const { data: c } = await client.super.createCondominium(
      { name: `Insurance Bulk Edge ${ts}` },
      { headers: auth },
    );
    condoId = c.id;

    const create = async (designation: string, perm: number) =>
      String(
        (await client.super.createUnit(
          condoId,
          { designation, permillage: perm } as Record<string, unknown>,
          { headers: auth },
        )).data.id,
      );
    uA = await create("UA", 250);
    uB = await create("UB", 250);
    uC = await create("UC", 250);
    uD = await create("UD", 250);

    // Owners + occupants:
    //   uA tem owner com email
    //   uB tem owner com email
    //   uC sem occupant
    //   uD tem owner sem email
    await sqlExec(`
      INSERT INTO core.occupant (id, condominium_id, name, email) VALUES
        ('${oA}', '${condoId}', 'Owner A', 'a@example.pt'),
        ('${oB}', '${condoId}', 'Owner B', 'b@example.pt'),
        ('${oD}', '${condoId}', 'Owner D', NULL);
      INSERT INTO core.unit_occupant (id, unit_id, occupant_id, relationship_type, start_date) VALUES
        ('${uoA}', '${uA}', '${oA}', 'owner', '2025-01-01'),
        ('${uoB}', '${uB}', '${oB}', 'owner', '2025-01-01'),
        ('${uoD}', '${uD}', '${oD}', 'owner', '2025-01-01');
    `);

    // uA: policy active válida (não conta para reminder)
    // uB: policy active mas expired (validTo no passado).
    // A apólice não tem `storage_key` (ficheiros vivem em
    // `core.attachment`). `valid_from` é NOT NULL.
    await sqlExec(`
      INSERT INTO core.insurance_policy
        (id, condominium_id, unit_id, status, valid_from, valid_to, uploaded_by) VALUES
        ('${polA}', '${condoId}', '${uA}', 'active', '2025-01-01', '2099-12-31',
         '{"id":"sys","name":"sys","email":null}'::jsonb),
        ('${polB}', '${condoId}', '${uB}', 'active', '2019-01-01', '2020-01-01',
         '{"id":"sys","name":"sys","email":null}'::jsonb);
    `);
  });

  it("bulk → unitsTargeted=3 (uB expired + uC missing + uD missing); uA não conta", async () => {
    const headers = { ...auth, "x-condominium-id": condoId };
    const { data, status } = await client.admin.sendInsuranceRemindersBulk({ headers });
    assertEquals(status, 200);
    // 3 units precisam de cobrança: B (expired), C+D (sem policy).
    assertEquals(data.unitsTargeted, 3);
  });

  it("bulk → skippedNoEmail contém UC e UD (sem owner com email)", async () => {
    // Reset cooldown: bulk anterior criou rows em insurance_reminder com
    // sent_at = now(). Limpar para que esta chamada veja os mesmos targets.
    await sqlExec(`DELETE FROM core.insurance_reminder WHERE condominium_id='${condoId}'`);
    const headers = { ...auth, "x-condominium-id": condoId };
    const { data } = await client.admin.sendInsuranceRemindersBulk({ headers });
    const skipped = data.skippedNoEmail ?? [];
    // Lista contém designations das units saltadas.
    assertEquals(
      skipped.includes("UC"),
      true,
      `UC esperado em skippedNoEmail, got: ${skipped.join(",")}`,
    );
    assertEquals(
      skipped.includes("UD"),
      true,
      `UD esperado em skippedNoEmail, got: ${skipped.join(",")}`,
    );
    assertEquals(
      skipped.includes("UA"),
      false,
      "UA não devia estar em skipped (tem policy active)",
    );
    assertEquals(skipped.includes("UB"), false, "UB tem owner com email, não é skipped");
  });

  it("bulk → perUnit regista todas as 3 targets com sent/failed/skipped", async () => {
    await sqlExec(`DELETE FROM core.insurance_reminder WHERE condominium_id='${condoId}'`);
    const headers = { ...auth, "x-condominium-id": condoId };
    const { data } = await client.admin.sendInsuranceRemindersBulk({ headers });
    const perUnit = data.perUnit as Array<
      { unitId: string; designation: string; sent: number; failed: number; skipped?: string }
    >;
    assertEquals(perUnit.length, 3);

    const ub = perUnit.find((p) => p.designation === "UB");
    const uc = perUnit.find((p) => p.designation === "UC");
    const ud = perUnit.find((p) => p.designation === "UD");
    assertExists(ub);
    assertExists(uc);
    assertExists(ud);

    // UB foi tentada (sent ≥ 0; failed pode ser ≥ 0 se SMTP falha).
    // UC e UD foram skipped (sem email para enviar).
    assertExists(uc.skipped);
    assertExists(ud.skipped);
  });

  it("bulk → todas as units com policy active devolve unitsTargeted=0", async () => {
    // Marcar policies das units alvo como active para neutralizar o estado.
    // uB: extender validTo para futuro.
    // uC, uD: criar policy active.
    await sqlExec(`
      UPDATE core.insurance_policy SET valid_to='2099-12-31' WHERE id='${polB}';
      INSERT INTO core.insurance_policy
        (id, condominium_id, unit_id, status, valid_from, valid_to, uploaded_by) VALUES
        ('${polC}', '${condoId}', '${uC}', 'active', '2025-01-01', '2099-12-31',
         '{"id":"sys","name":"sys","email":null}'::jsonb),
        ('${polD}', '${condoId}', '${uD}', 'active', '2025-01-01', '2099-12-31',
         '{"id":"sys","name":"sys","email":null}'::jsonb);
    `);

    const headers = { ...auth, "x-condominium-id": condoId };
    const { data, status } = await client.admin.sendInsuranceRemindersBulk({ headers });
    assertEquals(status, 200);
    assertEquals(data.unitsTargeted, 0);
    assertEquals(data.sent, 0);
    assertEquals(data.failed, 0);
    assertEquals((data.perUnit as unknown[]).length, 0);
  });

  it("teardown", async () => {
    await sqlExec(`
      DELETE FROM core.insurance_reminder WHERE condominium_id='${condoId}';
      DELETE FROM core.insurance_policy WHERE condominium_id='${condoId}';
      DELETE FROM core.unit_occupant WHERE id IN ('${uoA}','${uoB}','${uoD}');
      DELETE FROM core.occupant WHERE id IN ('${oA}','${oB}','${oD}');
    `);
    await client.super.deleteCondominium(condoId, { headers: auth });
  });
});
