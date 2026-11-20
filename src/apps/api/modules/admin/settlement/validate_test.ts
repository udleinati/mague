// Validations puras de settlement antes do INSERT. Testes pinning cada
// regra que existe em `validate.ts` (mirror do trigger fn_settlement_bi).
//
// O sistema tem 3 settlement types - cada um com regras próprias:
//
//   • bank_reconciliation: bank_tx ↔ charge (1 lado, debit XOR credit)
//   • charge_offset:       charge ↔ charge (debit + credit, sem bank_tx)
//   • bank_deposit_credit: bank_tx ↔ credit charge (recibo)
//
// Validações comuns: amount > 0; entidades referenciadas existem; amount
// não excede o open_amount do alvo nem o saldo não-alocado do bank_tx.

import { assertEquals, assertThrows } from "@std/assert";
import { AppError } from "$api/libs/error/app_error.ts";
import {
  type ChargeSide,
  type SettlementInput,
  type SettlementType,
  validateSettlement,
  validateSettlementSides,
  type ValidationContext,
} from "./validate.ts";

// Helpers para reduzir boilerplate. Defaults razoáveis - testes sobrescrevem
// só o que é relevante para o caso.
function input(
  overrides: Partial<SettlementInput> & { settlementType: SettlementType },
): SettlementInput {
  return {
    amount: 100,
    bankTransactionId: null,
    debitChargeId: null,
    creditChargeId: null,
    ...overrides,
  };
}

function ctx(overrides: Partial<ValidationContext> = {}): ValidationContext {
  return {
    debitChargeOpen: null,
    creditChargeOpen: null,
    bankTxAbs: null,
    bankTxAlreadyAllocated: 0,
    ...overrides,
  };
}

// ─── Validações partilhadas ────────────────────────────────────────────────

Deno.test("amount <= 0 → AppError VALIDATION_ERROR", () => {
  const err = assertThrows(
    () =>
      validateSettlement(
        input({
          settlementType: "charge_offset",
          amount: 0,
          debitChargeId: "d",
          creditChargeId: "c",
        }),
        ctx({ debitChargeOpen: 100, creditChargeOpen: 100 }),
      ),
    AppError,
  );
  assertEquals(err.code, "VALIDATION_ERROR");
});

Deno.test("amount negativo é rejeitado", () => {
  assertThrows(
    () =>
      validateSettlement(
        input({
          settlementType: "charge_offset",
          amount: -50,
          debitChargeId: "d",
          creditChargeId: "c",
        }),
        ctx({ debitChargeOpen: 100, creditChargeOpen: 100 }),
      ),
    AppError,
  );
});

Deno.test("settlement_type desconhecido → AppError", () => {
  assertThrows(
    () =>
      validateSettlement(
        input({ settlementType: "invalid_type" as SettlementType }),
        ctx(),
      ),
    AppError,
  );
});

// ─── charge_offset ─────────────────────────────────────────────────────────
// Liga 2 charges (debit + credit) da mesma fração. Não envolve bank_tx.

Deno.test("charge_offset: happy path com ambas charges existentes e amount fits", () => {
  // Não atira - devolve undefined.
  validateSettlement(
    input({
      settlementType: "charge_offset",
      debitChargeId: "d1",
      creditChargeId: "c1",
      amount: 50,
    }),
    ctx({ debitChargeOpen: 100, creditChargeOpen: 80 }),
  );
});

Deno.test("charge_offset: debitChargeId em falta → 400", () => {
  assertThrows(
    () =>
      validateSettlement(
        input({ settlementType: "charge_offset", creditChargeId: "c1" }),
        ctx({ creditChargeOpen: 100 }),
      ),
    AppError,
  );
});

Deno.test("charge_offset: creditChargeId em falta → 400", () => {
  assertThrows(
    () =>
      validateSettlement(
        input({ settlementType: "charge_offset", debitChargeId: "d1" }),
        ctx({ debitChargeOpen: 100 }),
      ),
    AppError,
  );
});

