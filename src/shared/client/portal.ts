import { type AsyncResult, HttpClient, validateResponse } from "./http.ts";
import type { Condominium, PortalCharge, Receipt, Settlement } from "./types.ts";

// Cliente do portal do condómino (occupant). URLs em
// `/v1/portal/condominiums/:cid/...`; escopo de fração via `:unitId` no PATH.
// Maioritariamente read-only. Auth por JWT Bearer; os middlewares
// `requirePortalAccessToCondo`/`requirePortalAccessToUnit` validam acesso.
export class PortalResource {
  constructor(
    private readonly httpClient: HttpClient,
    private readonly cidResolver: () => string,
  ) {}

  /** Base do condomínio: `/v1/portal/condominiums/:cid`. O header
   *  `x-condominium-id` só serve quando não há resolver (compat com e2e). */
  private basePathFor(requestInit?: RequestInit): string {
    const h = (requestInit?.headers ?? {}) as Record<string, string>;
    const cid = this.cidResolver() || h["x-condominium-id"];
    if (!cid) throw new Error("PortalResource: condominiumId em falta");
    return `/v1/portal/condominiums/${cid}`;
  }

  // GET que devolve a Response crua (bytes + headers) - downloads e PDFs.
  // O panel converte-a em resposta de download via proxyDownload().
  downloadStream(path: string, requestInit: RequestInit = {}): Promise<Response> {
    return this.httpClient.get(`${this.basePathFor(requestInit)}${path}`, requestInit);
  }

  // ── Nível condomínio (assemblies, budgets, bank_accounts, inspections) ─
  async getCondominium(requestInit: RequestInit = {}): AsyncResult<Condominium> {
    const r = await this.httpClient.get(`${this.basePathFor(requestInit)}`, requestInit);
    return validateResponse<Condominium>(r);
  }

  async listAssemblies(
    params: Record<string, string> = {},
    requestInit: RequestInit = {},
  ): AsyncResult<Record<string, unknown>[]> {
    const qs = new URLSearchParams(params).toString();
    const url = `${this.basePathFor(requestInit)}/assemblies${qs ? `?${qs}` : ""}`;
    const r = await this.httpClient.get(url, requestInit);
    return validateResponse<Record<string, unknown>[]>(r);
  }

  async getAssembly(
    assemblyId: string,
    requestInit: RequestInit = {},
  ): AsyncResult<Record<string, unknown>> {
    const r = await this.httpClient.get(
      `${this.basePathFor(requestInit)}/assemblies/${assemblyId}`,
      requestInit,
    );
    return validateResponse<Record<string, unknown>>(r);
  }

  /** Anexos da assembleia (ata PDF, presenças). Read-only no portal. */
  async listAssemblyAttachments(
    assemblyId: string,
    requestInit: RequestInit = {},
  ): AsyncResult<Array<Record<string, unknown>>> {
    const r = await this.httpClient.get(
      `${this.basePathFor(requestInit)}/assemblies/${assemblyId}/attachments`,
      requestInit,
    );
    return validateResponse<Array<Record<string, unknown>>>(r);
  }

  /** URL para `<a href>` direto - download do anexo via portal. */
  assemblyAttachmentUrl(assemblyId: string, attachmentId: string, baseUrl: string): string {
    const cid = this.cidResolver();
    return `${baseUrl}/v1/portal/condominiums/${cid}/assemblies/${assemblyId}/attachments/${attachmentId}`;
  }

  async listBudgets(requestInit: RequestInit = {}): AsyncResult<Record<string, unknown>[]> {
    const r = await this.httpClient.get(`${this.basePathFor(requestInit)}/budgets`, requestInit);
    return validateResponse<Record<string, unknown>[]>(r);
  }

  async getBudget(
    budgetId: string,
    requestInit: RequestInit = {},
  ): AsyncResult<Record<string, unknown>> {
    const r = await this.httpClient.get(
      `${this.basePathFor(requestInit)}/budgets/${budgetId}`,
      requestInit,
    );
    return validateResponse<Record<string, unknown>>(r);
  }

  async getBudgetQuotaMap(
    budgetId: string,
    requestInit: RequestInit = {},
  ): AsyncResult<Record<string, unknown> | null> {
    const r = await this.httpClient.get(
      `${this.basePathFor(requestInit)}/budgets/${budgetId}/quota_map`,
      requestInit,
    );
    return validateResponse<Record<string, unknown> | null>(r);
  }

