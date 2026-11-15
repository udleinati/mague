// Unit tests para `_query.ts`. Padrão ADR 0003: validam invariantes (multi-tenant
// + soft-delete) e o gating do scope (admin all vs portal public).
// Sem HTTP/DB.

import { assertEquals } from "@std/assert";
import {
  buildPathologyDetailWhere,
  buildPathologyListOrderBy,
  buildPathologyListWhere,
  PATHOLOGY_STATUS_GROUPS,
} from "./_query.ts";

// ── Mocks ────────────────────────────────────────────────────────────────

interface OpNode {
  kind: "eq" | "isNull" | "and" | "desc" | "inArray";
  col?: string;
  val?: unknown;
  values?: unknown[];
  args?: OpNode[];
}

const mockColumns = {
  id: "p.id",
  condominiumId: "p.condominiumId",
  status: "p.status",
  detectedAt: "p.detectedAt",
  createdAt: "p.createdAt",
  deletedAt: "p.deletedAt",
};

const mockOps = {
  eq: (col: string, val: unknown): OpNode => ({ kind: "eq", col, val }),
  isNull: (col: string): OpNode => ({ kind: "isNull", col }),
  inArray: (col: string, values: unknown[]): OpNode => ({ kind: "inArray", col, values }),
  and: (...args: OpNode[]): OpNode => ({ kind: "and", args }),
  desc: (col: string): OpNode => ({ kind: "desc", col }),
};

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

function inArrayValues(filters: OpNode[], col: string): unknown[] | null {
  const f = filters.find((x) => x.kind === "inArray" && x.col === col);
  return f?.values ?? null;
}

// ── List where ───────────────────────────────────────────────────────────

Deno.test("buildPathologyListWhere - scope=all, sem filtros: só multi-tenant + soft-delete", () => {
  const where = buildPathologyListWhere({ condominiumId: "co_1", scope: "all" });
  const filters = andChildren(where(mockColumns, mockOps));
  assertEquals(filters.length, 2);
  assertEquals(hasEq(filters, "p.condominiumId", "co_1"), true);
  assertEquals(hasIsNull(filters, "p.deletedAt"), true);
  // Sem filtro de status quando scope=all sem opts.
  assertEquals(
    filters.some((f) => f.kind === "inArray" || f.kind === "eq" && f.col === "p.status"),
    false,
  );
});

Deno.test("buildPathologyListWhere - scope=public força status != 'draft'", () => {
  const where = buildPathologyListWhere({ condominiumId: "co_1", scope: "public" });
  const filters = andChildren(where(mockColumns, mockOps));
  const statuses = inArrayValues(filters, "p.status");
  assertEquals(statuses !== null, true);
  // Não inclui draft.
  assertEquals((statuses as string[]).includes("draft"), false);
  // Inclui pelo menos identified e resolved.
  assertEquals((statuses as string[]).includes("identified"), true);
  assertEquals((statuses as string[]).includes("resolved"), true);
});

Deno.test("buildPathologyListWhere - scope=all + status=draft respeita filtro admin", () => {
  const where = buildPathologyListWhere({
    condominiumId: "co_1",
    scope: "all",
    status: "draft",
  });
  const filters = andChildren(where(mockColumns, mockOps));
  assertEquals(hasEq(filters, "p.status", "draft"), true);
});

Deno.test("buildPathologyListWhere - scope=public ignora status='draft' (anti-vazamento)", () => {
  // Se o admin filter ?status=draft vaze para o portal handler, scope=public
  // não permite que apareça - a constraint inArray do scope já exclui draft.
  const where = buildPathologyListWhere({
    condominiumId: "co_1",
    scope: "public",
    status: "draft",
  });
  const filters = andChildren(where(mockColumns, mockOps));
  // Não existe um eq sobre p.status='draft'.
  assertEquals(hasEq(filters, "p.status", "draft"), false);
  // O inArray do scope existe e continua sem incluir draft.
  const statuses = inArrayValues(filters, "p.status");
  assertEquals((statuses as string[]).includes("draft"), false);
});

Deno.test("buildPathologyListWhere - statusGroup='active' aplica bucket", () => {
  const where = buildPathologyListWhere({
    condominiumId: "co_1",
    scope: "public",
    statusGroup: "active",
  });
  const filters = andChildren(where(mockColumns, mockOps));
  // Existem 2 inArrays sobre p.status: o do scope (public) + o do bucket.
  const inArrayFilters = filters.filter((f) => f.kind === "inArray" && f.col === "p.status");
  assertEquals(inArrayFilters.length, 2);
  // O bucket active não inclui resolved nem dismissed.
  const active = PATHOLOGY_STATUS_GROUPS.active;
  assertEquals(active.includes("resolved" as never), false);
  assertEquals(active.includes("dismissed" as never), false);
  assertEquals(active.includes("identified"), true);
  assertEquals(active.includes("in_repair"), true);
});

Deno.test("buildPathologyListWhere - statusGroup='resolved' aplica só 'resolved'", () => {
  const where = buildPathologyListWhere({
    condominiumId: "co_1",
    scope: "public",
    statusGroup: "resolved",
  });
  const filters = andChildren(where(mockColumns, mockOps));
  const bucketStatuses = filters
    .filter((f) => f.kind === "inArray" && f.col === "p.status")
    .map((f) => f.values as string[])
    .find((vs) => vs.length === 1);
  assertEquals(bucketStatuses, ["resolved"]);
});

// ── Detail where ─────────────────────────────────────────────────────────

Deno.test("buildPathologyDetailWhere - scope=all: id + cid + soft-delete", () => {
  const where = buildPathologyDetailWhere({
    pathologyId: "pa_1",
    condominiumId: "co_1",
    scope: "all",
  });
  const filters = andChildren(where(mockColumns, mockOps));
  assertEquals(filters.length, 3);
  assertEquals(hasEq(filters, "p.id", "pa_1"), true);
  assertEquals(hasEq(filters, "p.condominiumId", "co_1"), true);
  assertEquals(hasIsNull(filters, "p.deletedAt"), true);
});

Deno.test("buildPathologyDetailWhere - scope=public adiciona status != 'draft'", () => {
  const where = buildPathologyDetailWhere({
    pathologyId: "pa_1",
    condominiumId: "co_1",
    scope: "public",
  });
  const filters = andChildren(where(mockColumns, mockOps));
  assertEquals(filters.length, 4);
  const statuses = inArrayValues(filters, "p.status");
  assertEquals(statuses !== null, true);
  assertEquals((statuses as string[]).includes("draft"), false);
});

// ── Order by ─────────────────────────────────────────────────────────────

Deno.test("buildPathologyListOrderBy - detectedAt DESC, createdAt DESC", () => {
  const orderBy = buildPathologyListOrderBy();
  const result = orderBy(mockColumns, mockOps) as OpNode[];
  assertEquals(result.length, 2);
  assertEquals(result[0].kind, "desc");
  assertEquals(result[0].col, "p.detectedAt");
  assertEquals(result[1].col, "p.createdAt");
});
