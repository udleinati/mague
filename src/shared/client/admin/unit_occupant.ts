import { type AsyncResult } from "../http.ts";
import { ManagerResource } from "../admin.ts";
import type { UnitOccupant } from "../types.ts";

declare module "../admin.ts" {
  interface ManagerResource {
    listUnitOccupants(
      unitId: string,
      requestInit?: RequestInit,
    ): AsyncResult<UnitOccupant[]>;
    getUnitOccupant(
      unitId: string,
      unitOccupantId: string,
      requestInit?: RequestInit,
    ): AsyncResult<UnitOccupant>;
    createUnitOccupant(
      unitId: string,
      body: Record<string, unknown>,
      requestInit?: RequestInit,
    ): AsyncResult<UnitOccupant>;
    updateUnitOccupant(
      unitId: string,
      unitOccupantId: string,
      body: Record<string, unknown>,
      requestInit?: RequestInit,
    ): AsyncResult<UnitOccupant>;
    deleteUnitOccupant(
      unitId: string,
      unitOccupantId: string,
      requestInit?: RequestInit,
    ): AsyncResult<void>;
    deleteUnitOccupantByOccupant(
      unitId: string,
      occupantId: string,
      requestInit?: RequestInit,
    ): AsyncResult<void>;
  }
}

// Unit Occupants
export function registerUnitOccupantMethods(): void {
  ManagerResource.prototype.listUnitOccupants = function (unitId, requestInit) {
    return this.request<UnitOccupant[]>("GET", `/units/${unitId}/occupants`, requestInit);
  };

  ManagerResource.prototype.getUnitOccupant = function (unitId, unitOccupantId, requestInit) {
    return this.request<UnitOccupant>(
      "GET",
      `/units/${unitId}/occupants/${unitOccupantId}`,
      requestInit,
    );
  };

  ManagerResource.prototype.createUnitOccupant = function (unitId, body, requestInit) {
    return this.request<UnitOccupant>("POST", `/units/${unitId}/occupants`, requestInit, body);
  };

  ManagerResource.prototype.updateUnitOccupant = function (
    unitId,
    unitOccupantId,
    body,
    requestInit,
  ) {
    return this.request<UnitOccupant>(
      "PATCH",
      `/units/${unitId}/occupants/${unitOccupantId}`,
      requestInit,
      body,
    );
  };

  ManagerResource.prototype.deleteUnitOccupant = function (unitId, unitOccupantId, requestInit) {
    return this.request<void>(
      "DELETE",
      `/units/${unitId}/occupants/${unitOccupantId}`,
      requestInit,
    );
  };

  ManagerResource.prototype.deleteUnitOccupantByOccupant = function (
    unitId,
    occupantId,
    requestInit,
  ) {
    return this.request<void>(
      "DELETE",
      `/units/${unitId}/occupants/by-occupant/${occupantId}`,
      requestInit,
    );
  };
}
