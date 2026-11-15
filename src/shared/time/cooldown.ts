// Primitivo de janela temporal partilhado (ADR 0032): concentra a aritmética
// "este timestamp está dentro de N dias a contar de agora?" que convite,
// cobrança e seguro replicavam (com irmãos a divergir entre Date e number).
// Cada domínio mantém o seu nome/constante por cima (seam fino).
//
// Pure. Sem `new Date()` interno - o caller passa `now` (testável; o `now` do
// enforcement coincide com o do display quando partilham a chamada).

const DAY_MS = 86_400_000;

export interface CooldownState {
  /** true enquanto a janela está aberta (`now < endsAt`). */
  active: boolean;
  /** instante em que a janela fecha (`lastAt + windowDays`); null se nunca
   *  houve evento ou a data é inválida. */
  endsAt: Date | null;
  /** ms até fechar; 0 se já fechou ou nunca houve evento. */
  remainingMs: number;
}

function parseInstant(at: Date | string | null): Date | null {
  if (at === null) return null;
  const d = typeof at === "string" ? new Date(at) : at;
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Fim da janela (`lastAt + windowDays`), independente de "agora"; null se lastAt null/inválido. */
export function cooldownEndsAt(
  lastAt: Date | string | null,
  windowDays: number,
): Date | null {
  const last = parseInstant(lastAt);
  if (last === null) return null;
  return new Date(last.getTime() + windowDays * DAY_MS);
}

/** Estado do cooldown avaliado em `now`; sem evento -> `{ false, null, 0 }`. */
export function cooldown(
  lastAt: Date | string | null,
  windowDays: number,
  now: Date,
): CooldownState {
  const endsAt = cooldownEndsAt(lastAt, windowDays);
  if (endsAt === null) return { active: false, endsAt: null, remainingMs: 0 };
  const remainingMs = Math.max(0, endsAt.getTime() - now.getTime());
  return { active: remainingMs > 0, endsAt, remainingMs };
}
