// Máquina de vida da assembleia - fonte de verdade ÚNICA = `status` (sem flag
// "locked" nem "superseded"). Transições manuais e livres; este módulo exprime
// como pure functions QUEM pode mexer em QUÊ por estado + as transições válidas.
//
// O que foi CONVOCADO trava ao passar a `scheduled`; o que ACONTECEU na reunião
// regista-se já convocada e sela em `held`. Ver plano convocatoria-assembleia.
// Consumido pelo API (enforcement) e pelo Panel (gates da UI). Sem I/O.

/** Estados possíveis de `core.assembly.status`. `draft` é o default. */
export type AssemblyLifecycleStatus = "draft" | "scheduled" | "held" | "cancelled";

/** Ordem do dia, textos e dados da convocatória só editáveis em RASCUNHO;
 *  convocar trava-os. Corrigir = "retificar" (voltar a `draft`), explícita. */
export function canEditAgenda(status: string | null | undefined): boolean {
  return status === "draft";
}

/** Registo do que ACONTECEU na reunião (presenças, votos, assinatura, acta)
 *  faz-se já CONVOCADA (`scheduled`); sela ao passar a `held`/`cancelled`. */
export function canRecordMeeting(status: string | null | undefined): boolean {
  return status === "scheduled";
}

/**
 * True quando o DIA da reunião chegou (comparação ao nível do dia, UTC). Gate
 * de UI para revelar a fase de registo; data passada (acta histórica) abre já.
 *
 * NOTA: gate de UI, não de enforcement - a API aceita registo em `scheduled`
 * seja qual for a data, para não bloquear back-fill de actas antigas.
 */
export function meetingDateReached(
  scheduledAt: string | Date | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!scheduledAt) return false;
  const sched = typeof scheduledAt === "string" ? scheduledAt : scheduledAt.toISOString();
  if (sched.length < 10) return false;
  return now.toISOString().slice(0, 10) >= sched.slice(0, 10);
}

/** Enviar/reenviar exige fora de rascunho; em `draft` a convocatória ainda pode mudar. */
export function canSendConvocation(status: string | null | undefined): boolean {
  return status !== "draft";
}

/** Transições válidas: ciclo `draft -> scheduled -> held`, retificação livre
 *  `scheduled -> draft`, `-> cancelled` de qualquer estado vivo (terminal). */
export const ASSEMBLY_TRANSITIONS: Readonly<
  Record<AssemblyLifecycleStatus, readonly AssemblyLifecycleStatus[]>
> = {
  draft: ["scheduled", "cancelled"],
  scheduled: ["draft", "held", "cancelled"],
  held: ["cancelled"],
  cancelled: [],
};

/** true se `from -> to` é uma transição de estado válida (ver ASSEMBLY_TRANSITIONS). */
export function isValidAssemblyTransition(
  from: string | null | undefined,
  to: string | null | undefined,
): boolean {
  if (from == null || to == null) return false;
  const allowed = ASSEMBLY_TRANSITIONS[from as AssemblyLifecycleStatus];
  return allowed ? allowed.includes(to as AssemblyLifecycleStatus) : false;
}
