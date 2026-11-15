// Handlers do envio da convocatória (bulk + individual). Guard partilhado: envio bloqueado
// em `draft` -> 422 CONVOCATION_DRAFT (cobre no-JS, duplo-submit, corridas). O individual
// acrescenta o cooldown por pessoa (ADR 0032) em `sendConvocationIndividual`.

import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import type { Postgres } from "$api/libs/postgres/postgres.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { requireCondoAdmin } from "$api/libs/shared/require_condo_admin.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { requireActor } from "$api/middleware/api_auth.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { canSendConvocation, meetingDateReached } from "$shared/assembly/lifecycle.ts";
import { loadConvocationContext } from "./convocation_pdf.ts";
import { sendConvocationBulk, sendConvocationIndividual } from "./convocation_send.ts";

/** Carrega o contexto e impõe o guard de estado (não-`draft`). Partilhado pelos
 *  dois handlers de envio. Lança 422 CONVOCATION_DRAFT em rascunho. */
async function loadSendableContext(postgres: Postgres, cid: string, assemblyId: string) {
  const context = await loadConvocationContext(postgres, { condominiumId: cid, assemblyId });
  if (!canSendConvocation(context.assembly.status as string)) {
    throw new AppError({
      message:
        "Convoca a assembleia antes de enviar a convocatória (em rascunho o envio está bloqueado).",
      statusCode: STATUS_CODE.UnprocessableEntity,
      code: "CONVOCATION_DRAFT",
    });
  }
  // A convocatória notifica ANTES da reunião: chegada a data agendada deixa de fazer
  // sentido enviar/reenviar. Guard cobre no-JS, duplo-submit e pedidos forjados.
  if (meetingDateReached(context.assembly.scheduledAt as string | Date | null | undefined)) {
    throw new AppError({
      message: "A reunião já decorreu - não é possível enviar a convocatória.",
      statusCode: STATUS_CODE.UnprocessableEntity,
      code: "CONVOCATION_MEETING_PASSED",
    });
  }
  return context;
}

// POST /v1/admin/condominiums/:cid/assemblies/:assemblyId/convocation/send
export const sendAssemblyConvocation = async (ctx: Context, postgres: Postgres) => {
  const cid = requireCondominiumId(ctx);
  requireCondoAdmin(ctx, { action: "enviar a convocatória da assembleia" });
  const actor = requireActor(ctx);
  const assemblyId = requireParam(ctx, "assemblyId");

  const context = await loadSendableContext(postgres, cid, assemblyId);

  const { safePanelBaseUrl } = await import("$api/libs/shared/panel_base_url.ts");
  const panelBaseUrl = safePanelBaseUrl(ctx);

  const result = await sendConvocationBulk(postgres, {
    context,
    condominiumId: cid,
    assemblyId,
    trigger: "bulk",
    actor,
    panelBaseUrl,
  });
  return ctx.json({ data: result });
};

// POST .../convocation/send/:occupantId/:unitId - reenvio individual por (pessoa, fração)
// (ADR 0034). Cooldown 24h em `sendConvocationIndividual`: 422 COOLDOWN_ACTIVE/NO_EMAIL, 404.
export const sendAssemblyConvocationIndividual = async (ctx: Context, postgres: Postgres) => {
  const cid = requireCondominiumId(ctx);
  requireCondoAdmin(ctx, { action: "reenviar a convocatória a um condómino" });
  const actor = requireActor(ctx);
  const assemblyId = requireParam(ctx, "assemblyId");
  const occupantId = requireParam(ctx, "occupantId");
  const unitId = requireParam(ctx, "unitId");

  const context = await loadSendableContext(postgres, cid, assemblyId);

  const { safePanelBaseUrl } = await import("$api/libs/shared/panel_base_url.ts");
  const panelBaseUrl = safePanelBaseUrl(ctx);

  const result = await sendConvocationIndividual(postgres, {
    context,
    condominiumId: cid,
    assemblyId,
    occupantId,
    unitId,
    actor,
    panelBaseUrl,
  });
  return ctx.json({ data: result });
};
