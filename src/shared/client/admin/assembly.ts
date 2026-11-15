import { type AsyncResult } from "../http.ts";
import { ManagerResource } from "../admin.ts";

declare module "../admin.ts" {
  interface ManagerResource {
    listAssemblies(
      params?: Record<string, string>,
      requestInit?: RequestInit,
    ): AsyncResult<Record<string, unknown>[]>;
    getAssembly(
      assemblyId: string,
      requestInit?: RequestInit,
    ): AsyncResult<Record<string, unknown>>;
    createAssembly(
      body: Record<string, unknown>,
      requestInit?: RequestInit,
    ): AsyncResult<Record<string, unknown>>;
    updateAssembly(
      assemblyId: string,
      body: Record<string, unknown>,
      requestInit?: RequestInit,
    ): AsyncResult<Record<string, unknown>>;
    deleteAssembly(assemblyId: string, requestInit?: RequestInit): AsyncResult<void>;
    createAssemblyAgendaItem(
      assemblyId: string,
      body: Record<string, unknown>,
      requestInit?: RequestInit,
    ): AsyncResult<Record<string, unknown>>;
    updateAssemblyAgendaItem(
      assemblyId: string,
      agendaItemId: string,
      body: Record<string, unknown>,
      requestInit?: RequestInit,
    ): AsyncResult<Record<string, unknown>>;
    deleteAssemblyAgendaItem(
      assemblyId: string,
      agendaItemId: string,
      requestInit?: RequestInit,
    ): AsyncResult<void>;
    listAssemblyAttachments(
      assemblyId: string,
      requestInit?: RequestInit,
    ): AsyncResult<Array<Record<string, unknown>>>;
    uploadAssemblyAttachment(
      assemblyId: string,
      file: File,
      requestInit?: RequestInit,
    ): AsyncResult<Record<string, unknown>>;
    deleteAssemblyAttachment(
      assemblyId: string,
      attachmentId: string,
      requestInit?: RequestInit,
    ): AsyncResult<void>;
    assemblyAttachmentUrl(
      assemblyId: string,
      attachmentId: string,
      baseUrl: string,
    ): string;
    listAssemblyAttendees(
      assemblyId: string,
      requestInit?: RequestInit,
    ): AsyncResult<Array<Record<string, unknown>>>;
    createAssemblyAttendee(
      assemblyId: string,
      body: Record<string, unknown>,
      requestInit?: RequestInit,
    ): AsyncResult<Record<string, unknown>>;
    deleteAssemblyAttendee(
      assemblyId: string,
      attendeeId: string,
      requestInit?: RequestInit,
    ): AsyncResult<void>;
    sendAssemblyConvocation(
      assemblyId: string,
      requestInit?: RequestInit,
    ): AsyncResult<ConvocationSendResultData>;
    resendAssemblyConvocation(
      assemblyId: string,
      occupantId: string,
      unitId: string,
      requestInit?: RequestInit,
    ): AsyncResult<ConvocationSendResultData>;
    listAssemblyConvocationRecipients(
      assemblyId: string,
      requestInit?: RequestInit,
    ): AsyncResult<ConvocationRecipientStatusData[]>;
    previewAssemblyConvocation(
      assemblyId: string,
      occupantId: string,
      unitId: string,
      requestInit?: RequestInit,
    ): AsyncResult<ConvocationEmailPreviewData>;
  }
}

/** HTML do corpo do email da convocatória tal como seria enviado a este destinatário. */
export interface ConvocationEmailPreviewData {
  html: string;
  /** Assunto do email, o mesmo do envio. */
  subject: string;
}

/** Contagens devolvidas por um envio da convocatória (bulk ou individual). */
export interface ConvocationSendResultData {
  totalRecipients: number;
  sent: number;
  failed: number;
  noEmail: number;
  /** Saltados por cooldown (só no bulk; 0 no individual). */
  skippedCooldown: number;
  recipients: Array<Record<string, unknown>>;
}

/** Destinatário (pessoa × fração) + estado de envio/cooldown para a tabela admin. */
export interface ConvocationRecipientStatusData {
  occupantId: string;
  unitId: string;
  name: string;
  /** Rótulo da fração ("designation - identifier"). */
  unitLabel: string;
  email: string | null;
  hasEmail: boolean;
  lastSentAt: string | null;
  inCooldown: boolean;
  cooldownUntil: string | null;
}

