import { type AsyncResult, HttpClient, validateResponse } from "./http.ts";
import { registerCondominiumMethods } from "./admin/condominium.ts";
import { registerUnitMethods } from "./admin/unit.ts";
import { registerOccupantMethods } from "./admin/occupant.ts";
import { registerUnitOccupantMethods } from "./admin/unit_occupant.ts";
import { registerUserMethods } from "./admin/user.ts";
import { registerChartOfAccountMethods } from "./admin/chart_of_account.ts";
import { registerBudgetMethods } from "./admin/budget.ts";
import { registerAssemblyMethods } from "./admin/assembly.ts";
import { registerChargeMethods } from "./admin/charge.ts";
import { registerSupplierMethods } from "./admin/supplier.ts";
import { registerRecurringTemplateMethods } from "./admin/recurring_template.ts";
import { registerBankAccountMethods } from "./admin/bank_account.ts";
import { registerFcrTransferMethods } from "./admin/fcr_transfer.ts";
import { registerBankTransactionMethods } from "./admin/bank_transaction.ts";
import { registerSettlementMethods } from "./admin/settlement.ts";
import { registerReceiptMethods } from "./admin/receipt.ts";
import { registerInsuranceMethods } from "./admin/insurance.ts";
import { registerBillingReminderMethods } from "./admin/billing_reminder.ts";
import { registerInspectionMethods } from "./admin/inspection.ts";
import { registerTicketMethods } from "./admin/ticket.ts";
import { registerDocumentMethods } from "./admin/document.ts";
import { registerPathologyMethods } from "./admin/pathology.ts";
import { registerPaymentPlanMethods } from "./admin/payment_plan.ts";
import { registerDashboardMethods } from "./admin/dashboard.ts";
import { registerReportMethods } from "./admin/report.ts";

export class ManagerResource {
  constructor(
    public readonly httpClient: HttpClient,
    public readonly cidResolver: () => string,
  ) {}

  // Recurso preso a um condomínio explícito, sem depender do cid do ALS.
  forCondominium(cid: string): ManagerResource {
    return new ManagerResource(this.httpClient, () => cid);
  }

  // URL base com cid injectado: `config.condominiumId` (panel via ALS) ganha ao
  // header `x-condominium-id` (só e2e, sem resolver). Atira se nenhum existir.
  basePathFor(requestInit?: RequestInit): string {
    const h = (requestInit?.headers ?? {}) as Record<string, string>;
    const cid = this.cidResolver() || h["x-condominium-id"];
    if (!cid) {
      throw new Error(
        "ManagerResource: condominiumId em falta (config.condominiumId ou header x-condominium-id)",
      );
    }
    return `/v1/admin/condominiums/${cid}`;
  }

  // Primitivo dos métodos de recurso: path relativo à base do condomínio +
  // verbo + validateResponse. `json` presente → body JSON com Content-Type.
  async request<T>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    requestInit: RequestInit = {},
    json?: unknown,
  ): AsyncResult<T> {
    const url = `${this.basePathFor(requestInit)}${path}`;
    const init: RequestInit = json === undefined ? requestInit : {
      ...requestInit,
      body: JSON.stringify(json),
      headers: { ...requestInit.headers, "Content-Type": "application/json" },
    };
    const response = await this.httpClient[
      method.toLowerCase() as "get" | "post" | "patch" | "put" | "delete"
    ](url, init);
    return validateResponse<T>(response);
  }

  // Upload multipart de 1 ficheiro (campo `file`). Sem Content-Type manual:
  // fetch trata do boundary. `fields` acompanha o ficheiro no mesmo multipart -
  // é como a vigência da apólice chega junto do documento.
  async upload<T>(
    path: string,
    bytes: Uint8Array | Blob,
    fileName: string,
    contentType = "application/octet-stream",
    requestInit: RequestInit = {},
    fields: Record<string, string> = {},
  ): AsyncResult<T> {
    const form = new FormData();
    const blob = bytes instanceof Blob
      ? bytes
      : new Blob([bytes as unknown as BlobPart], { type: contentType });
    form.append("file", blob, fileName);
    for (const [name, value] of Object.entries(fields)) form.append(name, value);
    const response = await this.httpClient.post(`${this.basePathFor(requestInit)}${path}`, {
      ...requestInit,
      body: form,
      headers: requestInit.headers,
    });
    return validateResponse<T>(response);
  }

  // GET que devolve a Response crua (bytes + headers) - downloads e PDFs.
  // O panel converte-a em resposta de download via proxyDownload().
  downloadStream(path: string, requestInit: RequestInit = {}): Promise<Response> {
    return this.httpClient.get(`${this.basePathFor(requestInit)}${path}`, requestInit);
  }
}

// Regista os métodos no prototype DEPOIS da classe estar declarada (evita
// TDZ - as imports são hoisted, mas a invocação acontece em runtime).
registerCondominiumMethods();
registerUnitMethods();
registerOccupantMethods();
registerUnitOccupantMethods();
registerUserMethods();
registerChartOfAccountMethods();
registerBudgetMethods();
registerAssemblyMethods();
registerChargeMethods();
registerSupplierMethods();
registerRecurringTemplateMethods();
registerBankAccountMethods();
registerFcrTransferMethods();
registerBankTransactionMethods();
registerSettlementMethods();
registerReceiptMethods();
registerInsuranceMethods();
registerBillingReminderMethods();
registerInspectionMethods();
registerTicketMethods();
registerDocumentMethods();
registerPathologyMethods();
registerPaymentPlanMethods();
registerDashboardMethods();
registerReportMethods();