  async listBankAccounts(requestInit: RequestInit = {}): AsyncResult<Record<string, unknown>[]> {
    const r = await this.httpClient.get(
      `${this.basePathFor(requestInit)}/bank_accounts`,
      requestInit,
    );
    return validateResponse<Record<string, unknown>[]>(r);
  }

  async listInspections(requestInit: RequestInit = {}): AsyncResult<Record<string, unknown>[]> {
    const r = await this.httpClient.get(
      `${this.basePathFor(requestInit)}/inspections`,
      requestInit,
    );
    return validateResponse<Record<string, unknown>[]>(r);
  }

  // ── Nível unidade (`unitId` é fixo no path - não escapa via query) ─────
  async getUnit(
    unitId: string,
    requestInit: RequestInit = {},
  ): AsyncResult<Record<string, unknown>> {
    const r = await this.httpClient.get(
      `${this.basePathFor(requestInit)}/units/${unitId}`,
      requestInit,
    );
    return validateResponse<Record<string, unknown>>(r);
  }

  async listCharges(
    unitId: string,
    params: Record<string, string> = {},
    requestInit: RequestInit = {},
  ): AsyncResult<PortalCharge[]> {
    const qs = new URLSearchParams(params).toString();
    const url = `${this.basePathFor(requestInit)}/units/${unitId}/charges${qs ? `?${qs}` : ""}`;
    const r = await this.httpClient.get(url, requestInit);
    return validateResponse<PortalCharge[]>(r);
  }

  async listSettlements(
    unitId: string,
    params: Record<string, string> = {},
    requestInit: RequestInit = {},
  ): AsyncResult<Settlement[]> {
    const qs = new URLSearchParams(params).toString();
    const url = `${this.basePathFor(requestInit)}/units/${unitId}/settlements${qs ? `?${qs}` : ""}`;
    const r = await this.httpClient.get(url, requestInit);
    return validateResponse<Settlement[]>(r);
  }

  async listReceipts(
    unitId: string,
    params: Record<string, string> = {},
    requestInit: RequestInit = {},
  ): AsyncResult<Receipt[]> {
    const qs = new URLSearchParams(params).toString();
    const url = `${this.basePathFor(requestInit)}/units/${unitId}/receipts${qs ? `?${qs}` : ""}`;
    const r = await this.httpClient.get(url, requestInit);
    return validateResponse<Receipt[]>(r);
  }

  async getReceipt(
    unitId: string,
    receiptId: string,
    requestInit: RequestInit = {},
  ): AsyncResult<Receipt> {
    const r = await this.httpClient.get(
      `${this.basePathFor(requestInit)}/units/${unitId}/receipts/${receiptId}`,
      requestInit,
    );
    return validateResponse<Receipt>(r);
  }

  // ── Seguros / Insurance ────────────────────────────────────────────
  async listInsurancePolicies(
    unitId: string,
    requestInit: RequestInit = {},
  ): AsyncResult<Array<Record<string, unknown>>> {
    const r = await this.httpClient.get(
      `${this.basePathFor(requestInit)}/units/${unitId}/insurance`,
      requestInit,
    );
    return validateResponse<Array<Record<string, unknown>>>(r);
  }

  async getInsurancePolicy(
    unitId: string,
    policyId: string,
    requestInit: RequestInit = {},
  ): AsyncResult<Record<string, unknown>> {
    const r = await this.httpClient.get(
      `${this.basePathFor(requestInit)}/units/${unitId}/insurance/${policyId}`,
      requestInit,
    );
    return validateResponse<Record<string, unknown>>(r);
  }

  /** Estado agregado da fração pela regra do ADR 0017 - a mesma que o admin usa.
   *  `noticeDays` é a antecedência de "a expirar" aplicada no servidor. */
  async getInsuranceStatus(
    unitId: string,
    requestInit: RequestInit = {},
  ): AsyncResult<{
    unitId: string;
    aggregate: string;
    status: {
      kind: string;
      policy?: Record<string, unknown>;
      daysUntilExpiry?: number;
      daysOverdue?: number;
    };
    noticeDays: number;
  }> {
    const r = await this.httpClient.get(
      `${this.basePathFor(requestInit)}/units/${unitId}/insurance/status`,
      requestInit,
    );
    return validateResponse(r);
  }

