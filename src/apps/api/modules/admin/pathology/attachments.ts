// Attachments para pathology (fotos do defeito observado): POST (upload),
// GET (serve bytes), DELETE em /pathologies/:pathologyId/attachments[/:id].

import type { Context } from "hono";
import type { Postgres } from "$api/libs/postgres/postgres.ts";
import { makeAttachmentManager } from "$api/libs/attachments/manager.ts";
import type { AttachmentSelect } from "$api/libs/postgres/schemas/attachment.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { byIdInCondo } from "$api/libs/shared/by_id_in_condo.ts";
import { formatPathologyAttachmentForResponse } from "./_projection.ts";

const manager = makeAttachmentManager({
  entityType: "pathology",
  paramName: "pathologyId",
  entityNamePT: "Patologia",
  ownershipQuery: (postgres, pathologyId, condominiumId) =>
    postgres.query((db) =>
      db.query.pathology.findFirst({
        where: byIdInCondo(schema.pathology, pathologyId, condominiumId),
      })
    ),
  serialize: (a: AttachmentSelect) => formatPathologyAttachmentForResponse(a),
});

// Sem guard "estado mutável" para já - admin pode anexar a qualquer momento.
// Se o user pedir lock em terminal (resolved/dismissed), adiciona-se um
// requireMutablePathology(...) similar ao do ticket.
export const uploadPathologyAttachmentHandler = (ctx: Context, postgres: Postgres) =>
  manager.upload(ctx, postgres);

export const servePathologyAttachmentHandler = manager.serve;

export const deletePathologyAttachmentHandler = (ctx: Context, postgres: Postgres) =>
  manager.delete(ctx, postgres);
