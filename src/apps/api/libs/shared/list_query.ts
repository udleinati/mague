// List query: parse de params + `listWhere` (UM fragmento SQL com tenant scope
// + soft-delete por construção) que serve `findMany({ where })` E o `count()` -
// evita o WHERE duplicado que divergia. Mesmo racional do `byIdInCondo` - ADR 0030.

import {
  and,
  type AnyColumn,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { AnyPgTable } from "drizzle/pg-core";
import type { Postgres } from "$api/libs/postgres/postgres.ts";

/** Parse de `?year=YYYY` (só 4 dígitos); `null` para vazio/ausente/inválido. */
export function parseYear(raw: string | undefined): number | null {
  if (!raw) return null;
  return /^\d{4}$/.test(raw) ? Number(raw) : null;
}

/**
 * Parse de `?status=` CSV; filtra ao `allowed`. `[]` para ausente/vazio -
 * caller decide se isso é "todos" ou "nenhum".
 */
export function parseStatusList(
  raw: string | undefined,
  allowed: ReadonlySet<string>,
): string[] {
  if (!raw) return [];
  return raw.split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && allowed.has(s));
}

/**
 * Meta de paginação a partir de `parsePageParams` + total. `undefined` quando
 * não paginado - caller omite `pagination` da resposta nesse caso.
 */
export interface PaginationMeta {
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
}

export function buildPaginationMeta(
  pp: { page: number | null; perPage: number },
  total: number,
): PaginationMeta | undefined {
  if (pp.page === null) return undefined;
  return {
    page: pp.page,
    perPage: pp.perPage,
    total,
    totalPages: Math.max(1, Math.ceil(total / pp.perPage)),
  };
}

// ─── Composição de WHERE ─────────────────────────────────────────────────

/**
 * WHERE de listagem: tenant scope (+ `deleted_at IS NULL` quando a tabela o
 * tem) por construção + filtros opcionais (`undefined` = sem filtro). Serve
 * `findMany({ where })` e `count()` - uma definição, zero divergência.
 */
export function listWhere(
  table: {
    // deno-lint-ignore no-explicit-any
    condominiumId: any;
    // deno-lint-ignore no-explicit-any
    deletedAt?: any;
  },
  condominiumId: string,
  ...filters: (SQL | undefined)[]
): SQL {
  return and(
    eq(table.condominiumId, condominiumId),
    table.deletedAt ? isNull(table.deletedAt) : undefined,
    ...filters,
  )!;
}

/** `eq(column, value)` quando `value` presente; `undefined` = sem filtro. */
export function eqIf(
  column: AnyColumn,
  value: string | null | undefined,
): SQL | undefined {
  return value ? eq(column, value) : undefined;
}

/** Filtro multi-valor (par de `parseStatusList`): `[]` = sem filtro, 1 = `eq`, n = `inArray`. */
export function inListIf(
  column: AnyColumn,
  values: string[],
): SQL | undefined {
  if (values.length === 0) return undefined;
  if (values.length === 1) return eq(column, values[0]);
  return inArray(column, values);
}

/** Negação de `inListIf` (ex: "tudo o que não é quota"): `[]` = sem filtro. */
export function notInListIf(
  column: AnyColumn,
  values: string[],
): SQL | undefined {
  if (values.length === 0) return undefined;
  if (values.length === 1) return ne(column, values[0]);
  return notInArray(column, values);
}

/** Range inclusivo opcional; `from`/`to` independentes, ambos ausentes = sem filtro. */
export function dateRange(
  column: AnyColumn,
  from: string | null | undefined,
  to: string | null | undefined,
): SQL | undefined {
  const f = from ? gte(column, from) : undefined;
  const t = to ? lte(column, to) : undefined;
  if (f && t) return and(f, t);
  return f ?? t;
}

/** Range de um ano civil completo sobre coluna de data. `null` = sem filtro. */
export function yearRange(
  column: AnyColumn,
  year: number | null,
): SQL | undefined {
  if (year === null) return undefined;
  return dateRange(column, `${year}-01-01`, `${year}-12-31`);
}

/**
 * Pesquisa textual case-insensitive (`ILIKE %q%`) sobre 1+ colunas, em OR. Vazio
 * = sem filtro. Empurra a pesquisa para SQL em vez de puxar tudo e filtrar no
 * browser. `%`/`_`/`\` na query são escapados (tratados como literais, não
 * wildcards). Combina no mesmo `listWhere` que serve findMany + count.
 */
export function searchILike(
  columns: AnyColumn[],
  value: string | null | undefined,
): SQL | undefined {
  const q = value?.trim();
  if (!q || columns.length === 0) return undefined;
  const pattern = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const clauses = columns.map((c) => ilike(c, pattern));
  return clauses.length === 1 ? clauses[0] : or(...clauses);
}

// ─── Queries auxiliares de listagem ──────────────────────────────────────

/** `count(*)` para `pagination.total` - passar o where de `listWhere`, nunca reconstruir. */
export async function countWhere(
  postgres: Postgres,
  table: AnyPgTable,
  where: SQL,
): Promise<number> {
  const rows = await postgres.query((db) => db.select({ total: count() }).from(table).where(where));
  return Number(rows[0]?.total ?? 0);
}

/**
 * Anos distintos sob o `where`, DESC - para `meta.availableYears`. O `where`
 * é tipicamente mais largo que o da listagem (dropdown mostra todos os anos).
 */
export async function listAvailableYears(
  postgres: Postgres,
  table: AnyPgTable,
  column: AnyColumn,
  where: SQL,
): Promise<number[]> {
  const yearExpr = sql<number>`EXTRACT(YEAR FROM ${column})::int`;
  const rows = await postgres.query((db) =>
    db.selectDistinct({ year: yearExpr })
      .from(table)
      .where(and(where, isNotNull(column)))
      .orderBy(desc(yearExpr))
  );
  return rows.map((r) => Number(r.year)).filter((y) => Number.isFinite(y));
}
