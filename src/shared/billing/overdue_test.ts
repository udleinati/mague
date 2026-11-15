// Testes para classificação de charges em atraso (ADR 0028).
//
// Pure functions sobre o shape estrutural de uma charge - sem DB. O caller
// (handler API ou controller panel) extrai os campos da row Drizzle ou do
// DTO da API e passa o struct mínimo necessário.

import { assertEquals } from "@std/assert";
import {
  computeBillingEmailTotals,
  isChargeOverdueForBilling,
  overdueDaysAgainst,
} from "./overdue.ts";

Deno.test("isChargeOverdueForBilling: quota ordinária vencida há > 30d, não paga → overdue", () => {
  // due_date = 2026-04-15, ref = 2026-05-20 → 35 dias > 30. Não settled.
  const r = isChargeOverdueForBilling(
    {
      kind: "quota",
      nature: "debit",
      dueDate: "2026-04-15",
      amountCents: 10000,
      settledCents: 0,
    },
    "2026-05-20",
  );
  assertEquals(r, true);
});

Deno.test("isChargeOverdueForBilling: boundary - 30 dias exactos NÃO conta (regra é > 30)", () => {
  // due = 2026-04-20, ref = 2026-05-20 → 30 dias. Threshold é "> 30".
  const r = isChargeOverdueForBilling(
    { kind: "quota", nature: "debit", dueDate: "2026-04-20", amountCents: 10000, settledCents: 0 },
    "2026-05-20",
  );
  assertEquals(r, false);
});

Deno.test("isChargeOverdueForBilling: 31 dias conta", () => {
  const r = isChargeOverdueForBilling(
    { kind: "quota", nature: "debit", dueDate: "2026-04-19", amountCents: 10000, settledCents: 0 },
    "2026-05-20",
  );
  assertEquals(r, true);
});

Deno.test("isChargeOverdueForBilling: qualquer charge_type de débito dispara o gatilho", () => {
  // ADR 0028: dívida é dívida. Uma fração que só deve uma
  // refaturação ou o saldo inicial estava em dívida na página da fração e no
  // painel, mas era invisível na página de lembretes - e o valor não contava em
  // nenhum total. O que qualifica é ser débito, não o tipo.
  for (
    const kind of [
      "quota",
      "extraordinary_quota",
      "refacturation",
      "opening_balance_debit",
      "fine",
      "",
    ]
  ) {
    const r = isChargeOverdueForBilling(
      { kind, nature: "debit", dueDate: "2026-04-15", amountCents: 10000, settledCents: 0 },
      "2026-05-20",
    );
    assertEquals(r, true, `kind=${kind} devia ser true`);
  }
});

Deno.test("isChargeOverdueForBilling: charge de crédito nunca dispara nem é dívida", () => {
  // Nota de crédito / saldo credor está a favor da fração. Sem este guard, abrir
  // o gatilho a "qualquer charge_type" transformava crédito em dívida e o total
  // deixava de bater com o `v_unit_balance` do painel.
  for (const kind of ["credit_adjustment", "credit_balance", "openingBalance"]) {
    const r = isChargeOverdueForBilling(
      { kind, nature: "credit", dueDate: "2026-04-15", amountCents: 10000, settledCents: 0 },
      "2026-05-20",
    );
    assertEquals(r, false, `kind=${kind} devia ser false`);
  }
});

Deno.test("isChargeOverdueForBilling: settled total NÃO conta como atrasado", () => {
  const r = isChargeOverdueForBilling(
    {
      kind: "quota",
      nature: "debit",
      dueDate: "2026-04-15",
      amountCents: 10000,
      settledCents: 10000,
    },
    "2026-05-20",
  );
  assertEquals(r, false);
});

Deno.test("isChargeOverdueForBilling: settled parcial AINDA conta como atrasado", () => {
  // Pagou 60 €, deve 40 € → ainda há débito → overdue mantém-se true.
  const r = isChargeOverdueForBilling(
    {
      kind: "quota",
      nature: "debit",
      dueDate: "2026-04-15",
      amountCents: 10000,
      settledCents: 6000,
    },
    "2026-05-20",
  );
  assertEquals(r, true);
});

Deno.test("isChargeOverdueForBilling: dueDate null NÃO conta", () => {
  const r = isChargeOverdueForBilling(
    { kind: "quota", nature: "debit", dueDate: null, amountCents: 10000, settledCents: 0 },
    "2026-05-20",
  );
  assertEquals(r, false);
});

Deno.test("isChargeOverdueForBilling: ref antes do due (charge futura) NÃO conta", () => {
  // due no futuro - ainda nem venceu, nunca pode estar > 30d em atraso.
  const r = isChargeOverdueForBilling(
    { kind: "quota", nature: "debit", dueDate: "2026-06-15", amountCents: 10000, settledCents: 0 },
    "2026-05-20",
  );
  assertEquals(r, false);
});

