// Contratos de filtros das listagens admin. Substituem o `Record<string,string>`
// solto: o tipo passa a anunciar QUE filtros existem, por isso o caller deixa de
// adivinhar nomes de params (e de puxar tudo por não saber filtrar). Espelham os
// `ctx.req.query()` dos handlers em `$api/modules/admin/<recurso>/list.ts`.

/** Paginação opcional partilhada (page/perPage como string da querystring). */
export interface ListPageParams {
  page?: string;
  perPage?: string;
}

/** Filtros de `GET /charges`. */
export interface ChargeListParams extends ListPageParams {
  kind?: string;
  nature?: string;
  scope?: string;
  status?: string;
  chargeType?: string;
  /** CSV de tipos a EXCLUIR (ex: "outras" = tudo o que não é quota). */
  chargeTypeNot?: string;
  unitId?: string;
  supplierId?: string;
  sourceId?: string;
  competence_from?: string;
  competence_to?: string;
  year?: string;
  /** ILIKE sobre code + description (pesquisa server-side). */
  search?: string;
  limit?: string;
  withMeta?: string;
}

/** Filtros de `GET /bank_transactions`. */
export interface BankTransactionListParams extends ListPageParams {
  /** CSV de status (unreconciled,partial,reconciled,ignored,reversed). */
  status?: string;
  year?: string;
  bankAccountId?: string;
  limit?: string;
  withSuggestions?: string;
  withMeta?: string;
}

/** Filtros de `GET /receipts`. */
export interface ReceiptListParams extends ListPageParams {
  year?: string;
  unitId?: string;
  /** "true" | "false" - filtra recibos anulados. */
  voided?: string;
  limit?: string;
  withMeta?: string;
}

/** Filtros de `GET /settlements`. `bankTransactionId` aceita CSV de IDs. */
export interface SettlementListParams {
  bankTransactionId?: string;
  unitId?: string;
  dateFrom?: string;
  dateTo?: string;
  limit?: string;
}

/**
 * Querystring a partir de params tipados: omite chaves `undefined`/`null`
 * (mantém strings vazias, como o `new URLSearchParams(x)` anterior fazia para
 * os Record<string,string>). O tipo `object` aceita qualquer interface de
 * filtros sem exigir index signature.
 */
export function listQuery(params: object): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    qs.set(key, String(value));
  }
  return qs.toString();
}
