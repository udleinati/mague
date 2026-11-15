// Hash determinístico para dedup de bank_transaction numa re-importação.
// Inclui balanceAfterCents para distinguir movimentos idênticos no mesmo dia
// (ex.: duas SDD de 50,00 da mesma entidade - o saldo após cada uma difere).

export async function importHash(fields: {
  bankAccountId: string;
  transactionDate: string;
  amountCents: number;
  description: string;
  balanceAfterCents: number | null;
}): Promise<string> {
  const canonical = [
    fields.bankAccountId,
    fields.transactionDate,
    String(fields.amountCents),
    fields.description,
    fields.balanceAfterCents === null ? "-" : String(fields.balanceAfterCents),
  ].join("|");
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
