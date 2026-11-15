import { type AsyncResult, validateResponse } from "../http.ts";
import { type BankTransactionListParams, listQuery } from "../list_params.ts";
import { ManagerResource } from "../admin.ts";
import type { BankTransaction } from "../types.ts";

/** Resultado do dry-run de imputação por fração (GET .../allocation_preview). */
export interface AllocationPreview {
  charges: Array<{
    chargeId: string;
    description: string | null;
    chargeType: string;
    competencePeriod: string | null;
    status: string;
    openAmount: number;
    amountToSettle: number;
    fill: "full" | "partial" | "none";
  }>;
  surplus: number;
  txAmount: number;
  alreadyAllocated: number;
  remaining: number;
}

declare module "../admin.ts" {
  interface ManagerResource {
    listBankTransactions(
      params?: BankTransactionListParams,
      requestInit?: RequestInit,
    ): AsyncResult<BankTransaction[]>;
    getBankTransaction(
      txId: string,
      params?: { withSuggestions?: string },
      requestInit?: RequestInit,
    ): AsyncResult<BankTransaction>;
    bankActivitySummary(requestInit?: RequestInit): AsyncResult<{
      pendingCount: number;
      txTotalCents: number;
      activityByMonth: Array<{ ym: string; label: string; inCents: number; outCents: number }>;
    }>;
    listBankTransactionsWithMeta(
      params?: BankTransactionListParams,
      requestInit?: RequestInit,
    ): Promise<{
      data: BankTransaction[];
      meta: { availableYears: number[] };
      pagination?: { page: number; perPage: number; total: number; totalPages: number };
      status: number;
    }>;
    createBankTransaction(
      body: Record<string, unknown>,
      requestInit?: RequestInit,
    ): AsyncResult<BankTransaction>;
    allocateBankTransactionToUnit(
      bankTransactionId: string,
      body: { unitId: string; notes?: string; chargeTypes?: string[] },
      requestInit?: RequestInit,
    ): AsyncResult<{ allocations: Array<Record<string, unknown>> }>;
    /** Dry-run: quais charges seriam quitadas (total/parcial) sem executar. */
    previewAllocationToUnit(
      bankTransactionId: string,
      params: { unitId: string; chargeTypes?: string[] },
      requestInit?: RequestInit,
    ): AsyncResult<AllocationPreview>;
    allocateBankTransactionToSupplier(
      bankTransactionId: string,
      body: { supplierId: string; notes?: string },
      requestInit?: RequestInit,
    ): AsyncResult<{ allocations: Array<Record<string, unknown>> }>;
    refundSupplierBankTransaction(
      bankTransactionId: string,
      body: {
        supplierId: string;
        sourceChargeId?: string;
        amount: number;
        description?: string;
        settlementDate?: string;
      },
      requestInit?: RequestInit,
    ): AsyncResult<{
      chargeId: string;
      settlementId: string;
      bankTransactionStatus: string;
    }>;
    ignoreBankTransaction(
      bankTransactionId: string,
      requestInit?: RequestInit,
    ): AsyncResult<{ id: string; status: string }>;
    unignoreBankTransaction(
      bankTransactionId: string,
      requestInit?: RequestInit,
    ): AsyncResult<{ id: string; status: string }>;
    reverseBankTransaction(
      bankTransactionId: string,
      body: { reason: string },
      requestInit?: RequestInit,
    ): AsyncResult<ReverseBankTransactionResult>;
  }
}

export interface ReverseBankTransactionResult {
  id: string;
  status: string;
  reversalReason: string;
  reversedSettlements: string[];
  /** Recibos anulados em cascata (PDF regenerado com a tarja "ANULADO"). */
  voidedReceipts: string[];
}

