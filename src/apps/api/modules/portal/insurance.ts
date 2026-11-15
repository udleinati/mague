// /v1/portal/condominiums/:cid/units/:unitId/insurance - condómino submete,
// confirma e descarrega a apólice da SUA fração. `unitId` do path filtra contra
// IDOR (não lê policy de outra unit). Reutiliza helpers do módulo admin.

import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { z } from "zod";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { requireActor } from "$api/middleware/api_auth.ts";
import { dtoValidator } from "$api/libs/shared/dto_validator.ts";
import { loadUnitOwnedEntity, portalScope } from "$api/libs/portal/scope.ts";
import { softDeleteAttachment } from "$api/libs/attachments/mod.ts";
import { validateAttachmentMime } from "$api/libs/shared/validate_attachment.ts";
import {
  addInsurancePolicyAttachment,
  uploadInsurancePolicy,
} from "$api/modules/admin/insurance/upload.ts";
import {
  listPolicyAttachments,
  policyAttachmentResponse,
  servePolicyAttachment,
} from "$api/modules/admin/insurance/attachments.ts";
import {
  confirmInsurancePolicy,
  renewInsurancePolicyFromUnit,
} from "$api/modules/admin/insurance/state.ts";
import { deleteInsurancePolicy } from "$api/modules/admin/insurance/edit.ts";
import {
  canAddAttachment,
  canRemoveAttachment,
  OCCUPANT_NOTICE_DAYS,
} from "$shared/insurance/policy_status.ts";
import { occupantAudience, unitInsuranceView } from "$api/modules/admin/insurance/unit_view.ts";
import {
  formatInsurancePolicyForResponse,
  formatInsurancePolicyWithCapabilities,
  toRenewedFromRef,
} from "$api/modules/admin/insurance/_projection.ts";

import { env } from "$config/env.ts";
const MAX_PDF_SIZE = env.upload.maxFileSizeBytes;

// Apólices da fração, mais recente primeiro. Partilhado pela listagem e pelo
// estado agregado - as duas têm de ver exatamente o mesmo conjunto.
const loadUnitPolicies = (postgres: Postgres, cid: string, unitId: string) =>
  postgres.query((db) =>
    db.query.insurancePolicy.findMany({
      where: (p, ops) => ops.and(ops.eq(p.condominiumId, cid), ops.eq(p.unitId, unitId)),
      orderBy: (p, ops) => [ops.desc(p.createdAt)],
      limit: 100,
    })
  );

// ─── GET /v1/portal/c/:cid/units/:unitId/insurance ───────────────────────
export const portalListInsurance = async (ctx: Context, postgres: Postgres) => {
  const { cid, unitId } = portalScope(ctx);
  const actor = requireActor(ctx);
  const today = new Date();
  const r = await loadUnitPolicies(postgres, cid, unitId);
  // Linhagem (ADR 0040): o predecessor está no mesmo conjunto, resolve-se aqui
  // para o histórico poder agrupar a cadeia em vez de listar linhas soltas.
  const byId = new Map(r.map((p) => [p.id, p]));
  const audience = occupantAudience(actor.user_id);
  return ctx.json({
    data: r.map((p) => ({
      ...formatInsurancePolicyWithCapabilities(p, today, audience.gateFor(p), {
        expiringSoonDays: audience.expiringSoonDays,
      }),
      renewedFrom: toRenewedFromRef(p.renewedFromId ? byId.get(p.renewedFromId) : null),
    })),
  });
};

// ─── GET /v1/portal/c/:cid/units/:unitId/insurance/status ────────────────
// Estado agregado da fração pela MESMA regra do admin (ADR 0017): `∃ active
// dentro de vigência` vence uma rejeitada mais recente. Antes cada lado
// escolhia a sua policy (portal: a mais recente) e os dois contradiziam-se.
// Classificação com `OCCUPANT_NOTICE_DAYS` - é a vista do condómino.
export const portalGetInsuranceStatus = async (ctx: Context, postgres: Postgres) => {
  const { cid, unitId } = portalScope(ctx);
  const actor = requireActor(ctx);
  const today = new Date();
  const policies = await loadUnitPolicies(postgres, cid, unitId);
  // ADR 0011: a policy que viaja na resposta é a projetada (sem ActorSnapshots).
  const view = unitInsuranceView(policies, today, occupantAudience(actor.user_id));
  return ctx.json({
    data: {
      unitId,
      aggregate: view.aggregate,
      status: view.status,
      noticeDays: OCCUPANT_NOTICE_DAYS,
    },
  });
};

