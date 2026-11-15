// Classificação do estado de uma apólice de seguro face a uma data. Pura
// (sem DB/HTTP/S3), genérica sobre o tipo da policy. O caller escolhe a
// antecedência via `opts.expiringSoonDays`, das duas constantes nomeadas abaixo.
// O cooldown do reminder delega no primitivo `cooldown` partilhado (ADR 0032).

import { cooldown, cooldownEndsAt } from "$shared/time/cooldown.ts";

/** Shape mínimo para classificar uma policy. `createdAt` é opcional, usado só
 *  por `selectPolicyForDisplay` como tiebreaker quando `validTo` empata. */
export interface ClassifiablePolicy {
  status: string;
  validTo?: string | Date | null;
  confirmedAt?: string | Date | null;
  createdAt?: string | Date | null;
  /** Espelha `core.insurance_policy.evidence_source`. */
  evidenceSource?: "unit" | "admin" | null;
}

/** Discriminated union do estado computado de uma policy face a uma fração. */
export type UnitInsuranceStatus<P extends ClassifiablePolicy = ClassifiablePolicy> =
  | { kind: "active"; policy: P; daysUntilExpiry: number }
  | { kind: "expiring_soon"; policy: P; daysUntilExpiry: number }
  | { kind: "expired"; policy: P; daysOverdue: number }
  | { kind: "awaiting_confirmation"; policy: P } // condómino tem que confirmar dados
  | { kind: "awaiting_approval"; policy: P } // admin tem que aprovar
  | { kind: "rejected_only"; policy: P }
  | { kind: "superseded"; policy: P } // substituída por nova vigência (R2)
  | { kind: "never_submitted" };

/**
 * Antecedência com que a ADMINISTRAÇÃO vê "a expirar" (KPI, badge, filtro).
 * Maior que a do condómino: quem persegue o documento precisa de ver o problema
 * antes de quem o tem de arranjar.
 */
export const ADMIN_NOTICE_DAYS = 30;

/**
 * Antecedência com que o CONDÓMINO vê "a expirar" no portal. Divergência
 * intencional face a `ADMIN_NOTICE_DAYS`: o portal só alerta quando a
 * renovação é mesmo urgente.
 */
export const OCCUPANT_NOTICE_DAYS = 15;

export interface ClassifyOptions {
  /**
   * Quantos dias antes de `validTo` é que o estado vira `expiring_soon`.
   * Default `ADMIN_NOTICE_DAYS`; superfícies do portal passam
   * `OCCUPANT_NOTICE_DAYS`. Nunca um número literal no call site.
   */
  expiringSoonDays?: number;
}

export function classifyPolicy<P extends ClassifiablePolicy>(
  p: P | null,
  today: Date,
  opts: ClassifyOptions = {},
): UnitInsuranceStatus<P> {
  const expiringSoonDays = opts.expiringSoonDays ?? ADMIN_NOTICE_DAYS;
  if (!p) return { kind: "never_submitted" };
  if (p.status === "rejected") return { kind: "rejected_only", policy: p };
  if (p.status === "superseded") return { kind: "superseded", policy: p };
  if (p.status === "pending_review") {
    // Documento entregue à administração não espera confirmação da fração (ver
    // ADR 0016): quem age é o admin. Sem isto o upload do próprio
    // admin lia-se "aguarda condómino" e a UI nunca lhe oferecia o aprovar.
    if (p.evidenceSource === "admin") return { kind: "awaiting_approval", policy: p };
    return p.confirmedAt
      ? { kind: "awaiting_approval", policy: p }
      : { kind: "awaiting_confirmation", policy: p };
  }
  // active
  if (!p.validTo) return { kind: "expired", policy: p, daysOverdue: 999 };
  const validToDate = p.validTo instanceof Date
    ? p.validTo
    : new Date(`${String(p.validTo)}T00:00:00Z`);
  const diffMs = validToDate.getTime() - today.getTime();
  const days = Math.ceil(diffMs / 86_400_000);
  if (days < 0) return { kind: "expired", policy: p, daysOverdue: -days };
  if (days <= expiringSoonDays) {
    return { kind: "expiring_soon", policy: p, daysUntilExpiry: days };
  }
  return { kind: "active", policy: p, daysUntilExpiry: days };
}

