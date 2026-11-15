// Handlers HTTP thin sobre os módulos do subdomínio. Confirm NÃO existe aqui:
// ADR 0016 reserva ao portal o comprovativo da fração. Admin tem approve,
// reject, reminder, renew e criar de raiz (os dois com o documento que lhe foi
// entregue), edit (só pending_review), delete.

import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { z } from "zod";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { requireCondoAdmin } from "$api/libs/shared/require_condo_admin.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { requireActor } from "$api/middleware/api_auth.ts";
import { dtoValidator } from "$api/libs/shared/dto_validator.ts";
import { assertUserCanAccessUnit } from "$api/libs/shared/assert_ownership.ts";
import { servePolicyAttachment } from "./attachments.ts";
import { validateAttachmentMime } from "$api/libs/shared/validate_attachment.ts";
import { env } from "$config/env.ts";
import {
  approveInsurancePolicy,
  rejectInsurancePolicy,
  renewInsurancePolicy,
  reopenInsurancePolicy,
  undoRenewalInsurancePolicy,
} from "./state.ts";
import { deleteInsurancePolicy, editInsurancePolicyDetails } from "./edit.ts";
import { requireCoverageDates, uploadInsurancePolicy } from "./upload.ts";
import { listUnitsStatus } from "./read_model.ts";
import { sendReminderForUnit } from "./reminder.ts";
import {
  isInReminderCooldown,
  REMINDER_COOLDOWN_DAYS,
  type ReminderTrigger,
  reminderTriggerFor,
  unitUpdateAction,
} from "$shared/insurance/policy_status.ts";
import {
  insuranceReminderHtmlFor,
  insuranceReminderSubject,
  loadInsuranceReminderNote,
  resolveReminderRecipients,
  sendAdminEvidenceNotice,
} from "./_reminder.ts";
import {
  formatInsurancePolicyForResponse,
  formatInsurancePolicyWithCapabilities,
} from "./_projection.ts";

const MAX_UPLOAD_SIZE = env.upload.maxFileSizeBytes;

// ─── GET /v1/admin/c/:cid/insurance/units-status ─────────────────────────────
// ?unitId=X filtra server-side (evita response de MBs em condos grandes).
export const listUnitsStatusHandler = async (ctx: Context, postgres: Postgres) => {
  const cid = requireCondominiumId(ctx);
  if (!cid) return;
  const unitId = ctx.req.query("unitId") || undefined;
  const data = await listUnitsStatus(postgres, cid, { unitId });
  return ctx.json({ data });
};

// ─── GET /v1/admin/c/:cid/insurance ─ (lista flat de policies) ───────────────
export const listPoliciesHandler = async (ctx: Context, postgres: Postgres) => {
  const cid = requireCondominiumId(ctx);
  if (!cid) return;
  const status = ctx.req.query("status");
  const unitId = ctx.req.query("unitId");

  const r = await postgres.query((db) =>
    db.query.insurancePolicy.findMany({
      where: (p, ops) => {
        const conds = [ops.eq(p.condominiumId, cid)];
        if (status) conds.push(ops.eq(p.status, status));
        if (unitId) conds.push(ops.eq(p.unitId, unitId));
        return ops.and(...conds);
      },
      orderBy: (p, ops) => [ops.desc(p.createdAt)],
      limit: 200,
    })
  );
  // Projeta `kind`/`can` como as outras superfícies: sem eles o histórico da
  // fração relia o `status` cru e mentia (uma `superseded` lia-se "Rejeitada",
  // e um documento do admin lia-se "Por confirmar" - ADR 0016).
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return ctx.json({
    data: r.map((p) => formatInsurancePolicyWithCapabilities(p, today, { isAdmin: true })),
  });
};

// ─── GET /v1/admin/c/:cid/insurance/:id ──────────────────────────────────────
export const retrievePolicyHandler = async (ctx: Context, postgres: Postgres) => {
  const cid = requireCondominiumId(ctx);
  if (!cid) return;
  const id = ctx.req.param("policyId");
  const r = await postgres.query((db) =>
    db.query.insurancePolicy.findFirst({
      where: (p, ops) => ops.and(ops.eq(p.id, id!), ops.eq(p.condominiumId, cid)),
    })
  );
  const policy = findEntityOrFail(r, "Apólice");
  return ctx.json({ data: formatInsurancePolicyForResponse(policy) });
};

