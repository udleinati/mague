// GET /charges - suporta filtros via query string:
//   ?kind=receivable|payable
//   ?nature=debit|credit
//   ?scope=unit|condominium
//   ?status=open|partial|paid|overdue|cancelled
//   ?status=open_any  → composto (open + partial + overdue, charges com saldo)
//   ?chargeType=quota|supplier_service|...
//   ?chargeTypeNot=quota,extraordinary_quota  → CSV de tipos a excluir
//   ?unitId=...
//   ?supplierId=...
//   ?sourceId=... (ex: refaturações de uma charge - sourceId=<charge.id>)
//   ?competence_from=YYYY-MM-DD&competence_to=YYYY-MM-DD
//   ?year=YYYY  → filtro por ano de competence_period (mais simples que from/to)
//   ?search=…   → ILIKE sobre code + description (pesquisa server-side)
//   ?withMeta=1 → resposta inclui meta { availableYears, outOfYear }

import type { Context } from "hono";
import { count, gt, lt, or, sql, sum } from "drizzle-orm";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { isCondoAdmin } from "$api/libs/shared/require_condo_admin.ts";
import { assertUserCanAccessUnit } from "$api/libs/shared/assert_ownership.ts";
import { parseLimit, parsePageParams } from "$api/libs/shared/pagination.ts";
import {
  buildPaginationMeta,
  countWhere,
  dateRange,
  eqIf,
  inListIf,
  listAvailableYears,
  listWhere,
  notInListIf,
  parseYear,
  searchILike,
  yearRange,
} from "$api/libs/shared/list_query.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { CHARGE_PROJECTION, formatChargeForResponse } from "./_projection.ts";

const OPEN_ANY_STATUSES = ["open", "partial", "overdue"] as const;

