import { render } from "$panel/render.ts";
import { parseEurosToCents } from "$shared/money/parse_euros.ts";
import { parseFormBool, parseFormString } from "$panel/libs/form_parsing.ts";
import { client } from "$panel/client.ts";

export async function listBankAccounts() {
  const [accountsWithStatsResult, balancesResult, fcrTransfersResult] = await Promise.all([
    // Uma query com GROUP BY: cada conta já vem com txCount/pendingCount/balance.
    client.admin.listBankAccountsWithStats(),
    // Saldo ord/FCR do ledger - agregado por condomínio (não por conta), p/ KPI cards.
    client.admin.getBankAccountsBalances().catch(() => ({
      data: { ordinaryCents: 0, fcrCents: 0, totalCents: 0 },
    })),
    client.admin.listFcrTransfers().catch(() => ({ data: [] })),
  ]);

  // Mapeia camelCase → snake_case esperado pelos templates existentes.
  const accounts = accountsWithStatsResult.data.map((a) => ({
    ...a,
    tx_count: a.txCount,
    pending_count: a.pendingCount,
    current_balance_cents: a.currentBalanceCents,
  }));

  const totalPending = accounts.reduce((s, a) => s + a.pending_count, 0);
  const totalBalance = accounts.reduce((s, a) => s + a.current_balance_cents, 0);

  // Split ord/FCR vem do ledger (v_bank_balance) - agregado, não por conta.
  // Não inclui txs por conciliar; se totalBalance > ledger.totalCents há
  // movimentos pendentes que ainda não entraram no ledger.
  const balances = balancesResult.data as {
    ordinaryCents: number;
    fcrCents: number;
    totalCents: number;
  };

  return await render("pages/bank_accounts/list.vto", {
    title: "Contas bancárias",
    section: "bank_accounts",
    accounts,
    fcrTransfers: fcrTransfersResult.data,
    stats: {
      total: accounts.length,
      active: accounts.filter((a) => Boolean((a as Record<string, unknown>).isActive)).length,
      totalPending,
      totalBalance,
      ordinaryCents: balances.ordinaryCents,
      fcrCents: balances.fcrCents,
      ledgerCents: balances.totalCents,
      unreconciledCents: Math.max(0, totalBalance - balances.totalCents),
    },
  });
}

export async function newBankAccountPage() {
  return await render("pages/bank_accounts/new.vto", {
    title: "Nova conta bancária",
    section: "bank_accounts",
  });
}

// Helper: parse de checkbox HTML que pode vir como string única ("true"/"false"),
// como array (quando há hidden input + checkbox marcada) ou ausente.
function parseCheckbox(v: string | File | (string | File)[] | undefined): boolean {
  if (v === undefined) return false;
  if (Array.isArray(v)) return v.some((x) => String(x) === "true");
  return String(v) === "true" || String(v) === "on";
}

export async function createBankAccount(form: Record<string, string | File>) {
  // Só metadados básicos; saldo de abertura (ord/FCR) configura-se na edição.
  // Para `kind=cash`, IBAN/titular/is_quota_payment ficam vazios (constraint DB exige bank).
  const kind = String(form.kind ?? "bank") === "cash" ? "cash" : "bank";
  const result = await client.admin.createBankAccount({
    bankName: parseFormString(form, "bankName"),
    iban: parseFormString(form, "iban", { emptyAsNull: true }),
    accountName: parseFormString(form, "accountName", { emptyAsNull: true }),
    accountHolder: parseFormString(form, "accountHolder", { emptyAsNull: true }),
    isQuotaPayment: kind === "bank" && parseCheckbox(form.isQuotaPayment as never),
    kind,
  });
  return result.data;
}

export async function showBankAccount(
  id: string,
  flash: { type: string; message: string } | null = null,
) {
  // Filtro e ordenação (data DESC) feitos na API - sem trazer todas as txs
  // do condomínio nem ordenar em JS.
  const [accountResult, txsResult] = await Promise.all([
    client.admin.getBankAccount(id),
    client.admin.listBankTransactions({ bankAccountId: id, limit: "1000" }),
  ]);

  const account = accountResult.data as Record<string, unknown>;
  const txs = txsResult.data;

  const opening = Number(account.openingBalance ?? 0);
  const sumTxs = txs.reduce((s, t) => s + t.amount, 0);
  const currentBalance = opening + sumTxs;
  const pendingCount = txs.filter((t) => t.status === "unreconciled").length;
  const reconciledCount = txs.length - pendingCount;

  return await render("pages/bank_accounts/show.vto", {
    title: `Conta ${account.bankName}`,
    section: "bank_accounts",
    account,
    txs,
    stats: {
      txCount: txs.length,
      pendingCount,
      reconciledCount,
      currentBalance,
      opening,
    },
    flash,
  });
}

export async function editBankAccountPage(
  id: string,
  flash: { type: string; message: string } | null = null,
) {
  const accountResult = await client.admin.getBankAccount(id);
  return await render("pages/bank_accounts/edit.vto", {
    title: "Editar conta bancária",
    section: "bank_accounts",
    account: accountResult.data,
    flash,
  });
}

