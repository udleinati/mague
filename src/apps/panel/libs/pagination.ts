// Helpers de paginação para listagens grandes (charges, receipts, etc.).
// Padrão: controller lê page/perPage → API → buildPaginationMeta() enriquece
// com URLs prev/next/page-N + janela → template `partials/pagination.vto`.

/** Shape devolvido pela API quando page foi passado. */
export interface PaginationFromApi {
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
}

/** Shape consumido pelo template `partials/pagination.vto`. */
export interface PaginationMeta extends PaginationFromApi {
  start: number;
  end: number;
  hasPrev: boolean;
  hasNext: boolean;
  prevQs: string | null;
  nextQs: string | null;
  firstQs: string;
  lastQs: string;
  pageLinks: Array<
    | { kind: "page"; num: number; qs: string; isCurrent: boolean }
    | { kind: "ellipsis" }
  >;
}

// Lê `?page=`/`?perPage=` (ou defaults); página inválida (NaN/0/negativa) → 1.
// `defaultPerPage` 500: cabe ~1 ano de quotas num condo típico.
export function paginationParamsFromQuery(
  inputParams: Record<string, string>,
  defaultPerPage = 500,
  maxPerPage = 1000,
): { page: string; perPage: string; pageNum: number; perPageNum: number } {
  const pageNum = Math.max(1, Number.parseInt(inputParams.page ?? "1", 10) || 1);
  const requested = Number.parseInt(inputParams.perPage ?? String(defaultPerPage), 10);
  const perPageNum = Math.min(
    Math.max(Number.isFinite(requested) ? requested : defaultPerPage, 10),
    maxPerPage,
  );
  return {
    page: String(pageNum),
    perPage: String(perPageNum),
    pageNum,
    perPageNum,
  };
}

// Metadata enriquecida para o template. `paramsToPreserve` são as chaves
// mantidas no querystring dos links (não inclui `page`, que se substitui).
export function buildPaginationMeta(
  p: PaginationFromApi,
  inputParams: Record<string, string>,
  paramsToPreserve: string[] = ["kind", "nature", "year", "status", "perPage"],
): PaginationMeta {
  const baseParams: Record<string, string> = {};
  for (const k of paramsToPreserve) {
    if (inputParams[k] !== undefined) baseParams[k] = inputParams[k];
  }
  const qsForPage = (n: number) => {
    return new URLSearchParams({ ...baseParams, page: String(n) }).toString();
  };
  const start = p.total === 0 ? 0 : (p.page - 1) * p.perPage + 1;
  const end = Math.min(p.page * p.perPage, p.total);

  // Janela de páginas a mostrar: atual ±2, com primeira/última como âncoras.
  const pages: Array<number | "…"> = [];
  const winStart = Math.max(2, p.page - 2);
  const winEnd = Math.min(p.totalPages - 1, p.page + 2);
  pages.push(1);
  if (winStart > 2) pages.push("…");
  for (let i = winStart; i <= winEnd; i++) pages.push(i);
  if (winEnd < p.totalPages - 1) pages.push("…");
  if (p.totalPages > 1) pages.push(p.totalPages);

  return {
    page: p.page,
    perPage: p.perPage,
    total: p.total,
    totalPages: p.totalPages,
    start,
    end,
    hasPrev: p.page > 1,
    hasNext: p.page < p.totalPages,
    prevQs: p.page > 1 ? qsForPage(p.page - 1) : null,
    nextQs: p.page < p.totalPages ? qsForPage(p.page + 1) : null,
    firstQs: qsForPage(1),
    lastQs: qsForPage(p.totalPages),
    pageLinks: pages.map((n) =>
      typeof n === "number"
        ? { kind: "page" as const, num: n, qs: qsForPage(n), isCurrent: n === p.page }
        : { kind: "ellipsis" as const }
    ),
  };
}
