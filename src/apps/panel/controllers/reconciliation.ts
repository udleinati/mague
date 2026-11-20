import { render } from "$panel/render.ts";
import { type BankTransaction, type Settlement, type Supplier } from "$shared/client/mod.ts";
import { findKeywordMatches } from "$shared/match_keywords.ts";
import { buildPaginationMeta, paginationParamsFromQuery } from "$panel/libs/pagination.ts";
import { supplierLabelMap, type UnitForLabel, unitLabelMap } from "$shared/labels/mod.ts";
import { parseEurosToCents } from "$shared/money/parse_euros.ts";
import { resolveServerYearParam } from "$shared/year_filter/mod.ts";
import { parseFormString } from "$panel/libs/form_parsing.ts";
import { client } from "$panel/client.ts";

type Rec = Record<string, unknown>;

// Enriquece settlements com labels (descrição/tipo/unit/supplier) a partir do
// `debitCharge` nested da API; mapas units/suppliers resolvem os labels.
function enrichTransactions(
  txs: BankTransaction[],
  settlements: Settlement[],
  units: ReadonlyArray<UnitForLabel>,
  suppliers: Supplier[],
) {
  const unitLabelById = unitLabelMap(units);
  const supplierNameById = supplierLabelMap(suppliers);

  const settlementsByTx = new Map<string, Array<Settlement & Rec>>();
  for (const s of settlements) {
    const bankTxId = s.bankTransactionId;
    if (!bankTxId) continue;
    const unitId = s.unitId;
    const debitCharge = s.debitCharge;
    const chargeUnitId = debitCharge?.unitId ?? null;
    const chargeSupplierId = debitCharge?.supplierId ?? null;

    const resolvedUnitLabel = unitId
      ? unitLabelById.get(unitId) ?? null
      : chargeUnitId
      ? unitLabelById.get(chargeUnitId) ?? null
      : null;
    const resolvedSupplierLabel = chargeSupplierId
      ? supplierNameById.get(chargeSupplierId) ?? null
      : null;

    const resolvedUnitId = unitId ?? chargeUnitId ?? null;
    const enriched = {
      ...s,
      charge_description: debitCharge?.description ?? null,
      chargeType: debitCharge?.chargeType ?? null,
      unit_label: resolvedUnitLabel,
      unit_id: resolvedUnitId,
      supplier_label: resolvedSupplierLabel,
    };
    const arr = settlementsByTx.get(bankTxId) ?? [];
    arr.push(enriched);
    settlementsByTx.set(bankTxId, arr);
  }

  return txs.map((t) => {
    const txSettlements = settlementsByTx.get(String(t.id)) ?? [];
    return {
      ...t,
      settlements: txSettlements,
      unallocated: unallocatedCents(t.amount, txSettlements),
    };
  });
}

// Por conciliar do movimento: |amount| menos os settlements ativos.
function unallocatedCents(amount: number, settlements: ReadonlyArray<Settlement>): number {
  const allocated = settlements
    .filter((s) => s.status === "active")
    .reduce((sum, s) => sum + s.amount, 0);
  return Math.max(0, Math.abs(amount) - allocated);
}

// POST .../reconciliation/cutoff. Aceita YYYY-MM-DD ou `_clear=1` (null).
// Cutoff é o driver de "vencida" na view v_unit_balance: definido → quotas
// em aberto com due_date <= cutoff são atrasadas; null → nenhuma é atrasada.
export async function setReconciliationCutoff(form: Record<string, string | File>) {
  const clear = String(form._clear ?? "") === "1";
  const date = parseFormString(form, "reconciledThroughDate");
  const value: string | null = clear || !date ? null : date;
  await client.admin.updateMe({ reconciledThroughDate: value });
  return { ok: true };
}

// Tab "Em aberto" e default: tudo o que ainda pode ser conciliado.
export const OPEN_STATUS_FILTER = "unreconciled,partial,reversed";

