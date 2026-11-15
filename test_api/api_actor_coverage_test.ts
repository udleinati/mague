// Cobertura sistemática do `ActorSnapshot` (ADR 0011) em todas as tabelas
// auditáveis cobertas pela API admin.
//
// Para cada tabela: cria → valida `created_by`, se aplicável update → valida
// `updated_by`, se aplicável soft-delete → valida `deleted_by`. Tudo via
// query directa à BD (responses não expõem estes campos - Q11a=C).

import { describe, it } from "@std/testing/bdd";
import { Client } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";
import { assertActor, closeActorClient, getSuperUserId } from "./_helpers/actor_assertions.ts";

const BASE_URL = "http://localhost:3000";
const SUPER = await loginAsSuper();

describe("actor coverage - created_by/updated_by/deleted_by populated (ADR 0011)", () => {
  const client = new Client({ baseUrl: BASE_URL });

  let SUPER_USER_ID = "";
  let condoId = "";
  let unitId = "";
  let _unitId2 = "";
  let supplierId = "";
  let occupantId = "";
  let bankAccountId = "";
  let budgetId = "";
  let budgetLineId = "";
  let assemblyId = "";
  let docId = "";
  let ticketId = "";
  let recurringTemplateId = "";
  let chartAccountId = "";
  let chargeId = "";
  let unitOccupantId = "";
  function condoH() {
    return { ...SUPER, "x-condominium-id": condoId };
  }

  // ── Setup ────────────────────────────────────────────────────────────────

  it("setup - condomínio + unit + supplier + bank account", async () => {
    SUPER_USER_ID = await getSuperUserId();

    const { data: condo } = await client.super.createCondominium(
      { name: "Coverage Condo", fiscalNumber: "999111222" },
      { headers: SUPER },
    );
    condoId = String(condo.id);
    await assertActor({
      table: "core.condominium",
      id: condoId,
      expectedUserId: SUPER_USER_ID,
    });

    const { data: unit } = await client.admin.createUnitForMe(
      { designation: "AC1", permillage: 100 },
      { headers: condoH() },
    );
    unitId = String(unit.id);
    await assertActor({
      table: "core.unit",
      id: unitId,
      expectedUserId: SUPER_USER_ID,
    });

    const { data: unit2 } = await client.admin.createUnitForMe(
      { designation: "AC2", permillage: 100 },
      { headers: condoH() },
    );
    _unitId2 = String(unit2.id);

    const { data: sup } = await client.admin.createSupplier(
      { name: "ACov Sup", fiscalNumber: "555111223" },
      { headers: condoH() },
    );
    supplierId = String(sup.id);
    await assertActor({
      table: "core.supplier",
      id: supplierId,
      expectedUserId: SUPER_USER_ID,
    });

    const { data: bank } = await client.admin.createBankAccount(
      { bankName: "Test Bank", iban: "PT50000000000000000000099" },
      { headers: condoH() },
    );
    bankAccountId = String(bank.id);
    await assertActor({
      table: "finance.bank_account",
      id: bankAccountId,
      expectedUserId: SUPER_USER_ID,
    });
  });

  // ── core.occupant + core.unit_occupant ──────────────────────────────────

  it("core.occupant + core.unit_occupant - created_by", async () => {
    const { data: occ } = await client.admin.createOccupant(
      { name: "Cov Owner", type: "owner", email: "covowner@test.pt" },
      { headers: condoH() },
    );
    occupantId = String(occ.id);
    await assertActor({
      table: "core.occupant",
      id: occupantId,
      expectedUserId: SUPER_USER_ID,
    });

    const { data: uo } = await client.admin.createUnitOccupant(
      unitId,
      { unitId, occupantId, relationshipType: "owner" },
      { headers: condoH() },
    );
    unitOccupantId = String(uo.id);
    await assertActor({
      table: "core.unit_occupant",
      id: unitOccupantId,
      expectedUserId: SUPER_USER_ID,
    });
  });

  // ── core.manager: skipped - requires invite flow via portal/email; covered
  // indiretamente quando user/update.ts é chamado com isManager toggle e
  // tem `requireActor(ctx)` propagado. Cobrir manualmente via DB se preciso.

  // ── core.assembly ───────────────────────────────────────────────────────

  it("core.assembly - created_by + updated_by", async () => {
    const { data: a } = await client.admin.createAssembly(
      {
        type: "ordinary",
        scheduledAt: "2027-06-15T10:00:00Z",
        location: "Sala comum",
      },
      { headers: condoH() },
    );
    assemblyId = String(a.id);
    await assertActor({
      table: "core.assembly",
      id: assemblyId,
      expectedUserId: SUPER_USER_ID,
    });

    await client.admin.updateAssembly(
      assemblyId,
      { location: "Sala alterada" },
      { headers: condoH() },
    );
    await assertActor({
      table: "core.assembly",
      id: assemblyId,
      column: "updated_by",
      expectedUserId: SUPER_USER_ID,
    });
  });

  // ── core.budget + core.budget_line ──────────────────────────────────────

  it("core.budget + core.budget_line - created_by + updated_by", async () => {
    const { data: b } = await client.admin.createBudget(
      { year: 2027, notes: "Coverage", fcrPercentage: "10.00" },
      { headers: condoH() },
    );
    budgetId = String(b.id);
    await assertActor({
      table: "core.budget",
      id: budgetId,
      expectedUserId: SUPER_USER_ID,
    });

    await client.admin.updateBudget(
      budgetId,
      { notes: "Coverage v2" },
      { headers: condoH() },
    );
    await assertActor({
      table: "core.budget",
      id: budgetId,
      column: "updated_by",
      expectedUserId: SUPER_USER_ID,
    });

    // Need an account to create a budget_line - use chart_of_account first.
    const { data: ac } = await client.admin.createChartOfAccount(
      { code: "TST.1", name: "Coverage line", type: "expense" },
      { headers: condoH() },
    );
    chartAccountId = String(ac.id);
    await assertActor({
      table: "finance.chart_of_account",
      id: chartAccountId,
      expectedUserId: SUPER_USER_ID,
    });

    const { data: bl } = await client.admin.createBudgetLine(
      budgetId,
      { accountId: chartAccountId, annualAmount: 12000 },
      { headers: condoH() },
    );
    budgetLineId = String(bl.id);
    await assertActor({
      table: "core.budget_line",
      id: budgetLineId,
      expectedUserId: SUPER_USER_ID,
    });

    await client.admin.updateBudgetLine(
      budgetId,
      budgetLineId,
      { annualAmount: 24000 },
      { headers: condoH() },
    );
    await assertActor({
      table: "core.budget_line",
      id: budgetLineId,
      column: "updated_by",
      expectedUserId: SUPER_USER_ID,
    });
  });

  // ── core.recurring_template ─────────────────────────────────────────────

  it("core.recurring_template - created_by + updated_by", async () => {
    const { data: rt } = await client.admin.createRecurringTemplate(
      {
        kind: "payable",
        description: "Coverage subscription",
        amount: 5000,
        intervalType: "monthly",
        startDate: "2027-01-01",
        nextRunDate: "2027-01-01",
        supplierId,
      },
      { headers: condoH() },
    );
    recurringTemplateId = String(rt.id);
    await assertActor({
      table: "core.recurring_template",
      id: recurringTemplateId,
      expectedUserId: SUPER_USER_ID,
    });

    await client.admin.updateRecurringTemplate(
      recurringTemplateId,
      { description: "Coverage v2" },
      { headers: condoH() },
    );
    await assertActor({
      table: "core.recurring_template",
      id: recurringTemplateId,
      column: "updated_by",
      expectedUserId: SUPER_USER_ID,
    });
  });

  // ── core.document ───────────────────────────────────────────────────────

  it("core.document - created_by + updated_by", async () => {
    const { data: d } = await client.admin.createDocument(
      { title: "Cov Doc", category: "other", isPublic: false },
      { headers: condoH() },
    );
    docId = String(d.id);
    await assertActor({
      table: "core.document",
      id: docId,
      expectedUserId: SUPER_USER_ID,
    });

    await client.admin.updateDocument(
      docId,
      { title: "Cov Doc v2" },
      { headers: condoH() },
    );
    await assertActor({
      table: "core.document",
      id: docId,
      column: "updated_by",
      expectedUserId: SUPER_USER_ID,
    });
  });

  // ── core.ticket ─────────────────────────────────────────────────────────

  it("core.ticket - created_by + updated_by", async () => {
    const { data: t } = await client.admin.createTicket(
      {
        title: "Cov ticket",
        description: "Coverage",
        category: "common_area",
        priority: "normal",
        unitId,
      },
      { headers: condoH() },
    );
    ticketId = String(t.id);
    await assertActor({
      table: "core.ticket",
      id: ticketId,
      expectedUserId: SUPER_USER_ID,
    });

    await client.admin.updateTicket(
      ticketId,
      { priority: "high" },
      { headers: condoH() },
    );
    await assertActor({
      table: "core.ticket",
      id: ticketId,
      column: "updated_by",
      expectedUserId: SUPER_USER_ID,
    });
  });

  // ── finance.charge ──────────────────────────────────────────────────────

  it("finance.charge - created_by + updated_by", async () => {
    const { data: c } = await client.admin.createCharge(
      {
        kind: "payable",
        chargeType: "expense",
        issueDate: "2027-06-01",
        dueDate: "2027-06-30",
        competencePeriod: "2027-06-01",
        amountCents: 100000,
        description: "Coverage charge",
        supplierId,
      },
      { headers: condoH() },
    );
    chargeId = String(c.id);
    await assertActor({
      table: "finance.charge",
      id: chargeId,
      expectedUserId: SUPER_USER_ID,
    });

    await client.admin.updateCharge(
      chargeId,
      { description: "Coverage charge v2" },
      { headers: condoH() },
    );
    await assertActor({
      table: "finance.charge",
      id: chargeId,
      column: "updated_by",
      expectedUserId: SUPER_USER_ID,
    });
  });

  // ── finance.bank_transaction ────────────────────────────────────────────

  it("finance.bank_transaction - created_by", async () => {
    const { data: bt } = await client.admin.createBankTransaction(
      {
        bankAccountId,
        transactionDate: "2027-06-15",
        amount: 100000,
        description: "Coverage deposit",
      },
      { headers: condoH() },
    );
    await assertActor({
      table: "finance.bank_transaction",
      id: String(bt.id),
      expectedUserId: SUPER_USER_ID,
    });
  });

  // ── deleted_by sweep - soft-delete + verify ─────────────────────────────

  it("deleted_by - assembly + budget_line + recurring_template + document + ticket", async () => {
    // assembly
    await client.admin.deleteAssembly(assemblyId, { headers: condoH() });
    await assertActor({
      table: "core.assembly",
      id: assemblyId,
      column: "deleted_by",
      expectedUserId: SUPER_USER_ID,
    });

    // budget_line
    await client.admin.deleteBudgetLine(budgetId, budgetLineId, {
      headers: condoH(),
    });
    await assertActor({
      table: "core.budget_line",
      id: budgetLineId,
      column: "deleted_by",
      expectedUserId: SUPER_USER_ID,
    });

    // recurring_template
    await client.admin.deleteRecurringTemplate(recurringTemplateId, {
      headers: condoH(),
    });
    await assertActor({
      table: "core.recurring_template",
      id: recurringTemplateId,
      column: "deleted_by",
      expectedUserId: SUPER_USER_ID,
    });

    // document
    await client.admin.deleteDocument(docId, { headers: condoH() });
    await assertActor({
      table: "core.document",
      id: docId,
      column: "deleted_by",
      expectedUserId: SUPER_USER_ID,
    });

    // ticket (delete? check signature)
    await client.admin.deleteTicket(ticketId, { headers: condoH() });
    await assertActor({
      table: "core.ticket",
      id: ticketId,
      column: "deleted_by",
      expectedUserId: SUPER_USER_ID,
    });

    // bank_account
    await client.admin.deleteBankAccount(bankAccountId, { headers: condoH() });
    await assertActor({
      table: "finance.bank_account",
      id: bankAccountId,
      column: "deleted_by",
      expectedUserId: SUPER_USER_ID,
    });

    // chart_of_account
    await client.admin.deleteChartOfAccount(chartAccountId, {
      headers: condoH(),
    });
    await assertActor({
      table: "finance.chart_of_account",
      id: chartAccountId,
      column: "deleted_by",
      expectedUserId: SUPER_USER_ID,
    });

    // unit_occupant
    await client.admin.deleteUnitOccupant(unitId, unitOccupantId, {
      headers: condoH(),
    });
    await assertActor({
      table: "core.unit_occupant",
      id: unitOccupantId,
      column: "deleted_by",
      expectedUserId: SUPER_USER_ID,
    });
  });

  it("teardown - limpa condomínio + closes DB client", async () => {
    await client.super.deleteCondominium(condoId, { headers: SUPER });
    await closeActorClient();
  });
});
