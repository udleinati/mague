import { condominium } from "./condominium.ts";
import { unit } from "./unit.ts";
import { manager } from "./manager.ts";
import { occupant } from "./occupant.ts";
import { unitOccupant } from "./unit_occupant.ts";
import { user } from "./user.ts";
import { inviteToken } from "./invite_token.ts";
import { chartOfAccount } from "./chart_of_account.ts";
import { budget } from "./budget.ts";
import { budgetLine } from "./budget_line.ts";
import { assembly } from "./assembly.ts";
import { assemblyAgendaItem } from "./assembly_agenda_item.ts";
import { assemblyAttendee } from "./assembly_attendee.ts";
import { assemblyVote } from "./assembly_vote.ts";
import { assemblyConvocation } from "./assembly_convocation.ts";
import { charge } from "./charge.ts";
import { supplier } from "./supplier.ts";
import { recurringTemplate } from "./recurring_template.ts";
import { recurringGenerationRun } from "./recurring_generation_run.ts";
import { quotaGenerationRun } from "./quota_generation_run.ts";
import { bankAccount } from "./bank_account.ts";
import { bankImportBatch } from "./bank_import_batch.ts";
import { bankTransaction } from "./bank_transaction.ts";
import { ledger } from "./ledger.ts";
import { fcrTransfer } from "./fcr_transfer.ts";
import { settlement } from "./settlement.ts";
import { budgetQuotaMap } from "./budget_quota_map.ts";
import { unitBalance } from "./unit_balance.ts";
import { bankBalance } from "./bank_balance.ts";
import { receipt } from "./receipt.ts";
import { receiptSkip } from "./receipt_skip.ts";
import { insurancePolicy } from "./insurance_policy.ts";
import { insuranceReminder } from "./insurance_reminder.ts";
import { billingReminder } from "./billing_reminder.ts";
import { inspection } from "./inspection.ts";
import { ticket, ticketComment } from "./ticket.ts";
import { document } from "./document.ts";
import { pathology, pathologyUnit } from "./pathology.ts";
import { paymentPlan } from "./payment_plan.ts";
import { attachment } from "./attachment.ts";
import {
  assemblyAgendaItemRelations,
  assemblyRelations,
  assemblyVoteRelations,
  budgetLineRelations,
  budgetRelations,
  chargeRelations,
  inspectionRelations,
  occupantRelations,
  pathologyRelations,
  pathologyUnitRelations,
  settlementRelations,
  ticketCommentRelations,
  ticketRelations,
  unitOccupantRelations,
  unitRelations,
} from "./relations.ts";

export { condominium };
export { unit };
export { manager };
export { occupant };
export { unitOccupant };
export { user };
export { inviteToken };
export { chartOfAccount };
export { budget };
export { budgetLine };
export { assembly };
export { assemblyAgendaItem };
export { assemblyAttendee };
export { assemblyVote };
export { assemblyConvocation };
export { charge };
export { supplier };
export { recurringTemplate };
export { recurringGenerationRun };
export { quotaGenerationRun };
export { bankAccount };
export { bankImportBatch };
export { bankTransaction };
export { ledger };
export { fcrTransfer };
export { FCR_TRANSFER_DIRECTIONS } from "./fcr_transfer.ts";
export type { FcrTransferDirection, FcrTransferInsert, FcrTransferSelect } from "./fcr_transfer.ts";
export { settlement };
export { budgetQuotaMap };
export { unitBalance };
export { bankBalance };
export { receipt };
export { receiptSkip };
export { insurancePolicy };
export { insuranceReminder };
export { billingReminder };
export { inspection };
export { attachment };
export { ticket, ticketComment };
export { document };
export type { DocumentCategory, DocumentInsert, DocumentSelect } from "./document.ts";
export { DOCUMENT_CATEGORIES } from "./document.ts";
export { pathology, pathologyUnit };
export type {
  PathologyCategory,
  PathologyInsert,
  PathologySelect,
  PathologyStatus,
  PathologyUnitInsert,
  PathologyUnitSelect,
  PathologyUpdate,
} from "./pathology.ts";
export { paymentPlan };
export type {
  PaymentPlanInsert,
  PaymentPlanSelect,
  PaymentPlanStatus,
  PaymentPlanUpdate,
} from "./payment_plan.ts";
export { PAYMENT_PLAN_STATUSES, PAYMENT_PLAN_TERMINAL_STATUSES } from "./payment_plan.ts";
export {
  PATHOLOGY_CATEGORIES,
  PATHOLOGY_PUBLIC_STATUSES,
  PATHOLOGY_STATUSES,
} from "./pathology.ts";
export type { AttachmentEntityType, AttachmentInsert, AttachmentSelect } from "./attachment.ts";
// Aliases retro para callers que ainda usam tipos antigos:
export type { TicketAttachmentInsert, TicketAttachmentSelect } from "./ticket.ts";
export type {
  TicketCategory,
  TicketCommentInsert,
  TicketCommentSelect,
  TicketInsert,
  TicketPriority,
  TicketSelect,
  TicketStatus,
  TicketUpdate,
} from "./ticket.ts";
export { TICKET_CATEGORIES, TICKET_PRIORITIES, TICKET_STATUSES } from "./ticket.ts";

