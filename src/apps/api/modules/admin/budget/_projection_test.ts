// Testes unitários para `formatBudgetForResponse` - foca nas duas regras
// que dependem da projection:
//   1. Lines enriquecidas com categoryCode/categoryDescription do chartOfAccount.
//   2. Lines ordenadas por categoryCode com comparação numérica por segmento
//      (5.1.2 antes de 5.1.10), não localeCompare puro.

import { assertEquals } from "@std/assert";
import { formatBudgetForResponse } from "./_projection.ts";

// Helper: monta uma row de budget com N lines a partir de specs simples.
// `as never` no fim absorve os campos opcionais do schema (excludedUnitCategories,
// audit fields, etc.) que não são relevantes para estes testes.
function makeBudget(
  lines: Array<{
    id: string;
    categoryCode: string | null;
    categoryName?: string;
    categoryDescription?: string | null;
    deletedAt?: Date | null;
    annualAmount?: number;
  }>,
  fcrPercentage = "10",
) {
  return {
    id: "b1",
    condominiumId: "c1",
    year: "2027",
    status: "draft",
    fcrPercentage,
    budgetLines: lines.map((l) => ({
      id: l.id,
      budgetId: "b1",
      accountId: `acc_${l.id}`,
      annualAmount: l.annualAmount ?? 0,
      notes: null,
      deletedAt: l.deletedAt ?? null,
      createdAt: new Date(),
      excludedUnitCategories: null,
      chartOfAccount: l.categoryCode === null ? undefined : {
        id: `acc_${l.id}`,
        code: l.categoryCode,
        name: l.categoryName ?? "Cat",
        description: l.categoryDescription ?? null,
        type: "expense",
        condominiumId: null,
        parentCode: null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      },
    })),
  } as never;
}

Deno.test("formatBudgetForResponse - lines expõem categoryCode + categoryDescription do chartOfAccount", () => {
  const r = formatBudgetForResponse(makeBudget([
    {
      id: "L1",
      categoryCode: "5.1.1",
      categoryName: "Eletricidade",
      categoryDescription: "Luz comum",
    },
  ]));
  assertEquals(r.lines.length, 1);
  assertEquals(r.lines[0].categoryName, "Eletricidade");
  assertEquals(r.lines[0].categoryCode, "5.1.1");
  assertEquals(r.lines[0].categoryDescription, "Luz comum");
});

Deno.test("formatBudgetForResponse - line sem chartOfAccount tem code/description=null", () => {
  // Caso defensivo: budgetLine devolvida sem chartOfAccount aninhado (ex.:
  // queries que falharam ao trazer o nested) - formatter não crasha, expõe null.
  const r = formatBudgetForResponse(makeBudget([
    { id: "L1", categoryCode: null },
  ]));
  assertEquals(r.lines[0].categoryName, null);
  assertEquals(r.lines[0].categoryCode, null);
  assertEquals(r.lines[0].categoryDescription, null);
});

Deno.test("formatBudgetForResponse - sort numérico por segmento: 5.1.2 antes de 5.1.10 (não localeCompare)", () => {
  // localeCompare puro poria "5.1.10" antes de "5.1.2" (string compare); a
  // projection usa segmentos numéricos.
  const r = formatBudgetForResponse(makeBudget([
    { id: "L_dez", categoryCode: "5.1.10" },
    { id: "L_um", categoryCode: "5.1.1" },
    { id: "L_dois", categoryCode: "5.1.2" },
  ]));
  assertEquals(
    r.lines.map((l) => l.categoryCode),
    ["5.1.1", "5.1.2", "5.1.10"],
  );
});

Deno.test("formatBudgetForResponse - lines sem categoryCode vão para o fim", () => {
  const r = formatBudgetForResponse(makeBudget([
    { id: "L_null", categoryCode: null },
    { id: "L_um", categoryCode: "5.1.1" },
  ]));
  assertEquals(
    r.lines.map((l) => l.id),
    ["L_um", "L_null"],
  );
});

Deno.test("formatBudgetForResponse - filtra lines soft-deleted", () => {
  const r = formatBudgetForResponse(makeBudget([
    { id: "L1", categoryCode: "5.1.1", deletedAt: null },
    { id: "L2", categoryCode: "5.1.2", deletedAt: new Date() },
  ]));
  assertEquals(r.lines.length, 1);
  assertEquals(r.lines[0].id, "L1");
});

Deno.test("formatBudgetForResponse - totalAmount soma só lines vivas", () => {
  const r = formatBudgetForResponse(makeBudget([
    { id: "L1", categoryCode: "5.1.1", annualAmount: 1000 },
    { id: "L2", categoryCode: "5.1.2", annualAmount: 2000 },
    { id: "L3", categoryCode: "5.1.3", annualAmount: 9999, deletedAt: new Date() },
  ]));
  assertEquals(r.lines.length, 2);
  assertEquals(r.totalAmount, 3000);
});

Deno.test("formatBudgetForResponse - fcrAmount = round(totalAmount × fcrPercentage / 100)", () => {
  const r = formatBudgetForResponse(
    makeBudget([{ id: "L1", categoryCode: null, annualAmount: 12345 }], "15"),
  );
  // 12345 × 0.15 = 1851.75 → round → 1852
  assertEquals(r.fcrAmount, 1852);
});

Deno.test("formatBudgetForResponse - segmentos não-numéricos caem para localeCompare", () => {
  // Edge case: codes com letras (ex: "5.1.A" vs "5.1.B"). O algoritmo tenta
  // numeric, falha, recorre a localeCompare. Letras ordenam alfabeticamente.
  const r = formatBudgetForResponse(makeBudget([
    { id: "L_b", categoryCode: "5.1.B" },
    { id: "L_a", categoryCode: "5.1.A" },
  ]));
  assertEquals(
    r.lines.map((l) => l.categoryCode),
    ["5.1.A", "5.1.B"],
  );
});