Deno.test("charge_offset: rejeita bank_transaction_id (não pertence ao type)", () => {
  assertThrows(
    () =>
      validateSettlement(
        input({
          settlementType: "charge_offset",
          debitChargeId: "d",
          creditChargeId: "c",
          bankTransactionId: "bt1",
        }),
        ctx({ debitChargeOpen: 100, creditChargeOpen: 100 }),
      ),
    AppError,
  );
});

Deno.test("charge_offset: debit charge não existente → 404 NOT_FOUND", () => {
  const err = assertThrows(
    () =>
      validateSettlement(
        input({ settlementType: "charge_offset", debitChargeId: "ghost", creditChargeId: "c" }),
        ctx({ debitChargeOpen: null, creditChargeOpen: 100 }),
      ),
    AppError,
  );
  assertEquals(err.code, "NOT_FOUND");
  assertEquals(err.statusCode, 404);
});

Deno.test("charge_offset: credit charge não existente → 404", () => {
  const err = assertThrows(
    () =>
      validateSettlement(
        input({ settlementType: "charge_offset", debitChargeId: "d", creditChargeId: "ghost" }),
        ctx({ debitChargeOpen: 100, creditChargeOpen: null }),
      ),
    AppError,
  );
  assertEquals(err.code, "NOT_FOUND");
});

Deno.test("charge_offset: amount > debitChargeOpen → 400", () => {
  assertThrows(
    () =>
      validateSettlement(
        input({
          settlementType: "charge_offset",
          debitChargeId: "d",
          creditChargeId: "c",
          amount: 200,
        }),
        ctx({ debitChargeOpen: 100, creditChargeOpen: 500 }),
      ),
    AppError,
  );
});

Deno.test("charge_offset: amount > creditChargeOpen → 400", () => {
  assertThrows(
    () =>
      validateSettlement(
        input({
          settlementType: "charge_offset",
          debitChargeId: "d",
          creditChargeId: "c",
          amount: 200,
        }),
        ctx({ debitChargeOpen: 500, creditChargeOpen: 100 }),
      ),
    AppError,
  );
});

Deno.test("charge_offset: amount = open_amount exato (boundary) é aceite", () => {
  validateSettlement(
    input({
      settlementType: "charge_offset",
      debitChargeId: "d",
      creditChargeId: "c",
      amount: 100,
    }),
    ctx({ debitChargeOpen: 100, creditChargeOpen: 100 }),
  );
});

// ─── bank_reconciliation ───────────────────────────────────────────────────
// bank_tx ↔ charge. Exactly one of (debit, credit) preenchido (XOR).

Deno.test("bank_reconciliation: happy path com debit charge", () => {
  validateSettlement(
    input({
      settlementType: "bank_reconciliation",
      bankTransactionId: "bt1",
      debitChargeId: "d1",
      amount: 50,
    }),
    ctx({ bankTxAbs: 100, debitChargeOpen: 100 }),
  );
});

Deno.test("bank_reconciliation: happy path com credit charge", () => {
  validateSettlement(
    input({
      settlementType: "bank_reconciliation",
      bankTransactionId: "bt1",
      creditChargeId: "c1",
      amount: 50,
    }),
    ctx({ bankTxAbs: 100, creditChargeOpen: 100 }),
  );
});

Deno.test("bank_reconciliation: bankTransactionId em falta → 400", () => {
  assertThrows(
    () =>
      validateSettlement(
        input({ settlementType: "bank_reconciliation", debitChargeId: "d1" }),
        ctx({ debitChargeOpen: 100 }),
      ),
    AppError,
  );
});

Deno.test("bank_reconciliation: bank_tx não existente → 404", () => {
  const err = assertThrows(
    () =>
      validateSettlement(
        input({
          settlementType: "bank_reconciliation",
          bankTransactionId: "ghost",
          debitChargeId: "d",
        }),
        ctx({ bankTxAbs: null, debitChargeOpen: 100 }),
      ),
    AppError,
  );
  assertEquals(err.code, "NOT_FOUND");
});