Deno.test("isChargeOverdueForBilling: bloco +1 (threshold 0) - 1 dia de atraso conta", () => {
  // Bloco +1d: gatilho baixa para "vencida há >= 1 dia" (> 0).
  const r = isChargeOverdueForBilling(
    { kind: "quota", nature: "debit", dueDate: "2026-05-19", amountCents: 10000, settledCents: 0 },
    "2026-05-20",
    0,
  );
  assertEquals(r, true);
});

Deno.test("isChargeOverdueForBilling: bloco +1 (threshold 0) - vence no próprio dia da conciliação NÃO conta", () => {
  // 0 dias de atraso: venceu hoje (face à conciliação) → ainda não está atrasada.
  const r = isChargeOverdueForBilling(
    { kind: "quota", nature: "debit", dueDate: "2026-05-20", amountCents: 10000, settledCents: 0 },
    "2026-05-20",
    0,
  );
  assertEquals(r, false);
});

// ─── computeBillingEmailTotals ─────────────────────────────────────────

Deno.test("computeBillingEmailTotals: única quota vencida não paga", () => {
  const r = computeBillingEmailTotals(
    [
      {
        kind: "quota",
        nature: "debit",
        dueDate: "2026-04-15",
        amountCents: 10000,
        settledCents: 0,
      },
    ],
    "2026-05-20",
  );
  // 1 linha em dívida, sem crédito.
  assertEquals(r.totalOwedCents, 10000);
  assertEquals(r.creditCents, 0);
  assertEquals(r.lines.length, 1);
  assertEquals(r.lines[0].amountCents, 10000);
  assertEquals(r.lines[0].settledCents, 0);
});

Deno.test("computeBillingEmailTotals: charge totalmente paga NÃO entra na lista", () => {
  const r = computeBillingEmailTotals(
    [
      {
        kind: "quota",
        nature: "debit",
        dueDate: "2026-04-15",
        amountCents: 10000,
        settledCents: 10000,
      },
    ],
    "2026-05-20",
  );
  assertEquals(r.lines.length, 0);
  assertEquals(r.totalOwedCents, 0);
});

Deno.test("computeBillingEmailTotals: charge futura (após ref) NÃO entra", () => {
  // Quota de Junho ainda não venceu - email só fala do que está vencido.
  const r = computeBillingEmailTotals(
    [
      {
        kind: "quota",
        nature: "debit",
        dueDate: "2026-06-15",
        amountCents: 10000,
        settledCents: 0,
      },
    ],
    "2026-05-20",
  );
  assertEquals(r.lines.length, 0);
  assertEquals(r.totalOwedCents, 0);
});

Deno.test("computeBillingEmailTotals: settled parcial - outstanding correto", () => {
  // Pagou 60 €, deve 40 €. Linha aparece com outstanding=4000.
  const r = computeBillingEmailTotals(
    [
      {
        kind: "quota",
        nature: "debit",
        dueDate: "2026-04-15",
        amountCents: 10000,
        settledCents: 6000,
      },
    ],
    "2026-05-20",
  );
  assertEquals(r.lines.length, 1);
  assertEquals(r.lines[0].outstandingCents, 4000);
  assertEquals(r.totalOwedCents, 4000);
});

Deno.test("computeBillingEmailTotals: múltiplas charges + crédito existente", () => {
  // ADR 0028 edge case "fração tem crédito mas tem quota antiga em atraso":
  //   - 2 quotas vencidas em dívida (100 + 80)
  //   - 1 quota com settled em excesso (advance, paga 120 numa quota de 100)
  // Total em dívida = 180, crédito = 20 (mostrado no bloco).
  const r = computeBillingEmailTotals(
    [
      {
        kind: "quota",
        nature: "debit",
        dueDate: "2026-04-15",
        amountCents: 10000,
        settledCents: 0,
      },
      {
        kind: "refacturation",
        nature: "debit",
        dueDate: "2026-04-20",
        amountCents: 8000,
        settledCents: 0,
      },
      {
        kind: "quota",
        nature: "debit",
        dueDate: "2026-03-15",
        amountCents: 10000,
        settledCents: 12000,
      },
    ],
    "2026-05-20",
  );
  assertEquals(r.totalOwedCents, 18000);
  assertEquals(r.creditCents, 2000);
  assertEquals(r.lines.length, 2);
});

Deno.test("computeBillingEmailTotals: outras receivable (refacturation, opening_balance_debit) entram quando vencidas", () => {
  // ADR 0028: email lista TODAS receivable em aberto, não só quotas - o
  // gatilho é só quotas mas o detalhe é tudo. Schema real: charge_type
  // pode ser quota / refacturation / opening_balance_debit / fine / etc.
  const r = computeBillingEmailTotals(
    [
      {
        kind: "quota",
        nature: "debit",
        dueDate: "2026-04-15",
        amountCents: 10000,
        settledCents: 0,
      },
      {
        kind: "refacturation",
        nature: "debit",
        dueDate: "2026-04-20",
        amountCents: 5000,
        settledCents: 0,
      },
      {
        kind: "opening_balance_debit",
        nature: "debit",
        dueDate: "2026-04-10",
        amountCents: 3000,
        settledCents: 0,
      },
    ],
    "2026-05-20",
  );
  assertEquals(r.lines.length, 3);
  assertEquals(r.totalOwedCents, 18000);
});

