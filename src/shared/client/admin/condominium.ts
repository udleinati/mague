import { type AsyncResult } from "../http.ts";
import { ManagerResource } from "../admin.ts";
import type { Condominium } from "../types.ts";

declare module "../admin.ts" {
  interface ManagerResource {
    getMe(requestInit?: RequestInit): AsyncResult<Condominium>;
    updateMe(
      body: Record<string, unknown>,
      requestInit?: RequestInit,
    ): AsyncResult<Condominium>;
  }
}

// Condomínio ativo - cid já no prefixo, `/me` devolve esse. Plural segue
// a convenção dos outros recursos (`/units`, `/occupants`, …).
export function registerCondominiumMethods(): void {
  ManagerResource.prototype.getMe = function (requestInit) {
    return this.request<Condominium>("GET", "/condominiums/me", requestInit);
  };

  ManagerResource.prototype.updateMe = function (body, requestInit) {
    return this.request<Condominium>("PATCH", "/condominiums/me", requestInit, body);
  };
}
