// Agrupa settlements por bank_transaction: "1 entry por movimento com as
// quotas que liquidou" (dashboard + extrato). `totalAllocated` (Σ amounts
// active) é o imputado a esta unit; em pagamentos partilhados < `bankAmount`.

interface SettlementForGrouping {
  status: string;
  settlementType: string;
  amount: number;
  bankTransactionId: string | null;
  bankTransaction: {
    id?: string;
    transactionDate?: string | null;
    description?: string | null;
    amount?: number;
    status?: string | null;
  } | null;
  debitCharge: {
    id?: string;
    description: string;
    chargeType: string;
  } | null;
}

export interface BankPaymentAllocation {
  /** Pode estar ausente (dashboard) - extrato preenche para linkar à charge. */
  chargeId?: string;
  description: string;
  chargeType: string;
  amount: number;
  status: string;
}

export interface BankPayment {
  bankTxId: string;
  transactionDate: string | null;
  description: string | null;
  /** Valor original da tx no banco. Útil para distinguir pagamentos partilhados. */
  bankAmount: number;
  /** Σ allocations active. Em pagamentos partilhados < bankAmount. */
  totalAllocated: number;
  allocations: BankPaymentAllocation[];
  /** Bank tx anulada (status reversed/ignored) - extrato mostra com risca. */
  reversed: boolean;
}

export interface GroupOptions {
  /** Quando true, descarta settlements `status !== "active"` antes de agrupar
   *  (não constam no resultado). Default false: mantém todas e marca `reversed`. */
  onlyActive?: boolean;
}

// Agrupa settlements por bank_transaction. Skipa não-bank_reconciliation
// (offsets internos) e nulls defensivos. `totalAllocated` conta só status
// active (independente de `onlyActive`): reverted não infla o imputado.
export function groupSettlementsByBankTx<T extends SettlementForGrouping>(
  settlements: readonly T[],
  opts: GroupOptions = {},
): BankPayment[] {
  const onlyActive = opts.onlyActive ?? false;
  const byTxId = new Map<string, BankPayment>();

  for (const s of settlements) {
    if (s.settlementType !== "bank_reconciliation") continue;
    if (onlyActive && s.status !== "active") continue;
    const txId = s.bankTransactionId;
    if (!txId) continue;
    const tx = s.bankTransaction;
    const debitCharge = s.debitCharge;
    if (!tx || !debitCharge) continue;

    let bk = byTxId.get(txId);
    if (!bk) {
      const txStatus = String(tx.status ?? "");
      bk = {
        bankTxId: txId,
        transactionDate: tx.transactionDate ?? null,
        description: tx.description ?? null,
        bankAmount: Number(tx.amount ?? 0),
        totalAllocated: 0,
        allocations: [],
        reversed: txStatus === "reversed" || txStatus === "ignored",
      };
      byTxId.set(txId, bk);
    }

    const amount = Number(s.amount ?? 0);
    const status = String(s.status ?? "active");
    bk.allocations.push({
      chargeId: debitCharge.id,
      description: debitCharge.description,
      chargeType: debitCharge.chargeType,
      amount,
      status,
    });
    if (status === "active") bk.totalAllocated += amount;
  }

  return [...byTxId.values()].sort((a, b) =>
    String(b.transactionDate ?? "").localeCompare(String(a.transactionDate ?? ""))
  );
}