  // Upload de apólice. Aceita 1 ou N ficheiros: o primeiro é o principal
  // (OCR-eligible se PDF); os restantes ficam como attachments adicionais.
  async uploadInsurancePolicy(
    unitId: string,
    files: File | File[],
    filename: string,
    requestInit: RequestInit = {},
  ): AsyncResult<Record<string, unknown>> {
    const fd = new FormData();
    const list = Array.isArray(files) ? files : [files];
    for (const f of list) {
      fd.append("file", f, f.name || filename);
    }
    const r = await this.httpClient.post(
      `${this.basePathFor(requestInit)}/units/${unitId}/insurance`,
      { ...requestInit, body: fd, headers: requestInit.headers ?? {} },
    );
    return validateResponse<Record<string, unknown>>(r);
  }

  /** Renova a apólice da fração: recibo obrigatório, dados omitidos herdam do
   *  predecessor. Ver ADR 0016. */
  async renewInsurancePolicy(
    unitId: string,
    policyId: string,
    file: File,
    details: {
      validFrom: string;
      validTo: string;
      policyNumber?: string;
      insurer?: string;
      coverageAmountCents?: string;
    },
    requestInit: RequestInit = {},
  ): AsyncResult<Record<string, unknown>> {
    const fd = new FormData();
    fd.append("file", file, file.name || "comprovativo");
    for (const [name, value] of Object.entries(details)) {
      if (value !== undefined) fd.append(name, value);
    }
    const r = await this.httpClient.post(
      `${this.basePathFor(requestInit)}/units/${unitId}/insurance/${policyId}/renew`,
      { ...requestInit, body: fd, headers: requestInit.headers ?? {} },
    );
    return validateResponse<Record<string, unknown>>(r);
  }

  async listInsurancePolicyAttachments(
    unitId: string,
    policyId: string,
    requestInit: RequestInit = {},
  ): AsyncResult<
    Array<{ id: string; filename: string; mimeType: string; fileSize: number; createdAt: string }>
  > {
    const r = await this.httpClient.get(
      `${this.basePathFor(requestInit)}/units/${unitId}/insurance/${policyId}/attachments`,
      requestInit,
    );
    return validateResponse(r);
  }

  async addInsurancePolicyAttachment(
    unitId: string,
    policyId: string,
    file: File,
    requestInit: RequestInit = {},
  ): AsyncResult<Record<string, unknown>> {
    const fd = new FormData();
    fd.append("file", file, file.name);
    const r = await this.httpClient.post(
      `${this.basePathFor(requestInit)}/units/${unitId}/insurance/${policyId}/attachments`,
      { ...requestInit, body: fd, headers: requestInit.headers ?? {} },
    );
    return validateResponse(r);
  }

  async deleteInsurancePolicyAttachment(
    unitId: string,
    policyId: string,
    attachmentId: string,
    requestInit: RequestInit = {},
  ): AsyncResult<null> {
    const r = await this.httpClient.delete(
      `${
        this.basePathFor(requestInit)
      }/units/${unitId}/insurance/${policyId}/attachments/${attachmentId}`,
      requestInit,
    );
    return validateResponse(r);
  }

  async confirmInsurancePolicy(
    unitId: string,
    policyId: string,
    body: {
      validFrom: string;
      validTo: string;
      policyNumber: string;
      insurer: string;
      coverageAmountCents?: number | null;
    },
    requestInit: RequestInit = {},
  ): AsyncResult<Record<string, unknown>> {
    const r = await this.httpClient.post(
      `${this.basePathFor(requestInit)}/units/${unitId}/insurance/${policyId}/confirm`,
      {
        ...requestInit,
        body: JSON.stringify(body),
        headers: { ...requestInit.headers, "Content-Type": "application/json" },
      },
    );
    return validateResponse<Record<string, unknown>>(r);
  }

  insurancePdfUrl(unitId: string, policyId: string, baseUrl: string): string {
    const cid = this.cidResolver();
    return `${baseUrl}/v1/portal/condominiums/${cid}/units/${unitId}/insurance/${policyId}/pdf`;
  }

  async deleteInsurancePolicy(
    unitId: string,
    policyId: string,
    requestInit: RequestInit = {},
  ): AsyncResult<null> {
    const r = await this.httpClient.delete(
      `${this.basePathFor(requestInit)}/units/${unitId}/insurance/${policyId}`,
      requestInit,
    );
    return validateResponse<null>(r);
  }