// Soma 1 ano a uma data ISO, preservando dia/mês (29 fev -> 28 fev em não-bissexto).
export function addOneYear(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const next = new Date(Date.UTC(y + 1, (m ?? 1) - 1, d ?? 1));
  if (next.getUTCMonth() !== (m ?? 1) - 1) {
    // Bumped to next month (e.g. 29 fev → 1 mar) - recua um dia.
    next.setUTCDate(0);
  }
  return next.toISOString().slice(0, 10);
}

/**
 * A fração precisa de lembrete? Recebe o `kind` AGREGADO da fração (não o da
 * policy selecionada): com uma active e uma pending, o agregado é "active" e não
 * há nada a lembrar - o selected diria "awaiting_approval" e mandava email a
 * quem já está coberto. Fonte única do bulk, do badge e do botão.
 */
export function needsReminder(kind: AggregateKind): boolean {
  return kind === "expired" || kind === "expiring_soon" ||
    kind === "never_submitted" || kind === "rejected_only";
}

/** Famílias de email de seguro. `bulk` é o mesmo assunto que `individual`, só
 *  muda a origem, por isso não entra nesta decisão. */
export type ReminderTrigger = "individual" | "renewal_evidence";

/**
 * Que assunto tem esta fração, ou `null` se não há nada a pedir. Duas coisas
 * diferentes podem faltar: o seguro (sem cobertura viva) ou só o comprovativo
 * de uma renovação presumida (a fração está coberta). Copy, cooldown e botão
 * derivam daqui - se divergissem, o admin pedia o documento a quem não tem
 * seguro nenhum.
 */
export function reminderTriggerFor(
  unit: { aggregate: AggregateKind; presumedEvidenceDays: number | null },
): ReminderTrigger | null {
  if (needsReminder(unit.aggregate)) return "individual";
  return unit.presumedEvidenceDays !== null ? "renewal_evidence" : null;
}

// ─── Gates de ação (predicados puros, ADR 0040) ───────────────────────────────
//
// Decisões de negócio para renovar/anexar/eliminar. Handlers ficam finos: chamam
// o predicado e lançam o erro de domínio quando devolve falso. O discriminador de
// "vencida" é SEMPRE classifyPolicy (validTo vs hoje), nunca o status cru - uma
// apólice vencida tem status = "active" na BD.

/** Janela de renovação presumida de uma vencida: até 1 ano de atraso. Acima
 *  disto a continuidade nasceria já vencida - submeter apólice nova de raiz. */
export const RENEW_MAX_OVERDUE_DAYS = 365;

/** Renovável: ativa/a-expirar, ou vencida há <= RENEW_MAX_OVERDUE_DAYS dias. */
export function canRenew<P extends ClassifiablePolicy>(policy: P, today: Date): boolean {
  const s = classifyPolicy(policy, today);
  if (s.kind === "active" || s.kind === "expiring_soon") return true;
  if (s.kind === "expired") return s.daysOverdue <= RENEW_MAX_OVERDUE_DAYS;
  return false;
}

/** Anexar ficheiros: bloqueado em vencida/substituída (registo morto - renovar). */
export function canAddAttachment<P extends ClassifiablePolicy>(policy: P, today: Date): boolean {
  const s = classifyPolicy(policy, today);
  return s.kind !== "expired" && s.kind !== "superseded";
}

/** Remover ficheiros: condómino só na submissão por confirmar e na rejeitada;
 *  admin sem restrição. Impede despir a evidência de uma apólice já aprovada. */
export function canRemoveAttachment<P extends ClassifiablePolicy>(
  policy: P,
  today: Date,
  opts: { isAdmin: boolean },
): boolean {
  if (opts.isAdmin) return true;
  const s = classifyPolicy(policy, today);
  return s.kind === "awaiting_confirmation" || s.kind === "rejected_only";
}

export interface DeletePolicyContext {
  /** true para admin/super do condomínio; false para o portal (condómino). */
  isAdmin: boolean;
  /** Portal: true se o ator é o uploader da apólice. Ignorado para admin. */
  isOwnUpload?: boolean;
}

/** Eliminar apólice. Portal: só a própria submissão por confirmar (pending_review
 *  + confirmedAt IS NULL). Admin: tudo exceto cobertura viva saudável
 *  (active/expiring_soon), que exige rejeitar primeiro. */
export function canDeletePolicy<P extends ClassifiablePolicy>(
  policy: P,
  today: Date,
  ctx: DeletePolicyContext,
): boolean {
  const s = classifyPolicy(policy, today);
  if (ctx.isAdmin) return s.kind !== "active" && s.kind !== "expiring_soon";
  if (!ctx.isOwnUpload) return false;
  return s.kind === "awaiting_confirmation";
}

