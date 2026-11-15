// Attachments para tickets (fotos da avaria, comprovativos): POST (upload),
// GET (serve bytes), DELETE em /tickets/:ticketId/attachments[/:id].

import type { Context } from "hono";
import type { Postgres } from "$api/libs/postgres/postgres.ts";
import { makeAttachmentManager } from "$api/libs/attachments/manager.ts";
import type { AttachmentSelect } from "$api/libs/postgres/schemas/attachment.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { byIdInCondo } from "$api/libs/shared/by_id_in_condo.ts";
import { formatTicketAttachmentForResponse } from "./_projection.ts";
import { requireMutableTicket } from "./_helpers.ts";

const manager = makeAttachmentManager({
  entityType: "ticket",
  paramName: "ticketId",
  entityNamePT: "Ticket",
  ownershipQuery: (postgres, ticketId, condominiumId) =>
    postgres.query((db) =>
      db.query.ticket.findFirst({
        where: byIdInCondo(schema.ticket, ticketId, condominiumId),
      })
    ),
  serialize: (a: AttachmentSelect) => formatTicketAttachmentForResponse(a),
});

// Upload/delete só em open/in_progress. Guard ANTES do manager: ticket
// resolved/closed devolve 422 sem tocar no storage.
export const uploadTicketAttachmentHandler = async (
  ctx: Context,
  postgres: Postgres,
) => {
  const cid = requireCondominiumId(ctx);
  const ticketId = requireParam(ctx, "ticketId");
  await requireMutableTicket(postgres, cid, ticketId);
  return manager.upload(ctx, postgres);
};

// Serve continua aberto (download de fotos antigas em tickets fechados).
export const serveTicketAttachmentHandler = manager.serve;

export const deleteTicketAttachmentHandler = async (
  ctx: Context,
  postgres: Postgres,
) => {
  const cid = requireCondominiumId(ctx);
  const ticketId = requireParam(ctx, "ticketId");
  await requireMutableTicket(postgres, cid, ticketId);
  return manager.delete(ctx, postgres);
};