export async function updateBankAccount(id: string, form: Record<string, string | File>) {
  const body: Record<string, unknown> = {};
  if (form.bankName !== undefined) body.bankName = parseFormString(form, "bankName");
  if (form.iban !== undefined) body.iban = parseFormString(form, "iban", { emptyAsNull: true });
  if (form.accountName !== undefined) {
    body.accountName = parseFormString(form, "accountName", { emptyAsNull: true });
  }
  if (form.accountHolder !== undefined) {
    body.accountHolder = parseFormString(form, "accountHolder", { emptyAsNull: true });
  }
  if (form.kind !== undefined) body.kind = String(form.kind) === "cash" ? "cash" : "bank";
  // hidden+checkbox → array no parseBody do Hono. Se kind=cash o backend
  // rejeita (CHECK + refine Zod); a UI já desmarca ao trocar o tipo.
  if (form.isQuotaPayment !== undefined) {
    body.isQuotaPayment = parseCheckbox(form.isQuotaPayment as never);
  }
  if (form.isActive !== undefined) {
    body.isActive = parseFormBool(form, "isActive");
  }
  if (form.openingBalance !== undefined) {
    // Saldo de abertura pode ser negativo (e.g. conta começou em dívida).
    body.openingBalance = parseEurosToCents(form.openingBalance, { allowNegative: true }) ?? 0;
  }
  if (form.openingBalanceDate !== undefined) {
    body.openingBalanceDate = parseFormString(form, "openingBalanceDate", { emptyAsNull: true });
  }
  await client.admin.updateBankAccount(id, body);
  return { ok: true };
}

export async function deleteBankAccount(id: string) {
  await client.admin.deleteBankAccount(id);
  return { ok: true };
}

// Tx manual: caminho de entrada das contas `kind='cash'` (sem CSV); raro em
// `kind='bank'` p/ corrigir gaps. O form usa `direction` in/out e valor
// absoluto; convertemos para amount com sinal (convenção bank_transaction.amount).
export async function createManualBankTx(
  bankAccountId: string,
  form: Record<string, string | File>,
) {
  const direction = String(form.direction ?? "in") === "out" ? "out" : "in";
  const absCents = parseEurosToCents(form.amount);
  if (absCents === null || absCents === 0) {
    throw new Error("Valor inválido - deve ser maior que zero.");
  }
  // Convenção interna: amount com sinal (negativo = saída).
  const cents = direction === "in" ? absCents : -absCents;

  const transactionDate = parseFormString(form, "transactionDate");
  if (!transactionDate) throw new Error("Data obrigatória.");

  const result = await client.admin.createBankTransaction({
    bankAccountId,
    transactionDate,
    valueDate: parseFormString(form, "valueDate") || transactionDate,
    amount: cents,
    description: parseFormString(form, "description", { emptyAsNull: true }),
    notes: parseFormString(form, "notes", { emptyAsNull: true }),
  });
  return result.data;
}

export async function setOpeningBalance(id: string, form: Record<string, string | File>) {
  const date = parseFormString(form, "openingBalanceDate");
  if (!date) throw new Error("Data obrigatória");
  // Saldos de abertura podem ser negativos (conta começou em dívida).
  const result = await client.admin.setBankAccountOpeningBalance(id, {
    ordinary_cents: parseEurosToCents(form.openingBalanceOrdinary, { allowNegative: true }) ?? 0,
    fcr_cents: parseEurosToCents(form.openingBalanceFcr, { allowNegative: true }) ?? 0,
    date,
  });
  return result.data;
}

// Move saldo entre a bolsa ordinária e a bolsa FCR do condomínio. Não escolhe
// conta bancária: as bolsas são agregadas por condomínio (v_bank_balance).
export async function createFcrTransfer(form: Record<string, string | File>) {
  const direction = parseFormString(form, "direction");
  if (direction !== "to_fcr" && direction !== "to_ordinary") {
    throw new Error("Direção inválida.");
  }

  const amountCents = parseEurosToCents(form.amount);
  if (!amountCents) throw new Error("Valor obrigatório e maior que zero.");

  const date = parseFormString(form, "transferDate");
  if (!date) throw new Error("Data obrigatória.");

  const reason = parseFormString(form, "reason");
  if (!reason) throw new Error("Motivo obrigatório.");

  const result = await client.admin.createFcrTransfer({ direction, amountCents, date, reason });
  return result.data;
}

export async function previewImport(id: string, file: File) {
  const [accountResult, previewResult] = await Promise.all([
    client.admin.getBankAccount(id),
    client.admin.previewBankStatementImport(id, file, file.name),
  ]);

  return await render("pages/bank_accounts/import_preview.vto", {
    title: "Importar extrato",
    section: "bank_accounts",
    account: accountResult.data,
    filename: previewResult.data.filename,
    rows: previewResult.data.rows,
    summary: previewResult.data.summary,
  });
}

export async function commitImport(id: string, form: Record<string, string | File>) {
  const rowsJson = String(form.rows_json ?? "[]");
  let rows: Array<Record<string, unknown>>;
  try {
    rows = JSON.parse(rowsJson);
  } catch {
    throw new Error("rows_json inválido");
  }
  // Filtra linhas que o utilizador explicitamente incluiu (checkbox marcado).
  // Convenção: form tem `include_<idx>=on` para cada linha marcada.
  const included = rows.filter((_r, idx) => form[`include_${idx}`] === "on");
  if (included.length === 0) {
    return { created: 0, skipped: rows.length, importBatchId: null };
  }
  const filename = String(form.filename ?? "") || undefined;
  const result = await client.admin.commitBankStatementImport(id, { rows: included, filename });
  return result.data;
}
