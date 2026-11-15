// Unit tests para os helpers de paginação do panel.
// Correr:  deno test --allow-env src/apps/panel/libs/pagination_test.ts

import { assertEquals } from "@std/assert";
import { buildPaginationMeta, paginationParamsFromQuery } from "./pagination.ts";

// ── paginationParamsFromQuery ────────────────────────────────────────────────

Deno.test("paginationParamsFromQuery: defaults sem params (page 1, perPage 500)", () => {
  const r = paginationParamsFromQuery({});
  assertEquals(r.pageNum, 1);
  assertEquals(r.perPageNum, 500);
});

Deno.test("paginationParamsFromQuery: page inválida (NaN/0/negativa) cai para 1", () => {
  assertEquals(paginationParamsFromQuery({ page: "abc" }).pageNum, 1);
  assertEquals(paginationParamsFromQuery({ page: "0" }).pageNum, 1);
  assertEquals(paginationParamsFromQuery({ page: "-5" }).pageNum, 1);
});

Deno.test("paginationParamsFromQuery: perPage limitado a [10, 1000]", () => {
  assertEquals(paginationParamsFromQuery({ perPage: "5" }).perPageNum, 10);
  assertEquals(paginationParamsFromQuery({ perPage: "99999" }).perPageNum, 1000);
  assertEquals(paginationParamsFromQuery({ perPage: "250" }).perPageNum, 250);
});

// ── buildPaginationMeta ──────────────────────────────────────────────────────

Deno.test("buildPaginationMeta: total=0 → start 0, sem prev/next", () => {
  const m = buildPaginationMeta({ page: 1, perPage: 500, total: 0, totalPages: 0 }, {});
  assertEquals(m.start, 0);
  assertEquals(m.end, 0);
  assertEquals(m.hasPrev, false);
  assertEquals(m.hasNext, false);
});

Deno.test("buildPaginationMeta: página intermédia calcula start/end e prev/next", () => {
  const m = buildPaginationMeta({ page: 2, perPage: 50, total: 130, totalPages: 3 }, {});
  assertEquals(m.start, 51);
  assertEquals(m.end, 100);
  assertEquals(m.hasPrev, true);
  assertEquals(m.hasNext, true);
});

Deno.test("buildPaginationMeta: última página → end = total, sem next", () => {
  const m = buildPaginationMeta({ page: 3, perPage: 50, total: 130, totalPages: 3 }, {});
  assertEquals(m.start, 101);
  assertEquals(m.end, 130);
  assertEquals(m.hasNext, false);
});

Deno.test("buildPaginationMeta: janela ±2 com âncoras 1/última e ellipsis dos dois lados", () => {
  const m = buildPaginationMeta({ page: 10, perPage: 10, total: 200, totalPages: 20 }, {});
  const nums = m.pageLinks.map((l) => (l.kind === "page" ? l.num : "…"));
  // âncoras nas pontas
  assertEquals(nums[0], 1);
  assertEquals(nums[nums.length - 1], 20);
  // janela à volta da atual
  assertEquals(nums.includes(8), true);
  assertEquals(nums.includes(12), true);
  // ellipsis presente
  assertEquals(nums.includes("…"), true);
  // página atual marcada
  const current = m.pageLinks.find((l) => l.kind === "page" && l.isCurrent);
  assertEquals(current && current.kind === "page" ? current.num : null, 10);
});

Deno.test("buildPaginationMeta: querystring preserva params da lista e ignora os outros", () => {
  const m = buildPaginationMeta(
    { page: 2, perPage: 50, total: 130, totalPages: 3 },
    { year: "2025", status: "open", ignored: "x" },
  );
  assertEquals(m.nextQs?.includes("year=2025"), true);
  assertEquals(m.nextQs?.includes("status=open"), true);
  assertEquals(m.nextQs?.includes("page=3"), true); // page substituída, não preservada
  assertEquals(m.nextQs?.includes("ignored"), false); // chave fora da allowlist
});
