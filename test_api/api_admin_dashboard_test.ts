// Testes para GET /v1/admin/c/:cid/dashboard/metrics
//
// Este endpoint substitui o pattern antigo do panel que carregava todas as
// receivables só para calcular 3 escalares. Validamos:
//   - shape da resposta + defaults (year/month inferidos)
//   - paidThisMonthCents só conta `competence_period` no mês pedido
//   - collectionRate = round(paidCount / totalIssued × 100)
//   - filtra unit charges (scope!='condominium') de nature='debit' e kind='receivable'
//   - condomínio sem charges devolve zeros (sem 500)

import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { Client, type Unit } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";
import { type ScenarioFixture, seedScenario } from "./_helpers/fixtures.ts";

const BASE_URL = "http://localhost:3000";
const client = new Client({ baseUrl: BASE_URL });
const MASTER = await loginAsSuper();

describe("admin dashboard - metrics", () => {
  let fx: ScenarioFixture;
  let unit: Unit;
  const hdr = () => fx.hdr();

  it("setup - condomínio sem charges + unit", async () => {
    fx = await seedScenario(client, MASTER)
      .withCondo("Dashboard Metrics Test")
      .withUnit({ designation: "A", permillage: 1000, description: "unit única" })
      .build();
    unit = fx.units[0];
  });

  it("metrics - condomínio sem charges devolve zeros (sem 500)", async () => {
    const { data, status } = await client.admin.dashboardMetrics({}, { headers: hdr() });
    assertEquals(status, 200);
    assertEquals(data.totalIssued, 0);
    assertEquals(data.totalPaidCount, 0);
    assertEquals(data.paidThisMonthCents, 0);
    assertEquals(data.collectionRate, 0);
  });

  it("metrics - defaults: year/month vêm do today se não enviados", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const { data } = await client.admin.dashboardMetrics({}, { headers: hdr() });
    assertEquals(data.year, Number(today.slice(0, 4)));
    assertEquals(data.month, today.slice(0, 7));
  });

  it("metrics - aceita ?year=YYYY&month=YYYY-MM explícitos", async () => {
    const { data } = await client.admin.dashboardMetrics(
      { year: "2030", month: "2030-06" },
      { headers: hdr() },
    );
    assertEquals(data.year, 2030);
    assertEquals(data.month, "2030-06");
  });

  it("setup - cria 4 receivables + paga 2 + 1 paga é noutro mês", async () => {
    // 1. Quota Mai/2030 paga ANTES (issueDate dentro do ano 2030, paid)
    const { data: c1 } = await client.admin.createCharge(
      {
        kind: "receivable",
        chargeType: "quota",
        description: "Quota Mai/2030 (paga noutro mês)",
        issueDate: "2030-05-01",
        dueDate: "2030-05-31",
        competencePeriod: "2030-05-01",
        amountCents: 5000,
        unitId: unit.id,
      },
      { headers: hdr() },
    );
    // 2. Quota Jun/2030 paga ESTE mês (paidThisMonth deve contar esta)
    const { data: c2 } = await client.admin.createCharge(
      {
        kind: "receivable",
        chargeType: "quota",
        description: "Quota Jun/2030",
        issueDate: "2030-06-01",
        dueDate: "2030-06-30",
        competencePeriod: "2030-06-01",
        amountCents: 7500,
        unitId: unit.id,
      },
      { headers: hdr() },
    );
    // 3. Quota Jul/2030 ainda em aberto
    await client.admin.createCharge(
      {
        kind: "receivable",
        chargeType: "quota",
        description: "Quota Jul/2030",
        issueDate: "2030-07-01",
        dueDate: "2030-07-31",
        competencePeriod: "2030-07-01",
        amountCents: 6000,
        unitId: unit.id,
      },
      { headers: hdr() },
    );
    // 4. Receivable de OUTRO ano - não deve contar para totalIssued de 2030.
    await client.admin.createCharge(
      {
        kind: "receivable",
        chargeType: "quota",
        description: "Quota Jan/2029 (ano anterior)",
        issueDate: "2029-01-15",
        dueDate: "2029-01-31",
        competencePeriod: "2029-01-01",
        amountCents: 1000,
        unitId: unit.id,
      },
      { headers: hdr() },
    );

    // Marca c1 e c2 como paid via settlement bancário (caminho real).
    // Cria bank_account + bank_tx para cada.
    const { data: ba } = await client.admin.createBankAccount(
      {
        bankName: "BNP",
        accountName: "Principal",
        iban: "PT50000700000000000000000",
        openingBalance: 0,
      },
      { headers: hdr() },
    );

    const { data: bt1 } = await client.admin.createBankTransaction(
      {
        bankAccountId: String(ba.id),
        transactionDate: "2030-05-15",
        amount: 5000,
        description: "Pag c1",
      },
      { headers: hdr() },
    );
    await client.admin.createSettlement(
      {
        settlementType: "bank_reconciliation",
        bankTransactionId: String(bt1.id),
        debitChargeId: c1.id,
        amount: 5000,
        settlementDate: "2030-05-15",
      },
      { headers: hdr() },
    );

    // Pagamento de c2 com data NESTE mês.
    const today = new Date().toISOString().slice(0, 10);
    const { data: bt2 } = await client.admin.createBankTransaction(
      { bankAccountId: String(ba.id), transactionDate: today, amount: 7500, description: "Pag c2" },
      { headers: hdr() },
    );
    await client.admin.createSettlement(
      {
        settlementType: "bank_reconciliation",
        bankTransactionId: String(bt2.id),
        debitChargeId: c2.id,
        amount: 7500,
        settlementDate: today,
      },
      { headers: hdr() },
    );
  });

  it("metrics - filtra por year=2030: 3 issued, 2 paid, collection 67%", async () => {
    const { data } = await client.admin.dashboardMetrics({ year: "2030" }, { headers: hdr() });
    assertEquals(data.totalIssued, 3);
    assertEquals(data.totalPaidCount, 2);
    // 2 / 3 = 66.66… → arredondado para 67
    assertEquals(data.collectionRate, 67);
  });

  it("metrics - paidThisMonthCents só conta competence no mês pedido", async () => {
    // c1 (Mai/2030): paga em 2030-05-15, competence 2030-05-01 → cabe em month=2030-05
    const { data: may } = await client.admin.dashboardMetrics(
      { year: "2030", month: "2030-05" },
      { headers: hdr() },
    );
    assertEquals(may.paidThisMonthCents, 5000);

    // c2 (Jun/2030): paga, competence 2030-06-01 → cabe em month=2030-06
    const { data: jun } = await client.admin.dashboardMetrics(
      { year: "2030", month: "2030-06" },
      { headers: hdr() },
    );
    assertEquals(jun.paidThisMonthCents, 7500);

    // Mês sem pagamentos
    const { data: aug } = await client.admin.dashboardMetrics(
      { year: "2030", month: "2030-08" },
      { headers: hdr() },
    );
    assertEquals(aug.paidThisMonthCents, 0);
  });

  it("metrics - year=2029 devolve só a 4ª charge", async () => {
    const { data } = await client.admin.dashboardMetrics({ year: "2029" }, { headers: hdr() });
    assertEquals(data.totalIssued, 1);
    assertEquals(data.totalPaidCount, 0);
    assertEquals(data.collectionRate, 0);
  });

  it("metrics - ignora payables", async () => {
    // Cria payable no mesmo year/condo - não deve aparecer.
    await client.admin.createCharge(
      {
        kind: "payable",
        chargeType: "expense",
        description: "EDP 2030",
        issueDate: "2030-04-15",
        dueDate: "2030-04-30",
        competencePeriod: "2030-04-01",
        amountCents: 8000,
      },
      { headers: hdr() },
    );
    const { data } = await client.admin.dashboardMetrics({ year: "2030" }, { headers: hdr() });
    // totalIssued continua 3 (só receivables) - payable foi ignorado.
    assertEquals(data.totalIssued, 3);
  });

  it("teardown", async () => {
    await fx.cleanup();
  });
});
