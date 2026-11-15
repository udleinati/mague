import { type AsyncResult } from "../http.ts";
import { ManagerResource } from "../admin.ts";
import type {
  Ticket,
  TicketAttachment,
  TicketCategory,
  TicketPriority,
  TicketStatus,
} from "../types.ts";

declare module "../admin.ts" {
  interface ManagerResource {
    listTickets(
      params?: { status?: string; category?: string; priority?: string; unitId?: string },
      requestInit?: RequestInit,
    ): AsyncResult<Ticket[]>;
    countOpenTickets(requestInit?: RequestInit): AsyncResult<{ count: number }>;
    getTicket(ticketId: string, requestInit?: RequestInit): AsyncResult<Ticket>;
    createTicket(
      body: {
        title: string;
        description?: string | null;
        category: TicketCategory;
        priority?: TicketPriority;
        unitId?: string | null;
        location?: string | null;
        visibility?: "admin_only" | "admin_unit" | "public";
      },
      requestInit?: RequestInit,
    ): AsyncResult<Ticket>;
    updateTicket(
      ticketId: string,
      body: {
        title?: string;
        description?: string | null;
        category?: TicketCategory;
        priority?: TicketPriority;
        status?: TicketStatus;
        unitId?: string | null;
        location?: string | null;
        visibility?: "admin_only" | "admin_unit" | "public";
        resolutionNotes?: string | null;
        /** ID da patologia a associar. `null` desassocia. Omitir não muda. */
        pathologyId?: string | null;
      },
      requestInit?: RequestInit,
    ): AsyncResult<Ticket>;
    deleteTicket(ticketId: string, requestInit?: RequestInit): AsyncResult<void>;
    addTicketComment(
      ticketId: string,
      body: { comment: string; isInternal?: boolean },
      requestInit?: RequestInit,
    ): AsyncResult<Ticket>;
    deleteTicketComment(
      ticketId: string,
      commentId: string,
      requestInit?: RequestInit,
    ): AsyncResult<void>;
    uploadTicketAttachment(
      ticketId: string,
      file: File,
      requestInit?: RequestInit,
    ): AsyncResult<TicketAttachment>;
    deleteTicketAttachment(
      ticketId: string,
      attachmentId: string,
      requestInit?: RequestInit,
    ): AsyncResult<void>;
    ticketAttachmentUrl(ticketId: string, attachmentId: string, baseUrl: string): string;
  }
}

// ── Tickets (ocorrências/avarias) ─────────────────────────────────────────
export function registerTicketMethods(): void {
  ManagerResource.prototype.listTickets = function (params = {}, requestInit) {
    const qs = new URLSearchParams(params as Record<string, string>).toString();
    return this.request<Ticket[]>("GET", qs ? `/tickets?${qs}` : "/tickets", requestInit);
  };

  /** Contagem de tickets em estado `open` ou `in_progress` - usado pelo
   *  badge no menu admin. */
  ManagerResource.prototype.countOpenTickets = function (requestInit) {
    return this.request<{ count: number }>("GET", "/tickets/count", requestInit);
  };

  ManagerResource.prototype.getTicket = function (ticketId, requestInit) {
    return this.request<Ticket>("GET", `/tickets/${ticketId}`, requestInit);
  };

  ManagerResource.prototype.createTicket = function (body, requestInit) {
    return this.request<Ticket>("POST", "/tickets", requestInit, body);
  };

  ManagerResource.prototype.updateTicket = function (ticketId, body, requestInit) {
    return this.request<Ticket>("PATCH", `/tickets/${ticketId}`, requestInit, body);
  };

  ManagerResource.prototype.deleteTicket = function (ticketId, requestInit) {
    return this.request<void>("DELETE", `/tickets/${ticketId}`, requestInit);
  };

  ManagerResource.prototype.addTicketComment = function (ticketId, body, requestInit) {
    return this.request<Ticket>("POST", `/tickets/${ticketId}/comments`, requestInit, body);
  };

  ManagerResource.prototype.deleteTicketComment = function (ticketId, commentId, requestInit) {
    return this.request<void>(
      "DELETE",
      `/tickets/${ticketId}/comments/${commentId}`,
      requestInit,
    );
  };

  // ── Ticket attachments (multipart) ────────────────────────────────────────
  ManagerResource.prototype.uploadTicketAttachment = function (ticketId, file, requestInit) {
    return this.upload<TicketAttachment>(
      `/tickets/${ticketId}/attachments`,
      file,
      file.name,
      file.type,
      requestInit,
    );
  };

  ManagerResource.prototype.deleteTicketAttachment = function (
    ticketId,
    attachmentId,
    requestInit,
  ) {
    return this.request<void>(
      "DELETE",
      `/tickets/${ticketId}/attachments/${attachmentId}`,
      requestInit,
    );
  };

  /** URL do PDF/imagem para `<a href>` ou `<img src>` direto no panel. */
  ManagerResource.prototype.ticketAttachmentUrl = function (
    this: ManagerResource,
    ticketId: string,
    attachmentId: string,
    baseUrl: string,
  ): string {
    const cid = this.cidResolver();
    return `${baseUrl}/v1/admin/condominiums/${cid}/tickets/${ticketId}/attachments/${attachmentId}`;
  };
}
