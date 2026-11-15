// Elegibilidade de REENVIO da convocatória (ADR 0032), pure functions irmãs de
// `invite_eligibility` e dos lembretes de seguro/cobrança.
//
// Cooldown POR PESSOA (não por fração): um condómino com várias frações recebe
// 1 só convocatória. O "último envio por pessoa" deriva do scan dos runs
// `core.assembly_convocation` (recipients `status == "sent"`) - ver
// `convocation_history.ts`. Aritmética delegada no primitivo `cooldown`.
// Consumido pelo API (enforcement + skip no bulk) e pela UI do botão.

import { cooldown, cooldownEndsAt } from "$shared/time/cooldown.ts";

/** Cooldown entre 2 envios ao mesmo destinatário. 1 dia: a convocatória sai
 *  pontualmente (não é recorrente), a janela só trava duplo-clique/reenvio
 *  impulsivo. ADR 0032. */
export const CONVOCATION_COOLDOWN_DAYS = 1;

/** `lastSentAt` null = nunca enviada (fora de cooldown). */
export function isInConvocationCooldown(
  lastSentAt: Date | string | null,
  now: Date,
): boolean {
  return cooldown(lastSentAt, CONVOCATION_COOLDOWN_DAYS, now).active;
}

/** Fim do cooldown (= `lastSentAt` + janela) para a UI; null se nunca enviada/inválida. */
export function convocationCooldownEndsAt(
  lastSentAt: Date | string | null,
): Date | null {
  return cooldownEndsAt(lastSentAt, CONVOCATION_COOLDOWN_DAYS);
}