// ─── GET /v1/portal/c/:cid/units/:unitId/insurance/:policyId ─────────────
// Cross-unit IDOR guard via `loadUnitOwnedEntity` (404 se for de outra fração).
export const portalGetInsurance = async (ctx: Context, postgres: Postgres) => {
  const actor = requireActor(ctx);
  const { entity } = await loadUnitOwnedEntity({
    ctx,
    paramName: "policyId",
    entityNamePT: "Apólice",
    fetch: ({ cid, unitId, id }, pg) =>
      pg.query((db) =>
        db.query.insurancePolicy.findFirst({
          where: (p, ops) =>
            ops.and(
              ops.eq(p.id, id),
              ops.eq(p.condominiumId, cid),
              ops.eq(p.unitId, unitId),
            ),
        })
      ),
  }, postgres);
  // Predecessor só quando existe (uploads de raiz têm renewed_from_id NULL).
  const previous = entity.renewedFromId
    ? await postgres.query((db) =>
      db.query.insurancePolicy.findFirst({
        where: (p, ops) =>
          ops.and(
            ops.eq(p.id, entity.renewedFromId!),
            ops.eq(p.condominiumId, entity.condominiumId),
            ops.eq(p.unitId, entity.unitId),
          ),
        columns: { id: true, policyNumber: true, validFrom: true, validTo: true },
      })
    )
    : null;
  const audience = occupantAudience(actor.user_id);
  return ctx.json({
    data: {
      ...formatInsurancePolicyWithCapabilities(entity, new Date(), audience.gateFor(entity), {
        expiringSoonDays: audience.expiringSoonDays,
      }),
      renewedFrom: toRenewedFromRef(previous),
    },
  });
};

// ─── POST /v1/portal/c/:cid/units/:unitId/insurance/:policyId/renew ──────
//
// A fração renova a apólice que já tem: dados herdados do predecessor (o que o
// formulário reenviar vence), recibo obrigatório e linhagem gravada. Endpoint à
// parte e não uma flag no upload - o gate corre sobre o predecessor, e um gate
// condicional dentro de um handler é o erro que o ADR 0040 mandou eliminar.
export const portalRenewInsurance = async (ctx: Context, postgres: Postgres) => {
  const { cid, unitId } = portalScope(ctx);
  const actor = requireActor(ctx);
  const policyId = ctx.req.param("policyId") ?? "";
  const form = await ctx.req.formData();

  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    throw new AppError({
      // Sem prova não há renovação pela fração: presumir é do admin, que tem
      // autoridade para aprovar e um lembrete para perseguir o documento.
      message: "Anexa o recibo ou comprovativo da renovação.",
      statusCode: STATUS_CODE.BadRequest,
      code: "VALIDATION_ERROR",
    });
  }
  if (file.size > MAX_PDF_SIZE) {
    throw new AppError({
      message: `Ficheiro muito grande (max ${MAX_PDF_SIZE / 1024 / 1024} MB)`,
      statusCode: STATUS_CODE.ContentTooLarge,
      code: "FILE_TOO_LARGE",
    });
  }
  const mimeType = file.type || "application/octet-stream";
  const bytes = new Uint8Array(await file.arrayBuffer());
  validateAttachmentMime(mimeType, bytes);

  const text = (name: string) => {
    const v = String(form.get(name) ?? "").trim();
    return v === "" ? undefined : v;
  };
  const cents = form.get("coverageAmountCents");
  const renewed = await renewInsurancePolicyFromUnit(postgres, {
    policyId,
    condominiumId: cid,
    unitId,
    actor,
    attachment: { bytes, mimeType, filename: file.name || "comprovativo" },
    dates: {
      validFrom: String(form.get("validFrom") ?? ""),
      validTo: String(form.get("validTo") ?? ""),
    },
    details: {
      policyNumber: text("policyNumber"),
      insurer: text("insurer"),
      coverageAmountCents: cents === null
        ? undefined
        : String(cents).trim() === ""
        ? null
        : Number(String(cents)),
    },
  });
  return ctx.json({ data: formatInsurancePolicyForResponse(renewed) }, STATUS_CODE.Created);
};

