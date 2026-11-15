// Cobertura via API REST dos algoritmos de imputação (Art. 784º CC) e auto-offset
// - substitui pgTAP 0007, 0008, 0019, 0022, 0025, 0033 que dependiam dos
// helpers gated.
//
// Cenários:
//   1. Auto-offset on charge create - credit_balance pré-existente é
//      automaticamente consumido pelas próximas debit charges criadas.
//   2. Allocation prioridade unit - opening_balance overdue paga PRIMEIRO
//      do que quota corrente.
//   3. Allocation prioridade supplier - competence_period ASC dentro do
//      grupo "vencidas/parciais".

import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { type Charge, Client, type Unit } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";
import { type ScenarioFixture, seedScenario } from "./_helpers/fixtures.ts";

const BASE_URL = "http://localhost:3000";
const AUTH = await loginAsSuper();
const client = new Client({ baseUrl: BASE_URL });

// ── Cenário 1: Auto-offset on charge create ─────────────────────────────

describe("admin charge - auto_offset on create", () => {
  let fx: ScenarioFixture;
  let unit: Unit;
  const hdr = () => fx.hdr();

  it("setup", async () => {
    fx = await seedScenario(client, AUTH)
      .withCondo(`Auto-offset Test ${Date.now()}`)
      .withUnit({ designation: "F", permillage: 1000 })
      .build();
    unit = fx.units[0];
  });

  it("cria credit_balance manual de 250€ → unit tem 250€ de crédito", async () => {
    await client.admin.createCharge(
      {
        unitId: unit.id,
        kind: "receivable",
        nature: "credit",
        chargeType: "credit_balance",
        amountCents: 250_00,
        issueDate: "2099-01-15",
        description: "Crédito inicial",
      },
      { headers: hdr() },
    );
  });

  it("cria 3 quotas debit de 100€ cada → auto_offset consume créditos", async () => {
    // Cria 3 charges debit (quotas manuais, simulando geração)
    for (let m = 1; m <= 3; m++) {
      await client.admin.createCharge(
        {
          unitId: unit.id,
          kind: "receivable",
          nature: "debit",
          chargeType: "quota",
          amountCents: 100_00,
          issueDate: `2099-0${m}-01`,
          competencePeriod: `2099-0${m}-01`,
          description: `Quota ${m}`,
        },
        { headers: hdr() },
      );
    }

    // Após auto-offset:
    //   - Q1 (100€) totalmente paga pelo crédito (sobra 150€ crédito)
    //   - Q2 (100€) totalmente paga pelo crédito (sobra 50€ crédito)
    //   - Q3 (100€) parcial (50€ pago, 50€ open)
    const { data: charges } = await client.admin.listCharges(
      { kind: "receivable", chargeType: "quota", year: "2099" },
      { headers: hdr() },
    );
    const byMonth = new Map<string, Charge>();
    for (const c of charges) byMonth.set(c.competencePeriod as string, c);

    assertEquals(byMonth.get("2099-01")?.status, "paid", "Q1 paga");
    assertEquals(byMonth.get("2099-01")?.openAmount, 0);
    assertEquals(byMonth.get("2099-02")?.status, "paid", "Q2 paga");
    assertEquals(byMonth.get("2099-02")?.openAmount, 0);
    assertEquals(byMonth.get("2099-03")?.status, "partial", "Q3 parcial");
    assertEquals(byMonth.get("2099-03")?.openAmount, 50_00);
  });

  it("teardown", async () => {
    await fx.cleanup();
  });
});

// ── Cenário 2: Allocation prioridade unit (opening_balance overdue) ─────