export type { CondominiumInsert, CondominiumSelect, CondominiumUpdate } from "./condominium.ts";
export type { UnitInsert, UnitSelect, UnitUpdate } from "./unit.ts";
export type { ManagerInsert, ManagerSelect, ManagerUpdate } from "./manager.ts";
export type { OccupantInsert, OccupantSelect, OccupantUpdate } from "./occupant.ts";
export type {
  UnitOccupantInsert,
  UnitOccupantSelect,
  UnitOccupantUpdate,
} from "./unit_occupant.ts";
export type { UserInsert, UserSelect, UserUpdate } from "./user.ts";
export type { InviteTokenInsert, InviteTokenSelect } from "./invite_token.ts";
export type {
  ChartOfAccountInsert,
  ChartOfAccountSelect,
  ChartOfAccountUpdate,
} from "./chart_of_account.ts";
export type { BudgetInsert, BudgetSelect, BudgetUpdate } from "./budget.ts";
export type { BudgetLineInsert, BudgetLineSelect, BudgetLineUpdate } from "./budget_line.ts";
export type { AssemblyInsert, AssemblySelect, AssemblyUpdate } from "./assembly.ts";
export type {
  AssemblyAgendaItemInsert,
  AssemblyAgendaItemSelect,
  AssemblyAgendaItemUpdate,
} from "./assembly_agenda_item.ts";
export type {
  AssemblyAttendeeInsert,
  AssemblyAttendeeSelect,
  AssemblyAttendeeUpdate,
} from "./assembly_attendee.ts";
export type {
  AssemblyVoteInsert,
  AssemblyVoteSelect,
  AssemblyVoteUpdate,
} from "./assembly_vote.ts";
export type {
  AssemblyConvocationInsert,
  AssemblyConvocationRecipient,
  AssemblyConvocationSelect,
} from "./assembly_convocation.ts";
export type { ChargeInsert, ChargeSelect, ChargeUpdate } from "./charge.ts";
export type { SupplierInsert, SupplierSelect, SupplierUpdate } from "./supplier.ts";
export type {
  RecurringTemplateInsert,
  RecurringTemplateSelect,
  RecurringTemplateUpdate,
} from "./recurring_template.ts";
export type {
  RecurringGenerationRunInsert,
  RecurringGenerationRunSelect,
} from "./recurring_generation_run.ts";
export type { BankAccountInsert, BankAccountSelect, BankAccountUpdate } from "./bank_account.ts";
export type {
  BankTransactionInsert,
  BankTransactionSelect,
  BankTransactionUpdate,
} from "./bank_transaction.ts";
export type { SettlementInsert, SettlementSelect, SettlementUpdate } from "./settlement.ts";
export type { BudgetQuotaMapRow } from "./budget_quota_map.ts";
export type { UnitBalanceRow } from "./unit_balance.ts";
export type { BankBalanceRow } from "./bank_balance.ts";
export type { ReceiptInsert, ReceiptSelect, ReceiptUpdate } from "./receipt.ts";
export type { ReceiptSkipInsert, ReceiptSkipSelect } from "./receipt_skip.ts";
export type {
  EvidenceSource,
  InsurancePolicyInsert,
  InsurancePolicySelect,
  InsurancePolicyStatus,
  InsurancePolicyUpdate,
  OcrExtracted,
} from "./insurance_policy.ts";
export type {
  InsuranceReminderInsert,
  InsuranceReminderRecipient,
  InsuranceReminderSelect,
} from "./insurance_reminder.ts";
export type {
  BillingReminderInsert,
  BillingReminderRecipient,
  BillingReminderSelect,
} from "./billing_reminder.ts";
export type {
  InspectionCategory,
  InspectionInsert,
  InspectionSelect,
  InspectionUpdate,
} from "./inspection.ts";
export { INSPECTION_CATEGORIES } from "./inspection.ts";
// Aliases retro: InspectionAttachment* aponta agora para AttachmentSelect.
import type { AttachmentSelect } from "./attachment.ts";
export type InspectionAttachmentSelect = AttachmentSelect;
export const schema = {
  condominium,
  unit,
  manager,
  occupant,
  unitOccupant,
  user,
  inviteToken,
  chartOfAccount,
  budget,
  budgetLine,
  assembly,
  assemblyAgendaItem,
  assemblyAttendee,
  assemblyVote,
  assemblyConvocation,
  charge,
  supplier,
  recurringTemplate,
  recurringGenerationRun,
  quotaGenerationRun,
  bankAccount,
  bankImportBatch,
  bankTransaction,
  ledger,
  fcrTransfer,
  settlement,
  budgetQuotaMap,
  unitBalance,
  bankBalance,
  receipt,
  receiptSkip,
  insurancePolicy,
  insuranceReminder,
  billingReminder,
  inspection,
  attachment,
  ticket,
  ticketComment,
  document,
  pathology,
  pathologyUnit,
  paymentPlan,
  unitRelations,
  unitOccupantRelations,
  occupantRelations,
  budgetRelations,
  budgetLineRelations,
  assemblyRelations,
  assemblyAgendaItemRelations,
  assemblyVoteRelations,
  chargeRelations,
  inspectionRelations,
  settlementRelations,
  ticketRelations,
  ticketCommentRelations,
  pathologyRelations,
  pathologyUnitRelations,
};
