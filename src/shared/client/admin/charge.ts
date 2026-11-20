import { type AsyncResult, validateResponse } from "../http.ts";
import { type ChargeListParams, listQuery } from "../list_params.ts";
import { ManagerResource } from "../admin.ts";
import type { Charge, ChargeOpenBySupplier, ChargeOpenByUnit } from "../types.ts";

declare module "../admin.ts" {
  interface ManagerResource {
    listCharges(
      params?: ChargeListParams,
      requestInit?: RequestInit,
    ): AsyncResult<Charge[]>;
    listChargesWithMeta(
      params?: ChargeListParams,
      requestInit?: RequestInit,
    ): Promise<{
      data: Charge[];
      meta: {
        availableYears: number[];
        outOfYear: { count: number; totalOpenCents: number } | null;
      };
      pagination?: { page: number; perPage: number; total: number; totalPages: number };
      status: number;
    }>;
    listTopOpenChargesByGroup(
      topPerGroup?: number,
      requestInit?: RequestInit,
    ): AsyncResult<{
      byUnit: Record<string, ChargeOpenByUnit[]>;
      bySupplier: Record<string, ChargeOpenBySupplier[]>;
    }>;
    getCharge(
      chargeId: string,
      requestInit?: RequestInit,
    ): AsyncResult<Charge>;
    createCharge(
      body: Record<string, unknown>,
      requestInit?: RequestInit,
    ): AsyncResult<Charge>;
    updateCharge(
      chargeId: string,
      body: Record<string, unknown>,
      requestInit?: RequestInit,
    ): AsyncResult<Charge>;
    cancelCharge(
      chargeId: string,
      body: { reason: string },
      requestInit?: RequestInit,
    ): AsyncResult<Charge>;
    setChargeBudget(
      chargeId: string,
      budgetId: string | null,
      requestInit?: RequestInit,
    ): AsyncResult<Charge>;
    createRefacturations(
      chargeId: string,
      body: {
        allocations: Array<{ unitId: string; amountCents: number; description?: string }>;
        issueDate?: string;
        /** Obrigatório - sem vencimento a refaturação nunca entra nos atrasos. */
        dueDate: string;
      },
      requestInit?: RequestInit,
    ): AsyncResult<{
      created: number;
      total_cents: number;
      remaining_cents: number;
      charges: Charge[];
    }>;
    getChargeLedger(chargeId: string, requestInit?: RequestInit): AsyncResult<
      Array<{
        id: string;
        entryDate: string;
        entryType: string;
        accountCode: string;
        direction: string;
        amount: number;
        description: string;
        refType: string | null;
        refId: string | null;
        createdAt: string;
      }>
    >;
    listChargeAttachments(
      chargeId: string,
      requestInit?: RequestInit,
    ): AsyncResult<
      Array<
        {
          id: string;
          chargeId: string;
          filename: string;
          mimeType: string;
          fileSize: number;
          createdAt: string;
        }
      >
    >;
    addChargeAttachment(
      chargeId: string,
      bytes: Uint8Array | Blob,
      fileName: string,
      mimeType?: string,
      requestInit?: RequestInit,
    ): AsyncResult<
      { id: string; chargeId: string; filename: string; mimeType: string; fileSize: number }
    >;
    deleteChargeAttachment(
      chargeId: string,
      attachmentId: string,
      requestInit?: RequestInit,
    ): AsyncResult<void>;
  }
}