/** CSV → lista de tipos; sem allow-list (charge_type não tem enum canónico). */
const csvList = (raw: string | undefined): string[] =>
  (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export const listCharges = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);

  const {
    kind,
    nature,
    scope,
    status,
    chargeType,
    chargeTypeNot,
    unitId,
    supplierId,
    sourceId,
    competence_from,
    competence_to,
    year: yearRaw,
    search,
    withMeta,
    limit: limitRaw,
    page: pageRaw,
    perPage: perPageRaw,
  } = ctx.req.query();

  const year = parseYear(yearRaw);

  // ── Auth gate ────────────────────────────────────────────────────────
  // `?unitId=` presente: valida acesso a essa unit (anti-IDOR). Ausente:
  // exige admin, senão um occupant leaka o condomínio inteiro. `isCondoAdmin`
  // aplica a regra (manager vive em core.manager pós-ADR 0002).
  const isAdmin = isCondoAdmin(ctx);
  if (unitId) {
    await assertUserCanAccessUnit(ctx, postgres, unitId, condominiumId);
  } else if (!isAdmin) {
    throw new AppError({
      message: "unitId é obrigatório para callers que não são admin",
      statusCode: STATUS_CODE.Forbidden,
      code: "UNIT_ID_REQUIRED",
    });
  }

  // Max 5000 cobre o panel de conciliação (histórico grande sem cortar overdue).
  const effectiveLimit = parseLimit(limitRaw, { default: 500, max: 5000 });

  // Paginação opcional (?page=1&perPage=500). Sem `page`, comportamento legacy
  // (até `effectiveLimit` rows, sem meta). maxPerPage 10000 evita split de meses.
  const pp = parsePageParams(pageRaw, perPageRaw, {
    defaultPerPage: 500,
    maxPerPage: 10000,
  });
  const isPaginated = pp.page !== null;
  const sliceLimit = isPaginated ? pp.perPage : effectiveLimit;

  // WHERE único para findMany + count - tenant scope por construção.
  const where = listWhere(
    schema.charge,
    condominiumId,
    eqIf(schema.charge.kind, kind),
    eqIf(schema.charge.nature, nature),
    eqIf(schema.charge.scope, scope),
    status === "open_any"
      ? inListIf(schema.charge.status, [...OPEN_ANY_STATUSES])
      : eqIf(schema.charge.status, status),
    eqIf(schema.charge.chargeType, chargeType),
    notInListIf(schema.charge.chargeType, csvList(chargeTypeNot)),
    eqIf(schema.charge.unitId, unitId),
    eqIf(schema.charge.supplierId, supplierId),
    eqIf(schema.charge.sourceId, sourceId),
    dateRange(schema.charge.competencePeriod, competence_from, competence_to),
    yearRange(schema.charge.competencePeriod, year),
    searchILike([schema.charge.code, schema.charge.description], search),
  );

  const rows = await postgres.query((db) =>
    db.query.charge.findMany({
      where,
      // competencePeriod DESC, depois unit.designation natural, createdAt DESC.
      // Drizzle relational não ordena por coluna da relation; sub-query sobre
      // core.unit (PK indexada, O(1)/linha), NULLS LAST para charges sem unit.
      orderBy: (e, ops) => [
        ops.desc(e.competencePeriod),
        sql`length((SELECT designation FROM core.unit WHERE id = ${e.unitId})) ASC NULLS LAST`,
        sql`(SELECT designation FROM core.unit WHERE id = ${e.unitId}) ASC NULLS LAST`,
        ops.desc(e.createdAt),
      ],
      limit: sliceLimit,
      offset: isPaginated ? pp.offset : undefined,
      // Nested default-on: poupa ao panel 3 listagens (units/suppliers/accounts)
      // só para resolver nomes. Custo ~150-300 bytes/linha, aceitável.
      ...CHARGE_PROJECTION,
    })
  );

  const data = rows.map(formatChargeForResponse);

  // count(*) sob o MESMO where para totalPages. Só corre se isPaginated.
  const pagination = isPaginated
    ? buildPaginationMeta(pp, await countWhere(postgres, schema.charge, where))
    : undefined;

  // Sem withMeta: comportamento legado (só `data`), preserva o shape antigo.
  if (withMeta !== "1" && withMeta !== "true") {
    return ctx.json(pagination ? { data, pagination } : { data });
  }

  // ── Meta enriquecida ─────────────────────────────────────────────────────
  // availableYears: anos com charges para (kind, nature) - lista do dropdown,
  // não filtra por status/year (deve conter todos os anos).
  const availableYears = await listAvailableYears(
    postgres,
    schema.charge,
    schema.charge.competencePeriod,
    listWhere(
      schema.charge,
      condominiumId,
      eqIf(schema.charge.kind, kind),
      eqIf(schema.charge.nature, nature),
    ),
  );

  // outOfYear (só com ano filtrado): charges em aberto cujo competence cai fora
  // do ano - sinaliza dívida pendente noutro ano.
  let outOfYear: { count: number; totalOpenCents: number } | null = null;
  if (year !== null) {
    const oRows = await postgres.query((db) =>
      db.select({
        count: count(),
        // COALESCE + ::int: sum() devolve string numeric e null sem rows.
        totalOpen: sql<number>`COALESCE(${sum(schema.charge.openAmount)}, 0)::int`,
      })
        .from(schema.charge)
        .where(listWhere(
          schema.charge,
          condominiumId,
          inListIf(schema.charge.status, [...OPEN_ANY_STATUSES]),
          eqIf(schema.charge.kind, kind),
          eqIf(schema.charge.nature, nature),
          or(
            lt(schema.charge.competencePeriod, `${year}-01-01`),
            gt(schema.charge.competencePeriod, `${year}-12-31`),
          ),
        ))
    );
    const row = oRows[0];
    const c = Number(row?.count ?? 0);
    if (c > 0) {
      outOfYear = { count: c, totalOpenCents: Number(row?.totalOpen ?? 0) };
    }
  }

  return ctx.json({
    data,
    meta: { availableYears, outOfYear },
    ...(pagination ? { pagination } : {}),
  });
};
