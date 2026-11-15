// Unit tests para `_query.ts`. Validam invariantes (multi-tenant + soft-delete)
// e o gating do scope. O callback Drizzle é invocado com mocks de `d` (colunas)
// e `ops` (operadores) que registam chamadas - assim assertamos a árvore de
// filtros aplicada sem depender do Drizzle ou da BD.

import { assertEquals } from "@std/assert";
import {
  buildDocumentDetailWhere,
  buildDocumentListOrderBy,
  buildDocumentListWhere,
} from "./_query.ts";

// ── Mocks ────────────────────────────────────────────────────────────────

interface OpNode {
  kind: "eq" | "isNull" | "and" | "desc";
  col?: string;
  val?: unknown;
  args?: OpNode[];
}

const mockColumns = {
  id: "doc.id",
  condominiumId: "doc.condominiumId",
  category: "doc.category",
  isPublic: "doc.isPublic",
  publishedAt: "doc.publishedAt",
  createdAt: "doc.createdAt",
  deletedAt: "doc.deletedAt",
};

const mockOps = {
  eq: (col: string, val: unknown): OpNode => ({ kind: "eq", col, val }),
  isNull: (col: string): OpNode => ({ kind: "isNull", col }),
  and: (...args: OpNode[]): OpNode => ({ kind: "and", args }),
  desc: (col: string): OpNode => ({ kind: "desc", col }),
};

/** Extrai filhos de um nó `and` para asserts simples. */
function andChildren(node: OpNode): OpNode[] {
  if (node.kind !== "and" || !node.args) {
    throw new Error(`Expected and-node, got ${node.kind}`);
  }
  return node.args;
}

/** Verifica se a árvore de filtros contém um eq exato. */
function hasEq(filters: OpNode[], col: string, val: unknown): boolean {
  return filters.some((f) => f.kind === "eq" && f.col === col && f.val === val);
}

function hasIsNull(filters: OpNode[], col: string): boolean {
  return filters.some((f) => f.kind === "isNull" && f.col === col);
}

// ── List where ───────────────────────────────────────────────────────────

Deno.test("buildDocumentListWhere - scope=all, sem filtros: só multi-tenant + soft-delete", () => {
  const where = buildDocumentListWhere({ condominiumId: "co_1", scope: "all" });
  const filters = andChildren(where(mockColumns, mockOps));
  assertEquals(filters.length, 2);
  assertEquals(hasEq(filters, "doc.condominiumId", "co_1"), true);
  assertEquals(hasIsNull(filters, "doc.deletedAt"), true);
  // Visibility NÃO é filtrada quando scope=all sem isPublic explícito.
  assertEquals(filters.some((f) => f.kind === "eq" && f.col === "doc.isPublic"), false);
});

Deno.test("buildDocumentListWhere - scope=public força is_public=true", () => {
  const where = buildDocumentListWhere({ condominiumId: "co_1", scope: "public" });
  const filters = andChildren(where(mockColumns, mockOps));
  assertEquals(filters.length, 3);
  assertEquals(hasEq(filters, "doc.isPublic", true), true);
});

Deno.test("buildDocumentListWhere - scope=all + isPublic=true respeita filtro admin", () => {
  const where = buildDocumentListWhere({
    condominiumId: "co_1",
    scope: "all",
    isPublic: true,
  });
  const filters = andChildren(where(mockColumns, mockOps));
  assertEquals(hasEq(filters, "doc.isPublic", true), true);
});

Deno.test("buildDocumentListWhere - scope=all + isPublic=false respeita filtro admin", () => {
  const where = buildDocumentListWhere({
    condominiumId: "co_1",
    scope: "all",
    isPublic: false,
  });
  const filters = andChildren(where(mockColumns, mockOps));
  assertEquals(hasEq(filters, "doc.isPublic", false), true);
});

Deno.test("buildDocumentListWhere - scope=public ignora isPublic=false (anti-vazamento)", () => {
  // Mesmo que o admin filter ?isPublic=false vaze para o portal handler,
  // scope=public força true e o filtro do caller é silenciosamente ignorado.
  const where = buildDocumentListWhere({
    condominiumId: "co_1",
    scope: "public",
    isPublic: false,
  });
  const filters = andChildren(where(mockColumns, mockOps));
  // Só existe UM eq sobre is_public e é true.
  const isPublicFilters = filters.filter((f) => f.kind === "eq" && f.col === "doc.isPublic");
  assertEquals(isPublicFilters.length, 1);
  assertEquals(isPublicFilters[0].val, true);
});

Deno.test("buildDocumentListWhere - category aplica filtro adicional", () => {
  const where = buildDocumentListWhere({
    condominiumId: "co_1",
    scope: "all",
    category: "minutes",
  });
  const filters = andChildren(where(mockColumns, mockOps));
  assertEquals(hasEq(filters, "doc.category", "minutes"), true);
});

Deno.test("buildDocumentListWhere - category vazio/null ignorado", () => {
  const where = buildDocumentListWhere({
    condominiumId: "co_1",
    scope: "all",
    category: null,
  });
  const filters = andChildren(where(mockColumns, mockOps));
  assertEquals(filters.some((f) => f.kind === "eq" && f.col === "doc.category"), false);
});

Deno.test("buildDocumentListWhere - composição: scope=public + category", () => {
  const where = buildDocumentListWhere({
    condominiumId: "co_1",
    scope: "public",
    category: "regulation",
  });
  const filters = andChildren(where(mockColumns, mockOps));
  assertEquals(hasEq(filters, "doc.condominiumId", "co_1"), true);
  assertEquals(hasIsNull(filters, "doc.deletedAt"), true);
  assertEquals(hasEq(filters, "doc.isPublic", true), true);
  assertEquals(hasEq(filters, "doc.category", "regulation"), true);
});

// ── Detail where ─────────────────────────────────────────────────────────

Deno.test("buildDocumentDetailWhere - scope=all: id + cid + soft-delete", () => {
  const where = buildDocumentDetailWhere({
    documentId: "doc_1",
    condominiumId: "co_1",
    scope: "all",
  });
  const filters = andChildren(where(mockColumns, mockOps));
  assertEquals(filters.length, 3);
  assertEquals(hasEq(filters, "doc.id", "doc_1"), true);
  assertEquals(hasEq(filters, "doc.condominiumId", "co_1"), true);
  assertEquals(hasIsNull(filters, "doc.deletedAt"), true);
});

Deno.test("buildDocumentDetailWhere - scope=public adiciona is_public=true", () => {
  const where = buildDocumentDetailWhere({
    documentId: "doc_1",
    condominiumId: "co_1",
    scope: "public",
  });
  const filters = andChildren(where(mockColumns, mockOps));
  assertEquals(filters.length, 4);
  assertEquals(hasEq(filters, "doc.isPublic", true), true);
});

// ── Order by ─────────────────────────────────────────────────────────────

Deno.test("buildDocumentListOrderBy - desc publishedAt + createdAt", () => {
  const orderBy = buildDocumentListOrderBy();
  const result = orderBy(mockColumns, mockOps);
  assertEquals(result.length, 2);
  assertEquals(result[0], { kind: "desc", col: "doc.publishedAt" });
  assertEquals(result[1], { kind: "desc", col: "doc.createdAt" });
});