  // ── Tickets / Ocorrências ──────────────────────────────────────────
  async listTickets(
    unitId: string,
    requestInit: RequestInit = {},
  ): AsyncResult<Array<Record<string, unknown>>> {
    const r = await this.httpClient.get(
      `${this.basePathFor(requestInit)}/units/${unitId}/tickets`,
      requestInit,
    );
    return validateResponse<Array<Record<string, unknown>>>(r);
  }

  async getTicket(
    unitId: string,
    ticketId: string,
    requestInit: RequestInit = {},
  ): AsyncResult<Record<string, unknown>> {
    const r = await this.httpClient.get(
      `${this.basePathFor(requestInit)}/units/${unitId}/tickets/${ticketId}`,
      requestInit,
    );
    return validateResponse<Record<string, unknown>>(r);
  }

  async createTicket(
    unitId: string,
    body: {
      title: string;
      description?: string | null;
      category?: string;
      priority?: string;
      location?: string | null;
    },
    requestInit: RequestInit = {},
  ): AsyncResult<Record<string, unknown>> {
    const r = await this.httpClient.post(
      `${this.basePathFor(requestInit)}/units/${unitId}/tickets`,
      {
        ...requestInit,
        body: JSON.stringify(body),
        headers: { ...requestInit.headers, "Content-Type": "application/json" },
      },
    );
    return validateResponse<Record<string, unknown>>(r);
  }

  async updateTicket(
    unitId: string,
    ticketId: string,
    body: {
      title?: string;
      description?: string | null;
      category?: string;
      priority?: string;
      location?: string | null;
    },
    requestInit: RequestInit = {},
  ): AsyncResult<Record<string, unknown>> {
    const r = await this.httpClient.patch(
      `${this.basePathFor(requestInit)}/units/${unitId}/tickets/${ticketId}`,
      {
        ...requestInit,
        body: JSON.stringify(body),
        headers: { ...requestInit.headers, "Content-Type": "application/json" },
      },
    );
    return validateResponse<Record<string, unknown>>(r);
  }

  async deleteTicket(
    unitId: string,
    ticketId: string,
    requestInit: RequestInit = {},
  ): AsyncResult<null> {
    const r = await this.httpClient.delete(
      `${this.basePathFor(requestInit)}/units/${unitId}/tickets/${ticketId}`,
      requestInit,
    );
    return validateResponse<null>(r);
  }

  async addTicketComment(
    unitId: string,
    ticketId: string,
    comment: string,
    requestInit: RequestInit = {},
  ): AsyncResult<Record<string, unknown>> {
    const r = await this.httpClient.post(
      `${this.basePathFor(requestInit)}/units/${unitId}/tickets/${ticketId}/comments`,
      {
        ...requestInit,
        body: JSON.stringify({ comment }),
        headers: { ...requestInit.headers, "Content-Type": "application/json" },
      },
    );
    return validateResponse<Record<string, unknown>>(r);
  }

  async uploadTicketAttachment(
    unitId: string,
    ticketId: string,
    file: File,
    requestInit: RequestInit = {},
  ): AsyncResult<Record<string, unknown>> {
    const fd = new FormData();
    fd.append("file", file);
    const r = await this.httpClient.post(
      `${this.basePathFor(requestInit)}/units/${unitId}/tickets/${ticketId}/attachments`,
      { ...requestInit, body: fd, headers: requestInit.headers ?? {} },
    );
    return validateResponse<Record<string, unknown>>(r);
  }

  async deleteTicketAttachment(
    unitId: string,
    ticketId: string,
    attachmentId: string,
    requestInit: RequestInit = {},
  ): AsyncResult<null> {
    const r = await this.httpClient.delete(
      `${
        this.basePathFor(requestInit)
      }/units/${unitId}/tickets/${ticketId}/attachments/${attachmentId}`,
      requestInit,
    );
    return validateResponse<null>(r);
  }

  ticketAttachmentUrl(
    unitId: string,
    ticketId: string,
    attachmentId: string,
    baseUrl: string,
  ): string {
    const cid = this.cidResolver();
    return `${baseUrl}/v1/portal/condominiums/${cid}/units/${unitId}/tickets/${ticketId}/attachments/${attachmentId}`;
  }

