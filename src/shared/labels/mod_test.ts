// Unit tests para os labels canónicos. Correr:
//   deno test --allow-env src/shared/labels/mod_test.ts

import { assertEquals } from "@std/assert";
import { supplierLabel, supplierLabelMap, unitLabel, unitLabelMap } from "./mod.ts";

Deno.test("unitLabel: com identifier devolve 'designation - identifier'", () => {
  assertEquals(
    unitLabel({ id: "u1", designation: "1ºE", identifier: "Bloco A 1º Esq" }),
    "1ºE - Bloco A 1º Esq",
  );
});

Deno.test("unitLabel: sem identifier devolve só designation", () => {
  assertEquals(unitLabel({ id: "u1", designation: "1ºE", identifier: null }), "1ºE");
  assertEquals(unitLabel({ id: "u1", designation: "1ºE" }), "1ºE");
});

Deno.test("unitLabel: identifier vazio trata como ausente", () => {
  assertEquals(unitLabel({ id: "u1", designation: "1ºE", identifier: "" }), "1ºE");
});

Deno.test("unitLabel: sem designation cai para id (defensivo)", () => {
  assertEquals(unitLabel({ id: "u_xyz", designation: "" }), "u_xyz");
});

Deno.test("unitLabelMap: constrói lookup id → label", () => {
  const m = unitLabelMap([
    { id: "u1", designation: "1ºE", identifier: "Bloco A" },
    { id: "u2", designation: "Garagem 5", identifier: null },
  ]);
  assertEquals(m.get("u1"), "1ºE - Bloco A");
  assertEquals(m.get("u2"), "Garagem 5");
  assertEquals(m.size, 2);
});

Deno.test("supplierLabel: devolve nome", () => {
  assertEquals(supplierLabel({ id: "s1", name: "EDP" }), "EDP");
});

Deno.test("supplierLabelMap: constrói lookup id → name", () => {
  const m = supplierLabelMap([
    { id: "s1", name: "EDP" },
    { id: "s2", name: "Águas de Lisboa" },
  ]);
  assertEquals(m.get("s1"), "EDP");
  assertEquals(m.get("s2"), "Águas de Lisboa");
});