describe("admin allocation - opening_balance overdue tem prioridade sobre quota corrente", () => {
  let fx: ScenarioFixture;
  let unit: Unit;
  let bankAccountId = "";
  const hdr = () => fx.hdr();

  it("setup", async () => {
    fx = await seedScenario(client, AUTH)
      .withCondo(`Priority Test ${Date.now()}`)
      .withUnit({ designation: "G", permillage: 1000 })
      .build();
    unit = fx.units[0];
    const { data: ba } = await client.admin.createBankAccount(
      { bankName: "Caixa", iban: "PT50000200001234567890154", kind: "bank" },
      { headers: hdr() },
    );
    bankAccountId = ba.id as string;
  });

  it("setup - opening_balance overdue (due_date no passado) + quota corrente", async () => {
    // Dezembro 2024: opening_balance debit 80€ overdue (due_date passou).
    // Datas no passado real para o planner reconhecer overdue.
    await client.admin.createCharge(
      {
        unitId: unit.id,
        kind: "receivable",
        nature: "debit",
        chargeType: "opening_balance_debit",
        amountCents: 80_00,
        issueDate: "2024-12-01",
        dueDate: "2024-12-31",
        competencePeriod: "2024-12-01",
        description: "Saldo abertura overdue",
      },
      { headers: hdr() },
    );

    // Janeiro 2026: quota 100€ corrente (due_date também no passado mas
    // competência mais recente; ainda assim é vencida em relação a hoje
    // 2026-05-03, mas o planner ordena por competence ASC dentro do grupo
    // overdue/parcial).
    await client.admin.createCharge(
      {
        unitId: unit.id,
        kind: "receivable",
        nature: "debit",
        chargeType: "quota",
        amountCents: 100_00,
        issueDate: "2026-01-01",
        dueDate: "2026-01-08",
        competencePeriod: "2026-01-01",
        description: "Quota Janeiro 2026",
      },
      { headers: hdr() },
    );
  });

  it("pagamento de 80€ vai para opening_balance (competence ASC dentro de overdue)", async () => {
    const { data: bt } = await client.admin.createBankTransaction(
      {
        bankAccountId,
        transactionDate: "2026-05-01",
        description: "Pagamento ocupante",
        amount: 80_00,
      },
      { headers: hdr() },
    );

    await client.admin.allocateBankTransactionToUnit(
      bt.id as string,
      { unitId: unit.id },
      { headers: hdr() },
    );

    const { data: charges } = await client.admin.listCharges(
      { unitId: unit.id, kind: "receivable" },
      { headers: hdr() },
    );
    const byType = new Map<string, Charge>();
    for (const c of charges) byType.set(c.chargeType as string, c);

    // Opening balance pago primeiro (regra Art. 784: vencidas/parciais)
    assertEquals(byType.get("opening_balance_debit")?.status, "paid");
    assertEquals(byType.get("opening_balance_debit")?.openAmount, 0);
    // Quota Janeiro fica intacta
    assertEquals(byType.get("quota")?.status, "open");
    assertEquals(byType.get("quota")?.openAmount, 100_00);
  });

  it("teardown", async () => {
    await fx.cleanup();
  });
});

// ── Cenário 3: Allocation supplier - competence_period ASC ──────────────

describe("admin allocation - supplier paga por competence ASC dentro do grupo", () => {
  let fx: ScenarioFixture;
  let supplierId = "";
  let bankAccountId = "";
  const hdr = () => fx.hdr();

  it("setup", async () => {
    fx = await seedScenario(client, AUTH)
      .withCondo(`Supplier Order Test ${Date.now()}`)
      .build();
    const { data: ba } = await client.admin.createBankAccount(
      { bankName: "Banco", iban: "PT50000200001234567890155", kind: "bank" },
      { headers: hdr() },
    );
    bankAccountId = ba.id as string;
    const { data: sup } = await client.admin.createSupplier(
      { name: "EDP", nif: "501234568" },
      { headers: hdr() },
    );
    supplierId = sup.id as string;
  });

  it("setup - 2 faturas EDP: Dez (competence anterior) + Jan (due_date anterior)", async () => {
    // Caso real do bug pgTAP 0025: prioridade DEVE ser competence ASC,
    // não due_date ASC.
    //
    // Dezembro 2098: fatura com competence 2098-12, due 2099-01-31
    await client.admin.createCharge(
      {
        supplierId,
        kind: "payable",
        nature: "debit",
        chargeType: "supplier_service",
        amountCents: 100_00,
        issueDate: "2098-12-15",
        dueDate: "2099-01-31",
        competencePeriod: "2098-12-01",
        description: "EDP Dezembro",
      },
      { headers: hdr() },
    );
    // Janeiro 2099: fatura com competence 2099-01, due 2099-01-15 (due ANTES)
    await client.admin.createCharge(
      {
        supplierId,
        kind: "payable",
        nature: "debit",
        chargeType: "supplier_service",
        amountCents: 80_00,
        issueDate: "2099-01-05",
        dueDate: "2099-01-15",
        competencePeriod: "2099-01-01",
        description: "EDP Janeiro",
      },
      { headers: hdr() },
    );
  });

  it("pagamento de 100€ vai para a Dezembro (competence anterior), não Janeiro", async () => {
    const { data: bt } = await client.admin.createBankTransaction(
      {
        bankAccountId,
        transactionDate: "2099-02-01",
        description: "Transferência EDP",
        amount: -100_00, // negativo: saída para fornecedor
      },
      { headers: hdr() },
    );

    await client.admin.allocateBankTransactionToSupplier(
      bt.id as string,
      { supplierId },
      { headers: hdr() },
    );

    const { data: charges } = await client.admin.listCharges(
      { supplierId, kind: "payable" },
      { headers: hdr() },
    );
    const byCompetence = new Map<string, Charge>();
    for (const c of charges) byCompetence.set(c.competencePeriod as string, c);

    assertEquals(byCompetence.get("2098-12")?.status, "paid", "Dezembro pago primeiro");
    assertEquals(byCompetence.get("2099-01")?.status, "open", "Janeiro fica em aberto");
  });

  it("teardown", async () => {
    await fx.cleanup();
  });
});