// ─── POST /v1/portal/c/:cid/units/:unitId/insurance (multipart PDF) ──────
export const portalUploadInsurance = async (ctx: Context, postgres: Postgres) => {
  const { cid, unitId } = portalScope(ctx);
  const actor = requireActor(ctx);
  const form = await ctx.req.formData();
  // Multi-file: N ficheiros sob `file` (compat single-file). O 1.º é o principal
  // (OCR-eligible); os restantes ficam como attachments adicionais.
  const files = form.getAll("file").filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    throw new AppError({
      message: "Campo `file` em falta no multipart",
      statusCode: STATUS_CODE.BadRequest,
      code: "VALIDATION_ERROR",
    });
  }
  // Validação por ficheiro: tamanho + magic bytes.
  for (const f of files) {
    if (f.size > MAX_PDF_SIZE) {
      throw new AppError({
        message: `Ficheiro "${f.name}" muito grande (max ${MAX_PDF_SIZE / 1024 / 1024} MB)`,
        statusCode: STATUS_CODE.ContentTooLarge,
        code: "FILE_TOO_LARGE",
      });
    }
  }
  // Heurística OCR: o 1.º PDF é o ficheiro de apólice (ou o 1.º de todos).
  const sorted = [...files].sort((a, b) => {
    const pdfA = a.type === "application/pdf" ? 0 : 1;
    const pdfB = b.type === "application/pdf" ? 0 : 1;
    return pdfA - pdfB;
  });

  const first = sorted[0];
  const firstBytes = new Uint8Array(await first.arrayBuffer());
  validateAttachmentMime(first.type || "application/octet-stream", firstBytes);
  const policy = await uploadInsurancePolicy(postgres, {
    condominiumId: cid,
    unitId,
    bytes: firstBytes,
    mimeType: first.type || "application/octet-stream",
    actor,
    // Quem submete é a fração (ADR 0016); a vigência sai do OCR e a fração
    // confirma-a a seguir.
    evidenceSource: "unit",
  });

  // Attachments restantes (se houver) - sem OCR, apenas storage.
  for (const extra of sorted.slice(1)) {
    const extraBytes = new Uint8Array(await extra.arrayBuffer());
    validateAttachmentMime(extra.type || "application/octet-stream", extraBytes);
    await addInsurancePolicyAttachment(postgres, {
      condominiumId: cid,
      policyId: policy.id,
      bytes: extraBytes,
      mimeType: extra.type || "application/octet-stream",
      filename: extra.name || "anexo",
      actor,
    });
  }

  return ctx.json({ data: formatInsurancePolicyForResponse(policy) }, STATUS_CODE.Created);
};

// ─── GET /v1/portal/c/:cid/units/:unitId/insurance/:policyId/attachments ────
// Metadata dos anexos (bytes servidos pelo endpoint /serve individual).
export const portalListInsuranceAttachments = async (ctx: Context, postgres: Postgres) => {
  const { scope: { cid }, id: policyId } = await loadUnitOwnedEntity({
    ctx,
    paramName: "policyId",
    entityNamePT: "Apólice",
    fetch: ({ cid, unitId, id }, pg) =>
      pg.query((db) =>
        db.query.insurancePolicy.findFirst({
          where: (p, ops) =>
            ops.and(
              ops.eq(p.id, id),
              ops.eq(p.condominiumId, cid),
              ops.eq(p.unitId, unitId),
            ),
        })
      ),
  }, postgres);
  const atts = await listPolicyAttachments(postgres, { condominiumId: cid, policyId });
  return ctx.json({ data: atts.map(policyAttachmentResponse) });
};

