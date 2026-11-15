// Builder puro que transforma as rows do `/insurance/units-status` no estado da
// página de seguros. Separado do fetching para tipar `InsuranceUnitRow` (uma
// fonte de verdade) e ser testável sem mockar o Client.

import { noDefault, resolveYearFilterFrom, yearsInRange } from "$shared/year_filter/mod.ts";
import {
  addOneYear,
  ADMIN_NOTICE_DAYS,
  type AggregateKind,
  insuranceReminderCooldownEndsAt,
  isInReminderCooldown,
  REMINDER_COOLDOWN_DAYS,
  type ReminderTrigger,
  reminderTriggerFor,
} from "$shared/insurance/policy_status.ts";

/** Valor do `?status=` que filtra renovações presumidas sem comprovativo. Não é
 *  um `kind` - vive à parte para o template e o filtro não o escreverem à mão. */
export const PRESUMED_PENDING_FILTER = "presumed_pending";

/** Idem para o documento entregue à administração fora do portal: também
 *  atravessa os agregados (a fração pode estar ativa, a expirar, etc.). */
export const ADMIN_DOCUMENTED_FILTER = "admin_documented";

/** Entradas de `policies` de uma row da view, como os filtros as leem. */
export type PolicyEntries = ReadonlyArray<
  { policy?: { validFrom?: string; validTo?: string } | unknown }
>;

/** O mínimo que os filtros precisam de ver numa row da lista. */
export interface FilterableUnitRow {
  aggregate?: string;
  status: { kind: string };
  presumedEvidenceDays: number | null;
  policies?: PolicyEntries;
}

/** O que o builder inteiro lê. O resto passa intacto para o template. */
export interface InsuranceUnitRow extends FilterableUnitRow {
  lastReminderAt: Date | string | null;
  lastRenewalEvidenceAt: Date | string | null;
}

/** O agregado é a verdade da row; `status.kind` é o fallback das rows antigas.
 *  Numa função só - a regra estava escrita nos dois sítios que a liam. */
const aggregateOf = (row: FilterableUnitRow): AggregateKind =>
  (row.aggregate ?? row.status.kind) as AggregateKind;

/**
 * Anos em que a fração teve (ou terá) cobertura: a união das vigências das suas
 * apólices. Numa lista de seguros é isto que "ano" quer dizer - com a data de
 * submissão, em janeiro um upload novo escondia todas as frações cuja apólice
 * tinha sido entregue no ano anterior mas continuava em vigor (B6).
 */
export function coveredYears(policies: PolicyEntries): number[] {
  const years = policies.flatMap((p) => {
    const pol = p.policy as { validFrom?: string; validTo?: string } | undefined;
    return yearsInRange(pol?.validFrom, pol?.validTo);
  });
  return [...new Set(years)].sort((a, b) => b - a);
}

/**
 * A fração tem algum documento registado pela administração? Lê o
 * `adminDocumented` que a API já computa (`isAdminDocumented`) - o filtro não
 * recompõe a regra a partir de `evidenceSource` + contagem de anexos.
 */
function hasAdminDocumented(policies: PolicyEntries): boolean {
  return policies.some((p) =>
    (p.policy as { adminDocumented?: boolean } | undefined)?.adminDocumented === true
  );
}

/**
 * Anos da dropdown + ano filtrado. Os anos saem da VIGÊNCIA (`coveredYears`), e
 * o default é "Todos": os KPI do topo são globais e as abas de estado preservam
 * o ano, por isso um ano pré-selecionado punha "Vencidos: 3" sobre uma tabela
 * vazia - a vencida no ano passado não cobre o ano corrente (B6).
 */
export function resolveInsuranceYearFilter(
  rows: ReadonlyArray<{ policies?: PolicyEntries }>,
  param: string | null | undefined,
): { availableYears: number[]; filterYear: number | null } {
  const availableYears = [...new Set(rows.flatMap((r) => coveredYears(r.policies ?? [])))]
    .sort((a, b) => b - a);
  return resolveYearFilterFrom({
    items: rows,
    availableYears,
    param,
    defaultStrategy: noDefault(),
  });
}

/**
 * A fração passa os filtros da lista? Estado pelo AGREGADO (a UI mostra um badge
 * por fração), ano pela VIGÊNCIA (ver `coveredYears`). A fração sem apólice
 * atravessa o ano - senão o filtro escondia justamente quem nunca submeteu.
 */
export function matchesInsuranceFilters(
  row: FilterableUnitRow,
  filters: { year: number | null; status: string | null },
): boolean {
  // `presumed_pending` e `admin_documented` atravessam os estados agregados (uma
  // presumida está "Ativa"); são as entradas do filtro que não são um `kind`.
  if (filters.status === PRESUMED_PENDING_FILTER) {
    if (row.presumedEvidenceDays === null) return false;
  } else if (filters.status === ADMIN_DOCUMENTED_FILTER) {
    if (!hasAdminDocumented(row.policies ?? [])) return false;
  } else if (filters.status && aggregateOf(row) !== filters.status) return false;
  if (filters.year !== null && (row.policies ?? []).length > 0) {
    if (!coveredYears(row.policies ?? []).includes(filters.year)) return false;
  }
  return true;
}

