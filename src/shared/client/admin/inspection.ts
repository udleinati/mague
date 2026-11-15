import { type AsyncResult } from "../http.ts";
import { ManagerResource } from "../admin.ts";
import type { Inspection } from "../types.ts";

declare module "../admin.ts" {
  interface ManagerResource {
    listInspections(
      params?: {
        category?: string;
        status?: "ok" | "due_soon" | "expired" | "inactive";
        lite?: "1" | "true";
      },
      requestInit?: RequestInit,
    ): AsyncResult<Inspection[]>;
    listPortalInspections(requestInit?: RequestInit): AsyncResult<Inspection[]>;
    getInspection(
      inspectionId: string,
      requestInit?: RequestInit,
    ): AsyncResult<Inspection>;
    createInspection(
      body: {
        category: string;
        description: string;
        validUntil: string;
        lastDoneDate?: string | null;
        notifyDaysBefore?: number;
        notes?: string | null;
        supplierId?: string | null;
      },
      requestInit?: RequestInit,
    ): AsyncResult<Inspection>;
    updateInspection(
      inspectionId: string,
      body: Record<string, unknown>,
      requestInit?: RequestInit,
    ): AsyncResult<Inspection>;
    deleteInspection(inspectionId: string, requestInit?: RequestInit): AsyncResult<void>;
    countInspectionAlerts(requestInit?: RequestInit): AsyncResult<{ count: number }>;
    activateInspection(
      inspectionId: string,
      requestInit?: RequestInit,
    ): AsyncResult<Inspection>;
    deactivateInspection(
      inspectionId: string,
      requestInit?: RequestInit,
    ): AsyncResult<Inspection>;
    addInspectionAttachment(
      inspectionId: string,
      bytes: Uint8Array | Blob,
      fileName: string,
      mimeType?: string,
      requestInit?: RequestInit,
    ): AsyncResult<Inspection>;
    deleteInspectionAttachment(
      inspectionId: string,
      attachmentId: string,
      requestInit?: RequestInit,
    ): AsyncResult<void>;
  }
}

// ─── Inspections ─────────────────────────────────────────────────────────

export function registerInspectionMethods(): void {
  /** lite=1 → não traz attachments (≤ 100 rows poupadas em condos
   * com muitas inspeções). Usar quando só precisas de contagens/datas. */
  ManagerResource.prototype.listInspections = function (params = {}, requestInit) {
    const qs = new URLSearchParams(params as Record<string, string>).toString();
    return this.request<Inspection[]>("GET", `/inspections${qs ? `?${qs}` : ""}`, requestInit);
  };

  /** Subset público das inspeções (is_active=true). Usado pelo portal da
   *  fração - acessível a qualquer membro do condo. */
  ManagerResource.prototype.listPortalInspections = function (requestInit) {
    return this.request<Inspection[]>("GET", "/inspections/portal", requestInit);
  };

  ManagerResource.prototype.getInspection = function (inspectionId, requestInit) {
    return this.request<Inspection>("GET", `/inspections/${inspectionId}`, requestInit);
  };

  ManagerResource.prototype.createInspection = function (body, requestInit) {
    return this.request<Inspection>("POST", "/inspections", requestInit, body);
  };

  ManagerResource.prototype.updateInspection = function (inspectionId, body, requestInit) {
    return this.request<Inspection>("PATCH", `/inspections/${inspectionId}`, requestInit, body);
  };

  ManagerResource.prototype.deleteInspection = function (inspectionId, requestInit) {
    return this.request<void>("DELETE", `/inspections/${inspectionId}`, requestInit);
  };

  /** Conta inspeções em estado due_soon + expired - usado pelo badge no menu. */
  ManagerResource.prototype.countInspectionAlerts = function (requestInit) {
    return this.request<{ count: number }>("GET", "/inspections/alerts/count", requestInit);
  };

  ManagerResource.prototype.activateInspection = function (inspectionId, requestInit) {
    return this.request<Inspection>(
      "POST",
      `/inspections/${inspectionId}/activate`,
      requestInit,
      {},
    );
  };

  /** Desactiva: deixa de contar para o badge. */
  ManagerResource.prototype.deactivateInspection = function (inspectionId, requestInit) {
    return this.request<Inspection>(
      "POST",
      `/inspections/${inspectionId}/deactivate`,
      requestInit,
      {},
    );
  };

  /** Anexo de qualquer tipo, max 20 MB. Devolve a inspeção atualizada. */
  ManagerResource.prototype.addInspectionAttachment = function (
    inspectionId,
    bytes,
    fileName,
    mimeType,
    requestInit,
  ) {
    return this.upload<Inspection>(
      `/inspections/${inspectionId}/attachments`,
      bytes,
      fileName,
      mimeType,
      requestInit,
    );
  };

  /** Apaga um anexo (soft delete). Outros anexos da inspeção mantêm-se. */
  ManagerResource.prototype.deleteInspectionAttachment = function (
    inspectionId,
    attachmentId,
    requestInit,
  ) {
    return this.request<void>(
      "DELETE",
      `/inspections/${inspectionId}/attachments/${attachmentId}`,
      requestInit,
    );
  };
}
