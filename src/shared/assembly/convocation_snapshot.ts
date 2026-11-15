// Snapshot da CONVOCATÓRIA - captura pura do que foi enviado (ordem do dia,
// textos intro/footer, datas das 1ª/2ª convocações). Serve auditoria e o portal
// do condómino, que vê o ÚLTIMO snapshot enviado (não um render ao vivo).
//
// `agendaChangedSinceSend` compara o snapshot ATUAL com o ÚLTIMO enviado para o
// badge "há alterações por enviar". Consumido pelo API e pelo Panel. Sem I/O.

/** Um ponto da ordem do dia, tal como capturado no momento do envio. */
export interface ConvocationSnapshotAgendaItem {
  sequence: number | null;
  subject: string;
  description: string | null;
}

/** O que foi anunciado num envio da convocatória. Datas como ISO strings
 *  (normalizadas) para serem estáveis em JSONB e em comparações futuras. */
export interface ConvocationSnapshot {
  agenda: ConvocationSnapshotAgendaItem[];
  convocationIntro: string | null;
  convocationFooter: string | null;
  scheduledAt: string | null;
  secondConvocationAt: string | null;
}

/** Subset da assembleia necessário para o snapshot (estrutural, não importa
 *  o tipo Drizzle - mantém o módulo puro e desacoplado da camada de dados). */
export interface ConvocationSnapshotAssemblyInput {
  convocationIntro?: string | null;
  convocationFooter?: string | null;
  scheduledAt?: Date | string | null;
  secondConvocationAt?: Date | string | null;
}

/** Subset de uma deliberação (ponto da ordem do dia) para o snapshot. */
export interface ConvocationSnapshotAgendaItemInput {
  sequence?: number | null;
  subject?: string | null;
  description?: string | null;
}

/** Date|string|null -> ISO string|null. Strings assumem-se já ISO. */
function toIso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const s = String(value).trim();
  return s === "" ? null : s;
}

/** Puro. `agendaItems` devem vir já ordenados (sequence asc); a ordem é preservada. */
export function buildConvocationSnapshot(
  assembly: ConvocationSnapshotAssemblyInput,
  agendaItems: ConvocationSnapshotAgendaItemInput[],
): ConvocationSnapshot {
  return {
    agenda: agendaItems.map((d) => ({
      sequence: d.sequence ?? null,
      subject: d.subject ?? "",
      description: d.description ?? null,
    })),
    convocationIntro: assembly.convocationIntro ?? null,
    convocationFooter: assembly.convocationFooter ?? null,
    scheduledAt: toIso(assembly.scheduledAt),
    secondConvocationAt: toIso(assembly.secondConvocationAt),
  };
}

/**
 * Há alterações por (re)enviar? Ordem-sensível: reordenar pontos é alteração.
 *
 * `lastSent === null` (0 runs) -> `false`: sinal de propósito único ("difere do
 * último anunciado"); o estado "ainda não enviada" é sinalizado em separado
 * pelo caller, nunca aqui - evita reportar "alteração" sem nada anunciado.
 */
export function agendaChangedSinceSend(
  current: ConvocationSnapshot,
  lastSent: ConvocationSnapshot | null,
): boolean {
  if (lastSent == null) return false;
  if (current.convocationIntro !== lastSent.convocationIntro) return true;
  if (current.convocationFooter !== lastSent.convocationFooter) return true;
  if (current.scheduledAt !== lastSent.scheduledAt) return true;
  if (current.secondConvocationAt !== lastSent.secondConvocationAt) return true;
  if (current.agenda.length !== lastSent.agenda.length) return true;
  for (let i = 0; i < current.agenda.length; i++) {
    const a = current.agenda[i];
    const b = lastSent.agenda[i];
    if (a.sequence !== b.sequence) return true;
    if (a.subject !== b.subject) return true;
    if (a.description !== b.description) return true;
  }
  return false;
}