// Assemblies
export function registerAssemblyMethods(): void {
  /** Lista assembleias do condomínio atual.
   *  @param params Filtros opcionais: `status=scheduled|held|cancelled`, `limit=N` (max 1000). */
  ManagerResource.prototype.listAssemblies = function (params = {}, requestInit) {
    const qs = new URLSearchParams(params).toString();
    return this.request<Record<string, unknown>[]>(
      "GET",
      qs ? `/assemblies?${qs}` : "/assemblies",
      requestInit,
    );
  };

  ManagerResource.prototype.getAssembly = function (assemblyId, requestInit) {
    return this.request<Record<string, unknown>>("GET", `/assemblies/${assemblyId}`, requestInit);
  };

  ManagerResource.prototype.createAssembly = function (body, requestInit) {
    return this.request<Record<string, unknown>>("POST", "/assemblies", requestInit, body);
  };

  ManagerResource.prototype.updateAssembly = function (assemblyId, body, requestInit) {
    return this.request<Record<string, unknown>>(
      "PATCH",
      `/assemblies/${assemblyId}`,
      requestInit,
      body,
    );
  };

  ManagerResource.prototype.deleteAssembly = function (assemblyId, requestInit) {
    return this.request<void>("DELETE", `/assemblies/${assemblyId}`, requestInit);
  };

  ManagerResource.prototype.createAssemblyAgendaItem = function (assemblyId, body, requestInit) {
    return this.request<Record<string, unknown>>(
      "POST",
      `/assemblies/${assemblyId}/agenda-items`,
      requestInit,
      body,
    );
  };

  ManagerResource.prototype.updateAssemblyAgendaItem = function (
    assemblyId,
    agendaItemId,
    body,
    requestInit,
  ) {
    return this.request<Record<string, unknown>>(
      "PATCH",
      `/assemblies/${assemblyId}/agenda-items/${agendaItemId}`,
      requestInit,
      body,
    );
  };

  ManagerResource.prototype.deleteAssemblyAgendaItem = function (
    assemblyId,
    agendaItemId,
    requestInit,
  ) {
    return this.request<void>(
      "DELETE",
      `/assemblies/${assemblyId}/agenda-items/${agendaItemId}`,
      requestInit,
    );
  };

  // ─── Assembly attachments ────────────────────────────────────────────
  ManagerResource.prototype.listAssemblyAttachments = function (assemblyId, requestInit) {
    return this.request<Array<Record<string, unknown>>>(
      "GET",
      `/assemblies/${assemblyId}/attachments`,
      requestInit,
    );
  };

  ManagerResource.prototype.uploadAssemblyAttachment = function (assemblyId, file, requestInit) {
    return this.upload<Record<string, unknown>>(
      `/assemblies/${assemblyId}/attachments`,
      file,
      file.name,
      file.type,
      requestInit,
    );
  };

  ManagerResource.prototype.deleteAssemblyAttachment = function (
    assemblyId,
    attachmentId,
    requestInit,
  ) {
    return this.request<void>(
      "DELETE",
      `/assemblies/${assemblyId}/attachments/${attachmentId}`,
      requestInit,
    );
  };

  ManagerResource.prototype.assemblyAttachmentUrl = function (
    this: ManagerResource,
    assemblyId: string,
    attachmentId: string,
    baseUrl: string,
  ): string {
    const cid = this.cidResolver();
    return `${baseUrl}/v1/admin/condominiums/${cid}/assemblies/${assemblyId}/attachments/${attachmentId}`;
  };

  // ─── Attendees (presenças + procurações) ──────────────────────────────────
  ManagerResource.prototype.listAssemblyAttendees = function (assemblyId, requestInit) {
    return this.request<Array<Record<string, unknown>>>(
      "GET",
      `/assemblies/${assemblyId}/attendees`,
      requestInit,
    );
  };

  ManagerResource.prototype.createAssemblyAttendee = function (assemblyId, body, requestInit) {
    return this.request<Record<string, unknown>>(
      "POST",
      `/assemblies/${assemblyId}/attendees`,
      requestInit,
      body,
    );
  };

  ManagerResource.prototype.deleteAssemblyAttendee = function (
    assemblyId,
    attendeeId,
    requestInit,
  ) {
    return this.request<void>(
      "DELETE",
      `/assemblies/${assemblyId}/attendees/${attendeeId}`,
      requestInit,
    );
  };

  // ─── Envio da convocatória (bulk) ─────────────────────────────────────────
  ManagerResource.prototype.sendAssemblyConvocation = function (assemblyId, requestInit) {
    return this.request<ConvocationSendResultData>(
      "POST",
      `/assemblies/${assemblyId}/convocation/send`,
      requestInit,
      {},
    );
  };

  // ─── Reenvio individual + destinatários/cooldown ──────────────────────────
  ManagerResource.prototype.resendAssemblyConvocation = function (
    assemblyId,
    occupantId,
    unitId,
    requestInit,
  ) {
    return this.request<ConvocationSendResultData>(
      "POST",
      `/assemblies/${assemblyId}/convocation/send/${occupantId}/${unitId}`,
      requestInit,
      {},
    );
  };

  ManagerResource.prototype.listAssemblyConvocationRecipients = function (
    assemblyId,
    requestInit,
  ) {
    return this.request<ConvocationRecipientStatusData[]>(
      "GET",
      `/assemblies/${assemblyId}/convocation/recipients`,
      requestInit,
    );
  };

  ManagerResource.prototype.previewAssemblyConvocation = function (
    assemblyId,
    occupantId,
    unitId,
    requestInit,
  ) {
    return this.request<ConvocationEmailPreviewData>(
      "GET",
      `/assemblies/${assemblyId}/convocation/preview/${occupantId}/${unitId}`,
      requestInit,
    );
  };
}