// Bank transactions & settlements
export function registerBankTransactionMethods(): void {
  /** @param params Aceita filtros standard + `withSuggestions=1` para receber
   *  cada row enriquecida com sugestões de match (suggestedKind/UnitId/SupplierId/
   *  Label ou matchConflictCount). */
  ManagerResource.prototype.listBankTransactions = function (params = {}, requestInit) {
    const qs = listQuery(params);
    return this.request<BankTransaction[]>(
      "GET",
      qs ? `/bank_transactions?${qs}` : "/bank_transactions",
      requestInit,
    );
  };

  /** Devolve UMA bank_transaction. `?withSuggestions=1` enriquece com
   *  `suggestedKind/UnitId/SupplierId/Label` ou `matchConflictCount`,
   *  idêntico a listBankTransactions. */
  ManagerResource.prototype.getBankTransaction = function (txId, params = {}, requestInit) {
    const qs = new URLSearchParams(params as Record<string, string>).toString();
    return this.request<BankTransaction>(
      "GET",
      qs ? `/bank_transactions/${txId}?${qs}` : `/bank_transactions/${txId}`,
      requestInit,
    );
  };

  /** Agregados de bank_transactions (count pendentes + Σ amount + 6 buckets
   *  mensais) sem trazer rows individuais. Usado pelo dashboard. */
  ManagerResource.prototype.bankActivitySummary = function (requestInit) {
    return this.request<{
      pendingCount: number;
      txTotalCents: number;
      activityByMonth: Array<{ ym: string; label: string; inCents: number; outCents: number }>;
    }>("GET", "/bank_transactions/activity_summary", requestInit);
  };

  /** Como listBankTransactions mas devolve { data, meta } com availableYears
   *  e - quando params.page foi passado - pagination { page, perPage, total, totalPages }.
   *  Usado pela conciliação no panel para alimentar o dropdown de ano + paginação. */
  ManagerResource.prototype.listBankTransactionsWithMeta = async function (
    this: ManagerResource,
    params: BankTransactionListParams = {},
    requestInit: RequestInit = {},
  ): Promise<{
    data: BankTransaction[];
    meta: { availableYears: number[] };
    pagination?: { page: number; perPage: number; total: number; totalPages: number };
    status: number;
  }> {
    const qs = listQuery({ ...params, withMeta: "1" });
    const url = `${this.basePathFor(requestInit)}/bank_transactions?${qs}`;
    const response = await this.httpClient.get(url, requestInit);
    if (!response.ok) await validateResponse(response);
    const body = await response.json() as {
      data: BankTransaction[];
      meta?: { availableYears?: number[] };
      pagination?: { page: number; perPage: number; total: number; totalPages: number };
    };
    return {
      data: body.data ?? [],
      meta: { availableYears: body.meta?.availableYears ?? [] },
      pagination: body.pagination,
      status: response.status,
    };
  };

  ManagerResource.prototype.createBankTransaction = function (body, requestInit) {
    return this.request<BankTransaction>("POST", "/bank_transactions", requestInit, body);
  };

  ManagerResource.prototype.allocateBankTransactionToUnit = function (
    bankTransactionId,
    body,
    requestInit,
  ) {
    return this.request<{ allocations: Array<Record<string, unknown>> }>(
      "POST",
      `/bank_transactions/${bankTransactionId}/allocate_to_unit`,
      requestInit,
      body,
    );
  };

  ManagerResource.prototype.previewAllocationToUnit = function (
    bankTransactionId,
    params,
    requestInit,
  ) {
    const qs = new URLSearchParams({ unitId: params.unitId });
    if (params.chargeTypes && params.chargeTypes.length) {
      qs.set("chargeTypes", params.chargeTypes.join(","));
    }
    return this.request<AllocationPreview>(
      "GET",
      `/bank_transactions/${bankTransactionId}/allocation_preview?${qs}`,
      requestInit,
    );
  };

  ManagerResource.prototype.allocateBankTransactionToSupplier = function (
    bankTransactionId,
    body,
    requestInit,
  ) {
    return this.request<{ allocations: Array<Record<string, unknown>> }>(
      "POST",
      `/bank_transactions/${bankTransactionId}/allocate_to_supplier`,
      requestInit,
      body,
    );
  };

  /** Devolução de fornecedor: cria charge payable+credit + settlement num atom.
   *  `sourceChargeId` opcional liga à despesa original (via charge.source_id).
   *  Ver modules/admin/bank_transaction/refund_supplier.ts. */
  ManagerResource.prototype.refundSupplierBankTransaction = function (
    bankTransactionId,
    body,
    requestInit,
  ) {
    return this.request<{
      chargeId: string;
      settlementId: string;
      bankTransactionStatus: string;
    }>("POST", `/bank_transactions/${bankTransactionId}/refund_supplier`, requestInit, body);
  };

  ManagerResource.prototype.ignoreBankTransaction = function (bankTransactionId, requestInit) {
    return this.request<{ id: string; status: string }>(
      "POST",
      `/bank_transactions/${bankTransactionId}/ignore`,
      requestInit,
      {},
    );
  };

  ManagerResource.prototype.unignoreBankTransaction = function (bankTransactionId, requestInit) {
    return this.request<{ id: string; status: string }>(
      "POST",
      `/bank_transactions/${bankTransactionId}/unignore`,
      requestInit,
      {},
    );
  };

  /** Reverter conciliação - cascateia: settlements ativos → reversed,
   *  open_amount das charges é reposto, ledger estornado, recibos anulados.
   *  Razão obrigatória ≥10 chars. */
  ManagerResource.prototype.reverseBankTransaction = function (
    bankTransactionId,
    body,
    requestInit,
  ) {
    return this.request<ReverseBankTransactionResult>(
      "POST",
      `/bank_transactions/${bankTransactionId}/reverse`,
      requestInit,
      body,
    );
  };
}