Deno.test("bank_reconciliation: amount > saldo não-alocado → 400", () => {
  // bankTxAbs=100, alreadyAllocated=80 → remaining=20. amount=50 deve falhar.
  assertThrows(
    () =>
      validateSettlement(
        input({
          settlementType: "bank_reconciliation",
          bankTransactionId: "bt1",
          debitChargeId: "d",
          amount: 50,
        }),
        ctx({ bankTxAbs: 100, bankTxAlreadyAllocated: 80, debitChargeOpen: 1000 }),
      ),
    AppError,
  );
});

Deno.test("bank_reconciliation: amount = saldo restante (boundary) é aceite", () => {
  validateSettlement(
    input({
      settlementType: "bank_reconciliation",
      bankTransactionId: "bt1",
      debitChargeId: "d",
      amount: 20,
    }),
    ctx({ bankTxAbs: 100, bankTxAlreadyAllocated: 80, debitChargeOpen: 1000 }),
  );
});

Deno.test("bank_reconciliation: ambos debit + credit → XOR violado", () => {
  assertThrows(
    () =>
      validateSettlement(
        input({
          settlementType: "bank_reconciliation",
          bankTransactionId: "bt1",
          debitChargeId: "d",
          creditChargeId: "c",
        }),
        ctx({ bankTxAbs: 100, debitChargeOpen: 100, creditChargeOpen: 100 }),
      ),
    AppError,
  );
});

Deno.test("bank_reconciliation: nem debit nem credit → XOR violado", () => {
  assertThrows(
    () =>
      validateSettlement(
        input({ settlementType: "bank_reconciliation", bankTransactionId: "bt1" }),
        ctx({ bankTxAbs: 100 }),
      ),
    AppError,
  );
});

Deno.test("bank_reconciliation: debit charge não existente → 404", () => {
  const err = assertThrows(
    () =>
      validateSettlement(
        input({
          settlementType: "bank_reconciliation",
          bankTransactionId: "bt1",
          debitChargeId: "ghost",
        }),
        ctx({ bankTxAbs: 100, debitChargeOpen: null }),
      ),
    AppError,
  );
  assertEquals(err.code, "NOT_FOUND");
});

Deno.test("bank_reconciliation: amount > debitChargeOpen → 400", () => {
  assertThrows(
    () =>
      validateSettlement(
        input({
          settlementType: "bank_reconciliation",
          bankTransactionId: "bt1",
          debitChargeId: "d",
          amount: 200,
        }),
        ctx({ bankTxAbs: 1000, debitChargeOpen: 100 }),
      ),
    AppError,
  );
});

Deno.test("bank_reconciliation: amount > creditChargeOpen → 400", () => {
  assertThrows(
    () =>
      validateSettlement(
        input({
          settlementType: "bank_reconciliation",
          bankTransactionId: "bt1",
          creditChargeId: "c",
          amount: 200,
        }),
        ctx({ bankTxAbs: 1000, creditChargeOpen: 100 }),
      ),
    AppError,
  );
});

// ─── bank_deposit_credit ───────────────────────────────────────────────────
// Recibo: bank_tx ↔ credit charge (a fração tem credit a ser "consumido"
// pelo recibo). NÃO admite debit_charge_id.

Deno.test("bank_deposit_credit: happy path", () => {
  validateSettlement(
    input({
      settlementType: "bank_deposit_credit",
      bankTransactionId: "bt1",
      creditChargeId: "c1",
      amount: 50,
    }),
    ctx({ bankTxAbs: 100, creditChargeOpen: 100 }),
  );
});

Deno.test("bank_deposit_credit: bankTransactionId em falta → 400", () => {
  assertThrows(
    () =>
      validateSettlement(
        input({ settlementType: "bank_deposit_credit", creditChargeId: "c" }),
        ctx({ creditChargeOpen: 100 }),
      ),
    AppError,
  );
});

Deno.test("bank_deposit_credit: creditChargeId em falta → 400", () => {
  assertThrows(
    () =>
      validateSettlement(
        input({ settlementType: "bank_deposit_credit", bankTransactionId: "bt1" }),
        ctx({ bankTxAbs: 100 }),
      ),
    AppError,
  );
});

