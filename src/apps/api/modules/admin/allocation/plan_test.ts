// Unit tests para planAllocation - cobre prioridade legal (Art. 784.º CC) e ordering por grupo.
// Correr:  deno test --allow-env src/apps/api/modules/admin/allocation/plan_test.ts

import { assertEquals } from "@std/assert";
import type { ChargeSelect } from "$api/libs/postgres/schemas/charge.ts";
import { planAllocation } from "./plan.ts";

const TODAY = new Date("2026-05-02T00:00:00.000Z");

// Factory de charges com defaults; testes só sobrescrevem os campos relevantes.
function ch(
  overrides: Partial<ChargeSelect> & { id: string; chargeType: string; openAmount: number },
): ChargeSelect {
  const base: ChargeSelect = {
    id: "_placeholder_",
    code: null,
    condominiumId: "c1",
    unitId: "u1",
    scope: "unit",
    nature: "debit",
    chargeType: "quota",
    status: "open",
    issueDate: "2026-01-01",
    dueDate: null,
    competencePeriod: "2026-01-01",
    budgetId: null,
    originalAmount: 0,
    settledAmount: 0,
    openAmount: 0,
    description: "",
    note: null,
    documentNumber: null,
    sourceType: null,
    sourceId: null,
    createdBy: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    kind: "receivable",
    accountId: null,
    expectedAmount: 0,
    amount: 0,
    supplierId: null,
    contractId: null,
    recurringTemplateId: null,
    invoiceNumber: null,
    paymentMethod: "manual",
    updatedBy: null,
  };
  return { ...base, ...overrides };
}

// ── Unit: prioridade entre grupos ─────────────────────────────────────────

Deno.test("unit: juros vão antes de tudo", () => {
  const charges = [
    ch({ id: "q1", chargeType: "quota", openAmount: 100_00, competencePeriod: "2026-01-01" }),
    ch({ id: "i1", chargeType: "interest", openAmount: 5_00, competencePeriod: "2026-04-01" }),
  ];
  const plan = planAllocation({
    bankTxAmount: 200_00,
    alreadyAllocated: 0,
    target: { kind: "unit" },
    openCharges: charges,
    today: TODAY,
  });
  assertEquals(plan.entries.map((e) => e.chargeId), ["i1", "q1"]);
  assertEquals(plan.entries[0].group, 1);
  assertEquals(plan.entries[1].group, 3);
});

Deno.test("unit: charge vencida sobe para grupo 2 mesmo sendo refaturação", () => {
  const charges = [
    ch({ id: "q1", chargeType: "quota", openAmount: 100_00, competencePeriod: "2026-05-01" }),
    ch({
      id: "ref-overdue",
      chargeType: "refacturation",
      openAmount: 50_00,
      dueDate: "2026-04-01", // < today (2026-05-02)
      competencePeriod: "2026-04-01",
    }),
  ];
  const plan = planAllocation({
    bankTxAmount: 200_00,
    alreadyAllocated: 0,
    target: { kind: "unit" },
    openCharges: charges,
    today: TODAY,
  });
  // ref-overdue está no grupo 2 (vencida); quota corrente fica no grupo 3.
  assertEquals(plan.entries.map((e) => e.chargeId), ["ref-overdue", "q1"]);
});

Deno.test("unit: status partial sobe para grupo 2", () => {
  const charges = [
    ch({ id: "q1", chargeType: "quota", openAmount: 100_00, competencePeriod: "2026-05-01" }),
    ch({
      id: "q-partial",
      chargeType: "quota",
      openAmount: 30_00,
      status: "partial",
      competencePeriod: "2026-04-01",
    }),
  ];
  const plan = planAllocation({
    bankTxAmount: 200_00,
    alreadyAllocated: 0,
    target: { kind: "unit" },
    openCharges: charges,
    today: TODAY,
  });
  assertEquals(plan.entries.map((e) => e.chargeId), ["q-partial", "q1"]);
});

Deno.test("unit: refaturação corrente fica no grupo 4 (depois de quotas correntes)", () => {
  const charges = [
    ch({
      id: "ref",
      chargeType: "refacturation",
      openAmount: 50_00,
      competencePeriod: "2026-01-01",
    }),
    ch({ id: "q1", chargeType: "quota", openAmount: 100_00, competencePeriod: "2026-05-01" }),
  ];
  const plan = planAllocation({
    bankTxAmount: 200_00,
    alreadyAllocated: 0,
    target: { kind: "unit" },
    openCharges: charges,
    today: TODAY,
  });
  assertEquals(plan.entries.map((e) => e.chargeId), ["q1", "ref"]);
  assertEquals(plan.entries[0].group, 3);
  assertEquals(plan.entries[1].group, 4);
});

// ── Unit: ordering dentro de cada grupo ───────────────────────────────────