async function fetchReconciliationData(params: Record<string, string>) {
  const statusFilter = params.status === undefined ? OPEN_STATUS_FILTER : params.status;
  const bankAccountFilter = params.bankAccountId ?? "";

  // Filtro de ano server-side (default ano atual, "" = Todos). Ver
  // resolveServerYearParam. `currentYear` é reusado abaixo nos availableYears.
  const currentYear = new Date().getUTCFullYear();
  const filterYear = resolveServerYearParam(params.year, currentYear);

  // withSuggestions=1 traz `suggested*`/`matchConflictCount` por row
  // (matching em $shared/match_keywords.ts, executado na API).
  const txParams: Record<string, string> = { withSuggestions: "1" };
  if (statusFilter) txParams.status = statusFilter;
  if (filterYear !== null) txParams.year = String(filterYear);
  const pp = paginationParamsFromQuery(params);
  txParams.page = pp.page;
  txParams.perPage = pp.perPage;

  // Modais renderizados sob pedido via renderTxModal (hx-get) - evita ~100k nós
  // no HTML inicial. settlements são puxados só dos movimentos desta página
  // (abaixo), não de todo o condomínio.
  const [txsRes, unitsRes, suppliersRes, bankAccountsRes] = await Promise.all([
    client.admin.listBankTransactionsWithMeta(txParams),
    client.admin.listUnits(),
    client.admin.listSuppliers(),
    client.admin.listBankAccounts(),
  ]);

  let txs = txsRes.data;
  if (bankAccountFilter) {
    txs = txs.filter((t) => t.bankAccountId === bankAccountFilter);
  }

  // availableYears da API + ano atual garantido.
  const availableYearsSet = new Set<number>(txsRes.meta.availableYears);
  availableYearsSet.add(currentYear);
  const availableYears = [...availableYearsSet].sort((a, b) => b - a);

  // Cronológica ASC (coerente com o scroll do extrato), tiebreak por createdAt.
  txs.sort((a, b) => {
    const da = String(a.transactionDate ?? "");
    const db = String(b.transactionDate ?? "");
    if (da !== db) return da.localeCompare(db);
    const ca = String(a.createdAt ?? "");
    const cb = String(b.createdAt ?? "");
    return ca.localeCompare(cb);
  });

  // listUnits devolve ordem natural (A, B, …, Z, AA, AB, …) via API.
  const units = unitsRes.data;

  // Settlements só dos movimentos visíveis nesta página (listBankTransactions já
  // vem paginado) - o enrich escala com a página, não com o histórico do condo.
  const pageTxIds = txs.map((t) => String(t.id));
  const settlements: Settlement[] = pageTxIds.length
    ? (await client.admin.listSettlements({ bankTransactionId: pageTxIds.join(",") })).data
    : [];

  const transactions = enrichTransactions(
    txs,
    settlements,
    units,
    suppliersRes.data,
  );

  // `suggested*`/`matchConflictCount` vêm no payload (withSuggestions=1) e são
  // preservados por enrichTransactions (spread do objeto).

  const pagination = txsRes.pagination
    ? buildPaginationMeta(txsRes.pagination, params, [
      "status",
      "year",
      "bankAccountId",
      "perPage",
    ])
    : null;

  return {
    title: "Conciliação",
    section: "reconciliation",
    transactions,
    bankAccounts: bankAccountsRes.data,
    filterStatus: statusFilter,
    openStatusFilter: OPEN_STATUS_FILTER,
    filterBankAccountId: bankAccountFilter,
    filterYear,
    availableYears,
    pagination,
    // Hoje (YYYY-MM-DD): banner destaca cutoff desatualizado (reconciledThroughDate < today).
    today: new Date().toISOString().slice(0, 10),
  };
}

export async function reconciliationPage(params: Record<string, string>) {
  const data = await fetchReconciliationData(params);
  return await render("pages/reconciliation/list.vto", data);
}

export async function reconciliationFragment(params: Record<string, string>) {
  const data = await fetchReconciliationData(params);
  return await render("pages/reconciliation/_list_fragment.vto", data);
}

