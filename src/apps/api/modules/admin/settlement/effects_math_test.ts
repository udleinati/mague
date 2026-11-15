// Tests para as funções puras de transição em `effects_math.ts`.
//
// Validamos:
//   • forward/reverse de offset (sinal correto, status recomputado)
//   • forward/reverse de bank_reconciliation (incluindo `amount` change)
//   • asymmetria do bank_tx status (forward NÃO tem guard 'reversed';
//     reverse TEM)

import { assertEquals } from "@std/assert";
import {
  type ChargeState,
  computeBankReconciliationTransition,
  computeBankTxStatus,
  computeOffsetSideTransition,
} from "./effects_math.ts";

const today = new Date("2026-05-15T00:00:00Z");

// Charge baseline: 100€ open, 0 settled, no due date.
const baselineCharge: ChargeState = {
  settledAmount: 0,
  openAmount: 100_00,
  amount: 100_00,
  expectedAmount: 100_00,
  originalAmount: 100_00,
  status: "open",
  dueDate: null,
};

// ── computeOffsetSideTransition ───────────────────────────────────────────

Deno.test("offsetSideTransition forward - adiciona ao settled, subtrai do open", () => {
  const r = computeOffsetSideTransition(baselineCharge, 30_00, "forward", today);
  assertEquals(r.settledAmount, 30_00);
  assertEquals(r.openAmount, 70_00);
  assertEquals(r.amount, 100_00); // amount NÃO muda em offset
  assertEquals(r.status, "partial");
});

Deno.test("offsetSideTransition forward - open=0 → status='paid'", () => {
  const r = computeOffsetSideTransition(baselineCharge, 100_00, "forward", today);
  assertEquals(r.openAmount, 0);
  assertEquals(r.status, "paid");
});

Deno.test("offsetSideTransition reverse - subtrai do settled, adiciona ao open", () => {
  const charge: ChargeState = {
    ...baselineCharge,
    settledAmount: 30_00,
    openAmount: 70_00,
    status: "partial",
  };
  const r = computeOffsetSideTransition(charge, 30_00, "reverse", today);
  assertEquals(r.settledAmount, 0);
  assertEquals(r.openAmount, 100_00);
  assertEquals(r.amount, 100_00);
  assertEquals(r.status, "open");
});

Deno.test("offsetSideTransition reverse - paid → open quando open volta a > 0", () => {
  const charge: ChargeState = {
    ...baselineCharge,
    settledAmount: 100_00,
    openAmount: 0,
    status: "paid",
  };
  const r = computeOffsetSideTransition(charge, 100_00, "reverse", today);
  assertEquals(r.settledAmount, 0);
  assertEquals(r.openAmount, 100_00);
  assertEquals(r.status, "open");
});

Deno.test("offsetSideTransition - overdue quando dueDate passou", () => {
  const charge: ChargeState = { ...baselineCharge, dueDate: "2025-12-31" };
  const r = computeOffsetSideTransition(charge, 0, "forward", today);
  assertEquals(r.status, "overdue");
});

// ── computeBankReconciliationTransition ───────────────────────────────────

Deno.test("bankReconciliationTransition forward debit - settled+amount mudam, open recompõe de expected", () => {
  const charge: ChargeState = { ...baselineCharge, expectedAmount: 80_00 };
  const r = computeBankReconciliationTransition(charge, /*isDebit*/ true, 50_00, "forward", today);
  assertEquals(r.settledAmount, 50_00);
  assertEquals(r.amount, 150_00); // amount += sign * settlementAmount
  assertEquals(r.openAmount, 30_00); // expected (80) - newSettled (50)
  assertEquals(r.status, "partial");
});

Deno.test("bankReconciliationTransition forward credit - base é originalAmount, não expected", () => {
  const charge: ChargeState = { ...baselineCharge, originalAmount: 100_00, expectedAmount: 50_00 };
  const r = computeBankReconciliationTransition(charge, /*isDebit*/ false, 30_00, "forward", today);
  assertEquals(r.openAmount, 70_00); // original (100) - newSettled (30)
});

Deno.test("bankReconciliationTransition reverse - sinal trocado", () => {
  const charge: ChargeState = {
    ...baselineCharge,
    settledAmount: 50_00,
    amount: 150_00,
    openAmount: 50_00,
    status: "partial",
  };
  const r = computeBankReconciliationTransition(charge, /*isDebit*/ true, 50_00, "reverse", today);
  assertEquals(r.settledAmount, 0);
  assertEquals(r.amount, 100_00);
  assertEquals(r.openAmount, 100_00);
  assertEquals(r.status, "open");
});

Deno.test("bankReconciliationTransition - open nunca fica negativo", () => {
  const charge: ChargeState = { ...baselineCharge, expectedAmount: 50_00 };
  const r = computeBankReconciliationTransition(charge, /*isDebit*/ true, 100_00, "forward", today);
  // newSettled (100) > base (50) → open seria -50, capa em 0
  assertEquals(r.openAmount, 0);
  assertEquals(r.status, "paid");
});

Deno.test("bankReconciliationTransition - status cancelled mantém-se", () => {
  const charge: ChargeState = { ...baselineCharge, status: "cancelled" };
  const r = computeBankReconciliationTransition(charge, /*isDebit*/ true, 50_00, "forward", today);
  assertEquals(r.status, "cancelled");
});

// ── computeBankTxStatus (asymmetria forward/reverse) ──────────────────────

Deno.test("bankTxStatus - allocated >= abs → reconciled", () => {
  assertEquals(computeBankTxStatus("unreconciled", 100_00, 100_00, "forward"), "reconciled");
  assertEquals(computeBankTxStatus("partial", 100_00, 100_00, "reverse"), "reconciled");
});

Deno.test("bankTxStatus - allocated > 0 mas < abs → partial", () => {
  assertEquals(computeBankTxStatus("unreconciled", 30_00, 100_00, "forward"), "partial");
});

Deno.test("bankTxStatus - allocated == 0 → unreconciled", () => {
  assertEquals(computeBankTxStatus("partial", 0, 100_00, "forward"), "unreconciled");
});

Deno.test("bankTxStatus - REVERSE com tx já 'reversed' → mantém 'reversed' (idempotente)", () => {
  // Crítico: isto previne race condition em cascade reverse - quando outro
  // caller marca a tx 'reversed' e nós já estamos a reverter um settlement,
  // não queremos rebaixar para 'partial'.
  assertEquals(computeBankTxStatus("reversed", 0, 100_00, "reverse"), "reversed");
  assertEquals(computeBankTxStatus("reversed", 50_00, 100_00, "reverse"), "reversed");
  assertEquals(computeBankTxStatus("reversed", 100_00, 100_00, "reverse"), "reversed");
});

Deno.test("bankTxStatus - FORWARD com tx 'reversed' RECUPERA (sem guard)", () => {
  // Crítico: admin reverteu por engano, depois faz allocate_to_unit. O
  // INSERT settlement nova passa por aqui em forward - DEVE permitir mover
  // a tx de volta a 'reconciled'/'partial'. Este é o cenário 2 do
  // reconciliation_flows_test.
  assertEquals(computeBankTxStatus("reversed", 100_00, 100_00, "forward"), "reconciled");
  assertEquals(computeBankTxStatus("reversed", 50_00, 100_00, "forward"), "partial");
  assertEquals(computeBankTxStatus("reversed", 0, 100_00, "forward"), "unreconciled");
});
