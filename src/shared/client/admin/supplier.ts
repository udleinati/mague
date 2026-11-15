import { type AsyncResult } from "../http.ts";
import { ManagerResource } from "../admin.ts";
import type { Supplier } from "../types.ts";

declare module "../admin.ts" {
  interface ManagerResource {
    listSuppliers(requestInit?: RequestInit): AsyncResult<Supplier[]>;
    getSupplier(
      supplierId: string,
      requestInit?: RequestInit,
    ): AsyncResult<Supplier>;
    createSupplier(
      body: Record<string, unknown>,
      requestInit?: RequestInit,
    ): AsyncResult<Supplier>;
    updateSupplier(
      supplierId: string,
      body: Record<string, unknown>,
      requestInit?: RequestInit,
    ): AsyncResult<Supplier>;
    deleteSupplier(supplierId: string, requestInit?: RequestInit): AsyncResult<void>;
  }
}

// Suppliers
export function registerSupplierMethods(): void {
  ManagerResource.prototype.listSuppliers = function (requestInit) {
    return this.request<Supplier[]>("GET", "/suppliers", requestInit);
  };

  ManagerResource.prototype.getSupplier = function (supplierId, requestInit) {
    return this.request<Supplier>("GET", `/suppliers/${supplierId}`, requestInit);
  };

  ManagerResource.prototype.createSupplier = function (body, requestInit) {
    return this.request<Supplier>("POST", "/suppliers", requestInit, body);
  };

  ManagerResource.prototype.updateSupplier = function (supplierId, body, requestInit) {
    return this.request<Supplier>("PATCH", `/suppliers/${supplierId}`, requestInit, body);
  };

  ManagerResource.prototype.deleteSupplier = function (supplierId, requestInit) {
    return this.request<void>("DELETE", `/suppliers/${supplierId}`, requestInit);
  };
}