// ─── POST /v1/admin/c/:cid/insurance/:id/approve (admin only) ────────────────
export const approvePolicyHandler = async (ctx: Context, postgres: Postgres) => {
  const cid = requireCondominiumId(ctx);
  requireCondoAdmin(ctx, { action: "aprovar apólices" });
  const actor = requireActor(ctx);
  const policyId = ctx.req.param("policyId") ?? "";
  const updated = await approveInsurancePolicy(postgres, {
    policyId,
    condominiumId: cid,
    actor,
  });

  // Aviso à fração, best-effort e só no documento entregue à administração: é
  // a pessoa afetada a ficar a saber de um registo que não passou por ela. No
  // caminho do portal foi ela que submeteu - avisá-la seria contar-lhe o que
  // acabou de fazer. Aqui e não na criação: só se notifica o que ficou firme.
  if (updated.evidenceSource === "admin") {
    try {
      const { safePanelBaseUrl } = await import("$api/libs/shared/panel_base_url.ts");
      await sendAdminEvidenceNotice(postgres, {
        condominiumId: cid,
        unitId: updated.unitId,
        panelBaseUrl: safePanelBaseUrl(ctx),
        policy: updated,
        actor,
      });
    } catch (_e) {
      // best-effort: tipicamente "sem occupant com email".
    }
  }
  return ctx.json({ data: formatInsurancePolicyForResponse(updated) });
};

// ─── POST /v1/admin/c/:cid/insurance/:id/reject (admin only) ─────────────────
const rejectSchema = z.object({ reason: z.string().min(3).max(500) });

export const rejectPolicyHandler = async (ctx: Context, postgres: Postgres) => {
  const cid = requireCondominiumId(ctx);
  requireCondoAdmin(ctx, { action: "rejeitar apólices" });
  const actor = requireActor(ctx);
  const policyId = ctx.req.param("policyId") ?? "";

  const dto = await dtoValidator(rejectSchema, await ctx.req.json());

  const updated = await rejectInsurancePolicy(postgres, {
    policyId,
    condominiumId: cid,
    reason: dto.reason,
    actor,
  });
  return ctx.json({ data: formatInsurancePolicyForResponse(updated) });
};

// Endpoints PATCH /auto-renew e /coverage-amount removidos. Consolidados
// em PATCH /v1/admin/c/:cid/insurance/:policyId (editPolicyHandler abaixo).

// ─── POST /v1/admin/c/:cid/insurance/:id/reopen (admin only) ─────────────────
// Volta active/rejected → pending_review. Permite corrigir aprovação ou
// rejeição errada sem perder o registo da policy.
export const reopenPolicyHandler = async (ctx: Context, postgres: Postgres) => {
  const cid = requireCondominiumId(ctx);
  requireCondoAdmin(ctx, { action: "reabrir apólices" });
  const actor = requireActor(ctx);
  const policyId = ctx.req.param("policyId") ?? "";
  const updated = await reopenInsurancePolicy(postgres, {
    policyId,
    condominiumId: cid,
    actor,
  });
  return ctx.json({ data: formatInsurancePolicyForResponse(updated) });
};

// ─── POST /v1/admin/c/:cid/insurance/:id/renew (admin only) ──────────────────
// Dois caminhos no mesmo endpoint: JSON vazio cria a vigência presumida +
// supersede da anterior (ADR 0016); multipart traz o documento que a fração
// entregou à administração e a vigência decidida no modal.
export const renewPolicyHandler = async (ctx: Context, postgres: Postgres) => {
  const cid = requireCondominiumId(ctx);
  requireCondoAdmin(ctx, { action: "renovar apólices" });
  const actor = requireActor(ctx);
  const policyId = ctx.req.param("policyId") ?? "";
  const documented = await readPolicyDocument(ctx);
  const renewed = await renewInsurancePolicy(postgres, {
    policyId,
    condominiumId: cid,
    actor,
    attachment: documented?.attachment,
    dates: documented?.dates,
    details: documented?.details,
  });

  // Email best-effort: pede o comprovativo da renovação ao condómino. Falha de
  // envio (ou fração sem occupant com email) não reverte a renovação nem devolve
  // erro - a evidência é cortesia, não pré-requisito. Com documento não se pede
  // nada: seria pedir à fração o papel que o admin acabou de registar.
  if (!documented) {
    try {
      const { safePanelBaseUrl } = await import("$api/libs/shared/panel_base_url.ts");
      await sendReminderForUnit(postgres, {
        condominiumId: cid,
        unitId: renewed.unitId,
        trigger: "renewal_evidence",
        actor,
        panelBaseUrl: safePanelBaseUrl(ctx),
      });
    } catch (_e) {
      // best-effort: ignora (tipicamente "sem occupant com email").
    }
  }
  return ctx.json({ data: formatInsurancePolicyForResponse(renewed) }, STATUS_CODE.Created);
};

