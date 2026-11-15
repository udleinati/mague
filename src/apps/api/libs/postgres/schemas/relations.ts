import { relations } from "drizzle-orm";
import { unit } from "./unit.ts";
import { unitOccupant } from "./unit_occupant.ts";
import { occupant } from "./occupant.ts";
import { condominium } from "./condominium.ts";
import { budget } from "./budget.ts";
import { budgetLine } from "./budget_line.ts";
import { chartOfAccount } from "./chart_of_account.ts";
import { assembly } from "./assembly.ts";
import { assemblyAgendaItem } from "./assembly_agenda_item.ts";
import { assemblyVote } from "./assembly_vote.ts";
import { charge } from "./charge.ts";
import { supplier } from "./supplier.ts";
import { settlement } from "./settlement.ts";
import { bankTransaction } from "./bank_transaction.ts";
import { ticket, ticketComment } from "./ticket.ts";
import { pathology, pathologyUnit } from "./pathology.ts";
import { inspection } from "./inspection.ts";

export const unitRelations = relations(unit, ({ one, many }) => ({
  unitOccupants: many(unitOccupant),
  // Usado no /auth/me do switcher de fração para o nome do condomínio sem query extra.
  condominium: one(condominium, {
    fields: [unit.condominiumId],
    references: [condominium.id],
  }),
}));

export const unitOccupantRelations = relations(unitOccupant, ({ one }) => ({
  unit: one(unit, { fields: [unitOccupant.unitId], references: [unit.id] }),
  occupant: one(occupant, { fields: [unitOccupant.occupantId], references: [occupant.id] }),
}));

export const occupantRelations = relations(occupant, ({ many }) => ({
  unitOccupants: many(unitOccupant),
}));

export const budgetRelations = relations(budget, ({ many }) => ({
  budgetLines: many(budgetLine),
}));

export const budgetLineRelations = relations(budgetLine, ({ one }) => ({
  budget: one(budget, { fields: [budgetLine.budgetId], references: [budget.id] }),
  chartOfAccount: one(chartOfAccount, {
    fields: [budgetLine.accountId],
    references: [chartOfAccount.id],
  }),
}));

export const assemblyRelations = relations(assembly, ({ many }) => ({
  agendaItems: many(assemblyAgendaItem),
}));

export const assemblyAgendaItemRelations = relations(assemblyAgendaItem, ({ one, many }) => ({
  assembly: one(assembly, { fields: [assemblyAgendaItem.assemblyId], references: [assembly.id] }),
  // Votos individuais por fração; trigger SQL agrega os totais.
  votes: many(assemblyVote),
}));

export const assemblyVoteRelations = relations(assemblyVote, ({ one }) => ({
  agendaItem: one(assemblyAgendaItem, {
    fields: [assemblyVote.assemblyAgendaItemId],
    references: [assemblyAgendaItem.id],
  }),
  unit: one(unit, { fields: [assemblyVote.unitId], references: [unit.id] }),
}));

// Nested objects para resolver nomes server-side (ver subset estável em
// `admin/charge/_projection.ts`). `debitSettlements`/`creditSettlements` são o
// lado inverso de settlementRelations; `relationName` tem de bater
// EXACTAMENTE com o one() do settlement (uma charge é debit OU credit).
export const chargeRelations = relations(charge, ({ one, many }) => ({
  unit: one(unit, { fields: [charge.unitId], references: [unit.id] }),
  supplier: one(supplier, { fields: [charge.supplierId], references: [supplier.id] }),
  account: one(chartOfAccount, { fields: [charge.accountId], references: [chartOfAccount.id] }),
  debitSettlements: many(settlement, { relationName: "settlementDebitCharge" }),
  creditSettlements: many(settlement, { relationName: "settlementCreditCharge" }),
}));

// Nested para resolver descrições/tipos server-side, evitando que o panel da
// conciliação puxe todas as charges + bank transactions só para o join.
export const settlementRelations = relations(settlement, ({ one }) => ({
  debitCharge: one(charge, {
    fields: [settlement.debitChargeId],
    references: [charge.id],
    relationName: "settlementDebitCharge",
  }),
  creditCharge: one(charge, {
    fields: [settlement.creditChargeId],
    references: [charge.id],
    relationName: "settlementCreditCharge",
  }),
  bankTransaction: one(bankTransaction, {
    fields: [settlement.bankTransactionId],
    references: [bankTransaction.id],
  }),
}));

// ─── Ticket relations ──────────────────────────────────────────────────────
// Ticket -> 1:N comments + 0:1 unit (null = zona comum). Attachments vivem em
// core.attachment (polimórficos), fetched à parte.
export const ticketRelations = relations(ticket, ({ one, many }) => ({
  comments: many(ticketComment),
  unit: one(unit, { fields: [ticket.unitId], references: [unit.id] }),
  reportedByOccupant: one(occupant, {
    fields: [ticket.reportedByOccupantId],
    references: [occupant.id],
  }),
  pathology: one(pathology, {
    fields: [ticket.pathologyId],
    references: [pathology.id],
  }),
}));

export const ticketCommentRelations = relations(ticketComment, ({ one }) => ({
  ticket: one(ticket, { fields: [ticketComment.ticketId], references: [ticket.id] }),
}));

// ─── Pathology relations ───────────────────────────────────────────────────
// Pathology -> N:N units via pathologyUnit. Attachments via core.attachment
// polimórficos, fetched à parte.
export const pathologyRelations = relations(pathology, ({ many }) => ({
  units: many(pathologyUnit),
  // Tickets associados via ticket.pathology_id (ADR 0024).
  tickets: many(ticket),
}));

export const pathologyUnitRelations = relations(pathologyUnit, ({ one }) => ({
  pathology: one(pathology, {
    fields: [pathologyUnit.pathologyId],
    references: [pathology.id],
  }),
  unit: one(unit, { fields: [pathologyUnit.unitId], references: [unit.id] }),
}));

// Nested supplier para resolver o nome do fornecedor server-side no detalhe da
// inspeção (mesmo subset estável de charge: id/name/nif). Anexos vivem em
// core.attachment (polimórficos), fetched à parte.
export const inspectionRelations = relations(inspection, ({ one }) => ({
  supplier: one(supplier, { fields: [inspection.supplierId], references: [supplier.id] }),
}));
