// Contrato HTTP dos Lembretes de cobrança (admin, ADR 0028/0039).
//
// Dois caminhos:
//   1. GUARD - condo nunca reconciliado: overdue devolve guard não-ok;
//      preview/send falham 422 (RECONCILIATION_NEVER) antes de qualquer envio.
//   2. HAPPY - condo reconciliado (reconciled_through_date) + owner com email:
//      preview devolve o HTML do email; send resolve o destinatário e dispara.
//
// Pré-requisitos: stack de pé (inclui mailpit) + DB com super@mague.pt. Correr:
//   deno test --allow-net --allow-read --allow-env --allow-run test_api/api_admin_billing_reminder_test.ts

import { assertEquals, assertRejects } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { ApiError, Client } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";
import { type ScenarioFixture, seedScenario } from "./_helpers/fixtures.ts";
import { sqlExec } from "./_helpers/db.ts";

const BASE_URL = "http://localhost:3000";
const client = new Client({ baseUrl: BASE_URL });
const MASTER = await loginAsSuper();

describe("admin billing reminders - guard (condo não reconciliado)", () => {
  let fx: ScenarioFixture;
  let unitId = "";
  const hdr = () => fx.hdr();

  it("setup - condo + unit", async () => {
    fx = await seedScenario(client, MASTER)
      .withCondo("BillingReminder Guard")
      .withUnit({ designation: "A", permillage: 1000 })
      .build();
    unitId = fx.units[0].id;
  });

  it("listBillingOverdueUnits - sem reconciliação: guard não-ok, sem unidades", async () => {
    const { data, status } = await client.admin.listBillingOverdueUnits({}, { headers: hdr() });
    assertEquals(status, 200);
    assertEquals(data.reconciledThroughDate, null);
    assertEquals(data.guard.ok, false);
    assertEquals(data.units, []);
  });

  it("previewBillingReminder - sem reconciliação → 422", async () => {
    const e = await assertRejects(
      () => client.admin.previewBillingReminder(unitId, { headers: hdr() }),
      ApiError,
    );
    assertEquals(e.statusCode, 422); // RECONCILIATION_NEVER
  });

  it("sendBillingReminder - sem reconciliação → 422", async () => {
    const e = await assertRejects(
      () => client.admin.sendBillingReminder(unitId, {}, { headers: hdr() }),
      ApiError,
    );
    assertEquals(e.statusCode, 422); // RECONCILIATION_NEVER
  });

  it("anti-IDOR - overdue de outro condo não inclui a fração do condo A", async () => {
    const fxB = await seedScenario(client, MASTER).withCondo("BillingReminder Guard B").build();
    const { data } = await client.admin.listBillingOverdueUnits({}, { headers: fxB.hdr() });
    assertEquals(data.units.some((u) => u.unitId === unitId), false);
    await fxB.cleanup();
  });

  it("cleanup", async () => {
    await fx.cleanup();
  });
});

describe("admin billing reminders - happy path (reconciliado)", () => {
  let fx: ScenarioFixture;
  let unitId = "";
  const hdr = () => fx.hdr();

  it("setup - condo + unit + owner com email, marca condo como reconciliado hoje", async () => {
    fx = await seedScenario(client, MASTER)
      .withCondo("BillingReminder Happy")
      .withUnit({ designation: "A", permillage: 1000 })
      .withOccupant({
        name: "Dona Ana",
        email: "ana@billing.test",
        unitDesignation: "A",
        relationshipType: "owner",
      })
      .build();
    unitId = fx.units[0].id;
    // Conciliação fresca (hoje) → guard ok.
    await sqlExec(
      `UPDATE core.condominium SET reconciled_through_date = CURRENT_DATE WHERE id = '${fx.condominium.id}'`,
    );
  });

  it("listBillingOverdueUnits - com reconciliação fresca: guard ok", async () => {
    const { data } = await client.admin.listBillingOverdueUnits({}, { headers: hdr() });
    assertEquals(data.reconciledThroughDate !== null, true);
    assertEquals(data.guard.ok, true);
  });

  it("previewBillingReminder - devolve HTML do email com o nome do condomínio", async () => {
    const { data, status } = await client.admin.previewBillingReminder(unitId, { headers: hdr() });
    assertEquals(status, 200);
    assertEquals(typeof data.html, "string");
    assertEquals(data.html.includes("BillingReminder Happy"), true);
    // O modal mostra o assunto com que o email sai.
    assertEquals(data.subject, "Quotas em atraso - BillingReminder Happy, fração A");
  });

  it("sendBillingReminder - resolve o owner e dispara (1 destinatário)", async () => {
    const { data, status } = await client.admin.sendBillingReminder(unitId, {}, { headers: hdr() });
    assertEquals(status, 200);
    assertEquals(data.totalRecipients, 1);
    assertEquals(data.recipients[0].email, "ana@billing.test");
  });

  it("cleanup", async () => {
    await fx.cleanup();
  });
});

