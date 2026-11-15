import { type AsyncResult } from "../http.ts";
import { ManagerResource } from "../admin.ts";
import type { Document, DocumentCategory } from "../types.ts";

declare module "../admin.ts" {
  interface ManagerResource {
    listDocuments(
      params?: { category?: DocumentCategory; isPublic?: boolean; limit?: number },
      requestInit?: RequestInit,
    ): AsyncResult<Document[]>;
    getDocument(documentId: string, requestInit?: RequestInit): AsyncResult<Document>;
    createDocument(
      body: {
        title: string;
        description?: string | null;
        category?: DocumentCategory;
        isPublic?: boolean;
        publishedAt?: string;
      },
      requestInit?: RequestInit,
    ): AsyncResult<Document>;
    updateDocument(
      documentId: string,
      body: {
        title?: string;
        description?: string | null;
        category?: DocumentCategory;
        isPublic?: boolean;
        publishedAt?: string;
      },
      requestInit?: RequestInit,
    ): AsyncResult<Document>;
    deleteDocument(documentId: string, requestInit?: RequestInit): AsyncResult<void>;
    uploadDocumentAttachment(
      documentId: string,
      bytes: Uint8Array | Blob,
      fileName: string,
      contentType?: string,
      requestInit?: RequestInit,
    ): AsyncResult<Record<string, unknown>>;
    deleteDocumentAttachment(
      documentId: string,
      attachmentId: string,
      requestInit?: RequestInit,
    ): AsyncResult<void>;
  }
}

export function registerDocumentMethods(): void {
  ManagerResource.prototype.listDocuments = function (params = {}, requestInit) {
    const qs = new URLSearchParams();
    if (params.category) qs.set("category", params.category);
    if (params.isPublic !== undefined) qs.set("isPublic", String(params.isPublic));
    if (params.limit !== undefined) qs.set("limit", String(params.limit));
    const path = qs.toString() ? `/documents?${qs}` : "/documents";
    return this.request<Document[]>("GET", path, requestInit);
  };

  ManagerResource.prototype.getDocument = function (documentId, requestInit) {
    return this.request<Document>("GET", `/documents/${documentId}`, requestInit);
  };

  ManagerResource.prototype.createDocument = function (body, requestInit) {
    return this.request<Document>("POST", "/documents", requestInit, body);
  };

  ManagerResource.prototype.updateDocument = function (documentId, body, requestInit) {
    return this.request<Document>("PATCH", `/documents/${documentId}`, requestInit, body);
  };

  ManagerResource.prototype.deleteDocument = function (documentId, requestInit) {
    return this.request<void>("DELETE", `/documents/${documentId}`, requestInit);
  };

  ManagerResource.prototype.uploadDocumentAttachment = function (
    documentId,
    bytes,
    fileName,
    contentType,
    requestInit,
  ) {
    return this.upload<Record<string, unknown>>(
      `/documents/${documentId}/attachments`,
      bytes,
      fileName,
      contentType,
      requestInit,
    );
  };

  ManagerResource.prototype.deleteDocumentAttachment = function (
    documentId,
    attachmentId,
    requestInit,
  ) {
    return this.request<void>(
      "DELETE",
      `/documents/${documentId}/attachments/${attachmentId}`,
      requestInit,
    );
  };
}