Deno.test("unit: dentro de grupo, competence_period ASC", () => {
  const charges = [
    ch({ id: "q-mar", chargeType: "quota", openAmount: 100_00, competencePeriod: "2026-03-01" }),
    ch({ id: "q-jan", chargeType: "quota", openAmount: 100_00, competencePeriod: "2026-01-01" }),
    ch({ id: "q-feb", chargeType: "quota", openAmount: 100_00, competencePeriod: "2026-02-01" }),
  ];
  const plan = planAllocation({
    bankTxAmount: 500_00,
    alreadyAllocated: 0,
    target: { kind: "unit" },
    openCharges: charges,
    today: TODAY,
  });
  assertEquals(plan.entries.map((e) => e.chargeId), ["q-jan", "q-feb", "q-mar"]);
});

// ── Unit: surplus ─────────────────────────────────────────────────────────

Deno.test("unit: surplus quando bank_tx > soma de open_amounts", () => {
  const charges = [ch({ id: "q1", chargeType: "quota", openAmount: 50_00 })];
  const plan = planAllocation({
    bankTxAmount: 100_00,
    alreadyAllocated: 0,
    target: { kind: "unit" },
    openCharges: charges,
    today: TODAY,
  });
  assertEquals(plan.entries.length, 1);
  assertEquals(plan.entries[0].amount, 50_00);
  assertEquals(plan.surplus, 50_00);
});

Deno.test("unit: sem charges, todo o valor é surplus", () => {
  const plan = planAllocation({
    bankTxAmount: 100_00,
    alreadyAllocated: 0,
    target: { kind: "unit" },
    openCharges: [],
    today: TODAY,
  });
  assertEquals(plan.entries.length, 0);
  assertEquals(plan.surplus, 100_00);
});

Deno.test("unit: alreadyAllocated reduz o valor disponível", () => {
  const charges = [ch({ id: "q1", chargeType: "quota", openAmount: 100_00 })];
  const plan = planAllocation({
    bankTxAmount: 100_00,
    alreadyAllocated: 30_00,
    target: { kind: "unit" },
    openCharges: charges,
    today: TODAY,
  });
  // Só sobram 70€ para alocar.
  assertEquals(plan.entries[0].amount, 70_00);
  assertEquals(plan.surplus, 0);
});

Deno.test("unit: alreadyAllocated >= bank_tx → plano vazio", () => {
  const charges = [ch({ id: "q1", chargeType: "quota", openAmount: 100_00 })];
  const plan = planAllocation({
    bankTxAmount: 100_00,
    alreadyAllocated: 100_00,
    target: { kind: "unit" },
    openCharges: charges,
    today: TODAY,
  });
  assertEquals(plan.entries.length, 0);
  assertEquals(plan.surplus, 0);
});

// ── Unit: pagamento parcial (LEAST(remaining, open_amount)) ───────────────

Deno.test("unit: paga charge parcialmente quando bank_tx é menor", () => {
  const charges = [ch({ id: "q1", chargeType: "quota", openAmount: 100_00 })];
  const plan = planAllocation({
    bankTxAmount: 30_00,
    alreadyAllocated: 0,
    target: { kind: "unit" },
    openCharges: charges,
    today: TODAY,
  });
  assertEquals(plan.entries[0].amount, 30_00);
  assertEquals(plan.surplus, 0);
});

// ── Supplier: prioridade vencidas → outras ─────────────────────────────────

Deno.test("supplier: faturas vencidas/parciais sobem antes das correntes", () => {
  const charges = [
    ch({
      id: "f1",
      chargeType: "expense",
      openAmount: 100_00,
      kind: "payable",
      competencePeriod: "2026-05-01",
    }),
    ch({
      id: "f-overdue",
      chargeType: "expense",
      openAmount: 50_00,
      kind: "payable",
      dueDate: "2026-04-01",
      competencePeriod: "2026-04-01",
    }),
  ];
  const plan = planAllocation({
    bankTxAmount: 200_00,
    alreadyAllocated: 0,
    target: { kind: "supplier" },
    openCharges: charges,
    today: TODAY,
  });
  assertEquals(plan.entries.map((e) => e.chargeId), ["f-overdue", "f1"]);
  assertEquals(plan.entries[0].group, 1);
  assertEquals(plan.entries[1].group, 2);
});

// ── Unit: filtro por chargeType (seletor Todas / Só ordinárias / Só extraordinárias) ──