/**
 * Enriquece uma row com o trigger e o cooldown que lhe correspondem (ADR 0032):
 * `reminderTrigger` decide se há botão e que legenda leva, `inCooldown`
 * desactiva-o e `cooldownUntil` (ISO) alimenta o tooltip. Mesmas pure functions
 * que os gates no API - o botão e o enforcement não divergem, e o template
 * deixa de reimplementar "que frações é que precisam de email".
 */
export function withCooldown<T extends InsuranceUnitRow>(row: T, now: Date) {
  const reminderTrigger = reminderTriggerFor({
    aggregate: aggregateOf(row),
    presumedEvidenceDays: row.presumedEvidenceDays,
  });
  const lastOfFamily = reminderTrigger === "renewal_evidence"
    ? row.lastRenewalEvidenceAt
    : row.lastReminderAt;
  return {
    ...row,
    reminderTrigger,
    inCooldown: isInReminderCooldown(lastOfFamily, now),
    cooldownUntil: insuranceReminderCooldownEndsAt(lastOfFamily)?.toISOString() ?? null,
  };
}

/**
 * Vigência que o modal de renovação pré-preenche em cada apólice: a seguinte
 * começa onde a atual acaba (D8). Editável - é o admin que a confere contra o
 * documento. Calculada aqui porque o template não pode chamar `addOneYear`, e
 * reimplementá-la em JS daria duas versões do tratamento do 29 de fevereiro.
 */
export function withRenewalDates<T extends { policies?: PolicyEntries }>(u: T) {
  const entries = (u.policies ?? []) as ReadonlyArray<{ policy?: { validTo?: string } }>;
  return {
    ...u,
    policies: entries.map((e) => {
      const validTo = e.policy?.validTo;
      return validTo ? { ...e, renewFrom: validTo, renewTo: addOneYear(validTo) } : e;
    }),
  };
}

/** Row como o template a recebe: a original mais o que o builder acrescenta. */
export type EnrichedUnitRow<T> =
  & Omit<T, "policies">
  & {
    reminderTrigger: ReminderTrigger | null;
    inCooldown: boolean;
    cooldownUntil: string | null;
    policies: ReadonlyArray<Record<string, unknown>>;
  };

export interface InsuranceListState<T> {
  /** Rows visíveis: filtradas, com cooldown e datas de renovação. */
  units: Array<EnrichedUnitRow<T>>;
  /** Distingue "condomínio sem frações" (empty state global) de "filtros sem
   *  resultados" (mantém layout, tabela vazia). */
  totalUnits: number;
  /** KPI do topo, sempre sobre TUDO (não filtrado). */
  summary: Record<string, number>;
  availableYears: number[];
  filterYear: number | null;
  filterStatus: string | null;
  cooldownCount: number;
  cooldownDays: number;
  noticeDays: number;
  remindableCount: number;
  presumedPendingCount: number;
  presumedPendingFilter: string;
  adminDocumentedFilter: string;
}

export function buildInsuranceListState<T extends InsuranceUnitRow>(
  rows: readonly T[],
  filters: { year?: string | null; status?: string | null },
  now: Date,
): InsuranceListState<T> {
  const { availableYears, filterYear } = resolveInsuranceYearFilter(rows, filters.year);
  const filterStatus = filters.status ?? null;

  // Enriquece uma vez só: o cooldown alimenta as rows visíveis E a contagem
  // global, que antes o recalculava numa segunda passagem sobre tudo.
  const enriched = rows.map((r) => withCooldown(r, now));

  const units = enriched
    .filter((r) => matchesInsuranceFilters(r, { year: filterYear, status: filterStatus }))
    .map(withRenewalDates);

  // Só conta quem tem mesmo alguma coisa a receber - a fração coberta e
  // documentada não está "em cooldown", não está na lista de todo.
  const cooldownCount = enriched.filter((r) => r.reminderTrigger !== null && r.inCooldown).length;

  const summary: Record<string, number> = {
    active: 0,
    expiring_soon: 0,
    expired: 0,
    awaiting_approval: 0,
    awaiting_confirmation: 0,
    rejected_only: 0,
    never_submitted: 0,
  };
  // Frações que o bulk reminder alvejaria (mesmos predicados que o API usa para
  // montar as duas listas) - decide se o botão "Lembrar todos os pendentes"
  // aparece. As presumidas sem comprovativo contam: levam o email de renovação.
  let remindableCount = 0;
  let presumedPendingCount = 0;
  for (const r of enriched) {
    summary[aggregateOf(r)] = (summary[aggregateOf(r)] ?? 0) + 1;
    if (r.presumedEvidenceDays !== null) presumedPendingCount += 1;
    if (r.reminderTrigger !== null) remindableCount += 1;
  }

  return {
    units,
    totalUnits: rows.length,
    summary,
    availableYears,
    filterYear,
    filterStatus,
    cooldownCount,
    cooldownDays: REMINDER_COOLDOWN_DAYS,
    noticeDays: ADMIN_NOTICE_DAYS,
    remindableCount,
    presumedPendingCount,
    presumedPendingFilter: PRESUMED_PENDING_FILTER,
    adminDocumentedFilter: ADMIN_DOCUMENTED_FILTER,
  };
}
