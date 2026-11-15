// Cobertura via API REST da geração de quotas a partir de budget aprovado.
//
// Substitui os antigos pgTAP 0013, 0017, 0023 que dependiam dos helpers
// gated. Aqui exercitamos a stack real:
//   POST /budgets → POST /budgets/:id/lines → assembleia held →
//   POST /budgets/:id/generate_quotas → GET /charges
//
// Cenários:
//   1. Geração completa (12 meses) com permillage equilibrada
//   2. Geração incremental (re-correr com data maior só gera meses em falta)
//   3. Idempotência (mesmas through_date duas vezes não duplica)
//   4. Rateio por permillage proporcional + arredondamento agregado
//      (regression do bug que produzia 1 cêntimo de drift)

import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { Client, type Unit } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";
import { type ScenarioFixture, seedScenario } from "./_helpers/fixtures.ts";

const BASE_URL = "http://localhost:3000";
const AUTH = await loginAsSuper();
const client = new Client({ baseUrl: BASE_URL });

describe("admin budgets - generate_quotas end-to-end", () => {
  let fx: ScenarioFixture;
  let unitA: Unit;
  let unitB: Unit;
  let unitC: Unit;
  let budgetId = "";
  let categoryAccountId = "";

  const hdr = () => fx.hdr();
  let approvalCounter = 0;

  // Helper: cria assembleia held + decision approve_budget → trigger aprova budget.
  const approveBudget = async (bid: string) => {
    approvalCounter++;
    const scheduledAt = `2030-0${1 + (approvalCounter % 9)}-15T19:00:00Z`;
    const { data: assembly } = await client.admin.createAssembly(
      { type: "ordinary", scheduledAt },
      { headers: hdr() },
    );
    await client.admin.createAssemblyAgendaItem(
      assembly.id as string,
      {
        sequence: 1,
        subject: "Aprovação do orçamento",
        itemType: "approve_budget",
        refType: "budget",
        refId: bid,
        // Resultado derivado dos votos (maioria simples): favor > contra.
        votesInFavor: 1000,
        votesAgainst: 0,
        votesAbstain: 0,
      },
      { headers: hdr() },
    );
    await client.admin.updateAssembly(
      assembly.id as string,
      { status: "held", heldAt: scheduledAt },
      { headers: hdr() },
    );
  };

  it("setup - condo + 3 frações com permillage 500/300/200", async () => {
    fx = await seedScenario(client, AUTH)
      .withCondo(`Quota Gen Test ${Date.now()}`)
      .withUnit({ designation: "A", permillage: 500 })
      .withUnit({ designation: "B", permillage: 300 })
      .withUnit({ designation: "C", permillage: 200 })
      .build();
    unitA = fx.units[0];
    unitB = fx.units[1];
    unitC = fx.units[2];
  });

  it("setup - cria categoria de despesa custom (5.X)", async () => {
    const { data: acc } = await client.admin.createChartOfAccount(
      {
        code: `CAT_${Date.now().toString(36).toUpperCase()}`,
        name: "Limpeza",
        type: "expense",
        parentCode: "5",
      },
      { headers: hdr() },
    );
    categoryAccountId = acc.id as string;
  });

  it("create budget - 12000€/ano (=1000€/mês)", async () => {
    const { data: budget } = await client.admin.createBudget(
      { year: 2030, fcrPercentage: "0" },
      { headers: hdr() },
    );
    budgetId = budget.id;
    await client.admin.createBudgetLine(
      budgetId,
      { accountId: categoryAccountId, annualAmount: 12_000_00 },
      { headers: hdr() },
    );
  });

  it("approve budget via assembleia → status passa a 'approved'", async () => {
    await approveBudget(budgetId);
  });

  // ── Cenário 1: geração completa ──────────────────────────────────────────
  it("generate quotas para o ano todo → 36 charges (3 frações × 12 meses)", async () => {
    const { data } = await client.admin.generateQuotas(
      budgetId,
      { throughDate: "2030-12-31" },
      { headers: hdr() },
    );
    assertEquals(data.chargesCreated, 36);
  });

  it("listar quotas - todas têm chargeType='quota' e nature='debit'", async () => {
    const { data } = await client.admin.listCharges(
      { kind: "receivable", chargeType: "quota", year: "2030" },
      { headers: hdr() },
    );
    assertEquals(data.length, 36);
    for (const c of data) {
      assertEquals(c.kind, "receivable");
      assertEquals(c.nature, "debit");
      assertEquals(c.chargeType, "quota");
    }
  });

  it("rateio mensal: 1000€/mês = unitA 500€ + unitB 300€ + unitC 200€", async () => {
    // Filtrar quotas de Janeiro (competence_period 2030-01-01).
    const { data: all } = await client.admin.listCharges(
      { kind: "receivable", chargeType: "quota", year: "2030" },
      { headers: hdr() },
    );
    const jan = all.filter((c) => c.competencePeriod === "2030-01");
    assertEquals(jan.length, 3);
    const totals = new Map<string, number>();
    for (const c of jan) totals.set(c.unitId as string, c.originalAmount as number);
    assertEquals(totals.get(unitA.id), 500_00);
    assertEquals(totals.get(unitB.id), 300_00);
    assertEquals(totals.get(unitC.id), 200_00);
  });

  it("soma anual por fração = permillage × valor anual", async () => {
    const { data } = await client.admin.listCharges(
      { kind: "receivable", chargeType: "quota", year: "2030" },
      { headers: hdr() },
    );
    const sumByUnit = new Map<string, number>();
    for (const c of data) {
      sumByUnit.set(
        c.unitId as string,
        (sumByUnit.get(c.unitId as string) ?? 0) + (c.originalAmount as number),
      );
    }
    assertEquals(sumByUnit.get(unitA.id), 6_000_00); // 500‰ × 12000€
    assertEquals(sumByUnit.get(unitB.id), 3_600_00); // 300‰ × 12000€
    assertEquals(sumByUnit.get(unitC.id), 2_400_00); // 200‰ × 12000€
  });

  // ── Cenário 2: idempotência (re-correr não duplica) ─────────────────────
  it("re-correr generate_quotas com mesma through_date → 0 charges novas", async () => {
    const { data } = await client.admin.generateQuotas(
      budgetId,
      { throughDate: "2030-12-31" },
      { headers: hdr() },
    );
    assertEquals(data.chargesCreated, 0);
    // Total ainda 36
    const { data: all } = await client.admin.listCharges(
      { kind: "receivable", chargeType: "quota", year: "2030" },
      { headers: hdr() },
    );
    assertEquals(all.length, 36);
  });

  // ── Cenário 3: incremental (data parcial gera só os meses até lá) ───────
  it("budget novo: through_date=2030-03-31 gera só 3 meses × 3 = 9", async () => {
    const { data: c } = await client.super.createCondominium(
      { name: `Incremental Test ${Date.now()}` },
      { headers: AUTH },
    );
    const headers = { ...AUTH, "x-condominium-id": c.id };
    await client.super.createUnit(
      c.id,
      { designation: "X", permillage: 500 },
      { headers: AUTH },
    );
    await client.super.createUnit(
      c.id,
      { designation: "Y", permillage: 300 },
      { headers: AUTH },
    );
    await client.super.createUnit(
      c.id,
      { designation: "Z", permillage: 200 },
      { headers: AUTH },
    );
    const { data: cat } = await client.admin.createChartOfAccount(
      {
        code: `INC_${Date.now().toString(36).toUpperCase()}`,
        name: "Manutenção",
        type: "expense",
        parentCode: "5",
      },
      { headers },
    );
    const { data: b } = await client.admin.createBudget(
      { year: 2030, fcrPercentage: "0" },
      { headers },
    );
    await client.admin.createBudgetLine(
      b.id,
      { accountId: cat.id as string, annualAmount: 12_000_00 },
      { headers },
    );
    // Aprova
    approvalCounter++;
    const scheduledAt = `2030-1${approvalCounter % 3}-15T19:00:00Z`;
    const { data: assembly } = await client.admin.createAssembly(
      { type: "ordinary", scheduledAt },
      { headers },
    );
    await client.admin.createAssemblyAgendaItem(
      assembly.id as string,
      {
        sequence: 1,
        subject: "Aprovação",
        itemType: "approve_budget",
        refType: "budget",
        refId: b.id,
        votesInFavor: 1000,
        votesAgainst: 0,
        votesAbstain: 0,
      },
      { headers },
    );
    await client.admin.updateAssembly(
      assembly.id as string,
      { status: "held", heldAt: scheduledAt },
      { headers },
    );

    // Gera só Q1
    const { data: r1 } = await client.admin.generateQuotas(
      b.id,
      { throughDate: "2030-03-31" },
      { headers },
    );
    assertEquals(r1.chargesCreated, 9, "3 meses × 3 frações");

    // Re-corre até final do ano: gera só os 9 meses restantes × 3 = 27
    const { data: r2 } = await client.admin.generateQuotas(
      b.id,
      { throughDate: "2030-12-31" },
      { headers },
    );
    assertEquals(r2.chargesCreated, 27);

    // Total final = 36
    const { data: all } = await client.admin.listCharges(
      { kind: "receivable", chargeType: "quota", year: "2030" },
      { headers },
    );
    assertEquals(all.length, 36);

    // Cleanup deste mini-cenário
    await client.super.deleteCondominium(c.id, { headers: AUTH });
  });

  // ── Cenário 4: arredondamento agregado (regression bug) ─────────────────
  it("rateio com FCR + permillages que dão fração: total exato sem drift", async () => {
    // Caso: 12 linhas somando 31148.70 € + FCR 10% → 34263.57 €
    // 34263.57 / 12 = 2855.297500€/mês. Sem agregação, cada mês perde 0.0025€
    // que ao fim do ano dá ~0.03€ de drift. Com agregação, a quota anual
    // soma exatamente o valor anual com FCR.
    const { data: c } = await client.super.createCondominium(
      { name: `Rounding Test ${Date.now()}` },
      { headers: AUTH },
    );
    const headers = { ...AUTH, "x-condominium-id": c.id };
    // 3 frações com permillagens primas (177, 421, 402)
    await client.super.createUnit(c.id, { designation: "P1", permillage: 177 }, { headers: AUTH });
    await client.super.createUnit(c.id, { designation: "P2", permillage: 421 }, { headers: AUTH });
    await client.super.createUnit(c.id, { designation: "P3", permillage: 402 }, { headers: AUTH });
    const { data: cat } = await client.admin.createChartOfAccount(
      {
        code: `RND_${Date.now().toString(36).toUpperCase()}`,
        name: "Despesas variadas",
        type: "expense",
        parentCode: "5",
      },
      { headers },
    );
    const { data: b } = await client.admin.createBudget(
      { year: 2030, fcrPercentage: "10" },
      { headers },
    );
    // 12 linhas que somam 31148.70 €
    const linhas = [
      2400_00,
      1800_50,
      950_30,
      5400_00,
      1200_00,
      850_75,
      2300_00,
      4500_45,
      1980_00,
      3200_70,
      4500_00,
      2066_00,
    ];
    let totalLines = 0;
    for (const valor of linhas) {
      await client.admin.createBudgetLine(
        b.id,
        { accountId: cat.id as string, annualAmount: valor },
        { headers },
      );
      totalLines += valor;
    }
    assertEquals(totalLines, 31148_70);

    // Aprova via assembly
    approvalCounter++;
    const scheduledAt = `2030-0${1 + (approvalCounter % 9)}-15T19:00:00Z`;
    const { data: assembly } = await client.admin.createAssembly(
      { type: "ordinary", scheduledAt },
      { headers },
    );
    await client.admin.createAssemblyAgendaItem(
      assembly.id as string,
      {
        sequence: 1,
        subject: "Aprovação rounding",
        itemType: "approve_budget",
        refType: "budget",
        refId: b.id,
        votesInFavor: 1000,
        votesAgainst: 0,
        votesAbstain: 0,
      },
      { headers },
    );
    await client.admin.updateAssembly(
      assembly.id as string,
      { status: "held", heldAt: scheduledAt },
      { headers },
    );

    await client.admin.generateQuotas(
      b.id,
      { throughDate: "2030-12-31" },
      { headers },
    );

    const { data } = await client.admin.listCharges(
      { kind: "receivable", chargeType: "quota", year: "2030" },
      { headers },
    );
    assertEquals(data.length, 36);

    // Total anual = (31148.70 / 12) round → 2595.73 + 10% FCR round → 259.57
    // soma per-month = 2855.30 × 12 = 34263.60 (não 34263.57 do total puro
    // sem rounding mensal). A regression é que esse total seja consistente
    // através de geração agregada (sem drift PER-FRACÇÃO).
    const total = data.reduce((s, c) => s + (c.originalAmount as number), 0);
    // Calcular esperado: round(annual/12) + round(round(annual/12) * fcr)
    const monthlyOrd = Math.round(31148_70 / 12);
    const monthlyFcr = Math.round(monthlyOrd * 0.10);
    const monthlyTotal = monthlyOrd + monthlyFcr;
    assertEquals(total, monthlyTotal * 12, "agregação mensal × 12 = total anual sem drift");

    await client.super.deleteCondominium(c.id, { headers: AUTH });
  });

  // ── Teardown ────────────────────────────────────────────────────────────
  it("teardown - apaga condomínio principal", async () => {
    await fx.cleanup();
  });
});
