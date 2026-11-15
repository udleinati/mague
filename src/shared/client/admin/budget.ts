import { type AsyncResult } from "../http.ts";
import { ManagerResource } from "../admin.ts";
import type { Budget, BudgetLine, BudgetQuotaMap } from "../types.ts";

declare module "../admin.ts" {
  interface ManagerResource {
    listBudgets(requestInit?: RequestInit): AsyncResult<Budget[]>;
    getBudget(budgetId: string, requestInit?: RequestInit): AsyncResult<Budget>;
    createBudget(
      body: Record<string, unknown>,
      requestInit?: RequestInit,
    ): AsyncResult<Budget>;
    updateBudget(
      budgetId: string,
      body: Record<string, unknown>,
      requestInit?: RequestInit,
    ): AsyncResult<Budget>;
    deleteBudget(budgetId: string, requestInit?: RequestInit): AsyncResult<void>;
    rejectBudget(budgetId: string, requestInit?: RequestInit): AsyncResult<Budget>;
    reopenBudget(budgetId: string, requestInit?: RequestInit): AsyncResult<Budget>;
    listBudgetLines(
      budgetId: string,
      requestInit?: RequestInit,
    ): AsyncResult<BudgetLine[]>;
    createBudgetLine(
      budgetId: string,
      body: Record<string, unknown>,
      requestInit?: RequestInit,
    ): AsyncResult<BudgetLine>;
    updateBudgetLine(
      budgetId: string,
      lineId: string,
      body: Record<string, unknown>,
      requestInit?: RequestInit,
    ): AsyncResult<BudgetLine>;
    deleteBudgetLine(
      budgetId: string,
      lineId: string,
      requestInit?: RequestInit,
    ): AsyncResult<void>;
    generateQuotas(
      budgetId: string,
      body?: { throughDate?: string; firstMonth?: string; notes?: string | null },
      requestInit?: RequestInit,
    ): AsyncResult<
      Budget & { chargesCreated: number; throughDate?: string; crossesYear?: boolean }
    >;
    getBudgetQuotaMap(
      budgetId: string,
      requestInit?: RequestInit,
    ): AsyncResult<BudgetQuotaMap>;
  }
}

// Budgets
export function registerBudgetMethods(): void {
  ManagerResource.prototype.listBudgets = function (requestInit) {
    return this.request<Budget[]>("GET", "/budgets", requestInit);
  };

  ManagerResource.prototype.getBudget = function (budgetId, requestInit) {
    return this.request<Budget>("GET", `/budgets/${budgetId}`, requestInit);
  };

  ManagerResource.prototype.createBudget = function (body, requestInit) {
    return this.request<Budget>("POST", "/budgets", requestInit, body);
  };

  ManagerResource.prototype.updateBudget = function (budgetId, body, requestInit) {
    return this.request<Budget>("PATCH", `/budgets/${budgetId}`, requestInit, body);
  };

  ManagerResource.prototype.deleteBudget = function (budgetId, requestInit) {
    return this.request<void>("DELETE", `/budgets/${budgetId}`, requestInit);
  };

  ManagerResource.prototype.rejectBudget = function (budgetId, requestInit) {
    return this.request<Budget>("POST", `/budgets/${budgetId}/reject`, requestInit, {});
  };

  ManagerResource.prototype.reopenBudget = function (budgetId, requestInit) {
    return this.request<Budget>("POST", `/budgets/${budgetId}/reopen`, requestInit, {});
  };

  // Budget Lines
  ManagerResource.prototype.listBudgetLines = function (budgetId, requestInit) {
    return this.request<BudgetLine[]>("GET", `/budgets/${budgetId}/lines`, requestInit);
  };

  ManagerResource.prototype.createBudgetLine = function (budgetId, body, requestInit) {
    return this.request<BudgetLine>("POST", `/budgets/${budgetId}/lines`, requestInit, body);
  };

  ManagerResource.prototype.updateBudgetLine = function (budgetId, lineId, body, requestInit) {
    return this.request<BudgetLine>(
      "PATCH",
      `/budgets/${budgetId}/lines/${lineId}`,
      requestInit,
      body,
    );
  };

  ManagerResource.prototype.deleteBudgetLine = function (budgetId, lineId, requestInit) {
    return this.request<void>("DELETE", `/budgets/${budgetId}/lines/${lineId}`, requestInit);
  };

  /** Gera quotas até `throughDate` (default: fim do ano do budget). Idempotente:
   *  re-chamar com datas maiores só gera os meses ainda em falta. */
  ManagerResource.prototype.generateQuotas = function (budgetId, body = {}, requestInit) {
    return this.request<
      Budget & { chargesCreated: number; throughDate?: string; crossesYear?: boolean }
    >("POST", `/budgets/${budgetId}/generate_quotas`, requestInit, body);
  };

  ManagerResource.prototype.getBudgetQuotaMap = function (budgetId, requestInit) {
    return this.request<BudgetQuotaMap>("GET", `/budgets/${budgetId}/quota_map`, requestInit);
  };
}
