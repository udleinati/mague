import { assertEquals, assertStringIncludes } from "@std/assert";
import type { SQL } from "drizzle-orm";
import { PgDialect, pgTable, text, timestamp } from "drizzle/pg-core";
import {
  buildPaginationMeta,
  dateRange,
  eqIf,
  inListIf,
  listWhere,
  notInListIf,
  parseStatusList,
  parseYear,
  searchILike,
  yearRange,
} from "./list_query.ts";

// ─── parseYear ─────────────────────────────────────────────────────────

Deno.test("parseYear - aceita YYYY 4 dígitos", () => {
  assertEquals(parseYear("2026"), 2026);
});

Deno.test("parseYear - rejeita não-numérico", () => {
  assertEquals(parseYear("abc"), null);
  assertEquals(parseYear("20a6"), null);
});

Deno.test("parseYear - rejeita comprimento errado (3 ou 5 dígitos)", () => {
  assertEquals(parseYear("202"), null);
  assertEquals(parseYear("20266"), null);
});

Deno.test("parseYear - vazio/undefined → null", () => {
  assertEquals(parseYear(""), null);
  assertEquals(parseYear(undefined), null);
});

// ─── parseStatusList ───────────────────────────────────────────────────

const ALLOWED = new Set(["open", "partial", "paid", "overdue"]);

Deno.test("parseStatusList - CSV simples filtra ao whitelist", () => {
  assertEquals(parseStatusList("open,partial", ALLOWED), ["open", "partial"]);
});

Deno.test("parseStatusList - ignora valores fora do whitelist", () => {
  assertEquals(parseStatusList("open,FAKE,paid", ALLOWED), ["open", "paid"]);
});

Deno.test("parseStatusList - trimma espaços", () => {
  assertEquals(parseStatusList(" open , partial ", ALLOWED), ["open", "partial"]);
});

Deno.test("parseStatusList - ausente/vazio → []", () => {
  assertEquals(parseStatusList(undefined, ALLOWED), []);
  assertEquals(parseStatusList("", ALLOWED), []);
});

Deno.test("parseStatusList - rejeita strings vazias entre vírgulas", () => {
  assertEquals(parseStatusList("open,,paid", ALLOWED), ["open", "paid"]);
});

// ─── buildPaginationMeta ───────────────────────────────────────────────

Deno.test("buildPaginationMeta - calcula totalPages", () => {
  const m = buildPaginationMeta({ page: 1, perPage: 10 }, 25);
  assertEquals(m, { page: 1, perPage: 10, total: 25, totalPages: 3 });
});

Deno.test("buildPaginationMeta - total exato múltiplo de perPage", () => {
  const m = buildPaginationMeta({ page: 1, perPage: 10 }, 30);
  assertEquals(m?.totalPages, 3);
});

Deno.test("buildPaginationMeta - total=0 → totalPages=1 (mínimo)", () => {
  // Defesa: lista vazia ainda mostra "página 1 de 1" em vez de "0 de 0".
  const m = buildPaginationMeta({ page: 1, perPage: 10 }, 0);
  assertEquals(m?.totalPages, 1);
});

Deno.test("buildPaginationMeta - page=null (não paginado) → undefined", () => {
  // Caller usa parseLimit + sem meta - buildPaginationMeta devolve undefined
  // para espalhar conditionalmente no JSON: `pagination ? { data, pagination } : { data }`.
  assertEquals(buildPaginationMeta({ page: null, perPage: 500 }, 1000), undefined);
});

// ─── listWhere + combinadores ──────────────────────────────────────────
// Testam o SQL renderizado (PgDialect) - é o que chega ao postgres.

