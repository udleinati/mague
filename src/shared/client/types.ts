export interface Condominium {
  id: string;
  name: string;
  fiscalNumber: string | null;
  address: string | null;
  city: string | null;
  postalCode: string | null;
  quotaDayOfMonth: number;
  /** Nota livre da administração no topo do email de lembrete (ADR 0028). */
  billingReminderNote: string | null;
  /** Equivalente para o email de lembrete de seguro. */
  insuranceReminderNote: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Unit {
  id: string;
  condominiumId: string;
  unitType: string;
  designation: string;
  floor: string | null;
  door: string | null;
  block: string | null;
  /** Label derivado (stored generated column): `Bloco X - Nº Letra` ou
   *  `Bloco X - Loja N` para comercial. Null se nada preenchido. */
  identifier: string | null;
  permillage: string;
  description: string | null;
  isActive: boolean;
  /** Palavras-chave usadas na pre-seleção automática da conciliação
   *  (comparadas com a descrição dos movimentos bancários, case-insensitive
   *  e sem acentos no lado do panel). */
  matchKeywords: string[];
  createdAt: string;
  updatedAt: string;
  occupants: UnitOccupantNested[];
  /** true se a fração tem um plano de pagamento ativo (ADR 0039). */
  hasActivePlan?: boolean;
}

export interface UnitOccupantNested {
  id: string;
  occupantId: string;
  relationshipType: string;
  startDate: string;
  endDate: string | null;
  createdAt: string;
  occupant: {
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    nif: string | null;
  };
}

export interface Occupant {
  id: string;
  userId: string | null;
  name: string;
  email: string | null;
  nif: string | null;
  phone: string | null;
  /** Natureza jurídica. Controla redação e rótulo fiscal
   *  (NIF/NIPC) da procuração da convocatória. Default `singular`. */
  personType: "singular" | "collective";
  condominiumId: string;
  isActive: boolean;
  /** Opt-in dos emails de recibo (default `true`). Se `false`, o re-envio
   *  salta este ocupante mesmo que o snapshot o liste (ver `resend_email.ts`). */
  receiveReceiptEmails: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UnitOccupant {
  id: string;
  unitId: string;
  occupantId: string;
  relationshipType: "owner" | "tenant";
  startDate: string;
  endDate: string | null;
  createdAt: string;
}

export interface User {
  id: string;
  email: string | null;
  name: string;
  /** 'super' | null pós-ADR 0002. Tudo o resto vive em tabelas de relação. */
  role: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  nif: string | null;
  phone: string | null;
  /** Derivado de `core.manager` para o cid do request. Só populado em
   *  responses de `/v1/admin/c/:cid/users/*`. Ver ADR 0002. */
  isManager?: boolean;
  /** Derivado de `core.occupant` para o cid do request - id do occupant
   *  deste user no condomínio. Só populado em responses de
   *  `/v1/admin/c/:cid/users/*`. `null` se o user não tem `core.occupant`
   *  no condo (caso típico: super sem fração ali). */
  occupantId?: string | null;
  /** Marcas de uso: `firstLoginAt` = primeiro login ever, `lastLoginAt` =
   *  último login. Ambos null = nunca logou. ISO8601 UTC. */
  firstLoginAt?: string | null;
  lastLoginAt?: string | null;
  /** Timestamp do convite mais recente em `core.invite_token`. `null` = nunca
   *  convidado. Só populado em responses de `/v1/admin/c/:cid/users/*`. */
  lastInvitedAt?: string | null;
  /** Cooldown de reenvio de convite (ADR 0032): `true` = convidado dentro da
   *  janela, botão "reenviar" desactivado. Só populado em `/users/*`. */
  inviteInCooldown?: boolean;
  /** Instante (ISO) em que o cooldown de convite termina. `null` quando não
   *  está em cooldown. A UI mostra-o + "faltam N dias". Só em `/users/*`. */
  inviteCooldownUntil?: string | null;
  /** Frações deste user NESTE condo (qualquer relationshipType). Só populado
   *  em responses de `/v1/admin/c/:cid/users/*`. Vazio = sem fração. */
  units?: Array<{
    unitId: string;
    designation: string;
    identifier: string | null;
    relationshipType: string; // "owner" | "tenant" | "resident"
  }>;
  /** Quem pede não pode repor a password (conta super ou com acesso a outro
   *  condomínio). Só no GET `/users/:id`. */
  passwordResetRequiresSuper?: boolean;
}

// Espelha `formatSupplierForResponse` em
// `src/apps/api/modules/admin/supplier/_projection.ts`. Sincronização manual.
export interface Supplier {
  id: string;
  condominiumId: string;
  name: string;
  nif: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  /** Conta de despesa default no chart_of_accounts. */
  accountId: string | null;
  notes: string | null;
  isActive: boolean;
  /** Palavras-chave para a pre-seleção automática da conciliação (mesmo
   *  pattern de `Unit.matchKeywords`). */
  matchKeywords: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ChartOfAccount {
  id: string;
  code: string;
  condominiumId: string | null;
  isGlobal: boolean;
  name: string;
  type: string;
  parentCode: string | null;
  description: string | null;
  isActive: boolean | null;
  createdAt: string;
  updatedAt: string;
}

export interface Budget {
  id: string;
  condominiumId: string;
  year: string;
  status: string;
  notes: string | null;
  type: string;
  parentBudgetId: string | null;
  fcrPercentage: string | null;
  installments: number | null;
  firstCompetencePeriod: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
  createdAt: string;
  updatedAt: string;
  totalAmount: number;
  fcrAmount: number;
  lines: BudgetLine[];
}

export interface BudgetQuotaMap {
  budgetId: string;
  year: number;
  budgetType: string;
  budgetStatus: string;
  quotasGeneratedAt: string | null;
  fcrPercentage: number;
  totalPermillage: number;
  annualOrdinaryCents: number;
  units: Array<{
    unitId: string;
    unitDesignation: string;
    identifier: string | null;
    unitPermillage: number;
    monthlyBaseCents: number;
    monthlyFcrCents: number;
    monthlyTotalCents: number;
    annualTotalCents: number;
  }>;
  totals: {
    monthlyBaseCents: number;
    monthlyFcrCents: number;
    monthlyTotalCents: number;
    annualTotalCents: number;
  };
}

export interface BudgetLine {
  id: string;
  budgetId: string;
  accountId: string;
  annualAmount: number;
  notes: string | null;
  categoryName: string | null;
  categoryCode: string | null;
  categoryDescription: string | null;
  createdAt: string;
}

export interface InspectionAttachment {
  id: string;
  inspectionId: string;
  filename: string;
  mimeType: string;
  fileSize: number;
  createdAt: string;
  createdBy: { id: string; email: string | null; ip: string | null } | null;
}

// ─── Tickets ────────────────────────────────────────────────────────────
// Categorias e prioridades alinhadas com `TICKET_CATEGORIES` em
// `src/apps/api/libs/postgres/schemas/ticket.ts`. Mantém-se sincronizado
// manualmente (mudança em ambos os lados).

export type TicketCategory =
  | "elevator"
  | "lighting"
  | "plumbing"
  | "hvac"
  | "common_area"
  | "facade"
  | "parking"
  | "garden"
  | "security"
  | "other";

export type TicketPriority = "low" | "normal" | "high" | "urgent";
export type TicketStatus = "open" | "in_progress" | "resolved" | "closed";

export interface TicketComment {
  id: string;
  ticketId: string;
  comment: string;
  isInternal: boolean;
  /** Preenchidos apenas quando o comment representa uma transição de
   *  estado (criado automaticamente pelo updateTicketHandler). */
  statusFrom: string | null;
  statusTo: string | null;
  createdAt: string;
  createdBy: { id: string; email: string | null; ip: string | null } | null;
}

export interface TicketAttachment {
  id: string;
  ticketId: string;
  filename: string;
  mimeType: string;
  fileSize: number;
  createdAt: string;
  createdBy: { id: string; email: string | null; ip: string | null } | null;
}

export interface Ticket {
  id: string;
  condominiumId: string;
  /** Identificador humano per-condomínio: T001..TZZZ (ADR 0023). NOT NULL
   *  na BD - o trigger `trg_ticket_code_assign` preenche em
   *  BEFORE INSERT. */
  code: string;
  title: string;
  description: string | null;
  category: TicketCategory;
  priority: TicketPriority;
  status: TicketStatus;
  /** null = zona comum (não associado a fração específica). */
  unitId: string | null;
  /** Localização livre (ex: "Hall do 2º piso"). */
  location: string | null;
  /** Visibilidade no portal.
   *  - "admin_only": só administração vê.
   *  - "admin_unit": administração + ocupantes da fração afetada.
   *    Requer `unitId !== null`.
   *  - "public": todos os condóminos vêem no portal.
   *  Só admin altera. Default `admin_only` (ticket criado pelo admin) ou
   *  `admin_unit` (ticket criado pelo portal). */
  visibility: "admin_only" | "admin_unit" | "public";
  /** Marcação devolvida só pelo retrieve do portal: true se o ticket
   *  pertence a outra fração (mas é público de zona comum) - frontend
   *  renderiza read-only. Admin nunca recebe este campo. */
  isVisitor?: boolean;
  resolvedAt: string | null;
  resolutionNotes: string | null;
  /** Subset seguro do `created_by` actor snapshot - só email + userId
   *  (sem ip/UA). Resolvido pelo projection via `actorAsSubmitter`. */
  submittedBy: { email: string | null; userId: string | null } | null;
  /** Vazio na listagem; populado em `getTicket`. */
  comments: TicketComment[];
  /** Vazio na listagem; populado em `getTicket`. */
  attachments: TicketAttachment[];
  createdAt: string;
  updatedAt: string;
  createdBy: { id: string; email: string | null; ip: string | null } | null;
  updatedBy: { id: string; email: string | null; ip: string | null } | null;
}

export type DocumentCategory =
  | "minutes"
  | "regulation"
  | "contract"
  | "budget"
  | "insurance"
  | "plant"
  | "other";

export interface Document {
  id: string;
  condominiumId: string;
  title: string;
  description: string | null;
  category: DocumentCategory;
  isPublic: boolean;
  publishedAt: string;
  createdAt: string;
  updatedAt: string;
  createdBy: { id: string; email: string | null; ip: string | null } | null;
  updatedBy: { id: string; email: string | null; ip: string | null } | null;
}

export type PathologyCategory =
  | "crack"
  | "infiltration"
  | "humidity"
  | "efflorescence"
  | "detachment"
  | "corrosion"
  | "mould"
  | "structural"
  | "other";

export type PathologyStatus =
  | "draft"
  | "identified"
  | "awaiting_quotes"
  | "quote_approved"
  | "awaiting_repair_start"
  | "in_repair"
  | "resolved"
  | "dismissed";

export interface PathologyUnitRef {
  id: string;
  designation: string;
  identifier: string | null;
}

export interface PathologyAttachment {
  id: string;
  pathologyId: string;
  filename: string;
  mimeType: string;
  fileSize: number;
  createdAt: string;
}

export interface Pathology {
  id: string;
  condominiumId: string;
  code: string;
  title: string;
  description: string | null;
  category: PathologyCategory;
  status: PathologyStatus;
  affectsCommonArea: boolean;
  units: PathologyUnitRef[];
  resolutionNotes: string | null;
  dismissedReason: string | null;
  detectedAt: string;
  resolvedAt: string | null;
  dismissedAt: string | null;
  attachments: PathologyAttachment[];
  createdAt: string;
  updatedAt: string;
}

// ─── Charges ────────────────────────────────────────────────────────────
// Contrato da response de charge. Espelha `formatChargeForResponse` em
// `src/apps/api/modules/admin/charge/_projection.ts` - a whitelist final
// antes do JSON. Mantém-se sincronizado manualmente (mudança em ambos os
// lados), como nos Tickets acima.

export type ChargeNature = "debit" | "credit";
export type ChargeKind = "receivable" | "payable";
export type ChargeScope = "unit" | "condominium";
/** Valores do CHECK `charge_status_check`. É o status
 *  GRAVADO - para display usar sempre o estado efetivo via
 *  `chargeStatusBadge`/`isChargeOverdue` (ADR 0037), nunca comparar com
 *  "overdue" diretamente. */
export type ChargeStatus =
  | "open"
  | "partial"
  | "paid"
  | "overdue"
  | "cancelled"
  | "disputed";
export type ChargePaymentMethod = "manual" | "direct_debit" | "auto_transfer";

export interface ChargeUnitRef {
  id: string;
  designation: string;
  identifier: string | null;
}

export interface ChargeSupplierRef {
  id: string;
  name: string;
  nif: string | null;
}

export interface ChargeAccountRef {
  id: string;
  code: string;
  name: string;
  type: string;
}

export interface Charge {
  id: string;
  /** Código humano per-condomínio (ADR 0023): `R00001` receivable /
   *  `D0001` payable. Nullable na BD; o trigger BEFORE INSERT preenche-o. */
  code: string | null;
  condominiumId: string;
  unitId: string | null;
  scope: ChargeScope;
  nature: ChargeNature;
  kind: ChargeKind;
  /** Classificação da origem: quota, extraordinary_quota, refacturation,
   *  expense, interest, ... Lista aberta - ver CONTEXT.md. */
  chargeType: string;
  status: ChargeStatus;
  issueDate: string;
  dueDate: string | null;
  /** Mês de competência `YYYY-MM` (a API trunca o date da BD). */
  competencePeriod: string | null;
  originalAmount: number;
  expectedAmount: number;
  settledAmount: number;
  openAmount: number;
  amount: number;
  description: string;
  /** Nota interna do admin. O portal NUNCA a recebe (strip no handler -
   *  ver `modules/portal/charge.ts`); só presente em responses do admin. */
  note: string | null;
  documentNumber: string | null;
  invoiceNumber: string | null;
  accountId: string | null;
  supplierId: string | null;
  contractId: string | null;
  paymentMethod: ChargePaymentMethod;
  sourceType: string | null;
  sourceId: string | null;
  /** Orçamento a que a despesa foi etiquetada à mão (relatório por Ata). */
  budgetId: string | null;
  createdAt: string;
  updatedAt: string;
  /** Null quando o call site da API não pediu nested (create/update). */
  unit: ChargeUnitRef | null;
  supplier: ChargeSupplierRef | null;
  account: ChargeAccountRef | null;
}

/** Variante do portal: igual ao admin menos `note` (interna). */
export type PortalCharge = Omit<Charge, "note">;

// Linhas de `/charges/top_open_by_group` - subset projetado em SQL, não a
// Charge inteira. Espelha `top_open_by_group.ts`.
export interface ChargeOpenByUnit {
  id: string;
  competencePeriod: string | null;
  description: string | null;
  openAmount: number;
  originalAmount: number;
  status: string;
  chargeType: string | null;
}

export interface ChargeOpenBySupplier {
  id: string;
  issueDate: string | null;
  dueDate: string | null;
  description: string | null;
  openAmount: number;
  originalAmount: number;
  status: string;
  chargeType: string | null;
}

// ─── Settlements ─────────────────────────────────────────────────────────
// Espelha `formatSettlementForResponse` em
// `src/apps/api/modules/admin/settlement/_projection.ts`. Sincronização
// manual, como nas Charges. Admin e portal devolvem a mesma forma.

/** Valores do CHECK `settlement_type_check`. */
export type SettlementType =
  | "bank_reconciliation"
  | "charge_offset"
  | "bank_deposit_credit";
export type SettlementStatus = "active" | "reversed";

export interface SettlementChargeRef {
  id: string;
  description: string;
  chargeType: string;
  unitId: string | null;
  supplierId: string | null;
  /** Date YYYY-MM-DD (dia 01) - NÃO truncado a YYYY-MM como na response
   *  de charge. */
  competencePeriod: string | null;
}

export interface SettlementBankTransactionRef {
  id: string;
  transactionDate: string;
  description: string | null;
  amount: number;
  status: string | null;
}

export interface Settlement {
  id: string;
  condominiumId: string;
  unitId: string | null;
  settlementType: SettlementType;
  debitChargeId: string | null;
  creditChargeId: string | null;
  bankTransactionId: string | null;
  amount: number;
  settlementDate: string;
  status: SettlementStatus;
  reversedAt: string | null;
  reversalReason: string | null;
  notes: string;
  createdAt: string;
  /** Null quando a FK é null OU o handler não pediu nested. */
  debitCharge: SettlementChargeRef | null;
  creditCharge: SettlementChargeRef | null;
  bankTransaction: SettlementBankTransactionRef | null;
}

// ─── Bank transactions ───────────────────────────────────────────────────
// Espelha `formatBankTransactionForResponse` em
// `src/apps/api/modules/admin/bank_transaction/_projection.ts`.
// Sincronização manual, como nas Charges.

/** Lifecycle: `unreconciled` → `partial` → `reconciled`, com `ignored`
 *  (casos especiais) e `reversed` (estorno). Coluna nullable na BD
 *  (default `unreconciled` - as views fazem COALESCE). */
export type BankTransactionStatus =
  | "unreconciled"
  | "partial"
  | "reconciled"
  | "ignored"
  | "reversed";

export interface BankTransaction {
  id: string;
  bankAccountId: string;
  condominiumId: string;
  transactionDate: string;
  valueDate: string | null;
  /** Cêntimos, com sinal: >0 entrada, <0 saída. */
  amount: number;
  description: string | null;
  balanceAfter: number | null;
  status: BankTransactionStatus | null;
  /** Estado de sugestão UX (`pending`/...) - SEM efeito contabilístico.
   *  Não confundir com conciliação (ver CONTEXT.md). */
  matchStatus: string | null;
  notes: string | null;
  createdAt: string | null;
  // Enriquecimento `?withSuggestions=1` (listagem da conciliação) - regra
  // de match keywords executada na API. Ausentes sem o param.
  suggestedKind?: "unit" | "supplier";
  suggestedUnitId?: string;
  suggestedSupplierId?: string;
  suggestedLabel?: string;
  /** Populado em vez de `suggested*` quando >1 keyword faz match. */
  matchConflictCount?: number;
}

// ─── Receipts ────────────────────────────────────────────────────────────
// Espelha `formatReceiptForResponse` em
// `src/apps/api/modules/admin/receipt/_projection.ts`; snapshots espelham
// os tipos JSONB de `$api/libs/postgres/schemas/receipt.ts`. Sincronização
// manual. Admin e portal devolvem a mesma forma (sem strip).

export interface ReceiptActor {
  id: string;
  name: string;
  email?: string | null;
  /** 'super' | 'manager' | 'system' */
  role?: string | null;
}

export interface ReceiptCondominiumSnapshot {
  name: string;
  /** Optional para snapshots antigos. */
  designationType?: "building" | "condominium";
  fiscalNumber: string | null;
  address: string | null;
  postalCode: string | null;
  city: string | null;
}

export interface ReceiptUnitSnapshot {
  designation: string;
  identifier: string | null;
  permillage: number;
  unitType: string | null;
}

export interface ReceiptRecipientSnapshot {
  occupantId: string;
  name: string;
  nif: string | null;
  email: string | null;
  receiveEmails: boolean;
}

export interface ReceiptLineSnapshot {
  description: string;
  /** Cêntimos. */
  amount: number;
  chargeType: string;
  /** YYYY-MM-DD (1º dia do mês) se aplicável. */
  competencePeriod: string | null;
  /** Parte FCR já incluída no `amount` (cêntimos). null/ausente se N/A. */
  fcrAmount?: number | null;
}

export interface ReceiptBankTxSnapshot {
  /** YYYY-MM-DD */
  transactionDate: string;
  description: string | null;
  /** 'bank' | 'cash' */
  accountKind: string;
  accountName: string;
  /** IBAN mascarado ou null para cash. */
  ibanMasked: string | null;
}

export interface ReceiptEmailSendRecord {
  email: string;
  sentAt: string;
  /** 'sent' | 'failed' */
  status: string;
  error?: string;
}

export interface ReceiptAccessRecord {
  occupantId: string;
  /** ISO timestamp do primeiro (e único gravado) download. */
  firstDownloadedAt: string;
  occupantName: string;
}

export interface Receipt {
  id: string;
  condominiumId: string;
  unitId: string;
  bankTransactionId: string;
  year: number;
  sequence: number;
  /** `YYYY/NNNNN` - coluna gerada na BD. */
  number: string;
  amountCents: number;
  issuedAt: string;
  issuedBy: ReceiptActor | null;
  voidedAt: string | null;
  voidedBy: ReceiptActor | null;
  voidedReason: string | null;
  /** Derivado: `voidedAt !== null`. */
  isVoided: boolean;
  condominiumSnapshot: ReceiptCondominiumSnapshot | null;
  unitSnapshot: ReceiptUnitSnapshot | null;
  recipientsSnapshot: ReceiptRecipientSnapshot[] | null;
  linesSnapshot: ReceiptLineSnapshot[] | null;
  bankTxSnapshot: ReceiptBankTxSnapshot | null;
  storageKey: string;
  fileSize: number | null;
  /** URL S3 pré-assinada quando o handler a gerou; senão null e o
   *  frontend usa `/receipts/:id/pdf` (proxy). */
  pdfUrl: string | null;
  emailSentTo: ReceiptEmailSendRecord[];
  emailLastAttemptAt: string | null;
  recipientsAccess: ReceiptAccessRecord[];
  createdAt: string;
  updatedAt: string;
}

/** Linha de `GET /receipts/pending` (view `vw_pending_receipts`) - ainda
 *  não é um Receipt, é um candidato a emissão. */
export interface PendingReceipt {
  condominiumId: string;
  bankTransactionId: string;
  unitId: string;
  /** YYYY-MM-DD */
  paymentDate: string;
  bankTxDescription: string | null;
  /** Cêntimos. */
  bankTxAmount: number;
  bankAccountId: string;
  /** Cêntimos - soma das settlements desta unit. */
  recipientAmount: number;
  settlementsCount: number;
}

/** Linha de `GET /receipts/skipped` - tuplas marcadas "não emitir". */
export interface SkippedReceipt {
  id: string;
  condominiumId: string;
  bankTransactionId: string;
  unitId: string;
  paymentDate: string;
  bankTxDescription: string | null;
  bankAccountId: string;
  recipientAmount: number;
  reason: string | null;
  skippedAt: string;
  skippedByName: string | null;
}

export interface Inspection {
  id: string;
  condominiumId: string;
  /** Identificador humano per-condomínio: I001..IZZZ (ADR 0023). */
  code: string | null;
  category: string;
  description: string;
  lastDoneDate: string | null;
  validUntil: string;
  notifyDaysBefore: number;
  notes: string | null;
  /** Fornecedor que realiza a inspeção (FK opcional). `supplier` é o subset
   *  resolvido server-side; null quando não há fornecedor associado. */
  supplierId: string | null;
  supplier: { id: string; name: string; nif: string | null } | null;
  /** Quando false, não conta para o badge nem aparece no portal. Linha
   *  continua na lista admin. */
  isActive: boolean;
  /** Calculado a partir das datas + isActive - não persistido. */
  status: "inactive" | "ok" | "due_soon" | "expired" | null;
  /** N anexos (1:N). Aceita qualquer mime type. */
  attachments: InspectionAttachment[];
  createdAt: string;
  updatedAt: string;
  createdBy: { id: string; email: string | null; ip: string | null } | null;
  updatedBy: { id: string; email: string | null; ip: string | null } | null;
  deletedBy: { id: string; email: string | null; ip: string | null } | null;
}
