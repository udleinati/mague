// `makeAttachmentManager` - concentra os 4 endpoints de attachments (list,
// upload, serve, delete) numa factory. Cada entidade (charge, ticket, ...)
// passa entityType, paramName, entityNamePT, ownershipQuery (anti-IDOR) e
// serialize; toda a lógica HTTP (multipart, ownership, response shape, 404)
// vive numa só implementação. Adicionar entidade = 1 chamada + wiring no router.

import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import type { Postgres } from "$api/libs/postgres/postgres.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { requireActor } from "$api/middleware/api_auth.ts";
import { logError } from "$shared/error_log.ts";
import {
  getAttachmentById as defaultGetAttachmentById,
  listAttachmentsForEntity as defaultListAttachmentsForEntity,
  serveAttachmentBytes as defaultServeAttachmentBytes,
  serveHeaders as defaultServeHeaders,
  softDeleteAttachment as defaultSoftDeleteAttachment,
  uploadAttachment as defaultUploadAttachment,
} from "./mod.ts";
import type {
  AttachmentEntityType,
  AttachmentSelect,
} from "$api/libs/postgres/schemas/attachment.ts";

/**
 * Função-stubs usadas pelos métodos do manager. Defaults apontam para a lib
 * `./mod.ts`. Tests passam fakes para validar a composição sem tocar S3/DB.
 */
export interface AttachmentLibDeps {
  uploadAttachment: typeof defaultUploadAttachment;
  listAttachmentsForEntity: typeof defaultListAttachmentsForEntity;
  getAttachmentById: typeof defaultGetAttachmentById;
  serveAttachmentBytes: typeof defaultServeAttachmentBytes;
  serveHeaders: typeof defaultServeHeaders;
  softDeleteAttachment: typeof defaultSoftDeleteAttachment;
}

const defaultDeps: AttachmentLibDeps = {
  uploadAttachment: defaultUploadAttachment,
  listAttachmentsForEntity: defaultListAttachmentsForEntity,
  getAttachmentById: defaultGetAttachmentById,
  serveAttachmentBytes: defaultServeAttachmentBytes,
  serveHeaders: defaultServeHeaders,
  softDeleteAttachment: defaultSoftDeleteAttachment,
};

export interface AttachmentManagerConfig<TSerialized> {
  /** Tipo canónico (mesmo valor usado na coluna `entity_type` da tabela polimórfica). */
  entityType: AttachmentEntityType;
  /** Nome do path param que carrega o id da entidade-pai (e.g. "chargeId"). */
  paramName: string;
  /** Label PT-PT usado em mensagens de erro 404 ("Charge", "Assembleia", "Ticket"). */
  entityNamePT: string;
  /** Validação anti-IDOR: confirma que a entidade existe + pertence ao condo. */
  ownershipQuery: (
    postgres: Postgres,
    entityId: string,
    condominiumId: string,
  ) => Promise<unknown>;
  /** Transforma o row do attachment na shape pública. Cada entidade pode ter aliases (chargeId, ticketId, ...). */
  serialize: (a: AttachmentSelect) => TSerialized;
  /** Nome default do ficheiro quando o multipart não vem com filename (e.g. "fatura", "anexo"). */
  defaultFilename?: string;
}

export interface AttachmentManager {
  /** GET /<parent>/:id/attachments */
  list: (ctx: Context, postgres: Postgres) => Promise<Response>;
  /** POST /<parent>/:id/attachments  (multipart/form-data, field "file") */
  upload: (ctx: Context, postgres: Postgres) => Promise<Response>;
  /** GET /<parent>/:id/attachments/:attachmentId  → bytes + headers */
  serve: (ctx: Context, postgres: Postgres) => Promise<Response>;
  /** DELETE /<parent>/:id/attachments/:attachmentId  → 204 */
  delete: (ctx: Context, postgres: Postgres) => Promise<Response>;
}

