import { type AsyncResult } from "../http.ts";
import { ManagerResource } from "../admin.ts";
import type { Pathology, PathologyCategory, PathologyStatus } from "../types.ts";

declare module "../admin.ts" {
  interface ManagerResource {
    listPathologies(
      params?: { status?: PathologyStatus },
      requestInit?: RequestInit,
    ): AsyncResult<Pathology[]>;
    getPathology(pathologyId: string, requestInit?: RequestInit): AsyncResult<Pathology>;
    createPathology(
      body: {
        title: string;
        description?: string | null;
        category: PathologyCategory;
        status?: PathologyStatus;
        affectsCommonArea?: boolean;
        unitIds?: string[];
        resolutionNotes?: string | null;
        dismissedReason?: string | null;
        detectedAt?: string;
        resolvedAt?: string | null;
        dismissedAt?: string | null;
      },
      requestInit?: RequestInit,
    ): AsyncResult<Pathology>;
    updatePathology(
      pathologyId: string,
      body: Partial<{
        title: string;
        description: string | null;
        category: PathologyCategory;
        status: PathologyStatus;
        affectsCommonArea: boolean;
        unitIds: string[];
        resolutionNotes: string | null;
        dismissedReason: string | null;
        detectedAt: string;
        resolvedAt: string | null;
        dismissedAt: string | null;
      }>,
      requestInit?: RequestInit,
    ): AsyncResult<Pathology>;
    deletePathology(pathologyId: string, requestInit?: RequestInit): AsyncResult<void>;
    uploadPathologyAttachment(
      pathologyId: string,
      bytes: Uint8Array | Blob,
      fileName: string,
      contentType?: string,
      requestInit?: RequestInit,
    ): AsyncResult<Record<string, unknown>>;
    deletePathologyAttachment(
      pathologyId: string,
      attachmentId: string,
      requestInit?: RequestInit,
    ): AsyncResult<void>;
    /** Duplica attachments de um ticket nesta patologia (server-side
     *  S3 get+put + INSERT em core.attachment). Usado pelo
     *  "promover ticket a patologia". */
    copyAttachmentsFromTicket(
      pathologyId: string,
      ticketId: string,
      requestInit?: RequestInit,
    ): AsyncResult<{ copied: number; failed: number; total: number }>;
  }
}

export function registerPathologyMethods(): void {
  ManagerResource.prototype.listPathologies = function (params = {}, requestInit) {
    const qs = new URLSearchParams();
    if (params.status) qs.set("status", params.status);
    return this.request<Pathology[]>(
      "GET",
      qs.toString() ? `/pathologies?${qs}` : "/pathologies",
      requestInit,
    );
  };

  ManagerResource.prototype.getPathology = function (pathologyId, requestInit) {
    return this.request<Pathology>("GET", `/pathologies/${pathologyId}`, requestInit);
  };

  ManagerResource.prototype.createPathology = function (body, requestInit) {
    return this.request<Pathology>("POST", "/pathologies", requestInit, body);
  };

  ManagerResource.prototype.updatePathology = function (pathologyId, body, requestInit) {
    return this.request<Pathology>("PATCH", `/pathologies/${pathologyId}`, requestInit, body);
  };

  ManagerResource.prototype.deletePathology = function (pathologyId, requestInit) {
    return this.request<void>("DELETE", `/pathologies/${pathologyId}`, requestInit);
  };

  ManagerResource.prototype.uploadPathologyAttachment = function (
    pathologyId,
    bytes,
    fileName,
    contentType,
    requestInit,
  ) {
    return this.upload<Record<string, unknown>>(
      `/pathologies/${pathologyId}/attachments`,
      bytes,
      fileName,
      contentType,
      requestInit,
    );
  };

  ManagerResource.prototype.deletePathologyAttachment = function (
    pathologyId,
    attachmentId,
    requestInit,
  ) {
    return this.request<void>(
      "DELETE",
      `/pathologies/${pathologyId}/attachments/${attachmentId}`,
      requestInit,
    );
  };

  ManagerResource.prototype.copyAttachmentsFromTicket = function (
    pathologyId,
    ticketId,
    requestInit,
  ) {
    return this.request<{ copied: number; failed: number; total: number }>(
      "POST",
      `/pathologies/${pathologyId}/copy-attachments-from-ticket`,
      requestInit,
      { ticketId },
    );
  };
}