Deno.test("bank_deposit_credit: rejeita debit_charge_id (não pertence ao type)", () => {
  assertThrows(
    () =>
      validateSettlement(
        input({
          settlementType: "bank_deposit_credit",
          bankTransactionId: "bt1",
          creditChargeId: "c",
          debitChargeId: "d",
        }),
        ctx({ bankTxAbs: 100, creditChargeOpen: 100, debitChargeOpen: 100 }),
      ),
    AppError,
  );
});

Deno.test("bank_deposit_credit: bank_tx não existente → 404", () => {
  const err = assertThrows(
    () =>
      validateSettlement(
        input({
          settlementType: "bank_deposit_credit",
          bankTransactionId: "ghost",
          creditChargeId: "c",
        }),
        ctx({ bankTxAbs: null, creditChargeOpen: 100 }),
      ),
    AppError,
  );
  assertEquals(err.code, "NOT_FOUND");
});

Deno.test("bank_deposit_credit: amount > saldo não-alocado → 400", () => {
  assertThrows(
    () =>
      validateSettlement(
        input({
          settlementType: "bank_deposit_credit",
          bankTransactionId: "bt1",
          creditChargeId: "c",
          amount: 50,
        }),
        ctx({ bankTxAbs: 100, bankTxAlreadyAllocated: 80, creditChargeOpen: 1000 }),
      ),
    AppError,
  );
});

// Reverter um bank_deposit_credit cancela a charge de crédito por id: tem de
// ter sido validada como do condomínio na criação.
Deno.test("bank_deposit_credit: credit charge não existente → 404", () => {
  const err = assertThrows(
    () =>
      validateSettlement(
        input({
          settlementType: "bank_deposit_credit",
          bankTransactionId: "bt1",
          creditChargeId: "ghost",
        }),
        ctx({ bankTxAbs: 100, creditChargeOpen: null }),
      ),
    AppError,
  );
  assertEquals(err.code, "NOT_FOUND");
  assertEquals(err.statusCode, 404);
});

// ─── validateSettlementSides ───────────────────────────────────────────────
// Um settlement marca charges como pagas. Sem estas regras, um offset entre
// duas dívidas (ou com um crédito de outra fração) salda-as sem dinheiro.

const quota: ChargeSide = { nature: "debit", kind: "receivable", unitId: "uA" };
const unitCredit: ChargeSide = { nature: "credit", kind: "receivable", unitId: "uA" };
const invoice: ChargeSide = { nature: "debit", kind: "payable", unitId: null };
const creditNote: ChargeSide = { nature: "credit", kind: "payable", unitId: null };

const offset = input({ settlementType: "charge_offset", debitChargeId: "d", creditChargeId: "c" });

function sidesErr(i: SettlementInput, sides: Parameters<typeof validateSettlementSides>[1]) {
  return assertThrows(() => validateSettlementSides(i, sides), AppError);
}

Deno.test("sides charge_offset: crédito da fração contra quota da mesma fração é aceite", () => {
  validateSettlementSides(offset, {
    debitCharge: quota,
    creditCharge: unitCredit,
    bankTxAmount: null,
  });
});

Deno.test("sides charge_offset: nota de crédito contra fatura do fornecedor é aceite (D11)", () => {
  validateSettlementSides(offset, {
    debitCharge: invoice,
    creditCharge: creditNote,
    bankTxAmount: null,
  });
});

Deno.test("sides charge_offset: duas dívidas (credit side nature=debit) → 400", () => {
  const err = sidesErr(offset, {
    debitCharge: quota,
    creditCharge: { ...quota },
    bankTxAmount: null,
  });
  assertEquals(err.code, "VALIDATION_ERROR");
  assertEquals(err.statusCode, 400);
});

Deno.test("sides charge_offset: debit side com nature=credit → 400", () => {
  const err = sidesErr(offset, {
    debitCharge: { ...unitCredit },
    creditCharge: unitCredit,
    bankTxAmount: null,
  });
  assertEquals(err.code, "VALIDATION_ERROR");
});

