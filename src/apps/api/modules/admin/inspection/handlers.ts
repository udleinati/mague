// Handlers HTTP thin sobre `_helpers.ts`. Admin (super/manager) acede a tudo;
// occupants não (exceto /portal).

import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { requireCondoAdmin } from "$api/libs/shared/require_condo_admin.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { byIdInCondo } from "$api/libs/shared/by_id_in_condo.ts";
import { dtoValidator } from "$api/libs/shared/dto_validator.ts";
import { assertOwnership } from "$api/libs/shared/assert_ownership.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { requireActor } from "$api/middleware/api_auth.ts";
import { getObject } from "$api/libs/storage/s3.ts";
import { inspectionCreateSchema, inspectionUpdateSchema } from "$api/libs/model/inspection.ts";
import { formatInspectionForResponse, INSPECTION_PROJECTION } from "./_projection.ts";
import {
  safeAttachmentServeHeaders,
  validateAttachmentMime,
} from "$api/libs/shared/validate_attachment.ts";
import {
  addAttachment,
  countInspectionAlerts,
  createInspection,
  listAttachmentsFor,
  listInspections,
  setInspectionActive,
  softDeleteInspection,
  softDeleteInspectionAttachment,
  updateInspection,
} from "./_helpers.ts";

import { env } from "$config/env.ts";
const MAX_FILE_SIZE = env.upload.maxFileSizeBytes;

// ─── GET /v1/admin/condominiums/:cid/inspections ─────────────────────────────
export const listInspectionsHandler = async (ctx: Context, postgres: Postgres) => {
  const cid = requireCondominiumId(ctx);
  if (!cid) return;
  requireCondoAdmin(ctx, { action: "aceder a inspeções" });

  const category = ctx.req.query("category");
  const status = ctx.req.query("status");
  const lite = ctx.req.query("lite") === "1" || ctx.req.query("lite") === "true";
  const validStatus =
    (status === "ok" || status === "due_soon" || status === "expired" || status === "inactive")
      ? status
      : undefined;

  const rows = await listInspections(postgres, cid, {
    category,
    status: validStatus,
  }, { withAttachments: !lite, withSupplier: !lite });
  const data = rows.map((r) => formatInspectionForResponse(r, r.attachments));
  return ctx.json({ data });
};

// ─── GET /v1/admin/condominiums/:cid/inspections/portal ─────────────────────
// Subset público (só is_active=true) para o condómino. Sem admin role: qualquer
// member do condo pode ler.
export const listPortalInspectionsHandler = async (ctx: Context, postgres: Postgres) => {
  const cid = requireCondominiumId(ctx);
  if (!cid) return;

  const rows = await listInspections(postgres, cid, { onlyActive: true });
  const data = rows.map((r) => formatInspectionForResponse(r, r.attachments));
  return ctx.json({ data });
};

// ─── GET /v1/admin/condominiums/:cid/inspections/alerts/count ────────────────
export const countAlertsHandler = async (ctx: Context, postgres: Postgres) => {
  const cid = requireCondominiumId(ctx);
  if (!cid) return;
  requireCondoAdmin(ctx, { action: "aceder a inspeções" });

  const count = await countInspectionAlerts(postgres, cid);
  return ctx.json({ data: { count } });
};

// ─── GET /v1/admin/condominiums/:cid/inspections/:id ─────────────────────────
export const retrieveInspectionHandler = async (ctx: Context, postgres: Postgres) => {
  const cid = requireCondominiumId(ctx);
  if (!cid) return;
  requireCondoAdmin(ctx, { action: "aceder a inspeções" });

  const id = ctx.req.param("inspectionId");
  const r = await postgres.query((db) =>
    db.query.inspection.findFirst({
      where: byIdInCondo(schema.inspection, id!, cid),
      ...INSPECTION_PROJECTION,
    })
  );
  const inspection = findEntityOrFail(r, "Inspeção");
  const attachments = await listAttachmentsFor(postgres, inspection.id);
  return ctx.json({ data: formatInspectionForResponse(inspection, attachments) });
};

