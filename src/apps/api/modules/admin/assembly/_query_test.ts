// Unit tests para `_query.ts`: validam invariantes (multi-tenant + soft-delete) e o gating
// do scope (portal esconde `draft`). Mocks de `e`/`ops` registam chamadas para assertar a
// árvore de filtros sem Drizzle/BD. Mesmo padrão que document/pathology _query_test.ts.

import { assertEquals } from "@std/assert";
import {
  buildAssemblyDetailWhere,
  buildAssemblyListOrderBy,
  buildAssemblyListWhere,
} from "./_query.ts";

// ── Mocks ────────────────────────────────────────────────────────────────

interface OpNode {
  kind: "eq" | "isNull" | "inArray" | "and" | "desc";
  col?: string;
  val?: unknown;
  vals?: unknown[];
  args?: OpNode[];
}

const mockColumns = {
  id: "asm.id",
  condominiumId: "asm.condominiumId",
  status: "asm.status",
  scheduledAt: "asm.scheduledAt",
  deletedAt: "asm.deletedAt",
};

const mockOps = {
  eq: (col: string, val: unknown): OpNode => ({ kind: "eq", col, val }),
  isNull: (col: string): OpNode => ({ kind: "isNull", col }),
  inArray: (col: string, vals: unknown[]): OpNode => ({ kind: "inArray", col, vals }),
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

function hasEq(filters: OpNode[], col: string, val: unknown): boolean {
  return filters.some((f) => f.kind === "eq" && f.col === col && f.val === val);
}

function hasIsNull(filters: OpNode[], col: string): boolean {
  return filters.some((f) => f.kind === "isNull" && f.col === col);
}

/** O gate de visibilidade do portal é `status NOT IN (draft)` via inArray. */
function publicStatusNode(filters: OpNode[]): OpNode | undefined {
  return filters.find((f) => f.kind === "inArray" && f.col === "asm.status");
}

// ── List where ───────────────────────────────────────────────────────────

Deno.test("buildAssemblyListWhere - scope=all, sem filtros: só multi-tenant + soft-delete", () => {
  const where = buildAssemblyListWhere({ condominiumId: "co_1", scope: "all" });
  const filters = andChildren(where(mockColumns, mockOps));
  assertEquals(filters.length, 2);
  assertEquals(hasEq(filters, "asm.condominiumId", "co_1"), true);
  assertEquals(hasIsNull(filters, "asm.deletedAt"), true);
  // Visibility NÃO é filtrada quando scope=all.
  assertEquals(publicStatusNode(filters), undefined);
});

Deno.test("buildAssemblyListWhere - scope=public força status público (sem draft)", () => {
  const where = buildAssemblyListWhere({ condominiumId: "co_1", scope: "public" });
  const filters = andChildren(where(mockColumns, mockOps));
  const node = publicStatusNode(filters);
  assertEquals(node !== undefined, true);
  // O conjunto público exclui `draft` e inclui os restantes estados.
  assertEquals(node!.vals?.includes("draft"), false);
  assertEquals(node!.vals?.includes("scheduled"), true);
  assertEquals(node!.vals?.includes("held"), true);
  assertEquals(node!.vals?.includes("cancelled"), true);
});

Deno.test("buildAssemblyListWhere - scope=all + status=draft respeita filtro admin", () => {
  const where = buildAssemblyListWhere({ condominiumId: "co_1", scope: "all", status: "draft" });
  const filters = andChildren(where(mockColumns, mockOps));
  assertEquals(hasEq(filters, "asm.status", "draft"), true);
});

Deno.test("buildAssemblyListWhere - scope=public ignora ?status=draft (anti-vazamento)", () => {
  const where = buildAssemblyListWhere({ condominiumId: "co_1", scope: "public", status: "draft" });
  const filters = andChildren(where(mockColumns, mockOps));
  // O eq exato a draft NÃO é aplicado; só o gate inArray público sobrevive.
  assertEquals(hasEq(filters, "asm.status", "draft"), false);
  assertEquals(publicStatusNode(filters) !== undefined, true);
});

Deno.test("buildAssemblyListWhere - scope=public + status=held aplica o eq (status público)", () => {
  const where = buildAssemblyListWhere({ condominiumId: "co_1", scope: "public", status: "held" });
  const filters = andChildren(where(mockColumns, mockOps));
  assertEquals(hasEq(filters, "asm.status", "held"), true);
  assertEquals(publicStatusNode(filters) !== undefined, true);
});

// ── Detail where ───────────────────────────────────────────────────────────

Deno.test("buildAssemblyDetailWhere - scope=all: id + condo + soft-delete, sem gate de status", () => {
  const where = buildAssemblyDetailWhere({
    assemblyId: "a_1",
    condominiumId: "co_1",
    scope: "all",
  });
  const filters = andChildren(where(mockColumns, mockOps));
  assertEquals(hasEq(filters, "asm.id", "a_1"), true);
  assertEquals(hasEq(filters, "asm.condominiumId", "co_1"), true);
  assertEquals(hasIsNull(filters, "asm.deletedAt"), true);
  assertEquals(publicStatusNode(filters), undefined);
});

Deno.test("buildAssemblyDetailWhere - scope=public adiciona gate de status público (draft → não encontra → 404)", () => {
  const where = buildAssemblyDetailWhere({
    assemblyId: "a_1",
    condominiumId: "co_1",
    scope: "public",
  });
  const filters = andChildren(where(mockColumns, mockOps));
  const node = publicStatusNode(filters);
  assertEquals(node !== undefined, true);
  assertEquals(node!.vals?.includes("draft"), false);
});

// ── Order by ───────────────────────────────────────────────────────────────

Deno.test("buildAssemblyListOrderBy - desc por scheduledAt", () => {
  const orderBy = buildAssemblyListOrderBy();
  const result = orderBy(mockColumns, mockOps) as OpNode[];
  assertEquals(result.length, 1);
  assertEquals(result[0].kind, "desc");
  assertEquals(result[0].col, "asm.scheduledAt");
});