Deno.test("sides charge_offset: crédito de outra fração não paga a quota → 400", () => {
  const err = sidesErr(offset, {
    debitCharge: quota,
    creditCharge: { ...unitCredit, unitId: "uB" },
    bankTxAmount: null,
  });
  assertEquals(err.code, "VALIDATION_ERROR");
});

Deno.test("sides charge_offset: crédito sem fração (ex. saldo inicial) não paga quota → 400", () => {
  sidesErr(offset, {
    debitCharge: quota,
    creditCharge: { ...unitCredit, unitId: null },
    bankTxAmount: null,
  });
});

Deno.test("sides charge_offset: crédito receivable não paga fatura de fornecedor → 400", () => {
  const err = sidesErr(offset, {
    debitCharge: invoice,
    creditCharge: { nature: "credit", kind: "receivable", unitId: null },
    bankTxAmount: null,
  });
  assertEquals(err.code, "VALIDATION_ERROR");
});

Deno.test("sides bank_reconciliation: entrada salda quota; saída salda fatura", () => {
  const rec = input({
    settlementType: "bank_reconciliation",
    bankTransactionId: "bt",
    debitChargeId: "d",
  });
  validateSettlementSides(rec, { debitCharge: quota, creditCharge: null, bankTxAmount: 5000 });
  validateSettlementSides(rec, { debitCharge: invoice, creditCharge: null, bankTxAmount: -5000 });
});

Deno.test("sides bank_reconciliation: devoluções (credit) seguem o sentido inverso", () => {
  const rec = input({
    settlementType: "bank_reconciliation",
    bankTransactionId: "bt",
    creditChargeId: "c",
  });
  // Fornecedor devolve dinheiro (entrada); condomínio devolve crédito à fração (saída).
  validateSettlementSides(rec, { debitCharge: null, creditCharge: creditNote, bankTxAmount: 2000 });
  validateSettlementSides(rec, {
    debitCharge: null,
    creditCharge: unitCredit,
    bankTxAmount: -2000,
  });
});

Deno.test("sides bank_reconciliation: entrada contra fatura de fornecedor → WRONG_SIGN", () => {
  // Dinheiro que entra não paga uma despesa: o ledger lançava Dr 121 / Cr despesa.
  const err = sidesErr(
    input({ settlementType: "bank_reconciliation", bankTransactionId: "bt", debitChargeId: "d" }),
    { debitCharge: invoice, creditCharge: null, bankTxAmount: 5000 },
  );
  assertEquals(err.code, "WRONG_SIGN");
  assertEquals(err.statusCode, 400);
});

Deno.test("sides bank_reconciliation: saída contra quota → WRONG_SIGN", () => {
  const err = sidesErr(
    input({ settlementType: "bank_reconciliation", bankTransactionId: "bt", debitChargeId: "d" }),
    { debitCharge: quota, creditCharge: null, bankTxAmount: -5000 },
  );
  assertEquals(err.code, "WRONG_SIGN");
});

Deno.test("sides bank_reconciliation: quota no lado crédito → 400", () => {
  // Os effects tratam o lado crédito com base no original_amount: estado errado.
  const err = sidesErr(
    input({ settlementType: "bank_reconciliation", bankTransactionId: "bt", creditChargeId: "c" }),
    { debitCharge: null, creditCharge: quota, bankTxAmount: 5000 },
  );
  assertEquals(err.code, "VALIDATION_ERROR");
});

Deno.test("sides bank_deposit_credit: excedente tem de ir para uma charge de crédito", () => {
  const dep = input({
    settlementType: "bank_deposit_credit",
    bankTransactionId: "bt",
    creditChargeId: "c",
  });
  validateSettlementSides(dep, { debitCharge: null, creditCharge: unitCredit, bankTxAmount: 3000 });
  sidesErr(dep, { debitCharge: null, creditCharge: quota, bankTxAmount: 3000 });
});