// Renderiza UM modal de conciliação (HTMX hx-get ao clicar "conciliar"). Só
// carrega o aberto, em vez de pre-renderizar todos - reduz o DOM inicial.
export async function renderTxModal(bankTxId: string) {
  // Queries fatiadas no servidor: listTopOpenChargesByGroup(6) via
  // ROW_NUMBER() OVER (PARTITION BY unit|supplier); listCharges(open_any) só
  // para o select Manual (todas as em aberto, filtro de status já na BD).
  const [txRes, openChargesRes, unitsRes, suppliersRes, settlementsRes] = await Promise.all([
    client.admin.getBankTransaction(bankTxId).catch(() => null),
    client.admin.listCharges({ status: "open_any", limit: "5000" }),
    client.admin.listUnits(),
    client.admin.listSuppliers(),
    client.admin.listSettlements({ bankTransactionId: bankTxId }),
  ]);

  // Entradas (amount > 0): tab "Devolução" lista despesas recentes por
  // fornecedor (inclui pagas/parciais p/ identificar o pagamento original).
  // Carregado só quando isIncoming, para poupar nas saídas.
  const isIncoming = txRes?.data && Number(txRes.data.amount ?? 0) > 0;
  const recentPayablesRes = isIncoming
    ? await client.admin.listCharges({ kind: "payable", limit: "1000" })
    : null;

  const t = txRes?.data;
  if (!t) {
    return `<!-- movimento ${bankTxId} não encontrado -->`;
  }

  // Por alocar do movimento: base do "falta conciliar" da tab Manual.
  const txUnallocated = unallocatedCents(t.amount, settlementsRes.data);
  const txAllocated = Math.abs(t.amount) - txUnallocated;

  // listUnits devolve ordem natural (A, B, …, Z, AA, AB, …) via API.
  const units = unitsRes.data;

  const unitLabelById = unitLabelMap(units);

  // Select da tab Manual: todas as charges em aberto (receivable+payable,
  // qualquer unit), já filtradas pelo servidor (?status=open_any).
  const allCharges = openChargesRes.data;
  const openCharges = allCharges
    .map((c) => ({
      ...c,
      unit_label: c.unitId ? unitLabelById.get(c.unitId) ?? c.unitId : null,
    }))
    // Data ASC: receivables ancoram em competencePeriod (mês da quota),
    // payables em issueDate. Tiebreak por dueDate.
    .sort((a, b) => {
      const aKey = a.kind === "receivable"
        ? (a.competencePeriod ?? a.issueDate ?? "")
        : (a.issueDate ?? a.competencePeriod ?? "");
      const bKey = b.kind === "receivable"
        ? (b.competencePeriod ?? b.issueDate ?? "")
        : (b.issueDate ?? b.competencePeriod ?? "");
      if (aKey !== bKey) return aKey.localeCompare(bKey);
      return (a.dueDate ?? "").localeCompare(b.dueDate ?? "");
    });

  // Tab "Devolução": top-6 payables (exceto cancelled) por fornecedor, issue_date
  // DESC. Só populado para entradas (isIncoming) - identifica o pagamento original.
  const recentPayablesBySupplier: Record<
    string,
    Array<{
      id: string;
      issueDate: string | null;
      dueDate: string | null;
      description: string | null;
      openAmount: number;
      originalAmount: number;
      status: string;
      accountId: string | null;
    }>
  > = {};
  if (recentPayablesRes) {
    const all = recentPayablesRes.data
      .filter((c) => c.status !== "cancelled" && c.supplierId);
    all.sort((a, b) => {
      const ad = a.issueDate ?? "";
      const bd = b.issueDate ?? "";
      if (ad !== bd) return bd.localeCompare(ad);
      return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
    });
    for (const c of all) {
      const sid = String(c.supplierId);
      const arr = recentPayablesBySupplier[sid] ?? (recentPayablesBySupplier[sid] = []);
      if (arr.length < 6) {
        arr.push({
          id: c.id,
          issueDate: c.issueDate ?? null,
          dueDate: c.dueDate ?? null,
          description: c.description ?? null,
          openAmount: c.openAmount,
          originalAmount: c.originalAmount,
          status: c.status,
          accountId: c.accountId ?? null,
        });
      }
    }
  }

  // Alfabético para o combobox.
  const suppliers = [...suppliersRes.data]
    .sort((a, b) => a.name.localeCompare(b.name, "pt", { sensitivity: "base" }));

  // Pre-seleção por keywords recalculada aqui para a URL direta do modal funcionar (testes).
  const amount = t.amount;
  const candidates = amount > 0
    ? (units as Array<{ id: string; matchKeywords?: string[] | null }>)
    : suppliers;
  const matches = findKeywordMatches(t.description, candidates);
  const suggestedUnitId = (amount > 0 && matches.length === 1) ? matches[0].id : null;
  const suggestedSupplierId = (amount < 0 && matches.length === 1) ? matches[0].id : null;

  return await render("pages/reconciliation/_tx_modal.vto", {
    t,
    txUnallocated,
    txAllocated,
    units,
    suppliers,
    openCharges,
    recentPayablesBySupplier,
    suggestedUnitId,
    suggestedSupplierId,
  });
}

// Form do panel envia `chargeIds[]`; Hono parseBody devolve string OU array.
function parseChargeIds(form: Record<string, string | File>): string[] {
  const raw = form["chargeIds[]"] ?? form.chargeIds;
  if (raw === undefined) return [];
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === "string");
  if (typeof raw === "string") return raw ? [raw] : [];
  return [];
}

