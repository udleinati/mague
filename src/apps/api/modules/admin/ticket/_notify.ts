// Emails de ocorrência. Duas regras, ambas best-effort (nunca fazem falhar a
// operação que as originou):
//   - criação no portal        -> caixa do condomínio (`condominium.email`);
//   - interação pública        -> o lado OPOSTO ao autor (nunca eco).
// "Interação" = comentário não-interno + mudança de estado. O lado da fração é
// sempre o reporter (`ticket.reported_by_occupant_id`); sem reporter não há
// email, e `visibility='admin_only'` corta-o (não se envia por email o que o
// portal esconde).

import type { Postgres } from "$api/libs/postgres/postgres.ts";
import type { ActorSnapshot } from "$api/libs/postgres/schemas/_audit.ts";
import type { TicketSelect } from "$api/libs/postgres/schemas/mod.ts";
import {
  sendEmail,
  ticketActivityEmailHtml,
  ticketCreatedEmailHtml,
} from "$api/libs/email/send.ts";
import { unitLabel } from "$shared/labels/mod.ts";
import { TICKET_CATEGORY_LABELS, TICKET_PRIORITY_LABELS, TICKET_STATUS_LABELS } from "./_labels.ts";

/** Quem escreveu a interação - determina quem é notificado (o outro lado). */
export type TicketAuthorSide = "admin" | "unit";

interface Reporter {
  occupantId: string;
  name: string;
  email: string | null;
}

export type ActivityRecipient =
  | { side: "condominium"; email: string; name: null }
  | { side: "reporter"; email: string; name: string; occupantId: string };

/**
 * Decide destinatário (ou razão do skip) de uma interação. Puro - o I/O fica
 * em `notifyTicketActivity`.
 */
export function decideActivityRecipient(input: {
  authorSide: TicketAuthorSide;
  visibility: string;
  condominiumEmail: string | null;
  reporter: Reporter | null;
}): { recipient: ActivityRecipient } | { skip: string } {
  if (input.authorSide === "unit") {
    const email = input.condominiumEmail?.trim();
    if (!email) return { skip: "condomínio sem email configurado" };
    return { recipient: { side: "condominium", email, name: null } };
  }

  // Autor = administração -> notifica o reporter, se existir e ainda puder ver.
  if (input.visibility === "admin_only") {
    return { skip: "ocorrência visível só à administração" };
  }
  if (!input.reporter) return { skip: "ocorrência sem reporter" };
  const email = input.reporter.email?.trim();
  if (!email) return { skip: "reporter sem email" };
  return {
    recipient: {
      side: "reporter",
      email,
      name: input.reporter.name,
      occupantId: input.reporter.occupantId,
    },
  };
}

const MAX_SUBJECT_TITLE = 80;
const shortTitle = (t: string) =>
  t.length > MAX_SUBJECT_TITLE ? `${t.slice(0, MAX_SUBJECT_TITLE)}...` : t;

async function loadCondominium(postgres: Postgres, condominiumId: string) {
  return await postgres.query((db) =>
    db.query.condominium.findFirst({
      where: (c, ops) => ops.eq(c.id, condominiumId),
      columns: { name: true, designationType: true, email: true },
    })
  );
}

async function loadUnitDesignation(
  postgres: Postgres,
  condominiumId: string,
  unitId: string | null,
): Promise<string | null> {
  if (!unitId) return null;
  const u = await postgres.query((db) =>
    db.query.unit.findFirst({
      where: (unit, ops) =>
        ops.and(ops.eq(unit.id, unitId), ops.eq(unit.condominiumId, condominiumId)),
      columns: { designation: true, identifier: true },
    })
  );
  if (!u) return null;
  return unitLabel({ id: unitId, designation: u.designation, identifier: u.identifier ?? null });
}

/**
 * Reporter ainda notificável: ocupante vivo, com ligação ativa à fração da
 * ocorrência. Quem saiu da fração deixa de receber.
 */
async function loadReporter(postgres: Postgres, ticket: TicketSelect): Promise<Reporter | null> {
  if (!ticket.reportedByOccupantId || !ticket.unitId) return null;
  const today = new Date().toISOString().slice(0, 10);
  const link = await postgres.query((db) =>
    db.query.unitOccupant.findFirst({
      where: (uo, ops) =>
        ops.and(
          ops.eq(uo.occupantId, ticket.reportedByOccupantId!),
          ops.eq(uo.unitId, ticket.unitId!),
          ops.isNull(uo.deletedAt),
          ops.lte(uo.startDate, today),
          ops.or(ops.isNull(uo.endDate), ops.gte(uo.endDate, today)),
        ),
      with: { occupant: { columns: { id: true, name: true, email: true, deletedAt: true } } },
    })
  );
  if (!link?.occupant || link.occupant.deletedAt !== null) return null;
  return {
    occupantId: link.occupant.id,
    name: link.occupant.name,
    email: link.occupant.email,
  };
}