// O documento entregue à administração e a vigência decidida no formulário.
// `null` quando o pedido não é multipart - no renew é o caminho presumido de
// sempre, no create é recusa. Tamanho e magic bytes validam-se aqui, antes de
// existir linha na BD.
const readPolicyDocument = async (ctx: Context) => {
  if (!(ctx.req.header("content-type") ?? "").includes("multipart/form-data")) return null;
  const form = await ctx.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    throw new AppError({
      message: "Campo `file` em falta no multipart",
      statusCode: STATUS_CODE.BadRequest,
      code: "VALIDATION_ERROR",
    });
  }
  if (file.size > MAX_UPLOAD_SIZE) {
    throw new AppError({
      message: `Ficheiro muito grande (max ${MAX_UPLOAD_SIZE / 1024 / 1024} MB)`,
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
  return {
    attachment: { bytes, mimeType, filename: file.name || "apolice" },
    dates: {
      validFrom: String(form.get("validFrom") ?? ""),
      validTo: String(form.get("validTo") ?? ""),
    },
    // Campo ausente herda o da anterior; presente e vazio no capital apaga-o.
    details: {
      policyNumber: text("policyNumber"),
      insurer: text("insurer"),
      coverageAmountCents: cents === null
        ? undefined
        : String(cents).trim() === ""
        ? null
        : Number(String(cents)),
    },
  };
};

// ─── POST /v1/admin/c/:cid/units/:unitId/insurance (admin only) ──────────────
// Regista de raiz o documento que a fração entregou à administração fora do
// portal, sem apólice anterior de onde renovar. O documento é obrigatório: sem
// predecessor não há continuidade de onde presumir a vigência, e registá-la sem
// prova seria invenção. Nasce em `pending_review` (o admin revê o que o OCR
// extraiu) e não substitui apólice nenhuma - `renewed_from_id` fica NULL.
// Só quando `unitUpdateAction` diz "register" - o mesmo gate do botão da lista.
export const createUnitPolicyHandler = async (ctx: Context, postgres: Postgres) => {
  const cid = requireCondominiumId(ctx);
  requireCondoAdmin(ctx, { action: "registar apólices" });
  const actor = requireActor(ctx);
  const unitId = requireParam(ctx, "unitId");

  const existing = await postgres.query((db) =>
    db.query.insurancePolicy.findMany({
      where: (p, ops) => ops.and(ops.eq(p.condominiumId, cid), ops.eq(p.unitId, unitId)),
      columns: { status: true, validTo: true },
    })
  );
  const action = unitUpdateAction(existing, new Date());
  if (action.kind !== "register") {
    throw new AppError({
      message: action.kind === "review"
        ? "Esta fração tem uma apólice por rever. Aprova, rejeita ou elimina essa primeiro."
        : "Esta fração tem uma apólice que ainda se pode renovar. Renova-a em vez de registar outra.",
      statusCode: STATUS_CODE.Conflict,
      code: "INVALID_STATE",
    });
  }

  const documented = await readPolicyDocument(ctx);
  if (!documented) {
    throw new AppError({
      message: "Anexa o documento da apólice - sem ele não há o que registar.",
      statusCode: STATUS_CODE.BadRequest,
      code: "VALIDATION_ERROR",
    });
  }
  const policy = await uploadInsurancePolicy(postgres, {
    condominiumId: cid,
    unitId,
    bytes: documented.attachment.bytes,
    mimeType: documented.attachment.mimeType,
    actor,
    evidenceSource: "admin",
    dates: requireCoverageDates(documented.dates),
  });
  return ctx.json({ data: formatInsurancePolicyForResponse(policy) }, STATUS_CODE.Created);
};

// ─── POST /v1/admin/c/:cid/insurance/:id/undo-renewal (admin only) ───────────
// Desfaz uma renovação por engano: apaga a presumida e devolve o predecessor a
// `active`. Devolve a apólice restaurada.
export const undoRenewalHandler = async (ctx: Context, postgres: Postgres) => {
  const cid = requireCondominiumId(ctx);
  requireCondoAdmin(ctx, { action: "desfazer renovações de apólices" });
  const actor = requireActor(ctx);
  const policyId = ctx.req.param("policyId") ?? "";
  const restored = await undoRenewalInsurancePolicy(postgres, {
    policyId,
    condominiumId: cid,
    actor,
  });
  return ctx.json({ data: formatInsurancePolicyForResponse(restored) });
};

// ─── PATCH /v1/admin/c/:cid/insurance/:id (admin only, pending_review) ───────
// E2 do grilling: edit só em `pending_review`. Active/rejected/superseded são
// imutáveis - admin tem de rejeitar antes para corrigir typos.
const editSchema = z.object({
  validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  validTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  policyNumber: z.string().min(1).max(60).optional(),
  insurer: z.string().min(1).max(80).optional(),
  coverageAmountCents: z.number().int().min(0).nullable().optional(),
}).refine(
  // validTo > validFrom só quando ambos enviados; um-lado-só usa o valor da BD
  // e não comparamos aqui (caso edge "novo cruza antigo" passa).
  (v) => !v.validFrom || !v.validTo || v.validTo > v.validFrom,
  { message: "validTo deve ser posterior a validFrom", path: ["validTo"] },
);

export const editPolicyHandler = async (ctx: Context, postgres: Postgres) => {
  const cid = requireCondominiumId(ctx);
  requireCondoAdmin(ctx, { action: "editar apólices" });
  const actor = requireActor(ctx);
  const policyId = ctx.req.param("policyId") ?? "";
  const dto = await dtoValidator(editSchema, await ctx.req.json());
  const updated = await editInsurancePolicyDetails(postgres, {
    policyId,
    condominiumId: cid,
    fields: dto,
    actor,
  });
  return ctx.json({ data: formatInsurancePolicyForResponse(updated) });
};

// ─── DELETE /v1/admin/c/:cid/insurance/:id ───────────────────────────────────
export const deletePolicyHandler = async (ctx: Context, postgres: Postgres) => {
  const cid = requireCondominiumId(ctx);
  requireCondoAdmin(ctx, { action: "apagar apólices" });
  const actor = requireActor(ctx);
  const policyId = ctx.req.param("policyId") ?? "";
  // Admin apaga tudo exceto cobertura viva saudável (active/expiring_soon, que
  // exigem rejeitar primeiro); vencidas/substituídas/rejeitadas/por-rever ok. A
  // UI exige typed-match "ELIMINAR" para confirmação deliberada (ADR 0040).
  await deleteInsurancePolicy(postgres, {
    policyId,
    condominiumId: cid,
    actor,
    gate: { isAdmin: true },
  });
  return new Response(null, { status: STATUS_CODE.NoContent });
};

// ─── GET /v1/admin/c/:cid/insurance/:id/attachments/:attachmentId ────────────
// Serve bytes de um attachment específico - usado pela UI admin (lightbox)
// com multi-file. Anti-IDOR via 3-way lookup (policy.cid + entity_type).
export const serveInsuranceAttachmentHandler = async (
  ctx: Context,
  postgres: Postgres,
) => {
  const cid = requireCondominiumId(ctx);
  if (!cid) return;
  const policyId = ctx.req.param("policyId");
  const attachmentId = ctx.req.param("attachmentId") ?? "";
  const r = await postgres.query((db) =>
    db.query.insurancePolicy.findFirst({
      where: (p, ops) => ops.and(ops.eq(p.id, policyId!), ops.eq(p.condominiumId, cid)),
    })
  );
  const policy = findEntityOrFail(r, "Apólice");
  await assertUserCanAccessUnit(ctx, postgres, policy.unitId, cid);

  return await servePolicyAttachment(postgres, {
    condominiumId: cid,
    policyId: policy.id,
    attachmentId,
  });
};

// ─── GET /v1/admin/c/:cid/insurance/:id/pdf ──────────────────────────────────
// Alias de compat: serve o attachment principal (o mais recente). A UI
// multi-ficheiro usa /attachments/:attachmentId; este endpoint mantém o link
// "PDF" histórico a apontar para o ficheiro principal.
export const servePolicyPdfHandler = async (ctx: Context, postgres: Postgres) => {
  const cid = requireCondominiumId(ctx);
  if (!cid) return;
  const policyId = ctx.req.param("policyId");
  const r = await postgres.query((db) =>
    db.query.insurancePolicy.findFirst({
      where: (p, ops) => ops.and(ops.eq(p.id, policyId!), ops.eq(p.condominiumId, cid)),
    })
  );
  const policy = findEntityOrFail(r, "Apólice");
  // Anti-IDOR para occupants: só vê se for da sua unit.
  await assertUserCanAccessUnit(ctx, postgres, policy.unitId, cid);

  // Sem `attachmentId`: serve o principal (ver `servePolicyAttachment`).
  return await servePolicyAttachment(postgres, {
    condominiumId: cid,
    policyId: policy.id,
  });
};

// ─── POST /v1/admin/c/:cid/insurance/reminders/:unitId (admin only) ──────────
export const sendReminderHandler = async (ctx: Context, postgres: Postgres) => {
  const cid = requireCondominiumId(ctx);
  requireCondoAdmin(ctx, { action: "enviar lembretes de seguro" });
  const actor = requireActor(ctx);
  const unitId = ctx.req.param("unitId") ?? "";
  if (!unitId) return;

  // O assunto vem do estado da fração, não do cliente: sem cobertura viva é
  // "falta o seguro"; coberta mas com renovação presumida é "falta o
  // comprovativo". Sem nada em falta mantém-se o lembrete normal - o admin pode
  // sempre insistir manualmente.
  const [unitStatus] = await listUnitsStatus(postgres, cid, { unitId });
  const trigger = (unitStatus && reminderTriggerFor(unitStatus)) ?? "individual";

  // Guard cooldown (ADR 0032) na família do trigger: bloqueia reenvio manual na
  // janela. O 422 cobre no-JS, duplo-submit e corridas. O bulk salta sem 422.
  const lastOfFamily = trigger === "renewal_evidence"
    ? unitStatus?.lastRenewalEvidenceAt
    : unitStatus?.lastReminderAt;
  if (unitStatus && isInReminderCooldown(lastOfFamily ?? null, new Date())) {
    throw new AppError({
      message:
        `Lembrete já enviado nos últimos ${REMINDER_COOLDOWN_DAYS} dias. Aguarda antes de re-enviar.`,
      statusCode: STATUS_CODE.UnprocessableEntity,
      code: "COOLDOWN_ACTIVE",
    });
  }

  const { safePanelBaseUrl } = await import("$api/libs/shared/panel_base_url.ts");
  const panelBaseUrl = safePanelBaseUrl(ctx);

  const r = await sendReminderForUnit(postgres, {
    condominiumId: cid,
    unitId,
    trigger,
    actor,
    panelBaseUrl,
  });
  return ctx.json({ data: r });
};

// ─── GET /v1/admin/c/:cid/insurance/reminders/:unitId/preview (admin only) ───
// Read-only: gera o mesmo HTML que o envio (com a nota gravada), sem enviar nem
// registar. NÃO valida cooldown (é só um render). Atira MISSING_EMAIL (422) se
// a fração não tem occupant elegível - o botão "Ver" já vem desativado nesse caso.
export const previewReminderHandler = async (ctx: Context, postgres: Postgres) => {
  const cid = requireCondominiumId(ctx);
  requireCondoAdmin(ctx, { action: "pré-visualizar lembrete de seguro" });
  const unitId = ctx.req.param("unitId") ?? "";
  if (!unitId) return;

  // Identidade do 1º destinatário elegível - mesma resolução do envio.
  const recipients = await resolveReminderRecipients(postgres, { condominiumId: cid, unitId });
  const r = recipients[0];
  const adminNote = await loadInsuranceReminderNote(postgres, cid);
  // Mesmo trigger que o envio escolheria - senão a pré-visualização mostra o
  // email errado à fração que só precisa do comprovativo.
  const [unitStatus] = await listUnitsStatus(postgres, cid, { unitId });
  const trigger = (unitStatus && reminderTriggerFor(unitStatus)) ?? "individual";

  const { safePanelBaseUrl } = await import("$api/libs/shared/panel_base_url.ts");
  const portalUrl = `${safePanelBaseUrl(ctx)}/portal/c/${cid}/u/${unitId}/insurances`;

  const html = insuranceReminderHtmlFor(trigger, {
    recipientName: r.name,
    condominiumName: r.condoName,
    designationType: r.condoDesignationType,
    unitDesignation: r.unitLabel,
    portalUrl,
    adminNote: adminNote ?? undefined,
  });
  const subject = insuranceReminderSubject(trigger, {
    condoName: r.condoName,
    unitLabel: r.unitLabel,
  });
  return ctx.json({ data: { html, subject } });
};

// ─── POST /v1/admin/c/:cid/insurance/reminders ─ (bulk: para todos sem seguro) ─
export const sendBulkRemindersHandler = async (ctx: Context, postgres: Postgres) => {
  const cid = requireCondominiumId(ctx);
  requireCondoAdmin(ctx, { action: "enviar lembretes de seguro em bulk" });
  const actor = requireActor(ctx);
  const { safePanelBaseUrl } = await import("$api/libs/shared/panel_base_url.ts");
  const panelBaseUrl = safePanelBaseUrl(ctx);

  const all = await listUnitsStatus(postgres, cid);
  const now = new Date();
  // Um trigger por fração, pelo mesmo predicado do botão individual: falta o
  // seguro (agregado sem cobertura viva) ou falta só o comprovativo de uma
  // renovação presumida. O agregado importa - fração com active + pending já
  // está coberta e não leva email; a policy "selected" diria o contrário.
  // Cada família tem o seu cooldown (a data que a view expõe em separado).
  const candidates = all
    .map((u) => ({ u, trigger: reminderTriggerFor(u) }))
    .filter((c): c is { u: typeof all[number]; trigger: ReminderTrigger } => c.trigger !== null)
    .map((c) => ({
      ...c,
      lastOfFamily: c.trigger === "renewal_evidence"
        ? c.u.lastRenewalEvidenceAt
        : c.u.lastReminderAt,
    }));
  const targets = candidates.filter((c) => !isInReminderCooldown(c.lastOfFamily, now));
  const inCooldown = candidates.filter((c) => isInReminderCooldown(c.lastOfFamily, now));

  let sent = 0, failed = 0;
  const perUnit: Array<
    { unitId: string; designation: string; sent: number; failed: number; skipped?: string }
  > = [];
  const skippedNoEmail: string[] = [];
  const skippedCooldown: string[] = inCooldown.map((c) => c.u.unit.designation);
  for (const { u: t, trigger } of targets) {
    try {
      const r = await sendReminderForUnit(postgres, {
        condominiumId: cid,
        unitId: t.unit.id,
        // 'bulk' e 'individual' são o mesmo email; só o audit distingue a origem.
        trigger: trigger === "individual" ? "bulk" : trigger,
        actor,
        panelBaseUrl,
      });
      sent += r.sent;
      failed += r.failed;
      perUnit.push({
        unitId: t.unit.id,
        designation: t.unit.designation,
        sent: r.sent,
        failed: r.failed,
      });
    } catch (e) {
      // Tipicamente "sem occupant com email" - em bulk não falhamos toda
      // a operação por causa disso, apenas registamos quais foram saltadas.
      skippedNoEmail.push(t.unit.designation);
      perUnit.push({
        unitId: t.unit.id,
        designation: t.unit.designation,
        sent: 0,
        failed: 0,
        skipped: (e as Error).message,
      });
    }
  }

  return ctx.json({
    data: {
      unitsTargeted: targets.length,
      evidenceTargeted: targets.filter((c) => c.trigger === "renewal_evidence").length,
      sent,
      failed,
      perUnit,
      skippedNoEmail,
      skippedCooldown,
      cooldownCount: inCooldown.length,
    },
  });
};