// Conciliação manual multi-charge: liquida as selecionadas pela ordem submetida
// (data ASC na UI), cada uma por min(openAmount, por alocar do movimento) - a
// última pode ficar parcial. Cada settlement valida na API (locks FOR UPDATE);
// falha a meio deixa os anteriores válidos (movimento fica partial).
export async function reconcile(form: Record<string, string | File>) {
  const bankTxId = parseFormString(form, "bankTransactionId");
  const settlementDate = String(form.settlementDate ?? "");
  const chargeIds = parseChargeIds(form);
  if (!bankTxId) throw new Error("bankTransactionId obrigatório.");
  if (chargeIds.length === 0) throw new Error("Seleciona pelo menos uma charge.");

  const [txRes, settlementsRes] = await Promise.all([
    client.admin.getBankTransaction(bankTxId),
    client.admin.listSettlements({ bankTransactionId: bankTxId }),
  ]);
  const allocated = settlementsRes.data
    .filter((s) => s.status === "active")
    .reduce((sum, s) => sum + s.amount, 0);
  let remaining = Math.abs(txRes.data.amount) - allocated;

  let count = 0;
  for (const chargeId of chargeIds) {
    if (remaining <= 0) break;
    const charge = (await client.admin.getCharge(chargeId)).data;
    const amount = Math.min(charge.openAmount, remaining);
    if (amount <= 0) continue;
    await client.admin.createSettlement({
      settlementType: "bank_reconciliation",
      bankTransactionId: bankTxId,
      debitChargeId: chargeId,
      amount,
      settlementDate: settlementDate,
    });
    remaining -= amount;
    count += 1;
  }
  if (count === 0) {
    throw new Error("Nada por conciliar - movimento já alocado ou charges sem valor em aberto.");
  }
  return { ok: true, count };
}

// Atalho "fatura veio com valor diferente": ajusta a charge ao valor do extrato
// e liquida full de uma vez. Ledger delta via trigger fn_charge_amount_adjust_ledger.
// Ex: previsto 100€, fatura 90/110 → charge passa a 90/110 e liquida.
export async function adjustChargeAndReconcile(form: Record<string, string | File>) {
  const bankTxId = parseFormString(form, "bankTransactionId");
  const chargeId = parseFormString(form, "chargeId");
  const amountCents = parseEurosToCents(form.amount) ?? 0;
  const settlementDate = String(form.settlementDate ?? "");

  // 1. Alinha o valor da charge com o do extrato (dispara trigger do ledger).
  await client.admin.updateCharge(chargeId, { amountCents });

  // 2. Liquida full contra a charge ajustada.
  await client.admin.createSettlement({
    settlementType: "bank_reconciliation",
    bankTransactionId: bankTxId,
    debitChargeId: chargeId,
    amount: amountCents,
    settlementDate,
  });
  return { ok: true };
}

// Seletor segmentado da tab "Fração": "all" (todos os tipos, prioridade legal completa),
// "quota" (só ordinárias), "extraordinary_quota" (só extraordinárias). Mapeia para a
// include-list que a API/algoritmo esperam (undefined = todos).
function chargeTypesFromFilter(filter: string): string[] | undefined {
  if (filter === "quota") return ["quota"];
  if (filter === "extraordinary_quota") return ["extraordinary_quota"];
  return undefined;
}

export async function allocateToUnit(form: Record<string, string | File>) {
  const bankTxId = parseFormString(form, "bankTransactionId");
  const unitId = parseFormString(form, "unitId");
  if (!bankTxId || !unitId) throw new Error("bankTransactionId e unitId obrigatórios.");
  const chargeTypes = chargeTypesFromFilter(parseFormString(form, "chargeTypeFilter"));
  const result = await client.admin.allocateBankTransactionToUnit(bankTxId, {
    unitId,
    chargeTypes,
  });
  return { ok: true, allocations: result.data.allocations };
}

// Fragmento HTMX do preview (dry-run) da imputação por fração. Recalculado no
// servidor com o algoritmo real ao escolher fração ou mudar o filtro de tipo.
export async function renderAllocationPreview(
  bankTxId: string,
  unitId: string,
  chargeTypeFilter: string,
) {
  if (!unitId) return "";
  const chargeTypes = chargeTypesFromFilter(chargeTypeFilter);
  const res = await client.admin.previewAllocationToUnit(bankTxId, { unitId, chargeTypes });
  return await render("pages/reconciliation/_allocation_preview.vto", { preview: res.data });
}

export async function allocateToSupplier(form: Record<string, string | File>) {
  const bankTxId = parseFormString(form, "bankTransactionId");
  const supplierId = parseFormString(form, "supplierId");
  if (!bankTxId || !supplierId) throw new Error("bankTransactionId e supplierId obrigatórios.");
  const result = await client.admin.allocateBankTransactionToSupplier(bankTxId, {
    supplierId: supplierId,
  });
  return { ok: true, allocations: result.data.allocations };
}

