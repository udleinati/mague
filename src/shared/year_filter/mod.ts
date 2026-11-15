// Filtro por ano (UI). Concentra a lógica que os controllers do panel
// replicavam (extrair anos, ordenar desc, resolver o filtro com regras
// subtilmente diferentes) em pure functions + estratégias canónicas.

/** Estratégia para escolher o ano default quando não há `?year=` na URL. */
export type YearDefaultStrategy<T> = (
  availableYears: number[],
  items: ReadonlyArray<T>,
) => number | null;

/** Default: nenhum filtro (mostra "Todos"). */
export const noDefault = <T>(): YearDefaultStrategy<T> => () => null;

/** Default: ano mais recente da lista (descendente). Sem items → null. */
export const mostRecent = <T>(): YearDefaultStrategy<T> => (years) =>
  years.length > 0 ? years[0] : null;

/** Default: ano atual se existir na lista; senão o mais recente. */
export const currentOrMostRecent = <T>(): YearDefaultStrategy<T> => (years) => {
  if (years.length === 0) return null;
  const now = new Date().getUTCFullYear();
  return years.includes(now) ? now : years[0];
};

/**
 * Default: ano mais ANTIGO entre os items que satisfazem `predicate`. Útil
 * para "ano mais antigo com dívida em aberto" - foca o user no que ainda
 * tem em atraso. Se nenhum item satisfaz, devolve null (= Todos).
 */
export const oldestWith = <T>(
  predicate: (item: T) => boolean,
  getDate: (item: T) => string | Date | null | undefined,
): YearDefaultStrategy<T> =>
(_years, items) => {
  const ys = new Set<number>();
  for (const item of items) {
    if (!predicate(item)) continue;
    const y = yearOf(getDate(item));
    if (y !== null) ys.add(y);
  }
  return ys.size > 0 ? Math.min(...ys) : null;
};

/** Extrai o ano de string ISO/YYYY-MM(-DD)/Date/null; null se não parseável. */
export function yearOf(value: string | Date | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    const y = value.getUTCFullYear();
    return Number.isFinite(y) ? y : null;
  }
  const s = String(value);
  if (s.length < 4) return null;
  // Aceita "YYYY-..." (ISO date) e "YYYYMMDD" (truncado nos primeiros 4).
  const y = Number(s.slice(0, 4));
  return Number.isFinite(y) && y > 0 ? y : null;
}

/** Anos únicos da lista, ordenados desc; items sem data válida são ignorados. */
export function computeAvailableYears<T>(
  items: ReadonlyArray<T>,
  getDate: (item: T) => string | Date | null | undefined,
): number[] {
  const set = new Set<number>();
  for (const item of items) {
    const y = yearOf(getDate(item));
    if (y !== null) set.add(y);
  }
  return [...set].sort((a, b) => b - a);
}

/**
 * Anos abrangidos pelo intervalo [from, to], inclusive nas pontas. Vazio se
 * nenhuma ponta for parseável; com só uma ponta, devolve o ano dessa. Para
 * listas em que o item cobre um período (uma vigência) e não uma data única -
 * aí "ser do ano Y" é intersectar Y, não ter sido criado em Y.
 */
export function yearsInRange(
  from: string | Date | null | undefined,
  to: string | Date | null | undefined,
): number[] {
  const a = yearOf(from);
  const b = yearOf(to);
  if (a === null && b === null) return [];
  const start = Math.min(a ?? b!, b ?? a!);
  const end = Math.max(a ?? b!, b ?? a!);
  const out: number[] = [];
  for (let y = start; y <= end; y++) out.push(y);
  return out;
}

/**
 * Resolve o ano filtrado (client-side) pelo param da URL. Tri-state:
 * `undefined` -> `defaultStrategy`; `""` -> null (Todos); `"NNNN"` -> respeita
 * só se válido E em `availableYears` (defensivo: senão null, não filtro fantoche).
 */
export function resolveYearFilter<T>(args: {
  items: ReadonlyArray<T>;
  getDate: (item: T) => string | Date | null | undefined;
  param: string | null | undefined;
  defaultStrategy: YearDefaultStrategy<T>;
}): { availableYears: number[]; filterYear: number | null } {
  return resolveYearFilterFrom({
    items: args.items,
    availableYears: computeAvailableYears(args.items, args.getDate),
    param: args.param,
    defaultStrategy: args.defaultStrategy,
  });
}

/**
 * Como `resolveYearFilter`, mas com `availableYears` já calculados - para listas
 * onde o ano de um item não sai de uma data única (e.g. uma vigência, que cobre
 * um intervalo). Mesma resolução tri-state do param.
 */
export function resolveYearFilterFrom<T>(args: {
  items: ReadonlyArray<T>;
  availableYears: number[];
  param: string | null | undefined;
  defaultStrategy: YearDefaultStrategy<T>;
}): { availableYears: number[]; filterYear: number | null } {
  const { availableYears } = args;
  let filterYear: number | null;
  if (args.param === undefined || args.param === null) {
    filterYear = args.defaultStrategy(availableYears, args.items);
  } else if (args.param === "") {
    filterYear = null;
  } else {
    const n = Number(args.param);
    filterYear = Number.isFinite(n) && availableYears.includes(n) ? n : null;
  }
  return { availableYears, filterYear };
}

/**
 * Resolve o ano para filtragem SERVER-SIDE (sem `availableYears` para validar).
 * Tri-state: ausente -> `defaultYear`; `""` -> null (Todos); 4 dígitos válidos
 * -> esse ano, inválido -> `defaultYear`. Distinto de `resolveYearFilter`
 * (client-side, valida contra a lista local).
 */
export function resolveServerYearParam(
  param: string | null | undefined,
  defaultYear: number,
): number | null {
  if (param === undefined || param === null) return defaultYear;
  if (param === "") return null;
  return /^\d{4}$/.test(param) ? Number(param) : defaultYear;
}