// Charges
export function registerChargeMethods(): void {
  ManagerResource.prototype.listCharges = function (params = {}, requestInit) {
    const qs = listQuery(params);
    return this.request<Charge[]>("GET", qs ? `/charges?${qs}` : "/charges", requestInit);
  };

  /** Variante que devolve `{ data, meta }`. Quando `withMeta=1` é enviado,
   *  a API enriquece a resposta com `availableYears` e `outOfYear`. Útil
   *  para a listagem do panel que precisa do dropdown de anos + banner. */
  ManagerResource.prototype.listChargesWithMeta = async function (
    this: ManagerResource,
    params: ChargeListParams = {},
    requestInit: RequestInit = {},
  ): Promise<{
    data: Charge[];
    meta: {
      availableYears: number[];
      outOfYear: { count: number; totalOpenCents: number } | null;
    };
    /** Presente quando params.page foi passado. */
    pagination?: { page: number; perPage: number; total: number; totalPages: number };
    status: number;
  }> {
    const qs = listQuery({ ...params, withMeta: "1" });
    const url = `${this.basePathFor(requestInit)}/charges?${qs}`;
    const response = await this.httpClient.get(url, requestInit);
    if (!response.ok) {
      // Reusa pipeline de erro do validateResponse (consistência das ApiError).
      await validateResponse(response);
    }
    const body = await response.json() as {
      data: Charge[];
      meta?: {
        availableYears?: number[];
        outOfYear?: { count: number; totalOpenCents: number } | null;
      };
      pagination?: { page: number; perPage: number; total: number; totalPages: number };
    };
    return {
      data: body.data ?? [],
      meta: {
        availableYears: body.meta?.availableYears ?? [],
        outOfYear: body.meta?.outOfYear ?? null,
      },
      pagination: body.pagination,
      status: response.status,
    };
  };

  /** Top-N charges em aberto por unit/supplier numa só query SQL (`ROW_NUMBER()
   *  OVER` no servidor). Usado pelo modal de reconciliação para não puxar 5000
   *  charges e fatiar em JS. `topPerGroup` default 6 (max 20). */
  ManagerResource.prototype.listTopOpenChargesByGroup = function (topPerGroup = 6, requestInit) {
    return this.request<{
      byUnit: Record<string, ChargeOpenByUnit[]>;
      bySupplier: Record<string, ChargeOpenBySupplier[]>;
    }>("GET", `/charges/top_open_by_group?topPerGroup=${topPerGroup}`, requestInit);
  };

  ManagerResource.prototype.getCharge = function (chargeId, requestInit) {
    return this.request<Charge>("GET", `/charges/${chargeId}`, requestInit);
  };

  ManagerResource.prototype.createCharge = function (body, requestInit) {
    return this.request<Charge>("POST", "/charges", requestInit, body);
  };

  ManagerResource.prototype.updateCharge = function (chargeId, body, requestInit) {
    return this.request<Charge>("PATCH", `/charges/${chargeId}`, requestInit, body);
  };

  /** POST /charges/:chargeId/cancel - cancela com justificação; reverte antes as
   *  offsets (charge_offset) e o ledger fica com o lançamento inverso. */
  ManagerResource.prototype.cancelCharge = function (chargeId, body, requestInit) {
    return this.request<Charge>("POST", `/charges/${chargeId}/cancel`, requestInit, body);
  };

  /** PATCH /charges/:chargeId/budget - etiqueta a despesa com o orçamento da
   *  Ata. Separado do PATCH geral: aceita despesas já pagas. */
  ManagerResource.prototype.setChargeBudget = function (chargeId, budgetId, requestInit) {
    return this.request<Charge>("PATCH", `/charges/${chargeId}/budget`, requestInit, { budgetId });
  };

  ManagerResource.prototype.createRefacturations = function (chargeId, body, requestInit) {
    return this.request<{
      created: number;
      total_cents: number;
      remaining_cents: number;
      charges: Charge[];
    }>("POST", `/charges/${chargeId}/refacturations`, requestInit, body);
  };

  /** GET /charges/:chargeId/ledger - linhas que afetam a charge (diretas via
   *  fn_charge_ai + indiretas via settlements). Auditoria / efeito contabilístico. */
  ManagerResource.prototype.getChargeLedger = function (chargeId, requestInit) {
    return this.request<
      Array<{
        id: string;
        entryDate: string;
        entryType: string;
        accountCode: string;
        direction: string;
        amount: number;
        description: string;
        refType: string | null;
        refId: string | null;
        createdAt: string;
      }>
    >("GET", `/charges/${chargeId}/ledger`, requestInit);
  };

  // ── Charge attachments (faturas, recibos, comprovativos) ──────────────────
  ManagerResource.prototype.listChargeAttachments = function (chargeId, requestInit) {
    return this.request<
      Array<
        {
          id: string;
          chargeId: string;
          filename: string;
          mimeType: string;
          fileSize: number;
          createdAt: string;
        }
      >
    >("GET", `/charges/${chargeId}/attachments`, requestInit);
  };

  ManagerResource.prototype.addChargeAttachment = function (
    chargeId,
    bytes,
    fileName,
    mimeType,
    requestInit,
  ) {
    return this.upload<
      { id: string; chargeId: string; filename: string; mimeType: string; fileSize: number }
    >(`/charges/${chargeId}/attachments`, bytes, fileName, mimeType, requestInit);
  };

  ManagerResource.prototype.deleteChargeAttachment = function (
    chargeId,
    attachmentId,
    requestInit,
  ) {
    return this.request<void>(
      "DELETE",
      `/charges/${chargeId}/attachments/${attachmentId}`,
      requestInit,
    );
  };
}