// Devolução de fornecedor: entrada bancária como abatimento de despesa anterior.
// Cria charge payable+credit + settlement atómico. Ver
// `$api/modules/admin/bank_transaction/refund_supplier.ts`.
export async function allocateSupplierRefund(form: Record<string, string | File>) {
  const bankTxId = parseFormString(form, "bankTransactionId");
  const supplierId = parseFormString(form, "supplierId");
  const sourceChargeId = parseFormString(form, "sourceChargeId");
  const description = parseFormString(form, "description");
  const settlementDate = parseFormString(form, "settlementDate");
  const amount = parseEurosToCents(form.amount) ?? 0;

  if (!bankTxId) throw new Error("bankTransactionId obrigatório.");
  if (!supplierId) throw new Error("supplierId obrigatório.");
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("amount tem de ser > 0.");

  const result = await client.admin.refundSupplierBankTransaction(bankTxId, {
    supplierId,
    amount,
    sourceChargeId: sourceChargeId || undefined,
    description: description || undefined,
    settlementDate: settlementDate || undefined,
  });
  return { ok: true, ...result.data };
}

export async function ignoreTx(bankTxId: string) {
  await client.admin.ignoreBankTransaction(bankTxId);
  return { ok: true };
}

export async function unignoreTx(bankTxId: string) {
  await client.admin.unignoreBankTransaction(bankTxId);
  return { ok: true };
}

export async function reverseTx(bankTxId: string, reason: string) {
  const { data } = await client.admin.reverseBankTransaction(bankTxId, { reason });
  return { ok: true, voidedReceipts: data.voidedReceipts?.length ?? 0 };
}

// Modal de reversão (HTMX swap): tx + settlements ativos com label legível
// para o admin confirmar antes de digitar REVERTER.
export async function renderReverseModal(bankTxId: string) {
  const [txRes, settlementsRes, unitsRes, suppliersRes, bankAccountsRes] = await Promise.all([
    client.admin.getBankTransaction(bankTxId).catch(() => null),
    client.admin.listSettlements({ bankTransactionId: bankTxId }),
    client.admin.listUnits(),
    client.admin.listSuppliers(),
    client.admin.listBankAccounts(),
  ]);

  const t = txRes?.data;
  if (!t) return `<!-- movimento ${bankTxId} não encontrado -->`;

  const bankAccount = (bankAccountsRes.data as Rec[]).find(
    (a) => a.id === t.bankAccountId,
  );

  const unitLabelById = unitLabelMap(unitsRes.data);
  const supplierNameById = supplierLabelMap(suppliersRes.data);

  // Só settlements ativos - os já revertidos não voltam a ser revertidos.
  const settlements = settlementsRes.data
    .filter((s) => s.status === "active")
    .map((s) => {
      const charge = s.debitCharge ?? s.creditCharge;
      const unitId = s.unitId ?? charge?.unitId ?? null;
      const supplierId = charge?.supplierId ?? null;
      return {
        id: s.id,
        amount: s.amount,
        settlementType: s.settlementType,
        label: charge?.description ?? null,
        competencePeriod: charge?.competencePeriod ?? null,
        unitLabel: unitId ? unitLabelById.get(unitId) ?? null : null,
        supplierLabel: supplierId ? supplierNameById.get(supplierId) ?? null : null,
      };
    })
    // Maior valor primeiro - hint visual de prioridade.
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

  return await render("pages/reconciliation/_reverse_modal.vto", {
    t,
    bankAccount,
    settlements,
  });
}

export async function renderTxUpdate(
  bankTxId: string,
  toast: { type: "success" | "error"; message: string },
) {
  // withSuggestions=1 mantém suggestedUnitId/Label na row pós-swap (sem isto, a
  // badge "Fração X" sumia até ao reload). listSettlements traz debitCharge nested.
  const [txRes, settlements, units, suppliers] = await Promise.all([
    client.admin.getBankTransaction(bankTxId, { withSuggestions: "1" }).catch(() => null),
    client.admin.listSettlements({ bankTransactionId: bankTxId }),
    client.admin.listUnits(),
    client.admin.listSuppliers(),
  ]);
  const t = txRes?.data;
  if (!t) {
    return await render("pages/reconciliation/_toast.vto", {
      toast: { type: "error", message: "Movimento não encontrado." },
    });
  }
  const [enriched] = enrichTransactions(
    [t],
    settlements.data,
    units.data,
    suppliers.data,
  );
  const [rowHtml, toastHtml] = await Promise.all([
    render("pages/reconciliation/_tx_row.vto", { t: enriched }),
    render("pages/reconciliation/_toast.vto", { toast }),
  ]);
  return rowHtml + toastHtml;
}
