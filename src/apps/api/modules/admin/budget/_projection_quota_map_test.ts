// formatBudgetQuotaMapForResponse: os valores por fração vêm SEMPRE do mapa
// (cobrado real OU previsão pelo algoritmo), nunca das colunas de valor da view.
// Regressão do bug em que o mapa exibido divergia do orçamento por arredondar
// base+FCR por fração e multiplicar por 12.

import { assertEquals } from "@std/assert";
import { formatBudgetQuotaMapForResponse } from "./_projection_quota_map.ts";
import type { BilledUnit } from "./_billed_by_unit.ts";

type Row = Parameters<typeof formatBudgetQuotaMapForResponse>[0][number];

// Linha da view = só esqueleto (fração, designação, permillage, metadados); os
// valores vêm sempre do mapa de amounts.
function row(over: Partial<Row>): Row {
  return {
    budgetId: "b1",
    year: 2026,
    budgetType: "principal",
    budgetStatus: "approved",
    quotasGeneratedAt: new Date("2026-04-24T00:00:00Z"),
    fcrPercentage: "10.00",
    unitId: "u1",
    unitDesignation: "A",
    unitPermillage: "500.000",
    totalPermillage: "1000",
    annualOrdinary: 3_114_870,
    identifier: null,
    ...over,
  } as Row;
}

Deno.test("soma das frações = total do mapa (cobrado/previsão), não a view", () => {
  const rows = [
    row({ unitId: "u1", unitDesignation: "A" }),
    row({ unitId: "u2", unitDesignation: "B" }),
  ];
  const amounts = new Map<string, BilledUnit>([
    ["u1", { billed: 51_000, periods: 12 }],
    ["u2", { billed: 49_000, periods: 12 }],
  ]);
  const res = formatBudgetQuotaMapForResponse(rows, amounts)!;
  // Anual = o mapa (não os 999999 da view).
  assertEquals(res.units[0].annualTotalCents, 51_000);
  assertEquals(res.units[1].annualTotalCents, 49_000);
  assertEquals(res.totals.annualTotalCents, 100_000);
});

Deno.test("split base/FCR reconstruído = fórmula do trigger (round(total/1.1))", () => {
  // Charge mensal 4192, FCR 10%: trigger faz base=round(4192/1.1)=3811, fcr=381
  // (ledger contas 721/723). A projeção tem de reproduzir isto.
  const rows = [row({ unitId: "u1", fcrPercentage: "10.00" })];
  const amounts = new Map<string, BilledUnit>([["u1", { billed: 4192 * 12, periods: 12 }]]);
  const res = formatBudgetQuotaMapForResponse(rows, amounts)!;
  assertEquals(res.units[0].monthlyTotalCents, 4192);
  assertEquals(res.units[0].monthlyBaseCents, 3811);
  assertEquals(res.units[0].monthlyFcrCents, 381);
});

Deno.test("fromCharges/periodsGenerated seguem quotasGeneratedAt", () => {
  const amounts = new Map<string, BilledUnit>([["u1", { billed: 12_000, periods: 12 }]]);

  const gerado = formatBudgetQuotaMapForResponse(
    [row({ quotasGeneratedAt: new Date("2026-04-24T00:00:00Z") })],
    amounts,
  )!;
  assertEquals(gerado.fromCharges, true);
  assertEquals(gerado.periodsGenerated, 12);

  const previsao = formatBudgetQuotaMapForResponse(
    [row({ quotasGeneratedAt: null })],
    amounts,
  )!;
  assertEquals(previsao.fromCharges, false);
  assertEquals(previsao.periodsGenerated, 0); // só conta meses quando gerado
});

Deno.test("fração sem valor no mapa cai para zero (não rebenta)", () => {
  const rows = [
    row({ unitId: "u1", unitDesignation: "A" }),
    row({ unitId: "u2", unitDesignation: "B" }),
  ];
  const amounts = new Map<string, BilledUnit>([["u1", { billed: 12_000, periods: 12 }]]);
  const res = formatBudgetQuotaMapForResponse(rows, amounts)!;
  assertEquals(res.units[1].annualTotalCents, 0);
  assertEquals(res.units[1].monthlyTotalCents, 0);
  assertEquals(res.totals.annualTotalCents, 12_000);
});