export function makeAttachmentManager<T>(
  config: AttachmentManagerConfig<T>,
  /** Override das deps (apenas para tests - produção usa os defaults da lib). */
  depsOverride: Partial<AttachmentLibDeps> = {},
): AttachmentManager {
  const deps: AttachmentLibDeps = { ...defaultDeps, ...depsOverride };
  const defaultFilename = config.defaultFilename ?? "anexo";

  async function readAndCheckOwnership(
    ctx: Context,
    postgres: Postgres,
  ): Promise<{ cid: string; entityId: string }> {
    const cid = requireCondominiumId(ctx);
    const entityId = requireParam(ctx, config.paramName);
    const entity = await config.ownershipQuery(postgres, entityId, cid);
    if (entity === null || entity === undefined) {
      // Marcador `attachment-ownership-404` (grep-able) para o ownership check
      // falhar num upload/serve. Causas típicas: id de outro condo, entidade
      // soft-deleted ou apagada noutro separador.
      logError("info", {
        app: "api",
        status: 404,
        condominiumId: cid,
        source: "attachment-ownership-404",
        extra: { entityType: config.entityType, entityId },
      }, new Error(`${config.entityNamePT} não encontrado (ownership)`));
    }
    findEntityOrFail(entity, config.entityNamePT);
    return { cid, entityId };
  }

  return {
    list: async (ctx, postgres) => {
      const { cid, entityId } = await readAndCheckOwnership(ctx, postgres);
      const items = await deps.listAttachmentsForEntity({
        postgres,
        condominiumId: cid,
        entityType: config.entityType,
        entityId,
      });
      return ctx.json({ data: items.map(config.serialize) });
    },

    upload: async (ctx, postgres) => {
      const { cid, entityId } = await readAndCheckOwnership(ctx, postgres);
      const actor = requireActor(ctx);

      const form = await ctx.req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        throw new AppError({
          message: "Campo `file` em falta no multipart",
          statusCode: STATUS_CODE.BadRequest,
          code: "VALIDATION_ERROR",
        });
      }

      const bytes = new Uint8Array(await file.arrayBuffer());
      const created = await deps.uploadAttachment({
        postgres,
        condominiumId: cid,
        entityType: config.entityType,
        entityId,
        actor,
        filename: file.name || defaultFilename,
        mimeType: file.type || "application/octet-stream",
        bytes,
      });
      return ctx.json({ data: config.serialize(created) }, STATUS_CODE.Created);
    },

    serve: async (ctx, postgres) => {
      // Ownership check ANTES do lookup: blinda o serve admin e permite que o
      // portal injecte filtros de visibilidade (e.g. `is_public`) no flow.
      const { cid, entityId } = await readAndCheckOwnership(ctx, postgres);
      const attachmentId = requireParam(ctx, "attachmentId");
      const att = await deps.getAttachmentById({
        postgres,
        condominiumId: cid,
        entityType: config.entityType,
        entityId,
        attachmentId,
      });
      if (!att) {
        throw new AppError({
          message: "Anexo não encontrado",
          statusCode: STATUS_CODE.NotFound,
          code: "NOT_FOUND",
        });
      }
      const bytes = await deps.serveAttachmentBytes(att.storageKey);
      return new Response(bytes as unknown as BodyInit, {
        status: STATUS_CODE.OK,
        headers: deps.serveHeaders(att, bytes.byteLength),
      });
    },

    delete: async (ctx, postgres) => {
      const cid = requireCondominiumId(ctx);
      const entityId = requireParam(ctx, config.paramName);
      const attachmentId = requireParam(ctx, "attachmentId");
      const actor = requireActor(ctx);

      const ok = await deps.softDeleteAttachment({
        postgres,
        condominiumId: cid,
        entityType: config.entityType,
        entityId,
        attachmentId,
        actor,
      });
      if (!ok) {
        throw new AppError({
          message: "Anexo não encontrado",
          statusCode: STATUS_CODE.NotFound,
          code: "NOT_FOUND",
        });
      }
      return new Response(null, { status: STATUS_CODE.NoContent });
    },
  };
}
