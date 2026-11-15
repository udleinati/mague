import { assertEquals } from "@std/assert";
import { parseLimit, parsePageParams } from "./pagination.ts";

Deno.test("parseLimit - undefined → default", () => {
  assertEquals(parseLimit(undefined, { default: 100, max: 1000 }), 100);
});

Deno.test("parseLimit - string vazia → default", () => {
  assertEquals(parseLimit("", { default: 100, max: 1000 }), 100);
});

Deno.test("parseLimit - valor válido devolve parsed", () => {
  assertEquals(parseLimit("50", { default: 100, max: 1000 }), 50);
});

Deno.test("parseLimit - valor acima de max é capado", () => {
  assertEquals(parseLimit("9999", { default: 100, max: 1000 }), 1000);
});

Deno.test("parseLimit - zero/negativos → default", () => {
  assertEquals(parseLimit("0", { default: 100, max: 1000 }), 100);
  assertEquals(parseLimit("-5", { default: 100, max: 1000 }), 100);
});

Deno.test("parseLimit - não-numérico → default", () => {
  assertEquals(parseLimit("abc", { default: 100, max: 1000 }), 100);
});

Deno.test("parsePageParams - sem page → page=null, offset=0", () => {
  const p = parsePageParams(undefined, undefined, { defaultPerPage: 50, maxPerPage: 500 });
  assertEquals(p, { page: null, perPage: 50, offset: 0 });
});

Deno.test("parsePageParams - page=1 → offset=0", () => {
  const p = parsePageParams("1", "20", { defaultPerPage: 50, maxPerPage: 500 });
  assertEquals(p, { page: 1, perPage: 20, offset: 0 });
});

Deno.test("parsePageParams - page=3 perPage=20 → offset=40", () => {
  const p = parsePageParams("3", "20", { defaultPerPage: 50, maxPerPage: 500 });
  assertEquals(p, { page: 3, perPage: 20, offset: 40 });
});

Deno.test("parsePageParams - perPage acima de max é capado", () => {
  const p = parsePageParams("1", "9999", { defaultPerPage: 50, maxPerPage: 500 });
  assertEquals(p.perPage, 500);
});

Deno.test("parsePageParams - page=0 vira 1", () => {
  const p = parsePageParams("0", "20", { defaultPerPage: 50, maxPerPage: 500 });
  assertEquals(p.page, 1);
});
