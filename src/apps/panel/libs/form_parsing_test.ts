// Edge-cases que motivaram a centralização.

import { assertEquals } from "@std/assert";
import { parseFormBool, parseFormInt, parseFormString } from "./form_parsing.ts";

Deno.test("parseFormString: trim básico", () => {
  assertEquals(parseFormString({ name: "  hello  " }, "name"), "hello");
  assertEquals(parseFormString({ name: "" }, "name"), "");
  assertEquals(parseFormString({}, "name"), "");
});

Deno.test("parseFormString: emptyAsNull", () => {
  // Decisão: forms enviam strings vazias para campos opcionais. O caller
  // pode preferir null para limpar o campo na BD.
  assertEquals(parseFormString({ note: "" }, "note", { emptyAsNull: true }), null);
  assertEquals(parseFormString({}, "note", { emptyAsNull: true }), null);
  assertEquals(parseFormString({ note: "x" }, "note", { emptyAsNull: true }), "x");
});

Deno.test("parseFormString: default value", () => {
  assertEquals(parseFormString({}, "cat", { default: "other" }), "other");
  assertEquals(parseFormString({ cat: "" }, "cat", { default: "other" }), "other");
  assertEquals(parseFormString({ cat: "fancy" }, "cat", { default: "other" }), "fancy");
});

Deno.test("parseFormBool: checkbox HTML", () => {
  // Browsers enviam "on" por defeito quando o checkbox está marcado.
  assertEquals(parseFormBool({ x: "on" }, "x"), true);
  assertEquals(parseFormBool({ x: "true" }, "x"), true);
  assertEquals(parseFormBool({ x: "1" }, "x"), true);
  assertEquals(parseFormBool({ x: "TRUE" }, "x"), true);
  assertEquals(parseFormBool({ x: "" }, "x"), false);
  assertEquals(parseFormBool({ x: "off" }, "x"), false);
  assertEquals(parseFormBool({}, "x"), false);
});

Deno.test("parseFormInt: parsing + default", () => {
  assertEquals(parseFormInt({ n: "42" }, "n"), 42);
  assertEquals(parseFormInt({ n: "  42 " }, "n"), 42);
  assertEquals(parseFormInt({}, "n"), 0);
  assertEquals(parseFormInt({}, "n", { default: 100 }), 100);
  assertEquals(parseFormInt({ n: "abc" }, "n", { default: 99 }), 99);
  assertEquals(parseFormInt({ n: "" }, "n", { default: 7 }), 7);
});
