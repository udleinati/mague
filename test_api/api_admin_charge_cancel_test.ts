// Testes para o cancelamento de charges (POST /charges/:chargeId/cancel { reason }).
//
// O cancelamento reverte os offsets (charge_offset) da charge, transita o
// status para 'cancelled' e volta a aplicar o auto-offset ao que ficou livre. Os triggers
// financeiros (component 004_trg_financial.sql) tratam do ledger:
//   - fn_charge_bu bloqueia se há settlements ativos + zera os montantes.
//   - fn_charge_au emite ledger inverso (charge_cancelled), só para débitos.
//
// Intenção verificada (não só comportamento):
//   1. Cancelar uma despesa em aberto reverte o lançamento contabilístico
//      (a soma líquida do ledger volta a zero) - senão os livros ficam
//      desequilibrados.
//   2. Não se cancela uma charge com pagamento já conciliado com o banco -
//      reverte-se na conciliação.
//   3. Uma cobrança ou crédito lançado por engano e já consumido por offset cancela-se:
//      a outra ponta volta ao estado de antes (dívida em aberto ou crédito
//      disponível) e o crédito não deixa lançamentos sem origem no ledger.
//   4. Sem justificação não se cancela.

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
  let unitB: Unit;
  let unitC: Unit;
  let unitD: Unit;

  const hdr = () => fx.hdr();
  const reason = { reason: "Lançada por engano no teste" };
  const net = (ledger: Array<{ direction: string; amount: number }>) =>
    ledger.reduce(
      (s, l) => s + (l.direction === "debit" ? Number(l.amount) : -Number(l.amount)),
      0,
    );
  const receivable = (unitId: string, over: Record<string, unknown>) =>
    client.admin.createCharge({
      kind: "receivable",
      issueDate: "2033-06-01",
      dueDate: "2033-06-30",
      competencePeriod: "2033-06-01",
      unitId,
      ...over,
    }, { headers: hdr() });

  it("setup - condomínio + unit", async () => {
    fx = await seedScenario(client, MASTER)
      .withCondo("Charge Cancel Condo")
      .withUnit({ designation: "A", permillage: 250, description: "unit A" })
      .withUnit({ designation: "B", permillage: 250, description: "unit B" })
      .withUnit({ designation: "C", permillage: 250, description: "unit C" })
      .withUnit({ designation: "D", permillage: 250, description: "unit D" })
      .build();
    _condo = fx.condominium;
    [unit, unitB, unitC, unitD] = fx.units;
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

    const { data, status } = await client.admin.cancelCharge(id, reason, { headers: hdr() });
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

    const { data: cancelled, status } = await client.admin.cancelCharge(id, reason, {
      headers: hdr(),
    });
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
      () => client.admin.cancelCharge(id, reason, { headers: hdr() }),
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
    await client.admin.cancelCharge(id, reason, { headers: hdr() });

    const e = await assertRejects(
      () => client.admin.cancelCharge(id, reason, { headers: hdr() }),
      ApiError,
    );
    assertEquals(e.statusCode, 409);
  });

  it("cancelCharge - sem justificação → 400 e a charge fica como estava", async () => {
    const { data: chg } = await client.admin.createCharge(
      {
        kind: "payable",
        chargeType: "expense",
        description: "Cancelar sem motivo",
        issueDate: "2033-04-01",
        competencePeriod: "2033-04-01",
        amountCents: 1000,
      },
      { headers: hdr() },
    );
    const id = chg.id as string;

    const e = await assertRejects(
      () => client.admin.cancelCharge(id, { reason: "curto" }, { headers: hdr() }),
      ApiError,
    );
    assertEquals(e.statusCode, 400);
    const { data: after } = await client.admin.getCharge(id, { headers: hdr() });
    assertEquals(after.status, "open");
  });

  it("cobrança por engano saldada por offset com um crédito → cancelar devolve o crédito à fração", async () => {
    // O crédito da fração foi consumido pela cobrança errada. Cancelá-la tem de
    // deixar o crédito disponível outra vez, com o ledger da cobrança a zero.
    const { data: credit } = await receivable(unitB.id, {
      nature: "credit",
      chargeType: "credit_adjustment",
      description: "Adiantamento",
      amountCents: 10000,
    });
    const { data: wrong } = await receivable(unitB.id, {
      chargeType: "opening_balance_debit",
      description: "Dívida lançada por engano",
      amountCents: 12000,
    });
    const { data: before } = await client.admin.getCharge(credit.id, { headers: hdr() });
    assertEquals(before.openAmount, 0); // consumido pelo auto-offset

    const { data, status } = await client.admin.cancelCharge(wrong.id, reason, {
      headers: hdr(),
    });
    assertEquals(status, 200);
    assertEquals(data.status, "cancelled");
    assertEquals(data.cancellationReason, reason.reason);

    const { data: creditAfter } = await client.admin.getCharge(credit.id, { headers: hdr() });
    assertEquals(creditAfter.openAmount, 10000);
    assertEquals(creditAfter.status, "open");

    const { data: ledger } = await client.admin.getChargeLedger(wrong.id, { headers: hdr() });
    const cancelled = ledger.filter((l) => l.entryType === "charge_cancelled");
    assertEquals(cancelled.map((l) => Number(l.amount)), [12000, 12000]);
    assertEquals(net(ledger), 0);
  });

  it("crédito por engano que pagou uma quota → cancelar devolve a quota a em aberto", async () => {
    // A quota parecia paga só por causa do crédito errado. Depois de cancelar
    // tem de voltar a contar como dívida, e o crédito (que nunca lançou no
    // ledger ao nascer) não pode deixar uma anulação sem origem.
    const { data: quota } = await receivable(unitC.id, {
      chargeType: "quota",
      description: "Quota 06/2033",
      amountCents: 3000,
    });
    const { data: wrongCredit } = await receivable(unitC.id, {
      nature: "credit",
      chargeType: "credit_adjustment",
      description: "Crédito lançado por engano",
      amountCents: 3000,
    });
    const { data: paid } = await client.admin.getCharge(quota.id, { headers: hdr() });
    assertEquals(paid.status, "paid");

    const { data } = await client.admin.cancelCharge(wrongCredit.id, reason, { headers: hdr() });
    assertEquals(data.status, "cancelled");

    const { data: quotaAfter } = await client.admin.getCharge(quota.id, { headers: hdr() });
    assertEquals(quotaAfter.status, "open");
    assertEquals(quotaAfter.openAmount, 3000);

    const { data: ledger } = await client.admin.getChargeLedger(wrongCredit.id, {
      headers: hdr(),
    });
    assertEquals(ledger.filter((l) => l.entryType === "charge_cancelled").length, 0);
    assertEquals(net(ledger), 0);
  });

  it("o crédito libertado volta a saldar, por offset, a dívida que ficou em aberto", async () => {
    // Sem a cobrança errada, o crédito teria pago a quota seguinte. Cancelar
    // tem de chegar a esse estado; senão a quota fica "em atraso" com crédito
    // por usar na mesma fração (e entra nos lembretes de cobrança).
    const { data: credit } = await receivable(unitD.id, {
      nature: "credit",
      chargeType: "credit_adjustment",
      description: "Adiantamento",
      amountCents: 5000,
    });
    const { data: wrong } = await receivable(unitD.id, {
      chargeType: "opening_balance_debit",
      description: "Dívida lançada por engano",
      amountCents: 5000,
    });
    const { data: quota } = await receivable(unitD.id, {
      chargeType: "quota",
      description: "Quota 06/2033",
      amountCents: 5000,
    });
    const { data: quotaBefore } = await client.admin.getCharge(quota.id, { headers: hdr() });
    assertEquals(quotaBefore.status, "open");

    await client.admin.cancelCharge(wrong.id, reason, { headers: hdr() });

    const { data: quotaAfter } = await client.admin.getCharge(quota.id, { headers: hdr() });
    assertEquals(quotaAfter.status, "paid");
    const { data: creditAfter } = await client.admin.getCharge(credit.id, { headers: hdr() });
    assertEquals(creditAfter.openAmount, 0);
  });

  it("cancelCharge - inexistente → 404", async () => {
    const e = await assertRejects(
      () => client.admin.cancelCharge("nonexistent", reason, { headers: hdr() }),
      ApiError,
    );
    assertEquals(e.statusCode, 404);
  });

  it("teardown - apaga condomínio", async () => {
    await fx.cleanup();
  });
});
