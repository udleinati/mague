// Elegibilidade de envio de Lembrete de cobrança (ADR 0028), pure functions:
// `canSendBillingReminder` (guard de conciliação fresca, lógica própria) e
// `isInBillingReminderCooldown` (anti-spam, delega no primitivo `cooldown`
// partilhado, ADR 0032). Consumido pelo API (envio) e pelo Panel (botão/banner).

import { cooldown, cooldownEndsAt } from "$shared/time/cooldown.ts";

/** Janela tolerada entre HOJE e a última `reconciled_through_date` antes
 *  do envio ser bloqueado. ADR 0028 decisão 2. */
export const RECONCILIATION_GUARD_DAYS = 3;

/** Cooldown entre 2 envios consecutivos para a mesma fração. Conta a
 *  partir do `sent_at` do último envio em que pelo menos 1 recipient
 *  recebeu (`status='sent'`). Tentativas todo-falhas não contam. */
export const BILLING_REMINDER_COOLDOWN_DAYS = 14;

/** Threshold em dias para considerar uma quota "em atraso > 30 dias",
 *  medido a partir de `condominium.reconciled_through_date - charge.due_date`. */
export const OVERDUE_THRESHOLD_DAYS = 30;

export type BillingReminderBlockReason = "never_reconciled" | "reconciliation_stale";

export interface BillingReminderEligibility {
  ok: boolean;
  reason?: BillingReminderBlockReason;
}

/** Decide se pode disparar lembretes agora, pelo estado da conciliação. */
export function canSendBillingReminder(args: {
  reconciledThroughDate: string | null;
  today: Date;
}): BillingReminderEligibility {
  if (args.reconciledThroughDate === null) {
    return { ok: false, reason: "never_reconciled" };
  }
  // Diff em dias completos UTC; acima do guard = stale.
  const ref = new Date(args.reconciledThroughDate + "T00:00:00Z");
  const todayUtc = new Date(Date.UTC(
    args.today.getUTCFullYear(),
    args.today.getUTCMonth(),
    args.today.getUTCDate(),
  ));
  const diffDays = Math.floor((todayUtc.getTime() - ref.getTime()) / 86_400_000);
  if (diffDays > RECONCILIATION_GUARD_DAYS) {
    return { ok: false, reason: "reconciliation_stale" };
  }
  return { ok: true };
}

/** `lastSentAt` = último `billing_reminder.sent_at` com >=1 recipient `sent`;
 *  null = nunca enviou (fora de cooldown). */
export function isInBillingReminderCooldown(
  lastSentAt: Date | string | null,
  today: Date,
): boolean {
  return cooldown(lastSentAt, BILLING_REMINDER_COOLDOWN_DAYS, today).active;
}

/** Fim do cooldown (= `lastSentAt` + janela) para a UI; null se nunca enviou/inválido. */
export function billingReminderCooldownEndsAt(
  lastSentAt: Date | string | null,
): Date | null {
  return cooldownEndsAt(lastSentAt, BILLING_REMINDER_COOLDOWN_DAYS);
}