/** Reabrir -> pending_review (recovery de aprovação/rejeição errada). Status cru
 *  de propósito: uma vencida continua `active` na BD e é reabrível; `superseded`
 *  é histórico e `pending_review` já lá está. */
export function canReopen<P extends ClassifiablePolicy>(policy: P): boolean {
  return policy.status === "active" || policy.status === "rejected";
}

/** Mexer nos campos da apólice: só em `pending_review` (ADR 0016). Serve o edit
 *  do admin e o confirm do condómino - a mesma janela de mutabilidade. */
export function canEditPolicy<P extends ClassifiablePolicy>(policy: P): boolean {
  return policy.status === "pending_review";
}

/** Rejeitar: `pending_review` (fluxo normal do ADR 0016) ou `active` - é o
 *  "rejeitar primeiro" que o ADR 0040 exige antes de apagar cobertura viva.
 *  Já rejeitada não se rejeita outra vez; `superseded` é histórico e fechado.
 *  Status cru de propósito, como `canReopen`: uma vencida continua `active` na
 *  BD e tem de continuar rejeitável. */
export function canRejectPolicy<P extends ClassifiablePolicy>(policy: P): boolean {
  return policy.status === "pending_review" || policy.status === "active";
}

export type ApproveRefusal = "not_pending" | "unconfirmed";

/**
 * Porque é que esta apólice não pode ser aprovada; `null` = pode. Mesma forma
 * que `undoRenewalRefusal`. Existe porque a discriminação
 * `pending_review`/`confirmedAt`/`evidenceSource` estava escrita à mão dentro do
 * handler de approve, em paralelo com a de `classifyPolicy` - duas cópias da
 * mesma regra, uma delas sem teste em tabela.
 */
export function approveRefusal<P extends ClassifiablePolicy>(policy: P): ApproveRefusal | null {
  if (policy.status !== "pending_review") return "not_pending";
  // Documento entregue à administração não espera confirmação da fração: não há
  // segundo interveniente (ADR 0016).
  if (policy.evidenceSource !== "admin" && !policy.confirmedAt) return "unconfirmed";
  return null;
}

// ─── Renovação presumida: desfazer e perseguir a evidência ───────────────────
//
// O `renew` do admin cria sempre uma apólice presumida sem evidência - ninguém
// viu o documento novo (ADR 0016). Daí os dois seguimentos: desfazer enquanto
// não há comprovativo, e perseguir o comprovativo enquanto ele falta.

/** Campos que a renovação precisa além do classificador. `attachmentCount`
 *  desconhecido conta como "tem evidência" - os gates são conservadores. */
export interface RenewalPolicy extends ClassifiablePolicy {
  presumedAt?: string | Date | null;
  renewedFromId?: string | null;
  attachmentCount?: number;
}

export type UndoRenewalRefusal =
  | "not_a_renewal"
  | "not_presumed"
  | "not_current"
  | "has_evidence";

/**
 * Porque é que a renovação desta apólice não pode ser desfeita; `null` = pode.
 * Só a última renovação, ainda presumida e sem comprovativo: com evidência
 * anexada o undo apagava o documento, e uma já substituída partia a cadeia.
 * `status` cru de propósito - uma renovação vencida continua desfazível (o
 * predecessor está tão vencido como ela).
 */
export function undoRenewalRefusal<P extends RenewalPolicy>(policy: P): UndoRenewalRefusal | null {
  if (!policy.renewedFromId) return "not_a_renewal";
  if (!policy.presumedAt) return "not_presumed";
  if (policy.status !== "active") return "not_current";
  if (policy.attachmentCount !== 0) return "has_evidence";
  return null;
}

export function canUndoRenewal<P extends RenewalPolicy>(policy: P): boolean {
  return undoRenewalRefusal(policy) === null;
}

/** A partir de quantos dias uma presunção sem comprovativo passa a estar em falta. */
export const PRESUMED_EVIDENCE_GRACE_DAYS = 30;

/**
 * Renovação presumida ainda sem comprovativo, e há quantos dias. `null` quando
 * não se aplica (sem presunção, com evidência, contagem desconhecida, ou registo
 * já substituído/rejeitado). Fonte única do KPI, do filtro, do badge e dos alvos
 * do bulk `renewal_evidence`.
 */
