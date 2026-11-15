// Handlers HTTP do módulo Lembrete de cobrança (ADR 0028).
//
// Endpoints:
//   GET  /v1/admin/condominiums/:cid/billing-reminders/overdue
//     → lista de frações elegíveis (>0 quotas com `due_date < reconciledThroughDate - 30d`).
//        Cada linha: total em dívida, charge mais antiga, lastReminderAt, inCooldown.
//
//   POST /v1/admin/condominiums/:cid/billing-reminders/units/:unitId
//     → dispara envio para 1 fração. Body: { trigger: "individual"|"bulk" }.
//        Valida guard de 3d e cooldown 14d; falha 422 se bloqueado.
//        Bulk = caller chama o POST 1x por fração (como `insurance`).

import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import type { Postgres } from "$api/libs/postgres/postgres.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { requireActor } from "$api/middleware/api_auth.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import {
  canSendBillingReminder,
  isInBillingReminderCooldown,
} from "$shared/billing/reminder_eligibility.ts";
import { computeBillingEmailTotals } from "$shared/billing/overdue.ts";
import {
  findOverdueUnits,
  getLastSuccessfulReminder,
  getReconciledThroughDate,
  loadOverdueChargesForEmail,
} from "./_helpers.ts";
import {
  billingReminderSubject,
  dispatchOneBillingEmail,
  recordBillingReminderRun,
  resolveBillingRecipients,
} from "./_reminder.ts";
import {
  billingReminderEmailHtml,
  type BillingReminderEmailLine,
  type BillingReminderEmailPlan,
} from "$api/libs/email/send.ts";

/** Labels PT-PT por `charge_type` - fallback para charges sem descrição. */
const KIND_LABELS: Record<string, string> = {
  quota: "Quota",
  extraordinary_quota: "Quota extraordinária",
  refacturation: "Refaturação",
  opening_balance_debit: "Saldo inicial em dívida",
  credit_adjustment: "Ajuste",
  credit_balance: "Saldo credor",
  fine: "Multa",
};

// Descrição primeiro (já se explica sozinha) - mesmo racional do
// humanizeChargeLine dos recibos. Tipo traduzido só como fallback.
function formatChargeLabel(kind: string, description: string | null): string {
  if (description) return description;
  return KIND_LABELS[kind] ?? kind;
}

