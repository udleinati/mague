import { type AsyncResult } from "../http.ts";
import { ManagerResource } from "../admin.ts";

export interface FcrTransfer {
  id: string;
  condominiumId: string;
  direction: "to_fcr" | "to_ordinary";
  amountCents: number;
  transferDate: string;
  reason: string;
  createdAt: string;
}

declare module "../admin.ts" {
  interface ManagerResource {
    listFcrTransfers(requestInit?: RequestInit): AsyncResult<FcrTransfer[]>;
    createFcrTransfer(
      body: {
        direction: "to_fcr" | "to_ordinary";
        amountCents: number;
        date: string;
        reason: string;
      },
      requestInit?: RequestInit,
    ): AsyncResult<FcrTransfer>;
  }
}

/** Transferências entre a bolsa ordinária (121) e a bolsa FCR (122). */
export function registerFcrTransferMethods(): void {
  ManagerResource.prototype.listFcrTransfers = function (requestInit) {
    return this.request<FcrTransfer[]>("GET", "/fcr-transfers", requestInit);
  };

  ManagerResource.prototype.createFcrTransfer = function (body, requestInit) {
    return this.request<FcrTransfer>("POST", "/fcr-transfers", requestInit, body);
  };
}
