import { type AsyncResult } from "../http.ts";
import { ManagerResource } from "../admin.ts";

declare module "../admin.ts" {
  interface ManagerResource {
    listInsuranceUnitsStatus(
      params?: { unitId?: string },
      requestInit?: RequestInit,
    ): AsyncResult<
      Array<{
        unit: { id: string; designation: string; identifier: string | null };
        /** Status detalhado da policy "selected" (compat). */
        status: {
          kind: string;
          policy?: Record<string, unknown>;
          daysUntilExpiry?: number;
          daysOverdue?: number;
        };
        /** Status agregado da fração (best across all). Usar para badges/filtros. */
        aggregate: string;
        /** Contagem por status raw (active/pending_review/rejected). */
        counts: Record<string, number>;
        /** Todas as policies não-superseded com a classificação individual. */
        policies: Array<{
          kind: string;
          policy?: Record<string, unknown>;
          daysUntilExpiry?: number;
          daysOverdue?: number;
        }>;
        lastReminderAt: string | null;
        /** Último pedido de comprovativo de renovação (cooldown próprio). */
        lastRenewalEvidenceAt: string | null;
        /** Dias da renovação presumida sem comprovativo mais antiga; null se não há. */
        presumedEvidenceDays: number | null;
        hasOccupantWithEmail: boolean;
        /** Botão "Atualizar" da lista (ver `unitUpdateAction`). */
        updateAction:
          | { kind: "review" }
          | { kind: "renew"; policyId: string }
          | { kind: "register" };
      }>
    >;
    listInsurancePolicies(
      params?: Record<string, string>,
      requestInit?: RequestInit,
    ): AsyncResult<Record<string, unknown>[]>;
    getInsurancePolicy(
      policyId: string,
      requestInit?: RequestInit,
    ): AsyncResult<Record<string, unknown>>;
    // Confirm continua a ser só do portal (Ver ADR 0016: o comprovativo vem da
    // fração). O que o admin carrega não é prova da fração - é o documento que
    // lhe foi entregue fora do portal, marcado como tal.
    /** Regista de raiz o documento entregue à administração: multipart com o
     *  ficheiro e a vigência decidida no formulário. Fica `pending_review`. */
    createInsurancePolicy(
      unitId: string,
      bytes: Uint8Array | Blob,
      fileName: string,
      contentType: string,
      dates: { validFrom: string; validTo: string },
      requestInit?: RequestInit,
    ): AsyncResult<Record<string, unknown>>;
    editInsurancePolicy(
      policyId: string,
      body: {
        validFrom?: string;
        validTo?: string;
        policyNumber?: string;
        insurer?: string;
        coverageAmountCents?: number | null;
      },
      requestInit?: RequestInit,
    ): AsyncResult<Record<string, unknown>>;
    renewInsurancePolicy(
      policyId: string,
      requestInit?: RequestInit,
    ): AsyncResult<Record<string, unknown>>;
    /** Renova com o documento entregue à administração: a antiga fica `active`
     *  até a nova ser aprovada. Campo omitido herda o da anterior. */
    renewInsurancePolicyWithDocument(
      policyId: string,
      bytes: Uint8Array | Blob,
      fileName: string,
      contentType: string,
      details: {
        validFrom: string;
        validTo: string;
        policyNumber?: string;
        insurer?: string;
        coverageAmountCents?: string;
      },
      requestInit?: RequestInit,
    ): AsyncResult<Record<string, unknown>>;
    undoInsuranceRenewal(
      policyId: string,
      requestInit?: RequestInit,
    ): AsyncResult<Record<string, unknown>>;
    reopenInsurancePolicy(
      policyId: string,
      requestInit?: RequestInit,
    ): AsyncResult<Record<string, unknown>>;
    approveInsurancePolicy(
      policyId: string,
      requestInit?: RequestInit,
    ): AsyncResult<Record<string, unknown>>;
    rejectInsurancePolicy(
      policyId: string,
      body: { reason: string },
      requestInit?: RequestInit,
    ): AsyncResult<Record<string, unknown>>;
    deleteInsurancePolicy(
      policyId: string,
      requestInit?: RequestInit,
    ): AsyncResult<null>;
    sendInsuranceReminder(
      unitId: string,
      requestInit?: RequestInit,
    ): AsyncResult<{ sent: number; failed: number; recipients: Array<Record<string, unknown>> }>;
    /** HTML do email de lembrete de seguro de uma fração (com a nota gravada),
     *  tal como seria enviado. Read-only, não envia nem regista. */
    previewInsuranceReminder(
      unitId: string,
      requestInit?: RequestInit,
    ): AsyncResult<{ html: string; subject: string }>;
    sendInsuranceRemindersBulk(
      requestInit?: RequestInit,
    ): AsyncResult<{
      unitsTargeted: number;
      /** Quantas dessas levaram o pedido de comprovativo da renovação. */
      evidenceTargeted?: number;
      sent: number;
      failed: number;
      perUnit: Array<Record<string, unknown>>;
      skippedNoEmail?: string[];
    }>;
  }
}

// ─── Insurance ───────────────────────────────────────────────────────────

