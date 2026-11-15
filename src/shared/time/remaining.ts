// formatRemaining - frase PT-PT do tempo que falta. Pure, usada nos badges de
// cooldown via filtro Vento. Granularidade dias -> horas -> minutos, com `floor`
// (nunca sobre-estima); o instante exacto vai à parte (tooltip).

const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Frase "faltam N dias/horas/minutos" até `until`; "" se null/inválido/passado. */
export function formatRemaining(until: Date | string | null, now: Date): string {
  if (until == null) return "";
  const end = typeof until === "string" ? new Date(until) : until;
  if (Number.isNaN(end.getTime())) return "";

  const ms = end.getTime() - now.getTime();
  if (ms <= 0) return "";

  const days = Math.floor(ms / DAY_MS);
  if (days >= 1) return days === 1 ? "falta 1 dia" : `faltam ${days} dias`;

  const hours = Math.floor(ms / HOUR_MS);
  if (hours >= 1) return hours === 1 ? "falta 1 hora" : `faltam ${hours} horas`;

  const minutes = Math.floor(ms / MIN_MS);
  if (minutes >= 1) return minutes === 1 ? "falta 1 minuto" : `faltam ${minutes} minutos`;

  return "falta menos de 1 minuto";
}
