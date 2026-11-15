// Pré-visualização (read-only) do email da convocatória (corpo + assunto), por (pessoa × fração).
// Reusa buildConvocationEmailMeta + planConvocationDispatch + renderConvocationEmailHtml: o
// HTML é o mesmo que o envio produziria. Não envia, não grava run, não renderiza PDF.

import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import type { Postgres } from "$api/libs/postgres/postgres.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { unitLabel } from "$shared/labels/mod.ts";
import { safePanelBaseUrl } from "$api/libs/shared/panel_base_url.ts";
import { loadConvocationContext } from "./convocation_pdf.ts";
import { buildConvocationEmailMeta, renderConvocationEmailHtml } from "./convocation_send.ts";
import { planConvocationDispatch } from "./convocation_dispatch.ts";
import { resolveConvocationRecipients } from "./convocation_recipients.ts";

// GET /v1/admin/condominiums/:cid/assemblies/:assemblyId/convocation/preview/:occupantId/:unitId
// Sem guard de estado/cooldown: pré-visualizar é inócuo (o botão "Ver" no panel só
// aparece quando a tabela de destinatários aparece). Email do destinatário não entra
// no corpo, por isso quem não tem email registado também pode ser pré-visualizado.
export const previewAssemblyConvocationEmail = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const assemblyId = requireParam(ctx, "assemblyId");
  const occupantId = requireParam(ctx, "occupantId");
  const unitId = requireParam(ctx, "unitId");

  const [context, recipients] = await Promise.all([
    loadConvocationContext(postgres, { condominiumId, assemblyId }),
    resolveConvocationRecipients(postgres, { condominiumId }),
  ]);
  const recipient = recipients.find((r) => r.occupantId === occupantId && r.unitId === unitId);
  if (!recipient) {
    throw new AppError({
      message: "Destinatário não encontrado entre os proprietários e residentes do condomínio.",
      statusCode: STATUS_CODE.NotFound,
      code: "RECIPIENT_NOT_FOUND",
    });
  }

  const emailMeta = await buildConvocationEmailMeta(postgres, { context, condominiumId });
  const plan = planConvocationDispatch(recipient, {
    unitLabel: unitLabel({
      id: recipient.unitId,
      designation: recipient.unitDesignation,
      identifier: recipient.unitIdentifier,
    }),
    condominiumName: emailMeta.condominiumName,
    correctionEmail: emailMeta.correctionEmail,
    assemblyType: emailMeta.assemblyType,
    firstConvocation: emailMeta.firstConvocation,
  });
  const portalUrl = `${
    safePanelBaseUrl(ctx)
  }/portal/c/${condominiumId}/u/${recipient.unitId}/assemblies`;

  const html = renderConvocationEmailHtml({ recipient, plan, emailMeta, portalUrl });
  return ctx.json({ data: { html, subject: plan.subject } });
};
