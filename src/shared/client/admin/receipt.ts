import { type AsyncResult, validateResponse } from "../http.ts";
import { listQuery, type ReceiptListParams } from "../list_params.ts";
import { ManagerResource } from "../admin.ts";
import type {
  PendingReceipt,
  Receipt,
  ReceiptRecipientChoice,
  ReceiptRecipientOptions,
  SkippedReceipt,
} from "../types.ts";

declare module "../admin.ts" {
  interface ManagerResource {
    listPendingReceipts(requestInit?: RequestInit): AsyncResult<PendingReceipt[]>;
    listReceipts(
      params?: ReceiptListParams,
      requestInit?: RequestInit,
    ): AsyncResult<Receipt[]>;
    listReceiptsWithMeta(
      params?: ReceiptListParams,
      requestInit?: RequestInit,
    ): Promise<{
      data: Receipt[];
      meta: { availableYears: number[] };
      pagination?: { page: number; perPage: number; total: number; totalPages: number };
      status: number;
    }>;
    getReceipt(
      receiptId: string,
      requestInit?: RequestInit,
    ): AsyncResult<Receipt>;
    getReceiptRecipientOptions(
      params: { bankTransactionId: string; unitId: string },
      requestInit?: RequestInit,
    ): AsyncResult<ReceiptRecipientOptions>;
    emitReceipt(
      body: { bankTransactionId: string; unitId: string; recipient?: ReceiptRecipientChoice },
      requestInit?: RequestInit,
    ): AsyncResult<{
      receiptId: string;
      number: string;
      amountCents: number;
      emailsSent: number;
      emailsFailed: number;
    }>;
    emitBulkReceipts(requestInit?: RequestInit): AsyncResult<{
      total: number;
      success: number;
      failed: number;
      pendingRemaining: number;
      results: Array<
        {
          bankTransactionId: string;
          unitId: string;
          status: string;
          receiptId?: string;
          number?: string;
          error?: string;
        }
      >;
    }>;
    voidReceipt(
      receiptId: string,
      body: { reason: string },
      requestInit?: RequestInit,
    ): AsyncResult<Receipt>;
    resendReceiptEmail(
      receiptId: string,
      requestInit?: RequestInit,
    ): AsyncResult<{
      sent: number;
      failed: number;
      records: Array<{ email: string; sentAt: string; status: string; error?: string }>;
    }>;
    trackReceiptAccess(
      receiptId: string,
      body: { occupantId: string },
      requestInit?: RequestInit,
    ): AsyncResult<{
      tracked: boolean;
      reason?: string;
      record?: { occupantId: string; firstDownloadedAt: string; occupantName: string };
    }>;
    listSkippedReceipts(requestInit?: RequestInit): AsyncResult<SkippedReceipt[]>;
    skipReceipt(
      body: { bankTransactionId: string; unitId: string; reason?: string },
      requestInit?: RequestInit,
    ): AsyncResult<Record<string, unknown>>;
    unskipReceipt(
      body: { bankTransactionId: string; unitId: string; reason?: string },
      requestInit?: RequestInit,
    ): AsyncResult<{ reactivated: boolean; skip: Record<string, unknown> | null }>;
  }
}

// ── Recibos ──────────────────────────────────────────────────────────
export function registerReceiptMethods(): void {
  ManagerResource.prototype.listPendingReceipts = function (requestInit) {
    return this.request<PendingReceipt[]>("GET", "/receipts/pending", requestInit);
  };

  ManagerResource.prototype.listReceipts = function (params = {}, requestInit) {
    const qs = listQuery(params);
    return this.request<Receipt[]>("GET", `/receipts${qs ? `?${qs}` : ""}`, requestInit);
  };

  /** Como listReceipts mas devolve { data, meta } com availableYears
   *  (anos com recibos emitidos). Usado pela listagem do panel para o
   *  dropdown de ano sem precisar de chamada extra. */
  ManagerResource.prototype.listReceiptsWithMeta = async function (
    this: ManagerResource,
    params: ReceiptListParams = {},
    requestInit: RequestInit = {},
  ): Promise<{
    data: Receipt[];
    meta: { availableYears: number[] };
    pagination?: { page: number; perPage: number; total: number; totalPages: number };
    status: number;
  }> {
    const qs = listQuery({ ...params, withMeta: "1" });
    const url = `${this.basePathFor(requestInit)}/receipts?${qs}`;
    const response = await this.httpClient.get(url, requestInit);
    if (!response.ok) await validateResponse(response);
    const body = await response.json() as {
      data: Receipt[];
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

  ManagerResource.prototype.getReceipt = function (receiptId, requestInit) {
    return this.request<Receipt>("GET", `/receipts/${receiptId}`, requestInit);
  };

  ManagerResource.prototype.getReceiptRecipientOptions = function (params, requestInit) {
    const qs = new URLSearchParams(params).toString();
    return this.request<ReceiptRecipientOptions>(
      "GET",
      `/receipts/recipient-options?${qs}`,
      requestInit,
    );
  };

  ManagerResource.prototype.emitReceipt = function (body, requestInit) {
    return this.request<{
      receiptId: string;
      number: string;
      amountCents: number;
      emailsSent: number;
      emailsFailed: number;
    }>("POST", "/receipts", requestInit, body);
  };

  ManagerResource.prototype.emitBulkReceipts = function (requestInit) {
    return this.request<{
      total: number;
      success: number;
      failed: number;
      pendingRemaining: number;
      results: Array<
        {
          bankTransactionId: string;
          unitId: string;
          status: string;
          receiptId?: string;
          number?: string;
          error?: string;
        }
      >;
    }>("POST", "/receipts/bulk", requestInit, {});
  };

  ManagerResource.prototype.voidReceipt = function (receiptId, body, requestInit) {
    return this.request<Receipt>("POST", `/receipts/${receiptId}/void`, requestInit, body);
  };

  ManagerResource.prototype.resendReceiptEmail = function (receiptId, requestInit) {
    return this.request<{
      sent: number;
      failed: number;
      records: Array<{ email: string; sentAt: string; status: string; error?: string }>;
    }>("POST", `/receipts/${receiptId}/resend-email`, requestInit, {});
  };

  ManagerResource.prototype.listSkippedReceipts = function (requestInit) {
    return this.request<SkippedReceipt[]>("GET", "/receipts/skipped", requestInit);
  };

  ManagerResource.prototype.skipReceipt = function (body, requestInit) {
    return this.request<Record<string, unknown>>("POST", "/receipts/skip", requestInit, body);
  };

  ManagerResource.prototype.unskipReceipt = function (body, requestInit) {
    return this.request<{ reactivated: boolean; skip: Record<string, unknown> | null }>(
      "POST",
      "/receipts/unskip",
      requestInit,
      body,
    );
  };

  /** Track first PDF download por occupant. Idempotente. */
  ManagerResource.prototype.trackReceiptAccess = function (receiptId, body, requestInit) {
    return this.request<{
      tracked: boolean;
      reason?: string;
      record?: { occupantId: string; firstDownloadedAt: string; occupantName: string };
    }>("POST", `/receipts/${receiptId}/access`, requestInit, body);
  };
}