export function presumedEvidenceGap<P extends RenewalPolicy>(
  policy: P,
  today: Date,
): { days: number; overdue: boolean } | null {
  if (policy.status !== "active" || !policy.presumedAt) return null;
  if (policy.attachmentCount !== 0) return null;
  const since = policy.presumedAt instanceof Date
    ? policy.presumedAt
    : new Date(String(policy.presumedAt));
  if (isNaN(since.getTime())) return null;
  const days = Math.max(0, Math.floor((today.getTime() - since.getTime()) / 86_400_000));
  return { days, overdue: days > PRESUMED_EVIDENCE_GRACE_DAYS };
}

// ─── Origem da evidência ─────────────────────────────────────────────────────
//
// `presumedEvidenceGap` trata qualquer anexo como evidência - é o que cala o
// pedido automático. Só esta marca distingue o documento entregue à
// administração fora do portal (ADR 0016).

/** Documento entregue à administração, não comprovativo submetido pela fração.
 *  Sem contagem de anexos (o portal não a projeta) devolve falso: não se afirma
 *  o que não se sabe. */
export function isAdminDocumented<P extends RenewalPolicy>(policy: P): boolean {
  return policy.evidenceSource === "admin" && (policy.attachmentCount ?? 0) > 0;
}

/** Gates de ação prontos para a UI: os templates consultam `can.*` em vez de
 *  reimplementarem as regras com constantes à mão. */
export interface PolicyCapabilities {
  renew: boolean;
  /** A fração renova submetendo o recibo; o admin renova presumindo. Mesmo
   *  predicado, caminhos com autoridades diferentes - daí serem exclusivos
   *  (ADR 0016). */
  submitRenewal: boolean;
  undoRenewal: boolean;
  reopen: boolean;
  edit: boolean;
  delete: boolean;
  addAttachment: boolean;
  removeAttachment: boolean;
}

export function policyCapabilities<P extends RenewalPolicy>(
  policy: P,
  today: Date,
  ctx: DeletePolicyContext,
): PolicyCapabilities {
  return {
    // Desfazer e reabrir são autoridade da administração (ADR 0016); renovar
    // deixou de o ser, mas o caminho difere consoante quem pede.
    renew: ctx.isAdmin && canRenew(policy, today),
    submitRenewal: !ctx.isAdmin && canRenew(policy, today),
    undoRenewal: ctx.isAdmin && canUndoRenewal(policy),
    reopen: ctx.isAdmin && canReopen(policy),
    edit: canEditPolicy(policy),
    delete: canDeletePolicy(policy, today, ctx),
    addAttachment: canAddAttachment(policy, today),
    removeAttachment: canRemoveAttachment(policy, today, { isAdmin: ctx.isAdmin }),
  };
}

// ─── "Atualizar" a partir da lista de seguros (admin) ────────────────────────

/** O que o botão "Atualizar" da fração faz. `renew` leva a apólice a renovar. */
export type UnitUpdateAction<P> =
  | { kind: "review" }
  | { kind: "renew"; policy: P }
  | { kind: "register" };

/** Por rever primeiro (renovar por cima dá 409, registar duplicava); depois renovar,
 *  que preserva a linhagem (ADR 0040); só sem nada disso se regista de raiz - sem
 *  submissão, rejeitada ou vencida há mais de `RENEW_MAX_OVERDUE_DAYS`. */
export function unitUpdateAction<P extends ClassifiablePolicy>(
  policies: ReadonlyArray<P>,
  today: Date,
): UnitUpdateAction<P> {
  if (policies.some((p) => p.status === "pending_review")) return { kind: "review" };
  const renewable = policies.filter((p) => canRenew(p, today));
  const policy = selectPolicyForDisplay(renewable);
  return policy ? { kind: "renew", policy } : { kind: "register" };
}

// ─── Agregação de status quando há múltiplas apólices na fração ──────────────
//
// Computa o ESTADO AGREGADO da fração (active + pending_review -> active: tem
// cobertura agora), distinto de selectPolicyForDisplay, que escolhe uma policy
// para apresentar dados detalhados.

export type AggregateKind = UnitInsuranceStatus["kind"];

/** Prioridade do "melhor estado": cobertura válida > submissão em curso > falha. */
const AGGREGATE_PRIORITY: AggregateKind[] = [
  "active",
  "expiring_soon",
  "awaiting_approval",
  "awaiting_confirmation",
  "expired",
  "rejected_only",
  "never_submitted",
];