const adminTicketUrl = (base: string, t: TicketSelect) =>
  `${base}/admin/c/${t.condominiumId}/tickets/${t.id}`;
const portalTicketUrl = (base: string, t: TicketSelect) =>
  `${base}/portal/c/${t.condominiumId}/u/${t.unitId}/tickets/${t.id}`;

/** Ocorrência registada no portal -> caixa do condomínio. */
export async function notifyTicketCreated(
  postgres: Postgres,
  args: {
    ticket: TicketSelect;
    reporterName: string;
    panelBaseUrl: string;
    actor: ActorSnapshot;
  },
): Promise<void> {
  const { ticket } = args;
  try {
    const condo = await loadCondominium(postgres, ticket.condominiumId);
    const to = condo?.email?.trim();
    if (!condo || !to) {
      console.warn(
        `[ticket:${ticket.id}] email de criação não enviado: condomínio sem email configurado`,
      );
      return;
    }
    const unitDesignation = await loadUnitDesignation(
      postgres,
      ticket.condominiumId,
      ticket.unitId,
    );

    await sendEmail({
      to,
      subject: `Nova ocorrência ${ticket.code ?? ""} · ${shortTitle(ticket.title)} · ${condo.name}`,
      category: "ticket_created",
      condominiumId: ticket.condominiumId,
      unitId: ticket.unitId,
      postgres,
      actor: args.actor,
      html: ticketCreatedEmailHtml({
        condominiumName: condo.name,
        designationType: condo.designationType,
        ticketCode: ticket.code ?? "",
        ticketTitle: ticket.title,
        unitDesignation: unitDesignation ?? "-",
        reporterName: args.reporterName,
        categoryLabel: TICKET_CATEGORY_LABELS[ticket.category] ?? ticket.category,
        priorityLabel: TICKET_PRIORITY_LABELS[ticket.priority] ?? ticket.priority,
        location: ticket.location,
        description: ticket.description,
        ticketUrl: adminTicketUrl(args.panelBaseUrl, ticket),
      }),
    });
  } catch (e) {
    console.warn(`[ticket:${ticket.id}] email de criação falhou: ${(e as Error).message}`);
  }
}

/** Comentário público ou mudança de estado -> o lado oposto ao autor. */
export async function notifyTicketActivity(
  postgres: Postgres,
  args: {
    /** Ticket já com o estado final da operação. */
    ticket: TicketSelect;
    authorSide: TicketAuthorSide;
    /** Quem escreveu, legível ("A administração", "Maria Silva"). */
    authorLabel: string;
    comment: string;
    /** Presente quando a interação foi mudança de estado (valores do enum). */
    statusChange?: { from: string; to: string } | null;
    panelBaseUrl: string;
    actor: ActorSnapshot;
  },
): Promise<void> {
  const { ticket } = args;
  try {
    const [condo, reporter] = await Promise.all([
      loadCondominium(postgres, ticket.condominiumId),
      loadReporter(postgres, ticket),
    ]);
    if (!condo) return;

    const decision = decideActivityRecipient({
      authorSide: args.authorSide,
      visibility: ticket.visibility,
      condominiumEmail: condo.email,
      reporter,
    });
    if ("skip" in decision) {
      console.warn(`[ticket:${ticket.id}] email de interação não enviado: ${decision.skip}`);
      return;
    }
    const { recipient } = decision;
    const toPortal = recipient.side === "reporter";
    const unitDesignation = await loadUnitDesignation(
      postgres,
      ticket.condominiumId,
      ticket.unitId,
    );

    await sendEmail({
      to: recipient.email,
      subject: `Ocorrência ${ticket.code ?? ""} · ${shortTitle(ticket.title)} · ${condo.name}`,
      category: "ticket_activity",
      condominiumId: ticket.condominiumId,
      unitId: ticket.unitId,
      occupantId: toPortal ? recipient.occupantId : null,
      postgres,
      actor: args.actor,
      html: ticketActivityEmailHtml({
        recipientName: recipient.name,
        condominiumName: condo.name,
        designationType: condo.designationType,
        ticketCode: ticket.code ?? "",
        ticketTitle: ticket.title,
        unitDesignation,
        authorLabel: args.authorLabel,
        statusChange: args.statusChange
          ? {
            from: TICKET_STATUS_LABELS[args.statusChange.from] ?? args.statusChange.from,
            to: TICKET_STATUS_LABELS[args.statusChange.to] ?? args.statusChange.to,
          }
          : null,
        statusLabel: TICKET_STATUS_LABELS[ticket.status] ?? ticket.status,
        comment: args.comment,
        ticketUrl: toPortal
          ? portalTicketUrl(args.panelBaseUrl, ticket)
          : adminTicketUrl(args.panelBaseUrl, ticket),
        buttonLabel: toPortal ? "Ver no portal" : "Abrir no painel",
      }),
    });
  } catch (e) {
    console.warn(`[ticket:${ticket.id}] email de interação falhou: ${(e as Error).message}`);
  }
}
