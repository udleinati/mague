import { type AsyncResult } from "../http.ts";
import { ManagerResource } from "../admin.ts";
import type { Occupant } from "../types.ts";
import type { EmailLogRow } from "./unit.ts";

/** Resposta de `POST /occupants/:id/invite`. Espelha o handler
 *  `invite_by_occupant`. */
export interface InviteOccupantResult {
  userId: string | null;
  sentTo: string;
  expiresAt: string | null;
}

declare module "../admin.ts" {
  interface ManagerResource {
    listOccupants(
      params?: Record<string, string>,
      requestInit?: RequestInit,
    ): AsyncResult<Occupant[]>;
    getOccupant(occupantId: string, requestInit?: RequestInit): AsyncResult<Occupant>;
    listOccupantEmails(
      occupantId: string,
      requestInit?: RequestInit,
    ): AsyncResult<EmailLogRow[]>;
    createOccupant(
      body: Record<string, unknown>,
      requestInit?: RequestInit,
    ): AsyncResult<Occupant>;
    updateOccupant(
      occupantId: string,
      body: Record<string, unknown>,
      requestInit?: RequestInit,
    ): AsyncResult<Occupant>;
    deleteOccupant(occupantId: string, requestInit?: RequestInit): AsyncResult<void>;
    /** Convida (ou reenvia convite a) o occupant para o portal. Gera novo
     *  invite_token e envia email. O guard de cooldown (ADR 0032) pode
     *  devolver 422 COOLDOWN_ACTIVE. */
    inviteOccupant(
      occupantId: string,
      requestInit?: RequestInit,
    ): AsyncResult<InviteOccupantResult>;
  }
}

// Occupants
export function registerOccupantMethods(): void {
  /** Lista occupants do condomínio atual.
   *  @param params Filtros opcionais: `isActive=true|false`, `limit=N` (max 1000). */
  ManagerResource.prototype.listOccupants = function (params = {}, requestInit) {
    const qs = new URLSearchParams(params).toString();
    const path = qs ? `/occupants?${qs}` : "/occupants";
    return this.request<Occupant[]>("GET", path, requestInit);
  };

  ManagerResource.prototype.getOccupant = function (occupantId, requestInit) {
    return this.request<Occupant>("GET", `/occupants/${occupantId}`, requestInit);
  };

  ManagerResource.prototype.listOccupantEmails = function (occupantId, requestInit) {
    return this.request<EmailLogRow[]>("GET", `/occupants/${occupantId}/emails`, requestInit);
  };

  ManagerResource.prototype.createOccupant = function (body, requestInit) {
    return this.request<Occupant>("POST", "/occupants", requestInit, body);
  };

  ManagerResource.prototype.updateOccupant = function (occupantId, body, requestInit) {
    return this.request<Occupant>("PATCH", `/occupants/${occupantId}`, requestInit, body);
  };

  ManagerResource.prototype.deleteOccupant = function (occupantId, requestInit) {
    return this.request<void>("DELETE", `/occupants/${occupantId}`, requestInit);
  };

  ManagerResource.prototype.inviteOccupant = function (occupantId, requestInit) {
    return this.request<InviteOccupantResult>(
      "POST",
      `/occupants/${occupantId}/invite`,
      requestInit,
      {},
    );
  };
}
