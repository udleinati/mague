// Elegibilidade de reenvio de convite ao portal (ADR 0032), pure functions.
// Aritmética delegada no primitivo `cooldown`, partilhado com cobrança e seguro.
// Consumido pelo API (enforcement no envio) e pelo Panel (UI do botão).

import { cooldown, cooldownEndsAt } from "$shared/time/cooldown.ts";

/** Cooldown entre 2 convites ao mesmo user, a contar do `created_at` do convite
 *  mais recente. Anti-spam: reenviar já invalida tokens anteriores, logo a
 *  janela é independente do TTL do token. ADR 0032. */
export const INVITE_RESEND_COOLDOWN_DAYS = 7;

/** `lastInvitedAt` null = nunca convidado (fora de cooldown). */
export function isInInviteResendCooldown(
  lastInvitedAt: Date | string | null,
  today: Date,
): boolean {
  return cooldown(lastInvitedAt, INVITE_RESEND_COOLDOWN_DAYS, today).active;
}

/** Fim do cooldown (= `lastInvitedAt` + janela) para a UI; null se nunca convidado/inválido. */
export function inviteCooldownEndsAt(lastInvitedAt: Date | string | null): Date | null {
  return cooldownEndsAt(lastInvitedAt, INVITE_RESEND_COOLDOWN_DAYS);
}