// Tabela com soft-delete (caso core: unit, supplier, …).
const softEntity = pgTable("soft_entity", {
  id: text("id").primaryKey(),
  condominiumId: text("condominium_id").notNull(),
  status: text("status"),
  eventDate: text("event_date"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

// Tabela sem deleted_at (caso finance: charge, settlement, bank_transaction -
// estado terminal é semântico, não soft-delete).
const hardEntity = pgTable("hard_entity", {
  id: text("id").primaryKey(),
  condominiumId: text("condominium_id").notNull(),
});

const render = (fragment: SQL) => new PgDialect().sqlToQuery(fragment);

const CID = "11111111-1111-1111-1111-111111111111";

Deno.test("listWhere - tenant scope sempre presente, por construção", () => {
  // A razão de ser do helper: NENHUMA listagem pode esquecer o gate
  // multi-tenant (ADR 0009). O condominium_id entra como param bound.
  const q = render(listWhere(hardEntity, CID));
  assertStringIncludes(q.sql, '"condominium_id" = ');
  assertEquals(q.params, [CID]);
});

Deno.test("listWhere - tabela com deletedAt ganha 'deleted_at is null' automático", () => {
  const q = render(listWhere(softEntity, CID));
  assertStringIncludes(q.sql, '"deleted_at" is null');
});

Deno.test("listWhere - tabela sem deletedAt não ganha cláusula soft-delete", () => {
  const q = render(listWhere(hardEntity, CID));
  assertEquals(q.sql.includes("deleted_at"), false);
});

Deno.test("listWhere - filtros undefined são omitidos do SQL", () => {
  // `undefined` = "sem esse filtro": o WHERE com todos os filtros ausentes
  // tem de ser idêntico ao WHERE base (mesmo SQL para findMany e count).
  const base = render(listWhere(hardEntity, CID));
  const withAbsent = render(listWhere(
    hardEntity,
    CID,
    eqIf(hardEntity.id, undefined),
    inListIf(hardEntity.id, []),
    dateRange(hardEntity.id, undefined, undefined),
    yearRange(hardEntity.id, null),
  ));
  assertEquals(withAbsent.sql, base.sql);
  assertEquals(withAbsent.params, base.params);
});

Deno.test("listWhere - filtros presentes entram em AND com o tenant scope", () => {
  const q = render(listWhere(
    softEntity,
    CID,
    eqIf(softEntity.status, "active"),
  ));
  assertStringIncludes(q.sql, '"condominium_id" = ');
  assertStringIncludes(q.sql, '"status" = ');
  assertStringIncludes(q.sql, " and ");
  assertEquals(q.params, [CID, "active"]);
});

Deno.test("eqIf - valor ausente/vazio → undefined (sem filtro)", () => {
  assertEquals(eqIf(softEntity.status, undefined), undefined);
  assertEquals(eqIf(softEntity.status, null), undefined);
  assertEquals(eqIf(softEntity.status, ""), undefined);
});

Deno.test("inListIf - 1 valor → '=', n valores → 'in' (preserva o SQL dos handlers)", () => {
  // Os handlers distinguiam eq de inArray para 1 vs n statuses; o helper
  // preserva esse shape para o plano de query não mudar.
  const one = render(inListIf(softEntity.status, ["open"])!);
  assertStringIncludes(one.sql, '"status" = ');
  const many = render(inListIf(softEntity.status, ["open", "partial"])!);
  assertStringIncludes(many.sql, '"status" in ');
  assertEquals(many.params, ["open", "partial"]);
});

Deno.test("notInListIf - lista vazia → undefined (sem filtro, não 'exclui nada')", () => {
  // Um filtro de exclusão vazio tem de deixar a listagem intacta; devolver
  // `not in ()` cortava tudo silenciosamente.
  assertEquals(notInListIf(softEntity.status, []), undefined);
});

Deno.test("notInListIf - 1 valor → '<>', n valores → 'not in'", () => {
  const one = render(notInListIf(softEntity.status, ["quota"])!);
  assertStringIncludes(one.sql, '"status" <> ');
  const many = render(notInListIf(softEntity.status, ["quota", "extraordinary_quota"])!);
  assertStringIncludes(many.sql, '"status" not in ');
  assertEquals(many.params, ["quota", "extraordinary_quota"]);
});

Deno.test("dateRange - from/to independentes (range aberto de um lado)", () => {
  const fromOnly = render(dateRange(softEntity.eventDate, "2026-01-01", undefined)!);
  assertStringIncludes(fromOnly.sql, ">=");
  assertEquals(fromOnly.sql.includes("<="), false);

  const toOnly = render(dateRange(softEntity.eventDate, undefined, "2026-12-31")!);
  assertStringIncludes(toOnly.sql, "<=");
  assertEquals(toOnly.sql.includes(">="), false);

  const both = render(dateRange(softEntity.eventDate, "2026-01-01", "2026-12-31")!);
  assertStringIncludes(both.sql, ">=");
  assertStringIncludes(both.sql, "<=");
  assertEquals(both.params, ["2026-01-01", "2026-12-31"]);
});

Deno.test("yearRange - ano civil completo inclusivo", () => {
  const q = render(yearRange(softEntity.eventDate, 2026)!);
  assertEquals(q.params, ["2026-01-01", "2026-12-31"]);
});

// ─── searchILike ───────────────────────────────────────────────────────

Deno.test("searchILike - vazio/whitespace/sem colunas → undefined (sem filtro)", () => {
  assertEquals(searchILike([softEntity.status], undefined), undefined);
  assertEquals(searchILike([softEntity.status], null), undefined);
  assertEquals(searchILike([softEntity.status], ""), undefined);
  assertEquals(searchILike([softEntity.status], "   "), undefined);
  assertEquals(searchILike([], "joão"), undefined);
});

Deno.test("searchILike - 1 coluna → ILIKE com padrão %q% (case-insensitive na BD)", () => {
  const q = render(searchILike([softEntity.status], "joão")!);
  assertStringIncludes(q.sql, "ilike");
  assertEquals(q.params, ["%joão%"]);
});

Deno.test("searchILike - n colunas → OR de ILIKEs (mesmo q em cada uma)", () => {
  const q = render(searchILike([softEntity.status, softEntity.eventDate], "ab")!);
  assertStringIncludes(q.sql, " or ");
  assertEquals(q.params, ["%ab%", "%ab%"]);
});

Deno.test("searchILike - escapa wildcards do utilizador (% _ \\) como literais", () => {
  // Sem escape, `50%` ou `a_b` colidiam com os wildcards do LIKE e devolviam
  // matches espúrios. Trim aplica-se antes do escape.
  const q = render(searchILike([softEntity.status], "  50%_\\x  ")!);
  assertEquals(q.params, ["%50\\%\\_\\\\x%"]);
});