// ─── GET .../insurance/:policyId/attachments/:attachmentId ──
// Serve bytes de um attachment específico (vs `/pdf` que serve só o 1.º). Anti-IDOR.
export const portalServeInsuranceAttachment = async (ctx: Context, postgres: Postgres) => {
  const { scope: { cid }, id: policyId } = await loadUnitOwnedEntity({
    ctx,
    paramName: "policyId",
    entityNamePT: "Apólice",
    fetch: ({ cid, unitId, id }, pg) =>
      pg.query((db) =>
        db.query.insurancePolicy.findFirst({
          where: (p, ops) =>
            ops.and(
              ops.eq(p.id, id),
              ops.eq(p.condominiumId, cid),
              ops.eq(p.unitId, unitId),
            ),
        })
      ),
  }, postgres);
  return await servePolicyAttachment(postgres, {
    condominiumId: cid,
    policyId,
    attachmentId: ctx.req.param("attachmentId") ?? "",
  });
};

// ─── DELETE .../insurance/:policyId/attachments/:attachmentId ──
// Remover ficheiro (condómino): só na submissão por confirmar e na rejeitada
// (ADR 0040). Numa ativa/aprovada não pode despir a evidência - 403.
export const portalDeleteInsuranceAttachment = async (ctx: Context, postgres: Postgres) => {
  const { scope: { cid }, id: policyId, entity: policy } = await loadUnitOwnedEntity({
    ctx,
    paramName: "policyId",
    entityNamePT: "Apólice",
    fetch: ({ cid, unitId, id }, pg) =>
      pg.query((db) =>
        db.query.insurancePolicy.findFirst({
          where: (p, ops) =>
            ops.and(
              ops.eq(p.id, id),
              ops.eq(p.condominiumId, cid),
              ops.eq(p.unitId, unitId),
            ),
        })
      ),
  }, postgres);
  if (!canRemoveAttachment(policy, new Date(), { isAdmin: false })) {
    throw new AppError({
      message: "Só podes remover ficheiros enquanto a apólice está por confirmar ou foi rejeitada.",
      statusCode: STATUS_CODE.Forbidden,
      code: "FORBIDDEN",
    });
  }
  const actor = requireActor(ctx);
  const attachmentId = ctx.req.param("attachmentId") ?? "";
  const ok = await softDeleteAttachment({
    postgres,
    condominiumId: cid,
    entityType: "insurance",
    entityId: policyId,
    attachmentId,
    actor,
  });
  if (!ok) {
    throw new AppError({
      message: "Ficheiro não encontrado",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }
  return new Response(null, { status: STATUS_CODE.NoContent });
};

// ─── POST .../insurance/:policyId/attachments ───
// Anexa ficheiros a uma apólice (ex.: recibo anual da renovação). Congelada após
// vencimento (ADR 0040): bloqueado em vencida/substituída - renovar em vez de
// mexer no registo morto.
export const portalAddInsuranceAttachment = async (ctx: Context, postgres: Postgres) => {
  const { scope: { cid }, id: policyId, entity: policy } = await loadUnitOwnedEntity({
    ctx,
    paramName: "policyId",
    entityNamePT: "Apólice",
    fetch: ({ cid, unitId, id }, pg) =>
      pg.query((db) =>
        db.query.insurancePolicy.findFirst({
          where: (p, ops) =>
            ops.and(
              ops.eq(p.id, id),
              ops.eq(p.condominiumId, cid),
              ops.eq(p.unitId, unitId),
            ),
        })
      ),
  }, postgres);
  if (!canAddAttachment(policy, new Date())) {
    throw new AppError({
      message: "Apólice vencida ou substituída - submete uma renovação em vez de anexar ficheiros.",
      statusCode: STATUS_CODE.UnprocessableEntity,
      code: "INVALID_STATE",
    });
  }
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
  if (file.size > MAX_PDF_SIZE) {
    throw new AppError({
      message: `Ficheiro muito grande (max ${MAX_PDF_SIZE / 1024 / 1024} MB)`,
      statusCode: STATUS_CODE.ContentTooLarge,
      code: "FILE_TOO_LARGE",
    });
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  validateAttachmentMime(file.type || "application/octet-stream", bytes);
  const att = await addInsurancePolicyAttachment(postgres, {
    condominiumId: cid,
    policyId,
    bytes,
    mimeType: file.type || "application/octet-stream",
    filename: file.name || "anexo",
    actor,
  });
  return ctx.json({ data: policyAttachmentResponse(att) }, STATUS_CODE.Created);
};

// ─── POST .../insurance/:policyId/confirm ────
// Confirma os dados do OCR; apólice fica em pending_review. validFrom/validTo
// obrigatórios (NOT NULL na BD); capital/coberturas opcionais.
const confirmSchema = z.object({
  validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  validTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  policyNumber: z.string().min(1).max(60),
  insurer: z.string().min(1).max(80),
  coverageAmountCents: z.number().int().min(0).nullable().optional(),
});

export const portalConfirmInsurance = async (ctx: Context, postgres: Postgres) => {
  const actor = requireActor(ctx);
  // Cross-unit IDOR guard: 404 se a policy não pertencer a esta fração.
  const { scope: { cid }, id: policyId } = await loadUnitOwnedEntity({
    ctx,
    paramName: "policyId",
    entityNamePT: "Apólice",
    fetch: ({ cid, unitId, id }, pg) =>
      pg.query((db) =>
        db.query.insurancePolicy.findFirst({
          where: (p, ops) =>
            ops.and(
              ops.eq(p.id, id),
              ops.eq(p.condominiumId, cid),
              ops.eq(p.unitId, unitId),
            ),
        })
      ),
  }, postgres);

  const dto = await dtoValidator(confirmSchema, await ctx.req.json());
  const updated = await confirmInsurancePolicy(postgres, {
    policyId,
    condominiumId: cid,
    validFrom: dto.validFrom,
    validTo: dto.validTo,
    policyNumber: dto.policyNumber,
    insurer: dto.insurer,
    coverageAmountCents: dto.coverageAmountCents ?? undefined,
    actor,
  });
  return ctx.json({ data: formatInsurancePolicyForResponse(updated) });
};

// ─── DELETE .../insurance/:policyId ──────────
// Apaga uma apólice própria não-ativa; `onlyOwnUploader` impede apagar submissões alheias.
export const portalDeleteInsurance = async (ctx: Context, postgres: Postgres) => {
  const actor = requireActor(ctx);
  const { scope: { cid }, id: policyId } = await loadUnitOwnedEntity({
    ctx,
    paramName: "policyId",
    entityNamePT: "Apólice",
    fetch: ({ cid, unitId, id }, pg) =>
      pg.query((db) =>
        db.query.insurancePolicy.findFirst({
          where: (p, ops) =>
            ops.and(
              ops.eq(p.id, id),
              ops.eq(p.condominiumId, cid),
              ops.eq(p.unitId, unitId),
            ),
        })
      ),
  }, postgres);

  await deleteInsurancePolicy(postgres, {
    policyId,
    condominiumId: cid,
    gate: { isAdmin: false, userId: actor.user_id ?? "" },
    actor,
  });
  return new Response(null, { status: STATUS_CODE.NoContent });
};

// ─── GET /v1/portal/c/:cid/units/:unitId/insurance/:policyId/pdf ─────────
// Serve o primeiro attachment da apólice (compat com link "PDF" existente).
export const portalServeInsurancePdf = async (ctx: Context, postgres: Postgres) => {
  const { entity: policy, scope: { cid } } = await loadUnitOwnedEntity({
    ctx,
    paramName: "policyId",
    entityNamePT: "Apólice",
    fetch: ({ cid, unitId, id }, pg) =>
      pg.query((db) =>
        db.query.insurancePolicy.findFirst({
          where: (p, ops) =>
            ops.and(
              ops.eq(p.id, id),
              ops.eq(p.condominiumId, cid),
              ops.eq(p.unitId, unitId),
            ),
        })
      ),
  }, postgres);
  return await servePolicyAttachment(postgres, {
    condominiumId: cid,
    policyId: policy.id,
  });
};
