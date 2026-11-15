import { type AsyncResult } from "../http.ts";
import { ManagerResource } from "../admin.ts";
import type { ChartOfAccount } from "../types.ts";

declare module "../admin.ts" {
  interface ManagerResource {
    listExpenseCategories(requestInit?: RequestInit): AsyncResult<ChartOfAccount[]>;
    getChartOfAccount(
      categoryId: string,
      requestInit?: RequestInit,
    ): AsyncResult<ChartOfAccount>;
    createChartOfAccount(
      body: Record<string, unknown>,
      requestInit?: RequestInit,
    ): AsyncResult<ChartOfAccount>;
    updateChartOfAccount(
      categoryId: string,
      body: Record<string, unknown>,
      requestInit?: RequestInit,
    ): AsyncResult<ChartOfAccount>;
    deleteChartOfAccount(categoryId: string, requestInit?: RequestInit): AsyncResult<void>;
  }
}

// Expense Categories
export function registerChartOfAccountMethods(): void {
  ManagerResource.prototype.listExpenseCategories = function (requestInit) {
    return this.request<ChartOfAccount[]>("GET", "/chart_of_accounts", requestInit);
  };

  ManagerResource.prototype.getChartOfAccount = function (categoryId, requestInit) {
    return this.request<ChartOfAccount>("GET", `/chart_of_accounts/${categoryId}`, requestInit);
  };

  ManagerResource.prototype.createChartOfAccount = function (body, requestInit) {
    return this.request<ChartOfAccount>("POST", "/chart_of_accounts", requestInit, body);
  };

  ManagerResource.prototype.updateChartOfAccount = function (categoryId, body, requestInit) {
    return this.request<ChartOfAccount>(
      "PATCH",
      `/chart_of_accounts/${categoryId}`,
      requestInit,
      body,
    );
  };

  ManagerResource.prototype.deleteChartOfAccount = function (categoryId, requestInit) {
    return this.request<void>("DELETE", `/chart_of_accounts/${categoryId}`, requestInit);
  };
}
