// Parse de paginação a partir do query string (antes repetido em ~10 handlers).

export interface LimitOptions {
  default: number;
  max: number;
}

/**
 * Faz parse robusto de `?limit=`. Devolve `default` se ausente/inválido,
 * cap em `max`. Garante valor inteiro > 0.
 */
export function parseLimit(raw: string | undefined, opts: LimitOptions): number {
  if (!raw) return opts.default;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return opts.default;
  return Math.min(parsed, opts.max);
}

export interface PageOptions {
  /** perPage default quando ?page presente mas ?perPage não. */
  defaultPerPage: number;
  /** Cap em perPage (defesa contra abuso). */
  maxPerPage: number;
}

export interface PageParams {
  /** null = não paginado (caller deve usar `parseLimit` em vez disto). */
  page: number | null;
  perPage: number;
  /** 0 quando page = null. */
  offset: number;
}

/**
 * Faz parse de `?page=` + `?perPage=`. Quando `page` está ausente/inválido,
 * devolve `{ page: null, perPage, offset: 0 }` - o caller decide se usa
 * paginação ou cai para `parseLimit`.
 */
export function parsePageParams(
  pageRaw: string | undefined,
  perPageRaw: string | undefined,
  opts: PageOptions,
): PageParams {
  const pageNum = pageRaw ? Math.max(1, Number.parseInt(pageRaw, 10)) : null;
  const isPaginated = pageNum !== null && Number.isFinite(pageNum);
  const requestedPerPage = perPageRaw ? Number.parseInt(perPageRaw, 10) : opts.defaultPerPage;
  const perPage = Number.isFinite(requestedPerPage)
    ? Math.min(Math.max(requestedPerPage, 1), opts.maxPerPage)
    : opts.defaultPerPage;
  return {
    page: isPaginated ? pageNum : null,
    perPage,
    offset: isPaginated ? (pageNum! - 1) * perPage : 0,
  };
}