function formatDatePt(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso + "T00:00:00Z");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getUTCFullYear()}`;
}

/** Linhas + totais + IBAN + nota da administração de uma fração. Partilhado
 *  entre o envio e a pré-visualização para o preview ser fiel ao email real. */
async function loadBillingEmailContext(
  postgres: Postgres,
  args: { condominiumId: string; unitId: string; reconciledThroughDate: string },
) {
  const { condominiumId, unitId, reconciledThroughDate } = args;
  const { charges } = await loadOverdueChargesForEmail(postgres, { condominiumId, unitId });
  const totals = computeBillingEmailTotals(charges, reconciledThroughDate);
  const lines: BillingReminderEmailLine[] = totals.lines.map((l) => {
    const orig = charges.find((c) => c.kind === l.kind && c.dueDate === l.dueDate);
    return {
      label: formatChargeLabel(l.kind, orig?.description ?? null),
      dueDate: formatDatePt(l.dueDate),
      amountCents: l.amountCents,
      settledCents: l.settledCents,
      outstandingCents: l.outstandingCents,
    };
  });
  // IBAN da conta `is_quota_payment` (opcional - se cond não tem, omite bloco).
  const iban = await postgres.query((db) =>
    db.query.bankAccount.findFirst({
      where: (b, ops) =>
        ops.and(
          ops.eq(b.condominiumId, condominiumId),
          ops.eq(b.isQuotaPayment, true),
          ops.isNull(b.deletedAt),
        ),
      columns: { iban: true },
    })
  ).then((r) => r?.iban ?? null);
  // Nota livre da administração (topo do email - ADR 0028).
  const adminNote = await postgres.query((db) =>
    db.query.condominium.findFirst({
      where: (cnd, ops) => ops.eq(cnd.id, condominiumId),
      columns: { billingReminderNote: true },
    })
  ).then((r) => r?.billingReminderNote ?? null);
  // Plano ativo muda o email para a variante de plano (ADR 0039).
  // Só a nota partilhada: `internal_notes` nunca se lê aqui, para nunca chegar ao email.
  const paymentPlan: BillingReminderEmailPlan | null = await postgres.query((db) =>
    db.query.paymentPlan.findFirst({
      where: (p, ops) =>
        ops.and(
          ops.eq(p.condominiumId, condominiumId),
          ops.eq(p.unitId, unitId),
          ops.eq(p.status, "active"),
          ops.isNull(p.deletedAt),
        ),
      columns: { notes: true, endDate: true },
    })
  ).then((p) => p ? { notes: p.notes, endDate: p.endDate ? formatDatePt(p.endDate) : null } : null);
  return {
    totalOwedCents: totals.totalOwedCents,
    creditCents: totals.creditCents,
    lines,
    iban,
    adminNote,
    paymentPlan,
  };
}

/** GET /units/:unitId/preview - devolve o HTML do email tal como seria enviado
 *  a esta fração (com a nota atual). Não envia nem regista. Não bloqueia por
 *  cooldown nem por conciliação atrasada (é só um render); só exige que exista
 *  data de conciliação para calcular os totais. */
export const previewBillingReminderHandler = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const unitId = requireParam(ctx, "unitId");

  const reconciledThroughDate = await getReconciledThroughDate(postgres, condominiumId);
  if (!reconciledThroughDate) {
    throw new AppError({
      message: "Condomínio ainda não foi reconciliado - reconcilia antes de pré-visualizar.",
      statusCode: STATUS_CODE.UnprocessableEntity,
      code: "RECONCILIATION_NEVER",
    });
  }

  const { totalOwedCents, creditCents, lines, iban, adminNote, paymentPlan } =
    await loadBillingEmailContext(postgres, { condominiumId, unitId, reconciledThroughDate });
  // Identidade (nome/condo/fração) do 1º destinatário elegível - mesma
  // resolução do envio. Atira MISSING_EMAIL (422) se ninguém qualifica.
  const recipients = await resolveBillingRecipients(postgres, { condominiumId, unitId });
  const r = recipients[0];

  const html = billingReminderEmailHtml({
    recipientName: r.name,
    condominiumName: r.condoName,
    designationType: r.condoDesignationType,
    unitDesignation: r.unitLabel,
    totalOwedCents,
    creditCents,
    iban,
    adminNote: adminNote ?? undefined,
    lines,
    paymentPlan,
  });
  const subject = billingReminderSubject({
    condoName: r.condoName,
    unitLabel: r.unitLabel,
    inPaymentPlan: paymentPlan !== null,
  });

  return ctx.json({ data: { html, subject } });
};

/** GET /overdue - lista frações elegíveis. Resposta inclui também o
 *  estado da conciliação (`reconciledThroughDate`, `guard`) para a UI
 *  mostrar o banner sem fazer query extra. */
export const listOverdueHandler = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const url = new URL(ctx.req.url);
  // Filtros opcionais (ADR 0039): bloco 1/30/60/90 + presença de plano de pagamento.
  const overdueRaw = Number(url.searchParams.get("overdue"));
  const minOverdueDays = [1, 60, 90].includes(overdueRaw) ? overdueRaw : 30;
  const planRaw = url.searchParams.get("plan");
  const plan = planRaw === "with" || planRaw === "without" ? planRaw : "all";
  const [reconciledThroughDate, units] = await Promise.all([
    getReconciledThroughDate(postgres, condominiumId),
    findOverdueUnits(postgres, condominiumId, { minOverdueDays, plan }),
  ]);
  const guard = canSendBillingReminder({ reconciledThroughDate, today: new Date() });
  return ctx.json({
    data: {
      reconciledThroughDate,
      guard,
      units,
    },
  });
};

/** POST /units/:unitId - dispara envio. Falha 422 se guard 3d bloqueia
 *  OU se cooldown 14d ainda ativo. Body opcional: { trigger }. */
export const sendBillingReminderHandler = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const unitId = requireParam(ctx, "unitId");
  const actor = requireActor(ctx);
  const body = ctx.req.header("content-type")?.includes("json")
    ? await ctx.req.json().catch(() => ({}))
    : {};
  const trigger = body?.trigger === "bulk" ? "bulk" : "individual";

  // Guard 1: conciliação fresca?
  const reconciledThroughDate = await getReconciledThroughDate(postgres, condominiumId);
  const guard = canSendBillingReminder({ reconciledThroughDate, today: new Date() });
  if (!guard.ok || !reconciledThroughDate) {
    throw new AppError({
      message: guard.reason === "never_reconciled"
        ? "Condomínio ainda não foi reconciliado - reconcilia antes de enviar lembretes."
        : "Conciliação atrasada (mais de 3 dias). Reconcilia antes de enviar lembretes.",
      statusCode: STATUS_CODE.UnprocessableEntity,
      code: guard.reason === "never_reconciled" ? "RECONCILIATION_NEVER" : "RECONCILIATION_STALE",
    });
  }

  // Guard 2: cooldown 14d?
  const lastSent = await getLastSuccessfulReminder(postgres, { condominiumId, unitId });
  if (lastSent && isInBillingReminderCooldown(lastSent.sentAt, new Date())) {
    throw new AppError({
      message: "Lembrete já enviado nos últimos 14 dias. Aguarda antes de re-enviar.",
      statusCode: STATUS_CODE.UnprocessableEntity,
      code: "COOLDOWN_ACTIVE",
    });
  }

  // Linhas + totais + IBAN + nota (partilhado com a pré-visualização).
  const { totalOwedCents, creditCents, lines, iban, adminNote, paymentPlan } =
    await loadBillingEmailContext(postgres, { condominiumId, unitId, reconciledThroughDate });

  // Resolve recipients e dispara.
  const recipients = await resolveBillingRecipients(postgres, { condominiumId, unitId });
  const results = [];
  for (const r of recipients) {
    results.push(
      await dispatchOneBillingEmail(postgres, {
        recipient: r,
        condominiumId,
        unitId,
        totalOwedCents,
        creditCents,
        iban,
        adminNote,
        lines,
        paymentPlan,
        actor,
      }),
    );
  }
  await recordBillingReminderRun(postgres, {
    condominiumId,
    unitId,
    trigger,
    recipients: results,
    actor,
  });

  const sentCount = results.filter((r) => r.status === "sent").length;
  return ctx.json({
    data: {
      sentCount,
      totalRecipients: results.length,
      recipients: results,
    },
  });
};