Deno.test("chargeTypes: só extraordinárias ignora quotas ordinárias e juros", () => {
  const charges = [
    ch({ id: "i1", chargeType: "interest", openAmount: 5_00, competencePeriod: "2026-01-01" }),
    ch({ id: "q1", chargeType: "quota", openAmount: 100_00, competencePeriod: "2026-01-01" }),
    ch({
      id: "e1",
      chargeType: "extraordinary_quota",
      openAmount: 40_00,
      competencePeriod: "2026-02-01",
    }),
  ];
  const plan = planAllocation({
    bankTxAmount: 200_00,
    alreadyAllocated: 0,
    target: { kind: "unit" },
    openCharges: charges,
    today: TODAY,
    chargeTypes: ["extraordinary_quota"],
  });
  // Só a extraordinária é elegível; o resto (100+5) fica por pagar → surplus vira crédito.
  assertEquals(plan.entries.map((e) => e.chargeId), ["e1"]);
  assertEquals(plan.entries[0].amount, 40_00);
  assertEquals(plan.surplus, 160_00);
});

Deno.test("chargeTypes: só ordinárias ignora extraordinárias", () => {
  const charges = [
    ch({ id: "q1", chargeType: "quota", openAmount: 100_00, competencePeriod: "2026-01-01" }),
    ch({
      id: "e1",
      chargeType: "extraordinary_quota",
      openAmount: 40_00,
      competencePeriod: "2026-01-01",
    }),
  ];
  const plan = planAllocation({
    bankTxAmount: 200_00,
    alreadyAllocated: 0,
    target: { kind: "unit" },
    openCharges: charges,
    today: TODAY,
    chargeTypes: ["quota"],
  });
  assertEquals(plan.entries.map((e) => e.chargeId), ["q1"]);
  assertEquals(plan.surplus, 100_00);
});

Deno.test("chargeTypes: vazio/undefined mantém todos os tipos (Todas)", () => {
  const charges = [
    ch({ id: "q1", chargeType: "quota", openAmount: 100_00, competencePeriod: "2026-01-01" }),
    ch({
      id: "e1",
      chargeType: "extraordinary_quota",
      openAmount: 40_00,
      competencePeriod: "2026-02-01",
    }),
  ];
  const plan = planAllocation({
    bankTxAmount: 200_00,
    alreadyAllocated: 0,
    target: { kind: "unit" },
    openCharges: charges,
    today: TODAY,
  });
  // Ambas elegíveis, ordenadas por competência ASC.
  assertEquals(plan.entries.map((e) => e.chargeId), ["q1", "e1"]);
});

Deno.test("supplier: dentro do grupo, competence_period ASC, depois issue_date ASC", () => {
  const charges = [
    ch({
      id: "f-feb",
      chargeType: "expense",
      openAmount: 100_00,
      kind: "payable",
      competencePeriod: "2026-02-01",
      issueDate: "2026-02-15",
    }),
    ch({
      id: "f-jan-late",
      chargeType: "expense",
      openAmount: 100_00,
      kind: "payable",
      competencePeriod: "2026-01-01",
      issueDate: "2026-02-20",
    }),
    ch({
      id: "f-jan-early",
      chargeType: "expense",
      openAmount: 100_00,
      kind: "payable",
      competencePeriod: "2026-01-01",
      issueDate: "2026-01-15",
    }),
  ];
  const plan = planAllocation({
    bankTxAmount: 500_00,
    alreadyAllocated: 0,
    target: { kind: "supplier" },
    openCharges: charges,
    today: TODAY,
  });
  // Competência igual entre jan-early e jan-late → tie-break por issue_date.
  assertEquals(plan.entries.map((e) => e.chargeId), ["f-jan-early", "f-jan-late", "f-feb"]);
});

// ── Edge cases ─────────────────────────────────────────────────────────────

Deno.test("openAmount=0 é ignorada (defensive - não deveria vir do filtro)", () => {
  const charges = [
    ch({ id: "q-zero", chargeType: "quota", openAmount: 0 }),
    ch({ id: "q1", chargeType: "quota", openAmount: 50_00 }),
  ];
  const plan = planAllocation({
    bankTxAmount: 100_00,
    alreadyAllocated: 0,
    target: { kind: "unit" },
    openCharges: charges,
    today: TODAY,
  });
  assertEquals(plan.entries.length, 1);
  assertEquals(plan.entries[0].chargeId, "q1");
});

Deno.test("competencePeriod NULL fica no fim do grupo (NULLS LAST)", () => {
  // Embora a coluna seja NOT NULL no schema atual, o algoritmo defende-se
  // contra isso (helper compareNullableDate).
  const charges = [
    ch({ id: "q1", chargeType: "quota", openAmount: 100_00, competencePeriod: "2026-01-01" }),
    ch({
      id: "q-null",
      chargeType: "quota",
      openAmount: 100_00,
      competencePeriod: null as unknown as string,
    }),
  ];
  const plan = planAllocation({
    bankTxAmount: 500_00,
    alreadyAllocated: 0,
    target: { kind: "unit" },
    openCharges: charges,
    today: TODAY,
  });
  assertEquals(plan.entries.map((e) => e.chargeId), ["q1", "q-null"]);
});
