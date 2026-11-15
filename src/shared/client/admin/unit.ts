import { type AsyncResult } from "../http.ts";
import { ManagerResource } from "../admin.ts";
import type { Unit } from "../types.ts";

/** Anexo de um email logado - só nome + tipo (sem conteúdo). */
export interface EmailAttachmentRow {
  filename: string;
  contentType?: string | null;
}

/**
 * Linha de audit de email (audit.email_log) para display. `bodyHtml`/`attachments`
 * são NULL em linhas antigas (UI mostra "corpo não guardado").
 */
export interface EmailLogRow {
  id: string;
  createdAt: string;
  subject: string;
  recipient: string;
  status: "sent" | "failed";
  error: string | null;
  bodyHtml: string | null;
  attachments: EmailAttachmentRow[] | null;
}

declare module "../admin.ts" {
  interface ManagerResource {
    listUnits(requestInit?: RequestInit): AsyncResult<Unit[]>;
    getUnit(unitId: string, requestInit?: RequestInit): AsyncResult<Unit>;
    listUnitEmails(
      unitId: string,
      requestInit?: RequestInit,
    ): AsyncResult<EmailLogRow[]>;
    createUnitForMe(
      body: Record<string, unknown>,
      requestInit?: RequestInit,
    ): AsyncResult<Unit>;
    updateUnitDescription(
      unitId: string,
      body: Record<string, unknown>,
      requestInit?: RequestInit,
    ): AsyncResult<Unit>;
    previewUnitsImport(
      file: File | Blob,
      filename: string,
      requestInit?: RequestInit,
    ): AsyncResult<{
      filename: string;
      units: Array<Record<string, unknown>>;
      occupants: Array<Record<string, unknown>>;
      links: Array<Record<string, unknown>>;
      warnings: string[];
      summary: Record<string, unknown>;
    }>;
    commitUnitsImport(
      body: {
        units: Array<Record<string, unknown>>;
        occupants: Array<Record<string, unknown>>;
        links: Array<Record<string, unknown>>;
      },
      requestInit?: RequestInit,
    ): AsyncResult<{
      unitsCreated: number;
      units_skipped: number;
      occupantsCreated: number;
      occupants_skipped: number;
      linksCreated: number;
      link_errors: string[];
    }>;
    deleteUnit(unitId: string, requestInit?: RequestInit): AsyncResult<void>;
  }
}

// Units
export function registerUnitMethods(): void {
  ManagerResource.prototype.listUnits = function (requestInit) {
    return this.request<Unit[]>("GET", "/units", requestInit);
  };

  ManagerResource.prototype.getUnit = function (unitId, requestInit) {
    return this.request<Unit>("GET", `/units/${unitId}`, requestInit);
  };

  ManagerResource.prototype.listUnitEmails = function (unitId, requestInit) {
    return this.request<EmailLogRow[]>("GET", `/units/${unitId}/emails`, requestInit);
  };

  ManagerResource.prototype.createUnitForMe = function (body, requestInit) {
    return this.request<Unit>("POST", "/units", requestInit, body);
  };

  ManagerResource.prototype.updateUnitDescription = function (unitId, body, requestInit) {
    return this.request<Unit>("PATCH", `/units/${unitId}`, requestInit, body);
  };

  ManagerResource.prototype.previewUnitsImport = function (file, filename, requestInit) {
    return this.upload<{
      filename: string;
      units: Array<Record<string, unknown>>;
      occupants: Array<Record<string, unknown>>;
      links: Array<Record<string, unknown>>;
      warnings: string[];
      summary: Record<string, unknown>;
    }>("/units/import/preview", file, filename, undefined, requestInit);
  };

  ManagerResource.prototype.commitUnitsImport = function (body, requestInit) {
    return this.request<{
      unitsCreated: number;
      units_skipped: number;
      occupantsCreated: number;
      occupants_skipped: number;
      linksCreated: number;
      link_errors: string[];
    }>("POST", "/units/import/commit", requestInit, body);
  };

  ManagerResource.prototype.deleteUnit = function (unitId, requestInit) {
    return this.request<void>("DELETE", `/units/${unitId}`, requestInit);
  };
}
