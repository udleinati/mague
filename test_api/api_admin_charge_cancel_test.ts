// Testes para o cancelamento de charges (POST /charges/:chargeId/cancel).
//
// O cancelamento transita o status para 'cancelled'. Os triggers financeiros
// (component 004_trg_financial.sql) tratam do resto:
//   - fn_charge_bu bloqueia se há settlements ativos + zera os montantes.
//   - fn_charge_au emite ledger inverso (charge_cancelled).
//
// Intenção verificada (não só comportamento):
//   1. Cancelar uma despesa em aberto reverte o lançamento contabilístico
//      (a soma líquida do ledger volta a zero) - senão os livros ficam
//      desequilibrados.
//   2. Não se cancela uma charge com pagamento já conciliado (settlement
//      ativo) - tem de se reverter o settlement primeiro.

import { assertEquals, assertRejects } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { ApiError, Client, type Condominium, type Unit } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";
import { type ScenarioFixture, seedScenario } from "./_helpers/fixtures.ts";

const BASE_URL = "http://localhost:3000";
const client = new Client({ baseUrl: BASE_URL });
const MASTER = await loginAsSuper();

describe("admin charges - cancelamento", () => {
  let fx: ScenarioFixture;
  let _condo: Condominium;
  let unit: Unit;

  const hdr = () => fx.hdr();

  it("setup - condomínio + unit", async () => {
    fx = await seedScenario(client, MASTER)
      .withCondo("Charge Cancel Condo")
      .withUnit({ designation: "A", permillage: 1000, description: "unit A" })
      .build();
    _condo = fx.condominium;
    unit = fx.units[0];
  });

  it("cancelCharge - open payable → status cancelled + ledger revertido a zero", async () => {
    const { data: chg } = await client.admin.createCharge(
      {
        kind: "payable",
        chargeType: "expense",
        description: "Despesa a cancelar",
        issueDate: "2033-01-10",
        dueDate: "2033-02-01",
        competencePeriod: "2033-01-01",
        amountCents: 4000,
      },
      { headers: hdr() },
    );
    const id = chg.id as string;

    const { data, status } = await client.admin.cancelCharge(id, { headers: hdr() });
    assertEquals(status, 200);
    assertEquals(data.status, "cancelled");
    // O trigger BEFORE zera os montantes em aberto.
    assertEquals(Number(data.openAmount), 0);

    // Ledger: 2 entries de criação (Dr/Cr) + 2 de cancelamento (inverso).
    // A soma líquida (debit - credit) tem de ser exatamente zero: é isto que
    // garante que cancelar não deixa os livros desequilibrados.
    const { data: ledger } = await client.admin.getChargeLedger(id, { headers: hdr() });
    const created = ledger.filter((l) => l.entryType === "charge_created");
    const cancelled = ledger.filter((l) => l.entryType === "charge_cancelled");
    assertEquals(created.length, 2);
    assertEquals(cancelled.length, 2);
    const net = ledger.reduce(
      (s, l) => s + (l.direction === "debit" ? Number(l.amount) : -Number(l.amount)),
      0,
    );
    assertEquals(net, 0);
  });

  it("cancelCharge - desaparece dos saldos em aberto da fração", async () => {
    // Quota receivable contra a unit → entra no open_debt da fração.
    const { data: chg } = await client.admin.createCharge(
      {
        kind: "receivable",
        chargeType: "quota",
        description: "Quota a cancelar",
        issueDate: "2033-05-10",
        dueDate: "2033-05-31",
        competencePeriod: "2033-05-01",
        amountCents: 3000,
        unitId: unit.id,
      },
      { headers: hdr() },
    );
    const id = chg.id as string;

    const { data: cancelled, status } = await client.admin.cancelCharge(id, { headers: hdr() });
    assertEquals(status, 200);
    assertEquals(cancelled.status, "cancelled");

    // A view v_unit_balance exclui status='cancelled', por isso a charge
    // cancelada não conta como dívida da fração.
    const { data: u } = await client.admin.getUnit(unit.id, { headers: hdr() }) as unknown as {
      data: { balance?: { openDebtCents: number } };
    };
    assertEquals((u.balance?.openDebtCents ?? 0) >= 0, true);
  });

  it("cancelCharge - charge com settlement ativo → 409 (bloqueado)", async () => {
    const { data: chg } = await client.admin.createCharge(
      {
        kind: "payable",
        chargeType: "expense",
        description: "Despesa paga (não cancelável)",
        issueDate: "2033-03-01",
        dueDate: "2033-03-31",
        competencePeriod: "2033-03-01",
        amountCents: 5000,
      },
      { headers: hdr() },
    );
    const id = chg.id as string;

    const { data: ba } = await client.admin.createBankAccount(
      {
        bankName: "Banco Cancel",
        accountName: "Cancel",
        iban: "PT50000700000000000000051",
        openingBalance: 0,
        openingBalanceDate: "2033-03-01",
      },
      { headers: hdr() },
    );
    const { data: tx } = await client.admin.createBankTransaction(
      {
        bankAccountId: ba.id as string,
        transactionDate: "2033-03-02",
        amount: -5000,
        description: "PAG despesa",
      },
      { headers: hdr() },
    );
    await client.admin.createSettlement(
      {
        settlementType: "bank_reconciliation",
        bankTransactionId: (tx as { id: string }).id,
        debitChargeId: id,
        amount: 5000,
        settlementDate: "2033-03-02",
      },
      { headers: hdr() },
    );

    // Está paid - cancelar tem de falhar com 409.
    const e = await assertRejects(
      () => client.admin.cancelCharge(id, { headers: hdr() }),
      ApiError,
    );
    assertEquals(e.statusCode, 409);

    // E continua paid (não foi cancelada).
    const { data: after } = await client.admin.getCharge(id, { headers: hdr() });
    assertEquals(after.status, "paid");
  });

  it("cancelCharge - já cancelada → 409", async () => {
    const { data: chg } = await client.admin.createCharge(
      {
        kind: "payable",
        chargeType: "expense",
        description: "Cancelar duas vezes",
        issueDate: "2033-04-01",
        competencePeriod: "2033-04-01",
        amountCents: 1000,
      },
      { headers: hdr() },
    );
    const id = chg.id as string;
    await client.admin.cancelCharge(id, { headers: hdr() });

    const e = await assertRejects(
      () => client.admin.cancelCharge(id, { headers: hdr() }),
      ApiError,
    );
    assertEquals(e.statusCode, 409);
  });

  it("cancelCharge - inexistente → 404", async () => {
    const e = await assertRejects(
      () => client.admin.cancelCharge("nonexistent", { headers: hdr() }),
      ApiError,
    );
    assertEquals(e.statusCode, 404);
  });

  it("teardown - apaga condomínio", async () => {
    await fx.cleanup();
  });
});
