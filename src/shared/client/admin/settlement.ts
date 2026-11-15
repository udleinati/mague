import { type AsyncResult } from "../http.ts";
import { listQuery, type SettlementListParams } from "../list_params.ts";
import { ManagerResource } from "../admin.ts";
import type { Settlement } from "../types.ts";

declare module "../admin.ts" {
  interface ManagerResource {
    createSettlement(
      body: Record<string, unknown>,
      requestInit?: RequestInit,
    ): AsyncResult<Settlement>;
    listSettlements(
      params?: SettlementListParams,
      requestInit?: RequestInit,
    ): AsyncResult<Settlement[]>;
  }
}

export function registerSettlementMethods(): void {
  ManagerResource.prototype.createSettlement = function (body, requestInit) {
    return this.request<Settlement>("POST", "/settlements", requestInit, body);
  };

  ManagerResource.prototype.listSettlements = function (params = {}, requestInit) {
    const qs = listQuery(params);
    return this.request<Settlement[]>(
      "GET",
      `/settlements${qs ? `?${qs}` : ""}`,
      requestInit,
    );
  };
}
