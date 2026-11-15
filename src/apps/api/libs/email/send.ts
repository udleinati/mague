// sendEmail - orchestrator fino: chama transport, escreve log best-effort,
// propaga erros do transport. Lógica dividida em `transport.ts`, `log.ts`,
// `templates.ts`; estes são re-exportados aqui por compat (50+ callers).

import { getEmailTransport, sanitizeEmailAddress, stripCRLF } from "./transport.ts";
import { type EmailCategory, recordEmailSent } from "./log.ts";
import { htmlToText } from "./html_to_text.ts";
import type { Postgres } from "$api/libs/postgres/postgres.ts";

// Re-exports - callers existentes importam estes daqui.
export {
  assemblyConvocationEmailHtml,
  billingReminderEmailHtml,
  insuranceAdminEvidenceEmailHtml,
  insuranceReminderEmailHtml,
  insuranceRenewalEvidenceEmailHtml,
  inviteEmailHtml,
  receiptIssuedEmailHtml,
  resetPasswordEmailHtml,
  ticketActivityEmailHtml,
  ticketCreatedEmailHtml,
} from "./templates.ts";
export type { BillingReminderEmailLine, BillingReminderEmailPlan } from "./templates.ts";
export type { EmailCategory } from "./log.ts";
export type { EmailMessage, EmailTransport } from "./transport.ts";

// Carrega `bcc_email` + `reply_to_email` do condomínio. Exposto para loops bulk
// poderem partilhar 1 lookup (passando o resultado a `sendEmail` via bcc/replyTo);
// para email isolado, `sendEmail` resolve internamente.
export async function loadCondominiumEmailConfig(
  postgres: Postgres,
  condominiumId: string,
): Promise<{ bcc: string | null; replyTo: string | null }> {
  const row = await postgres.query((db) =>
    db.query.condominium.findFirst({
      where: (c, ops) => ops.eq(c.id, condominiumId),
      columns: { bccEmail: true, replyToEmail: true },
    })
  );
  return {
    bcc: row?.bccEmail ?? null,
    replyTo: row?.replyToEmail ?? null,
  };
}

export interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
  /** Texto plano alternativo. Se omitido, é gerado a partir do html. */
  text?: string;
  category: EmailCategory;
  /** BCC adicional (tipicamente `condominium.bcc_email`). Ignorado em password_reset. */
  bcc?: string | null;
  /**
   * Reply-To header (tipicamente `condominium.reply_to_email`). Ignorado em
   * password_reset por segurança (atacante não deve poder redirecionar
   * respostas a um reset email para outro endereço).
   */
  replyTo?: string | null;
  /** Tenant para o audit log. */
  condominiumId?: string | null;
  /** Fração para o audit log quando aplicável. */
  unitId?: string | null;
  /** Ocupante destinatário para o audit log - chave estável (vs `to` mutável). */
  occupantId?: string | null;
  /** Postgres injectado para escrever em audit.email_log. Sem isto, sem log. */
  postgres?: import("$api/libs/postgres/postgres.ts").Postgres | null;
  /** Actor snapshot ({id, email, ip, user_agent?, request_id?}). */
  actor?: import("$api/libs/postgres/schemas/_audit.ts").ActorSnapshot | null;
  attachments?: Array<{
    filename: string;
    content: Uint8Array;
    contentType?: string;
  }>;
}

// Envia email + (opcionalmente) regista em audit.email_log. Atira em falha
// do transport; o log é best-effort. BCC/Reply-To resolvem do condo quando
// `undefined`; `null` suprime; valor explícito usa-se sem DB. password_reset
// força ambos a null (segurança). Ver `resolveEmailHeaders`.
export async function sendEmail(params: SendEmailParams): Promise<void> {
  const safeSubject = stripCRLF(params.subject);
  const safeTo = sanitizeEmailAddress(params.to);
  if (!safeTo) {
    throw new Error("sendEmail: campo `to` vazio ou inválido");
  }
  const headers = await resolveEmailHeaders(params);
  const useBcc = headers.bcc;
  const useReplyTo = headers.replyTo;

  // Sempre incluir text/plain alternativo, senão Gmail marca como spam.
  const text = params.text ?? htmlToText(params.html);

  let sendError: Error | null = null;
  try {
    await getEmailTransport().send({
      to: safeTo,
      subject: safeSubject,
      html: params.html,
      text,
      bcc: useBcc,
      replyTo: useReplyTo,
      attachments: params.attachments,
    });
  } catch (e) {
    sendError = e as Error;
  }

  if (params.postgres) {
    await recordEmailSent(params.postgres, {
      category: params.category,
      recipient: safeTo,
      subject: safeSubject,
      bcc: useBcc,
      condominiumId: params.condominiumId ?? null,
      unitId: params.unitId ?? null,
      occupantId: params.occupantId ?? null,
      actor: params.actor ?? null,
      status: sendError ? "failed" : "sent",
      error: sendError?.message ?? null,
      bodyHtml: params.html,
      // Só nome + tipo dos anexos (não o conteúdo).
      attachments: params.attachments?.map((a) => ({
        filename: a.filename,
        contentType: a.contentType ?? null,
      })) ?? null,
    });
  }

  if (sendError) throw sendError;
}

// Resolve os headers Bcc e Reply-To finais; só faz I/O (DB) quando precisa
// de auto-resolver do condomínio.
async function resolveEmailHeaders(
  params: SendEmailParams,
): Promise<{ bcc: string | null; replyTo: string | null }> {
  // System emails (password_reset) nunca carregam config do condomínio.
  if (params.category === "password_reset") {
    return { bcc: null, replyTo: null };
  }

  const explicitBcc = params.bcc !== undefined;
  const explicitReplyTo = params.replyTo !== undefined;

  // Caller passou ambos explicitamente - não há razão para tocar na DB.
  let cfg: { bcc: string | null; replyTo: string | null } | null = null;
  if (
    (!explicitBcc || !explicitReplyTo) &&
    params.condominiumId &&
    params.postgres
  ) {
    cfg = await loadCondominiumEmailConfig(params.postgres, params.condominiumId);
  }

  const bccSrc = explicitBcc ? params.bcc : cfg?.bcc ?? null;
  const replyToSrc = explicitReplyTo ? params.replyTo : cfg?.replyTo ?? null;

  return {
    bcc: bccSrc ? sanitizeEmailAddress(bccSrc) ?? null : null,
    replyTo: replyToSrc ? sanitizeEmailAddress(replyToSrc) ?? null : null,
  };
}