// ─── POST /v1/admin/condominiums/:cid/inspections ────────────────────────────
export const createInspectionHandler = async (ctx: Context, postgres: Postgres) => {
  const cid = requireCondominiumId(ctx);
  if (!cid) return;
  requireCondoAdmin(ctx, { action: "aceder a inspeções" });

  const actor = requireActor(ctx);

  const dto = await dtoValidator(inspectionCreateSchema, await ctx.req.json());
  await assertOwnership(postgres, dto, cid, { supplier: "supplierId" });

  const created = await createInspection(postgres, {
    condominiumId: cid,
    actor,
    data: dto,
  });
  return ctx.json(
    { data: formatInspectionForResponse(created, []) },
    STATUS_CODE.Created,
  );
};

// ─── PATCH /v1/admin/condominiums/:cid/inspections/:id ───────────────────────
export const updateInspectionHandler = async (ctx: Context, postgres: Postgres) => {
  const cid = requireCondominiumId(ctx);
  if (!cid) return;
  requireCondoAdmin(ctx, { action: "aceder a inspeções" });

  const actor = requireActor(ctx);
  const id = requireParam(ctx, "inspectionId");

  const dto = await dtoValidator(inspectionUpdateSchema, await ctx.req.json());
  await assertOwnership(postgres, dto, cid, { supplier: "supplierId" });

  const updated = await updateInspection(postgres, {
    condominiumId: cid,
    inspectionId: id,
    actor,
    patch: dto,
  });
  if (!updated) {
    throw new AppError({
      message: "Inspeção não encontrada",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }
  const attachments = await listAttachmentsFor(postgres, id);
  return ctx.json({ data: formatInspectionForResponse(updated, attachments) });
};

// ─── POST /v1/admin/condominiums/:cid/inspections/:id/activate ───────────────
// ─── POST /v1/admin/condominiums/:cid/inspections/:id/deactivate ─────────────
function makeSetActiveHandler(active: boolean) {
  return async (ctx: Context, postgres: Postgres) => {
    const cid = requireCondominiumId(ctx);
    if (!cid) return;
    requireCondoAdmin(ctx, { action: "aceder a inspeções" });
    const actor = requireActor(ctx);
    const id = ctx.req.param("inspectionId");
    if (!id) {
      throw new AppError({
        message: "inspectionId obrigatório",
        statusCode: STATUS_CODE.BadRequest,
        code: "VALIDATION_ERROR",
      });
    }
    const updated = await setInspectionActive(postgres, {
      condominiumId: cid,
      inspectionId: id,
      actor,
      isActive: active,
    });
    if (!updated) {
      throw new AppError({
        message: "Inspeção não encontrada",
        statusCode: STATUS_CODE.NotFound,
        code: "NOT_FOUND",
      });
    }
    const attachments = await listAttachmentsFor(postgres, id);
    return ctx.json({ data: formatInspectionForResponse(updated, attachments) });
  };
}

export const activateHandler = makeSetActiveHandler(true);
export const deactivateHandler = makeSetActiveHandler(false);

// ─── DELETE /v1/admin/condominiums/:cid/inspections/:id ──────────────────────
export const deleteInspectionHandler = async (ctx: Context, postgres: Postgres) => {
  const cid = requireCondominiumId(ctx);
  if (!cid) return;
  requireCondoAdmin(ctx, { action: "aceder a inspeções" });

  const actor = requireActor(ctx);
  const id = requireParam(ctx, "inspectionId");

  const deleted = await softDeleteInspection(postgres, {
    condominiumId: cid,
    inspectionId: id,
    actor,
  });
  if (!deleted) {
    throw new AppError({
      message: "Inspeção não encontrada",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }
  return new Response(null, { status: STATUS_CODE.NoContent });
};

// ═══ Attachments ══════════════════════════════════════════════════════════════

// ─── POST /v1/admin/condominiums/:cid/inspections/:id/attachments ─ (multipart) ─
export const uploadAttachmentHandler = async (ctx: Context, postgres: Postgres) => {
  const cid = requireCondominiumId(ctx);
  if (!cid) return;
  requireCondoAdmin(ctx, { action: "aceder a inspeções" });

  const actor = requireActor(ctx);
  const id = requireParam(ctx, "inspectionId");

  // Verifica que a inspeção existe antes do upload (evita objeto S3 orfão).
  const existing = await postgres.query((db) =>
    db.query.inspection.findFirst({
      where: byIdInCondo(schema.inspection, id, cid),
    })
  );
  const inspection = findEntityOrFail(existing, "Inspeção");

  const form = await ctx.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    throw new AppError({
      message: "Campo `file` em falta no multipart",
      statusCode: STATUS_CODE.BadRequest,
      code: "VALIDATION_ERROR",
    });
  }
  if (file.size === 0) {
    throw new AppError({
      message: "Ficheiro vazio",
      statusCode: STATUS_CODE.BadRequest,
      code: "EMPTY_FILE",
    });
  }
  if (file.size > MAX_FILE_SIZE) {
    throw new AppError({
      message: `Ficheiro muito grande (max ${MAX_FILE_SIZE / 1024 / 1024} MB)`,
      statusCode: STATUS_CODE.ContentTooLarge,
      code: "FILE_TOO_LARGE",
    });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  // Validação MIME (allowlist + magic bytes) - defesa contra XSS via SVG/HTML.
  validateAttachmentMime(
    file.type || "application/octet-stream",
    bytes,
  );

  const attachment = await addAttachment(postgres, {
    condominiumId: cid,
    inspectionId: id,
    actor,
    filename: file.name || "anexo",
    mimeType: file.type || "application/octet-stream",
    bytes,
  });
  const attachments = await listAttachmentsFor(postgres, id);
  return ctx.json(
    {
      data: formatInspectionForResponse(inspection, attachments),
      attachment: { id: attachment.id, filename: attachment.filename },
    },
    STATUS_CODE.Created,
  );
};

// ─── GET /v1/admin/condominiums/:cid/inspections/:id/attachments/:attachmentId ─
export const serveAttachmentHandler = async (ctx: Context, postgres: Postgres) => {
  const cid = requireCondominiumId(ctx);
  if (!cid) return;
  requireCondoAdmin(ctx, { action: "aceder a inspeções" });

  const inspectionId = ctx.req.param("inspectionId");
  const attachmentId = ctx.req.param("attachmentId");
  if (!inspectionId || !attachmentId) {
    throw new AppError({
      message: "inspectionId/attachmentId obrigatórios",
      statusCode: STATUS_CODE.BadRequest,
      code: "VALIDATION_ERROR",
    });
  }

  const r = await postgres.query((db) =>
    db.query.attachment.findFirst({
      where: (a, ops) =>
        ops.and(
          ops.eq(a.id, attachmentId),
          ops.eq(a.entityType, "inspection"),
          ops.eq(a.entityId, inspectionId),
          ops.eq(a.condominiumId, cid),
          ops.isNull(a.deletedAt),
        ),
    })
  );
  const att = findEntityOrFail(r, "Anexo");

  try {
    const bytes = await getObject(att.storageKey);
    return new Response(bytes as unknown as BodyInit, {
      status: 200,
      headers: safeAttachmentServeHeaders(
        att.mimeType || "application/octet-stream",
        att.filename,
        bytes.byteLength,
      ),
    });
  } catch (e) {
    throw new AppError({
      message: `Erro a servir anexo: ${(e as Error).message}`,
      statusCode: STATUS_CODE.NotFound,
      code: "ATTACHMENT_NOT_FOUND",
    });
  }
};

// ─── DELETE /v1/admin/condominiums/:cid/inspections/:id/attachments/:attId ───
export const deleteAttachmentHandler = async (ctx: Context, postgres: Postgres) => {
  const cid = requireCondominiumId(ctx);
  if (!cid) return;
  requireCondoAdmin(ctx, { action: "aceder a inspeções" });

  const actor = requireActor(ctx);
  const inspectionId = ctx.req.param("inspectionId");
  const attachmentId = ctx.req.param("attachmentId");
  if (!inspectionId || !attachmentId) {
    throw new AppError({
      message: "inspectionId/attachmentId obrigatórios",
      statusCode: STATUS_CODE.BadRequest,
      code: "VALIDATION_ERROR",
    });
  }

  const deleted = await softDeleteInspectionAttachment(postgres, {
    condominiumId: cid,
    inspectionId,
    attachmentId,
    actor,
  });
  if (!deleted) {
    throw new AppError({
      message: "Anexo não encontrado",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }
  return new Response(null, { status: STATUS_CODE.NoContent });
};