// Fração em plano de pagamento (ADR 0039): o envio
// individual manda a variante de plano (assunto + termos + pendentes), não o
// email de valores em atraso.
describe("admin billing reminders - fração em plano de pagamento", () => {
  let fx: ScenarioFixture;
  let unitId = "";
  const hdr = () => fx.hdr();
  const PLAN_NOTES = "Prestações de 50 € até ao fim do ano";
  const INTERNAL_NOTES = "NOTA-INTERNA: não confiar, já falhou duas vezes";

  it("setup - owner com email, condo reconciliado, plano ativo com data final", async () => {
    fx = await seedScenario(client, MASTER)
      .withCondo("BillingReminder Plano")
      .withUnit({ designation: "A", permillage: 1000 })
      .withOccupant({
        name: "Dona Rosa",
        email: "rosa@billing.test",
        unitDesignation: "A",
        relationshipType: "owner",
      })
      .build();
    unitId = fx.units[0].id;
    await sqlExec(
      `UPDATE core.condominium SET reconciled_through_date = CURRENT_DATE WHERE id = '${fx.condominium.id}'`,
    );
    await client.admin.createPaymentPlan(
      unitId,
      { notes: PLAN_NOTES, internalNotes: INTERNAL_NOTES, endDate: "2026-12-31" },
      { headers: hdr() },
    );
  });

  it("preview - variante de plano com os termos e a data final", async () => {
    const { data } = await client.admin.previewBillingReminder(unitId, { headers: hdr() });
    assertEquals(data.html.includes("tem um plano de pagamento em curso"), true);
    assertEquals(data.html.includes(PLAN_NOTES), true);
    assertEquals(data.html.includes("31/12/2026"), true);
    assertEquals(data.html.includes("tem valores em atraso"), false);
    // A nota interna nunca chega ao email.
    assertEquals(data.html.includes("NOTA-INTERNA"), false);
    assertEquals(
      data.subject,
      "Plano de pagamento: valores pendentes - BillingReminder Plano, fração A",
    );
  });

  it("send - o email gravado tem o assunto do plano", async () => {
    const { data } = await client.admin.sendBillingReminder(unitId, {}, { headers: hdr() });
    assertEquals(data.recipients[0].status, "sent");
    const subject = await sqlExec(
      `SELECT subject FROM audit.email_log WHERE unit_id = '${unitId}' AND category = 'billing_reminder' ORDER BY created_at DESC LIMIT 1`,
    );
    assertEquals(
      subject,
      "Plano de pagamento: valores pendentes - BillingReminder Plano, fração A",
    );
    // O corpo gravado é o que foi enviado: tem a partilhada, nunca a interna.
    const body = await sqlExec(
      `SELECT body_html FROM audit.email_log WHERE unit_id = '${unitId}' AND category = 'billing_reminder' ORDER BY created_at DESC LIMIT 1`,
    );
    assertEquals(body.includes(PLAN_NOTES), true);
    assertEquals(body.includes("NOTA-INTERNA"), false);
  });

  it("cleanup", async () => {
    await fx.cleanup();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Gatilho: qualquer dívida, não só quota (ADR 0028).
// Regressão: o total em atraso do painel era superior ao da página de
// lembretes. As frações em falta deviam quotas extraordinárias ou
// refaturações e nunca disparavam - invisíveis na lista E fora do total.
// ─────────────────────────────────────────────────────────────────────────────

describe("admin billing reminders - gatilho por qualquer dívida", () => {
  let fx: ScenarioFixture;
  const hdr = () => fx.hdr();

  it("setup - condo reconciliado hoje, 1 fração sem nenhuma quota", async () => {
    fx = await seedScenario(client, MASTER)
      .withCondo("BillingReminder Trigger")
      .withUnit({ designation: "A", permillage: 1000 })
      .build();
    await sqlExec(
      `UPDATE core.condominium SET reconciled_through_date = CURRENT_DATE WHERE id = '${fx.condominium.id}'`,
    );
  });

  it("sem dívida nenhuma, a fração não aparece", async () => {
    const { data } = await client.admin.listBillingOverdueUnits(
      { overdue: 1 },
      { headers: hdr() },
    );
    assertEquals(data.units.length, 0);
  });

  it("refaturação vencida faz a fração aparecer, sem nenhuma quota em dívida", async () => {
    const stamp = Date.now().toString(36).toUpperCase();
    const { data: acc } = await client.admin.createChartOfAccount(
      { code: `REF_${stamp}`, name: "Reparação imputável", type: "expense", parentCode: "5" },
      { headers: hdr() },
    );
    const ontem = new Date();
    ontem.setUTCDate(ontem.getUTCDate() - 5);
    const venc = ontem.toISOString().slice(0, 10);

    const { data: source } = await client.admin.createCharge(
      {
        kind: "payable",
        chargeType: "supplier_service",
        description: "Reparação da fração A",
        issueDate: venc,
        dueDate: venc,
        competencePeriod: `${venc.slice(0, 7)}-01`,
        amountCents: 150_00,
        accountId: acc.id as string,
      },
      { headers: hdr() },
    );
    await client.admin.createRefacturations(
      String(source.id),
      {
        allocations: [{ unitId: fx.units[0].id, amountCents: 150_00 }],
        issueDate: venc,
        dueDate: venc,
      },
      { headers: hdr() },
    );

    const { data } = await client.admin.listBillingOverdueUnits({ overdue: 1 }, { headers: hdr() });
    assertEquals(data.units.length, 1, "uma refaturação vencida basta para disparar");
    assertEquals(data.units[0].unitId, fx.units[0].id);
    assertEquals(data.units[0].totalOwedCents, 150_00);
    assertEquals(data.units[0].oldestOverdueDueDate, venc);
  });

  it("crédito a favor da fração não é dívida nem dispara", async () => {
    // Sem allowlist de charge_type, o guard que separa dívida de crédito é o
    // `nature`. Uma nota de crédito não pode passar a contar como dívida.
    const fxB = await seedScenario(client, MASTER)
      .withCondo("BillingReminder Credit")
      .withUnit({ designation: "A", permillage: 1000 })
      .build();
    await sqlExec(
      `UPDATE core.condominium SET reconciled_through_date = CURRENT_DATE WHERE id = '${fxB.condominium.id}'`,
    );
    const ontem = new Date();
    ontem.setUTCDate(ontem.getUTCDate() - 5);
    const venc = ontem.toISOString().slice(0, 10);
    await client.admin.createCharge(
      {
        kind: "receivable",
        nature: "credit",
        chargeType: "credit_adjustment",
        unitId: fxB.units[0].id,
        description: "Crédito a favor da fração",
        issueDate: venc,
        dueDate: venc,
        competencePeriod: `${venc.slice(0, 7)}-01`,
        amountCents: 100_00,
      },
      { headers: fxB.hdr() },
    );

    const { data } = await client.admin.listBillingOverdueUnits(
      { overdue: 1 },
      { headers: fxB.hdr() },
    );
    assertEquals(data.units.length, 0, "crédito não é dívida");
    await fxB.cleanup();
  });

  it("cleanup", async () => {
    await fx.cleanup();
  });
});