  /** Regista acesso ao PDF do recibo. occupantId é inferido do user logado
   *  no servidor - body é vazio. Idempotente. */
  async trackReceiptAccess(
    unitId: string,
    receiptId: string,
    requestInit: RequestInit = {},
  ): AsyncResult<{ tracked: boolean; reason?: string; record?: Record<string, unknown> }> {
    const r = await this.httpClient.post(
      `${this.basePathFor(requestInit)}/units/${unitId}/receipts/${receiptId}/track_access`,
      {
        ...requestInit,
        body: JSON.stringify({}),
        headers: { ...requestInit.headers, "Content-Type": "application/json" },
      },
    );
    return validateResponse(r);
  }

  /** Documentos públicos do condomínio (nivel-condomínio, sem unit). */
  async listDocuments(
    requestInit: RequestInit = {},
  ): AsyncResult<import("./types.ts").Document[]> {
    const r = await this.httpClient.get(
      `${this.basePathFor(requestInit)}/documents`,
      requestInit,
    );
    return validateResponse(r);
  }

  // ── Patologias (nível condomínio, read-only) ────────────────────────────
  /** Patologias públicas do edifício (Ver ADR 0024: status != 'draft').
   *  Filtro opcional `statusGroup`: "active" | "resolved" | "dismissed". */
  async listPathologies(
    params: { statusGroup?: string } = {},
    requestInit: RequestInit = {},
  ): AsyncResult<Array<Record<string, unknown>>> {
    const qs = new URLSearchParams();
    if (params.statusGroup) qs.set("statusGroup", params.statusGroup);
    const url = `${this.basePathFor(requestInit)}/pathologies${qs.size ? `?${qs}` : ""}`;
    const r = await this.httpClient.get(url, requestInit);
    return validateResponse<Array<Record<string, unknown>>>(r);
  }

  async getPathology(
    pathologyId: string,
    requestInit: RequestInit = {},
  ): AsyncResult<Record<string, unknown>> {
    const r = await this.httpClient.get(
      `${this.basePathFor(requestInit)}/pathologies/${pathologyId}`,
      requestInit,
    );
    return validateResponse<Record<string, unknown>>(r);
  }

  /** URL para `<a href>` direto - download da foto via portal. */
  pathologyAttachmentUrl(
    pathologyId: string,
    attachmentId: string,
    baseUrl: string,
  ): string {
    const cid = this.cidResolver();
    return `${baseUrl}/v1/portal/condominiums/${cid}/pathologies/${pathologyId}/attachments/${attachmentId}`;
  }

  // Persiste NIF do occupant nesta unit. Write-once; NIF vive em core.occupant
  // per-condo.
  async saveOccupantNif(
    unitId: string,
    nif: string,
    requestInit: RequestInit = {},
  ): AsyncResult<{ nif: string; occupantId: string }> {
    const r = await this.httpClient.post(
      `${this.basePathFor(requestInit)}/units/${unitId}/save-nif`,
      {
        ...requestInit,
        body: JSON.stringify({ nif }),
        headers: { ...requestInit.headers, "Content-Type": "application/json" },
      },
    );
    return validateResponse<{ nif: string; occupantId: string }>(r);
  }

  // Self-update do perfil do occupant. NIF não entra aqui: write-once via
  // `saveOccupantNif`.
  async saveOccupantProfile(
    unitId: string,
    body: {
      name: string;
      email?: string | null;
      phone?: string | null;
      receiveReceiptEmails: boolean;
    },
    requestInit: RequestInit = {},
  ): AsyncResult<{
    occupantId: string;
    name: string;
    email: string | null;
    phone: string | null;
    receiveReceiptEmails: boolean;
  }> {
    const r = await this.httpClient.post(
      `${this.basePathFor(requestInit)}/units/${unitId}/save-occupant-profile`,
      {
        ...requestInit,
        body: JSON.stringify(body),
        headers: { ...requestInit.headers, "Content-Type": "application/json" },
      },
    );
    return validateResponse(r);
  }

  // Toggle inline da preferência de recibos (switch no `profile.vto`).
  // Endpoint dedicado evita reenviar nome+email+telefone a cada toggle.
  async saveReceiveReceipts(
    unitId: string,
    body: { receiveReceiptEmails: boolean },
    requestInit: RequestInit = {},
  ): AsyncResult<{ occupantId: string; receiveReceiptEmails: boolean }> {
    const r = await this.httpClient.post(
      `${this.basePathFor(requestInit)}/units/${unitId}/save-receive-receipts`,
      {
        ...requestInit,
        body: JSON.stringify(body),
        headers: { ...requestInit.headers, "Content-Type": "application/json" },
      },
    );
    return validateResponse(r);
  }
}