export function registerInsuranceMethods(): void {
  ManagerResource.prototype.listInsuranceUnitsStatus = function (params = {}, requestInit) {
    const qs = params.unitId ? `?unitId=${encodeURIComponent(params.unitId)}` : "";
    return this.request<
      Array<{
        unit: { id: string; designation: string; identifier: string | null };
        status: {
          kind: string;
          policy?: Record<string, unknown>;
          daysUntilExpiry?: number;
          daysOverdue?: number;
        };
        aggregate: string;
        counts: Record<string, number>;
        policies: Array<{
          kind: string;
          policy?: Record<string, unknown>;
          daysUntilExpiry?: number;
          daysOverdue?: number;
        }>;
        lastReminderAt: string | null;
        lastRenewalEvidenceAt: string | null;
        presumedEvidenceDays: number | null;
        hasOccupantWithEmail: boolean;
        updateAction:
          | { kind: "review" }
          | { kind: "renew"; policyId: string }
          | { kind: "register" };
      }>
    >("GET", `/insurance/units-status${qs}`, requestInit);
  };

  ManagerResource.prototype.listInsurancePolicies = function (params = {}, requestInit) {
    const qs = new URLSearchParams(params).toString();
    return this.request<Record<string, unknown>[]>(
      "GET",
      `/insurance${qs ? `?${qs}` : ""}`,
      requestInit,
    );
  };

  ManagerResource.prototype.getInsurancePolicy = function (policyId, requestInit) {
    return this.request<Record<string, unknown>>("GET", `/insurance/${policyId}`, requestInit);
  };

  ManagerResource.prototype.createInsurancePolicy = function (
    unitId,
    bytes,
    fileName,
    contentType,
    dates,
    requestInit,
  ) {
    return this.upload<Record<string, unknown>>(
      `/units/${unitId}/insurance`,
      bytes,
      fileName,
      contentType,
      requestInit,
      dates,
    );
  };

  /** Edita campos de uma apólice em `pending_review` (Ver ADR 0016: active /
   *  rejected / superseded são imutáveis). */
  ManagerResource.prototype.editInsurancePolicy = function (policyId, body, requestInit) {
    return this.request<Record<string, unknown>>(
      "PATCH",
      `/insurance/${policyId}`,
      requestInit,
      body,
    );
  };

  /** Renova uma apólice `active`: cria nova vigência `presumed_at`, herda dados
   *  e supersede a antiga. Ver ADR 0016 (path admin renew). */
  ManagerResource.prototype.renewInsurancePolicy = function (policyId, requestInit) {
    return this.request<Record<string, unknown>>(
      "POST",
      `/insurance/${policyId}/renew`,
      requestInit,
      {},
    );
  };

  ManagerResource.prototype.renewInsurancePolicyWithDocument = function (
    policyId,
    bytes,
    fileName,
    contentType,
    details,
    requestInit,
  ) {
    const fields: Record<string, string> = {};
    for (const [name, value] of Object.entries(details)) {
      if (value !== undefined) fields[name] = value;
    }
    return this.upload<Record<string, unknown>>(
      `/insurance/${policyId}/renew`,
      bytes,
      fileName,
      contentType,
      requestInit,
      fields,
    );
  };

  /** Desfaz uma renovação presumida sem comprovativo: apaga-a e devolve o
   *  predecessor a `active`. Ver ADR 0040 (linhagem). */
  ManagerResource.prototype.undoInsuranceRenewal = function (policyId, requestInit) {
    return this.request<Record<string, unknown>>(
      "POST",
      `/insurance/${policyId}/undo-renewal`,
      requestInit,
      {},
    );
  };

  /** Reabre uma apólice `active`/`rejected` para `pending_review` (recovery de
   *  aprovações/rejeições erradas). */
  ManagerResource.prototype.reopenInsurancePolicy = function (policyId, requestInit) {
    return this.request<Record<string, unknown>>(
      "POST",
      `/insurance/${policyId}/reopen`,
      requestInit,
      {},
    );
  };

  ManagerResource.prototype.approveInsurancePolicy = function (policyId, requestInit) {
    return this.request<Record<string, unknown>>(
      "POST",
      `/insurance/${policyId}/approve`,
      requestInit,
      {},
    );
  };

  ManagerResource.prototype.rejectInsurancePolicy = function (policyId, body, requestInit) {
    return this.request<Record<string, unknown>>(
      "POST",
      `/insurance/${policyId}/reject`,
      requestInit,
      body,
    );
  };

  ManagerResource.prototype.deleteInsurancePolicy = function (policyId, requestInit) {
    return this.request<null>("DELETE", `/insurance/${policyId}`, requestInit);
  };

  ManagerResource.prototype.sendInsuranceReminder = function (unitId, requestInit) {
    return this.request<
      { sent: number; failed: number; recipients: Array<Record<string, unknown>> }
    >("POST", `/insurance/reminders/${unitId}`, requestInit, {});
  };

  ManagerResource.prototype.previewInsuranceReminder = function (unitId, requestInit) {
    return this.request<{ html: string; subject: string }>(
      "GET",
      `/insurance/reminders/${unitId}/preview`,
      requestInit,
    );
  };

  ManagerResource.prototype.sendInsuranceRemindersBulk = function (requestInit) {
    return this.request<{
      unitsTargeted: number;
      evidenceTargeted?: number;
      sent: number;
      failed: number;
      perUnit: Array<Record<string, unknown>>;
      skippedNoEmail?: string[];
    }>("POST", "/insurance/reminders", requestInit, {});
  };
}
