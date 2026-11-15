import { type AsyncResult } from "../http.ts";
import { ManagerResource } from "../admin.ts";

declare module "../admin.ts" {
  interface ManagerResource {
    dashboardMetrics(
      params?: { year?: string; month?: string },
      requestInit?: RequestInit,
    ): AsyncResult<{
      year: number;
      month: string;
      totalIssued: number;
      totalPaidCount: number;
      paidThisMonthCents: number;
      collectionRate: number;
    }>;
  }
}

export function registerDashboardMethods(): void {
  /** KPIs de receivables (paid this month, collection rate) calculados em SQL.
   *  Substitui o `listCharges({kind:'receivable',year:current})` que o dashboard
   *  fazia para obter 3 escalares iterando 1000+ rows. */
  ManagerResource.prototype.dashboardMetrics = function (params = {}, requestInit) {
    const qs = new URLSearchParams(params as Record<string, string>).toString();
    const path = `/dashboard/metrics${qs ? `?${qs}` : ""}`;
    return this.request<{
      year: number;
      month: string;
      totalIssued: number;
      totalPaidCount: number;
      paidThisMonthCents: number;
      collectionRate: number;
    }>("GET", path, requestInit);
  };
}
