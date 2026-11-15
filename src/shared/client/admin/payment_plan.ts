// Client admin para Plano de pagamento (ADR 0039). Espelha o pattern do
// pathology.ts (registerXxxMethods chamado de admin.ts no ctor).

import { type AsyncResult } from "../http.ts";
import { ManagerResource } from "../admin.ts";

export type PaymentPlanStatus = "active" | "completed" | "broken" | "cancelled";

export interface PaymentPlan {
  id: string;
  condominiumId: string;
  unitId: string;
  status: PaymentPlanStatus;
  /** Nota partilhada: sai no email de lembrete ao condómino. */
  notes: string | null;
  /** Nota interna: só a administração a vê. */
  internalNotes: string | null;
  endDate: string | null;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

declare module "../admin.ts" {
  interface ManagerResource {
    listPaymentPlans(
      unitId: string,
      requestInit?: RequestInit,
    ): AsyncResult<PaymentPlan[]>;
    createPaymentPlan(
      unitId: string,
      body: { notes?: string | null; internalNotes?: string | null; endDate?: string | null },
      requestInit?: RequestInit,
    ): AsyncResult<PaymentPlan>;
    updatePaymentPlan(
      unitId: string,
      planId: string,
      body: Partial<{
        notes: string | null;
        internalNotes: string | null;
        endDate: string | null;
        status: PaymentPlanStatus;
      }>,
      requestInit?: RequestInit,
    ): AsyncResult<PaymentPlan>;
  }
}

export function registerPaymentPlanMethods(): void {
  ManagerResource.prototype.listPaymentPlans = function (unitId, requestInit) {
    return this.request<PaymentPlan[]>("GET", `/units/${unitId}/payment-plans`, requestInit);
  };

  ManagerResource.prototype.createPaymentPlan = function (unitId, body, requestInit) {
    return this.request<PaymentPlan>(
      "POST",
      `/units/${unitId}/payment-plans`,
      requestInit,
      body,
    );
  };

  ManagerResource.prototype.updatePaymentPlan = function (unitId, planId, body, requestInit) {
    return this.request<PaymentPlan>(
      "PATCH",
      `/units/${unitId}/payment-plans/${planId}`,
      requestInit,
      body,
    );
  };
}
