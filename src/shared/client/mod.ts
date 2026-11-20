// Fachada do Client. Os recursos vivem em ficheiros próprios - este módulo
// só compõe e re-exporta para preservar compat com `import { Client, … }
// from "$shared/client/mod.ts"` em todo o codebase.

import { type ClientConfig, HttpClient } from "./http.ts";
import { SuperResource } from "./super.ts";
import { ManagerResource } from "./admin.ts";
import { PortalResource } from "./portal.ts";
import { AuthResource } from "./auth.ts";

export {
  ApiError,
  type AsyncResult,
  type ClientConfig,
  type HeadersFactory,
  HttpClient,
  validateResponse,
} from "./http.ts";
export type {
  BankTransaction,
  BankTransactionStatus,
  Budget,
  BudgetLine,
  BudgetQuotaMap,
  Charge,
  ChargeAccountRef,
  ChargeKind,
  ChargeNature,
  ChargeOpenBySupplier,
  ChargeOpenByUnit,
  ChargePaymentMethod,
  ChargeScope,
  ChargeStatus,
  ChargeSupplierRef,
  ChargeUnitRef,
  ChartOfAccount,
  Condominium,
  Document,
  DocumentCategory,
  Inspection,
  InspectionAttachment,
  Occupant,
  Pathology,
  PathologyAttachment,
  PathologyCategory,
  PathologyStatus,
  PathologyUnitRef,
  PendingReceipt,
  PortalCharge,
  Receipt,
  ReceiptAccessRecord,
  ReceiptActor,
  ReceiptBankTxSnapshot,
  ReceiptCondominiumSnapshot,
  ReceiptEmailSendRecord,
  ReceiptLineSnapshot,
  ReceiptRecipientChoice,
  ReceiptRecipientOptions,
  ReceiptRecipientSnapshot,
  ReceiptUnitSnapshot,
  Settlement,
  SettlementBankTransactionRef,
  SettlementChargeRef,
  SettlementStatus,
  SettlementType,
  SkippedReceipt,
  Supplier,
  Ticket,
  TicketAttachment,
  TicketCategory,
  TicketComment,
  TicketPriority,
  TicketStatus,
  Unit,
  UnitOccupant,
  UnitOccupantNested,
  User,
} from "./types.ts";
export type {
  BankTransactionListParams,
  ChargeListParams,
  ListPageParams,
  ReceiptListParams,
  SettlementListParams,
} from "./list_params.ts";
export { SuperResource } from "./super.ts";
export { ManagerResource } from "./admin.ts";
export { PortalResource } from "./portal.ts";
export { type AuthMe, AuthResource, type AuthSessionResponse } from "./auth.ts";

export class Client {
  private readonly httpClient: HttpClient;

  readonly super: SuperResource;
  readonly admin: ManagerResource;
  readonly portal: PortalResource;
  readonly auth: AuthResource;

  constructor(config: ClientConfig) {
    this.httpClient = new HttpClient(config.baseUrl, config.defaultHeaders);
    const cidResolver: () => string = typeof config.condominiumId === "function"
      ? config.condominiumId
      : () => (config.condominiumId as string | undefined) ?? "";
    this.super = new SuperResource(this.httpClient);
    this.admin = new ManagerResource(this.httpClient, cidResolver);
    this.portal = new PortalResource(this.httpClient, cidResolver);
    this.auth = new AuthResource(this.httpClient);
  }
}