/** Devolve o `kind` de maior prioridade presente; vazio -> `never_submitted`. */
export function computeAggregateStatus(
  classified: ReadonlyArray<UnitInsuranceStatus>,
): AggregateKind {
  if (classified.length === 0) return "never_submitted";
  const present = new Set(classified.map((c) => c.kind));
  for (const k of AGGREGATE_PRIORITY) {
    if (present.has(k)) return k;
  }
  return "never_submitted";
}

/**
 * Estado agregado da fração JUNTO com a apólice que o justifica. Fonte única
 * para admin e portal (ADR 0017): devolver só o `kind` deixava cada lado
 * escolher a policy à sua maneira, e o badge acabava a contradizer as datas
 * apresentadas ao lado. Desempate dentro do mesmo `kind`: `selectPolicyForDisplay`.
 */
export function aggregateUnitStatus<P extends ClassifiablePolicy>(
  classified: ReadonlyArray<UnitInsuranceStatus<P>>,
): UnitInsuranceStatus<P> {
  const kind = computeAggregateStatus(classified);
  const matching = classified.filter(
    (c): c is Extract<UnitInsuranceStatus<P>, { policy: P }> => c.kind === kind && "policy" in c,
  );
  if (matching.length === 0) return { kind: "never_submitted" };
  if (matching.length === 1) return matching[0];
  const best = selectPolicyForDisplay(matching.map((m) => m.policy));
  return matching.find((m) => m.policy === best) ?? matching[0];
}

// ─── Reminder cool-down ──────────────────────────────────────────────────────
//
// 14 dias contra spam de lembretes sobre a mesma fração. O reenvio manual TAMBÉM
// está sujeito ao cooldown (paridade com cobrança/convite, ADR 0032): individual
// devolve 422 COOLDOWN_ACTIVE; o bulk salta. Badge e enforcement derivam de
// `isInReminderCooldown` + `lastReminderAt`.

export const REMINDER_COOLDOWN_DAYS = 14;

export function isInReminderCooldown(
  lastReminderAt: Date | string | null,
  now: Date = new Date(),
): boolean {
  return cooldown(lastReminderAt ?? null, REMINDER_COOLDOWN_DAYS, now).active;
}

/** Fim do cooldown (= `lastReminderAt` + janela) para a UI; null se nunca houve
 *  reminder/inválido. Mesmo shape que billing/invite (ADR 0032). */
export function insuranceReminderCooldownEndsAt(
  lastReminderAt: Date | string | null,
): Date | null {
  return cooldownEndsAt(lastReminderAt ?? null, REMINDER_COOLDOWN_DAYS);
}

// ─── Seleção da policy "atual" da fração ──────────────────────────────────
//
// Qual policy domina a vista admin quando há várias (renovação: active +
// pending)? Regra pura em TS (antes era SQL na view, não testável, escondia uma
// `pending_review` sob uma `active` - admin nunca via a renovação). A view expõe
// TODAS as policies e o caller chama esta função antes de classificar.

const STATUS_PRIORITY: Record<string, number> = {
  pending_review: 0, // requer ação do admin
  active: 1,
  rejected: 2,
};

/** epoch ms; NULL -> -Infinity (vai para o fim quando ordenado descendente). */
function timeOf(value: string | Date | null | undefined): number {
  if (value === null || value === undefined) return -Infinity;
  if (value instanceof Date) return value.getTime();
  const parsed = new Date(value);
  return isNaN(parsed.getTime()) ? -Infinity : parsed.getTime();
}

/** Escolhe a policy a apresentar: status priority, depois `valid_to DESC`,
 *  depois `createdAt DESC`. null quando vazio (fração nunca submeteu). */
export function selectPolicyForDisplay<P extends ClassifiablePolicy>(
  policies: ReadonlyArray<P>,
): P | null {
  if (policies.length === 0) return null;
  const sorted = [...policies].sort((a, b) => {
    const pa = STATUS_PRIORITY[a.status] ?? 99;
    const pb = STATUS_PRIORITY[b.status] ?? 99;
    if (pa !== pb) return pa - pb;
    const va = timeOf(a.validTo);
    const vb = timeOf(b.validTo);
    if (va !== vb) return vb - va; // valid_to DESC
    return timeOf(b.createdAt) - timeOf(a.createdAt);
  });
  return sorted[0];
}
