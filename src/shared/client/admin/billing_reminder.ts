// Client admin para Lembretes de cobrança (ADR 0028). Espelha o pattern do
// `recurring_template.ts` (registerXxxMethods chamado de admin.ts no ctor).

import { type AsyncResult } from "../http.ts";
import { ManagerResource } from "../admin.ts";

export interface BillingOverdueUnit {
  unitId: string;
  unitLabel: string;
  /** Total vencido (todas as receivables com due_date <= conciliação). */
  totalOwedCents: number;
  /** Subset vencido há mais do que o bloco selecionado (coluna "Vencido"). */
  overdueBeyondThresholdCents: number;
  creditCents: number;
  oldestOverdueDueDate: string;
  lastReminderAt: string | null;
  inCooldown: boolean;
  /** Instante (ISO) em que o cooldown termina. null quando não está em
   *  cooldown. A UI mostra-o + "faltam N dias" no tooltip. */
  cooldownUntil: string | null;
  /** true se a fração tem plano de pagamento ativo (ADR 0039). */
  hasActivePlan: boolean;
  /** Resumo do plano ativo para badge/tooltip (null quando não há). */
  paymentPlan:
    | { notes: string | null; internalNotes: string | null; endDate: string | null }
    | null;
}

/** Filtros da página de lembretes (ADR 0039). */
export interface BillingOverdueFilters {
  /** Bloco de antiguidade cumulativo. 30 (default); 1 = qualquer quota vencida (>= 1 dia). */
  overdue?: 1 | 30 | 60 | 90;
  /** Presença de plano de pagamento ativo. */
  plan?: "all" | "with" | "without";
}

export interface BillingReminderEligibility {
  ok: boolean;
  reason?: "never_reconciled" | "reconciliation_stale";
}

export interface BillingOverdueResponse {
  reconciledThroughDate: string | null;
  guard: BillingReminderEligibility;
  units: BillingOverdueUnit[];
}

export interface BillingReminderRecipientResult {
  occupantId: string;
  email: string;
  name: string;
  status: "sent" | "failed";
  sentAt: string;
  error?: string;
}

export interface SendBillingReminderResponse {
  sentCount: number;
  totalRecipients: number;
  recipients: BillingReminderRecipientResult[];
}

export interface BillingReminderPreviewResponse {
  /** HTML completo do email tal como seria enviado (com a nota atual). */
  html: string;
  /** Assunto do email, o mesmo do envio. */
  subject: string;
}

declare module "../admin.ts" {
  interface ManagerResource {
    listBillingOverdueUnits(
      params?: BillingOverdueFilters,
      requestInit?: RequestInit,
    ): AsyncResult<BillingOverdueResponse>;
    sendBillingReminder(
      unitId: string,
      body?: { trigger?: "individual" | "bulk" },
      requestInit?: RequestInit,
    ): AsyncResult<SendBillingReminderResponse>;
    previewBillingReminder(
      unitId: string,
      requestInit?: RequestInit,
    ): AsyncResult<BillingReminderPreviewResponse>;
  }
}

export function registerBillingReminderMethods(): void {
  ManagerResource.prototype.listBillingOverdueUnits = function (params = {}, requestInit) {
    const qs = new URLSearchParams();
    if (params.overdue && params.overdue !== 30) qs.set("overdue", String(params.overdue));
    if (params.plan && params.plan !== "all") qs.set("plan", params.plan);
    const base = "/billing-reminders/overdue";
    const path = qs.toString() ? `${base}?${qs}` : base;
    return this.request<BillingOverdueResponse>("GET", path, requestInit);
  };

  ManagerResource.prototype.sendBillingReminder = function (unitId, body = {}, requestInit) {
    return this.request<SendBillingReminderResponse>(
      "POST",
      `/billing-reminders/units/${unitId}`,
      requestInit,
      body,
    );
  };

  ManagerResource.prototype.previewBillingReminder = function (unitId, requestInit) {
    return this.request<BillingReminderPreviewResponse>(
      "GET",
      `/billing-reminders/units/${unitId}/preview`,
      requestInit,
    );
  };
}
