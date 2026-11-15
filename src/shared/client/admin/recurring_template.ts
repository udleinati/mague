import { type AsyncResult } from "../http.ts";
import { ManagerResource } from "../admin.ts";

declare module "../admin.ts" {
  interface ManagerResource {
    listRecurringTemplates(
      requestInit?: RequestInit,
    ): AsyncResult<Record<string, unknown>[]>;
    createRecurringTemplate(
      body: Record<string, unknown>,
      requestInit?: RequestInit,
    ): AsyncResult<Record<string, unknown>>;
    updateRecurringTemplate(
      templateId: string,
      body: Record<string, unknown>,
      requestInit?: RequestInit,
    ): AsyncResult<Record<string, unknown>>;
    deleteRecurringTemplate(
      templateId: string,
      requestInit?: RequestInit,
    ): AsyncResult<void>;
    triggerRecurringRun(
      body: Record<string, unknown>,
      requestInit?: RequestInit,
    ): AsyncResult<Record<string, unknown>>;
  }
}

// Recurring templates
export function registerRecurringTemplateMethods(): void {
  ManagerResource.prototype.listRecurringTemplates = function (requestInit) {
    return this.request<Record<string, unknown>[]>("GET", "/recurring_templates", requestInit);
  };

  ManagerResource.prototype.createRecurringTemplate = function (body, requestInit) {
    return this.request<Record<string, unknown>>(
      "POST",
      "/recurring_templates",
      requestInit,
      body,
    );
  };

  ManagerResource.prototype.updateRecurringTemplate = function (templateId, body, requestInit) {
    return this.request<Record<string, unknown>>(
      "PATCH",
      `/recurring_templates/${templateId}`,
      requestInit,
      body,
    );
  };

  ManagerResource.prototype.deleteRecurringTemplate = function (templateId, requestInit) {
    return this.request<void>("DELETE", `/recurring_templates/${templateId}`, requestInit);
  };

  ManagerResource.prototype.triggerRecurringRun = function (body, requestInit) {
    return this.request<Record<string, unknown>>(
      "POST",
      "/recurring_templates/generate",
      requestInit,
      body,
    );
  };
}
