import { assertEquals } from "@std/assert";
import { groupSettlementsByBankTx } from "./bank_payments.ts";

function s(opts: {
  status?: string;
  type?: string;
  amount?: number;
  txId?: string | null;
  txDate?: string | null;
  txDesc?: string | null;
  txAmount?: number;
  txStatus?: string;
  chargeId?: string;
  chargeDesc?: string;
  chargeType?: string;
}) {
  return {
    status: opts.status ?? "active",
    settlementType: opts.type ?? "bank_reconciliation",
    amount: opts.amount ?? 1000,
    bankTransactionId: opts.txId === null ? null : (opts.txId ?? "tx_1"),
    bankTransaction: opts.txId === null ? null : {
      id: opts.txId ?? "tx_1",
      transactionDate: opts.txDate ?? "2024-06-01",
      description: opts.txDesc ?? "TRF",
      amount: opts.txAmount ?? 1000,
      status: opts.txStatus ?? "active",
    },
    debitCharge: {
      id: opts.chargeId ?? "ch_1",
      description: opts.chargeDesc ?? "Quota Junho",
      chargeType: opts.chargeType ?? "quota",
    },
  };
}

Deno.test("groupSettlementsByBankTx - vazio devolve []", () => {
  assertEquals(groupSettlementsByBankTx([]), []);
});

Deno.test("groupSettlementsByBankTx - skipa não-bank_reconciliation", () => {
  assertEquals(
    groupSettlementsByBankTx([
      s({ type: "charge_offset" }),
      s({ type: "bank_deposit_credit" }),
    ]),
    [],
  );
});

Deno.test("groupSettlementsByBankTx - skipa bankTransactionId null", () => {
  assertEquals(groupSettlementsByBankTx([s({ txId: null })]), []);
});

Deno.test("groupSettlementsByBankTx - 1 settlement → 1 BankPayment", () => {
  const out = groupSettlementsByBankTx([
    s({ amount: 5000, txId: "tx_a", txDate: "2024-06-15", txAmount: 5000 }),
  ]);
  assertEquals(out.length, 1);
  assertEquals(out[0].bankTxId, "tx_a");
  assertEquals(out[0].totalAllocated, 5000);
  assertEquals(out[0].bankAmount, 5000);
  assertEquals(out[0].allocations.length, 1);
});

Deno.test("groupSettlementsByBankTx - múltiplas allocations no mesmo bank tx", () => {
  const out = groupSettlementsByBankTx([
    s({ txId: "tx_a", amount: 3000, chargeId: "ch_1", chargeDesc: "Janeiro" }),
    s({ txId: "tx_a", amount: 3000, chargeId: "ch_2", chargeDesc: "Fevereiro" }),
    s({ txId: "tx_b", amount: 5000, chargeId: "ch_3", chargeDesc: "Março" }),
  ]);
  assertEquals(out.length, 2);
  // ordenado por transactionDate desc - mas ambos têm a mesma data default; usa bankTxId como tiebreaker estável da Map
  const txA = out.find((b) => b.bankTxId === "tx_a")!;
  assertEquals(txA.totalAllocated, 6000);
  assertEquals(txA.allocations.length, 2);
  assertEquals(txA.allocations.map((a) => a.description), ["Janeiro", "Fevereiro"]);
});

Deno.test("groupSettlementsByBankTx - totalAllocated SÓ conta status active", () => {
  const out = groupSettlementsByBankTx([
    s({ txId: "tx_a", amount: 1000, status: "active" }),
    s({ txId: "tx_a", amount: 5000, status: "reversed", chargeId: "ch_2" }),
  ]);
  assertEquals(out[0].totalAllocated, 1000);
  assertEquals(out[0].allocations.length, 2); // mas inclui ambas como entries
});

Deno.test("groupSettlementsByBankTx - onlyActive=true filtra reverted", () => {
  const out = groupSettlementsByBankTx([
    s({ txId: "tx_a", amount: 1000, status: "active" }),
    s({ txId: "tx_a", amount: 5000, status: "reversed", chargeId: "ch_2" }),
  ], { onlyActive: true });
  assertEquals(out[0].allocations.length, 1);
  assertEquals(out[0].totalAllocated, 1000);
});

Deno.test("groupSettlementsByBankTx - reversed flag de bank tx", () => {
  const out = groupSettlementsByBankTx([
    s({ txStatus: "reversed" }),
  ]);
  assertEquals(out[0].reversed, true);

  const out2 = groupSettlementsByBankTx([s({ txStatus: "ignored" })]);
  assertEquals(out2[0].reversed, true);

  const out3 = groupSettlementsByBankTx([s({ txStatus: "active" })]);
  assertEquals(out3[0].reversed, false);
});

Deno.test("groupSettlementsByBankTx - ordena por transactionDate DESC", () => {
  const out = groupSettlementsByBankTx([
    s({ txId: "tx_jan", txDate: "2024-01-15" }),
    s({ txId: "tx_jun", txDate: "2024-06-15" }),
    s({ txId: "tx_mar", txDate: "2024-03-15" }),
  ]);
  assertEquals(out.map((b) => b.bankTxId), ["tx_jun", "tx_mar", "tx_jan"]);
});