Deno.test("computeBillingEmailTotals: lista vazia → totais zero", () => {
  const r = computeBillingEmailTotals([], "2026-05-20");
  assertEquals(r.totalOwedCents, 0);
  assertEquals(r.overdueBeyondThresholdCents, 0);
  assertEquals(r.creditCents, 0);
  assertEquals(r.lines.length, 0);
});

// ─── overdueBeyondThresholdCents - coluna "Vencido" (ADR 0039) ─────────────

Deno.test("computeBillingEmailTotals: Vencido separa dívida além do limiar (>30d default) do total vencido", () => {
  // Cenário do utilizador: a quota deste mês (vencida há 10d) entra no Total
  // vencido mas NÃO na coluna "Vencido". A quota antiga (35d) entra nas duas.
  // Se a função somasse tudo, este teste falhava.
  const r = computeBillingEmailTotals(
    [
      {
        kind: "quota",
        nature: "debit",
        dueDate: "2026-04-15",
        amountCents: 10000,
        settledCents: 0,
      }, // 35d
      { kind: "quota", nature: "debit", dueDate: "2026-05-10", amountCents: 6000, settledCents: 0 }, // 10d
    ],
    "2026-05-20",
  );
  assertEquals(r.totalOwedCents, 16000);
  assertEquals(r.overdueBeyondThresholdCents, 10000);
});

Deno.test("computeBillingEmailTotals: overdue30Plus respeita o boundary > 30 (30d exactos fora)", () => {
  const r = computeBillingEmailTotals(
    [
      { kind: "quota", nature: "debit", dueDate: "2026-04-20", amountCents: 5000, settledCents: 0 }, // 30d exactos
      { kind: "quota", nature: "debit", dueDate: "2026-04-19", amountCents: 7000, settledCents: 0 }, // 31d
    ],
    "2026-05-20",
  );
  assertEquals(r.totalOwedCents, 12000);
  assertEquals(r.overdueBeyondThresholdCents, 7000);
});

Deno.test("computeBillingEmailTotals: Vencido usa o outstanding (parcial), não o original", () => {
  const r = computeBillingEmailTotals(
    [
      {
        kind: "quota",
        nature: "debit",
        dueDate: "2026-04-15",
        amountCents: 10000,
        settledCents: 6000,
      }, // 35d, deve 40
    ],
    "2026-05-20",
  );
  assertEquals(r.overdueBeyondThresholdCents, 4000);
});

Deno.test("computeBillingEmailTotals: limiar dinâmico (60/90) - a coluna Vencido acompanha o bloco", () => {
  // 3 quotas: 95d, 65d, 35d de atraso. Total vencido = 18000 sempre.
  // Limiar 30 → todas (18000); 60 → as de 95d+65d (12000); 90 → só a de 95d (5000).
  const charges = [
    { kind: "quota", nature: "debit", dueDate: "2026-02-14", amountCents: 5000, settledCents: 0 }, // ~95d
    { kind: "quota", nature: "debit", dueDate: "2026-03-16", amountCents: 7000, settledCents: 0 }, // ~65d
    { kind: "quota", nature: "debit", dueDate: "2026-04-15", amountCents: 6000, settledCents: 0 }, // ~35d
  ];
  const ref = "2026-05-20";
  assertEquals(computeBillingEmailTotals(charges, ref).totalOwedCents, 18000);
  assertEquals(computeBillingEmailTotals(charges, ref, 30).overdueBeyondThresholdCents, 18000);
  assertEquals(computeBillingEmailTotals(charges, ref, 60).overdueBeyondThresholdCents, 12000);
  assertEquals(computeBillingEmailTotals(charges, ref, 90).overdueBeyondThresholdCents, 5000);
});

Deno.test("computeBillingEmailTotals: bloco +1 (threshold 0) - Vencido = tudo o que está vencido", () => {
  // Quota vencida ontem entra na coluna Vencido; a que vence no próprio dia
  // da conciliação entra no total (due <= ref) mas não na coluna (> 0).
  const r = computeBillingEmailTotals(
    [
      { kind: "quota", nature: "debit", dueDate: "2026-05-19", amountCents: 6000, settledCents: 0 }, // 1d
      { kind: "quota", nature: "debit", dueDate: "2026-05-20", amountCents: 5000, settledCents: 0 }, // 0d
    ],
    "2026-05-20",
    0,
  );
  assertEquals(r.totalOwedCents, 11000);
  assertEquals(r.overdueBeyondThresholdCents, 6000);
});

// ─── overdueDaysAgainst - idade do bloco (ADR 0039) ────────────────────

Deno.test("overdueDaysAgainst: dias de atraso face à conciliação (não a today)", () => {
  assertEquals(overdueDaysAgainst("2026-05-20", "2026-04-15"), 35);
  assertEquals(overdueDaysAgainst("2026-05-20", "2026-05-20"), 0); // vence no próprio dia
  assertEquals(overdueDaysAgainst("2026-05-20", "2026-06-15"), -26); // futura → negativo
});
