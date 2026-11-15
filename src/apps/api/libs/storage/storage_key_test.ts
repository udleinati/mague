import { assertEquals } from "@std/assert";
import { buildStorageKey, shardOf } from "./storage_key.ts";

// ─── shardOf ─────────────────────────────────────────────────────────

Deno.test("shardOf: 2+ chars normais → primeiros 2 em minúsculas", () => {
  assertEquals(shardOf("ABCDEF"), "a/b");
  assertEquals(shardOf("xy_FFD"), "x/y");
});

Deno.test("shardOf: underscore conta como char válido", () => {
  assertEquals(shardOf("x_aaaaaaaa"), "x/_");
  assertEquals(shardOf("__abc"), "_/_");
});

Deno.test("shardOf: 1 char → segundo é '_' (padding)", () => {
  assertEquals(shardOf("z"), "z/_");
  assertEquals(shardOf("A"), "a/_");
});

Deno.test("shardOf: vazio → '_/_'", () => {
  assertEquals(shardOf(""), "_/_");
});

Deno.test("shardOf: chars fora de [a-zA-Z0-9_-] viram '_'", () => {
  assertEquals(shardOf("a@b#c"), "a/_");
  assertEquals(shardOf("@#"), "_/_");
  assertEquals(shardOf("é"), "_/_");
});

Deno.test("shardOf: hífen é válido", () => {
  assertEquals(shardOf("-A-B"), "-/a");
});

Deno.test("shardOf: dígitos válidos", () => {
  assertEquals(shardOf("123"), "1/2");
  assertEquals(shardOf("9z"), "9/z");
});

Deno.test("shardOf: case-insensitive collision - 'j...' e 'J...' colapsam no mesmo shard", () => {
  // Regressão: num FS case-insensitive, 'j/I' e 'J/D' colapsavam e partiam o
  // shard. Lowercased: imune à colisão (distribuição diferente).
  assertEquals(shardOf("jIaaaaaaaa"), "j/i");
  assertEquals(shardOf("JDaaaaaaaa"), "j/d");
  assertEquals(shardOf("FXaaaaaaaa"), "f/x");
  assertEquals(shardOf("N5aaaaaaaa"), "n/5");
});

// ─── buildStorageKey ─────────────────────────────────────────────────

Deno.test("buildStorageKey: formato canónico cid/entity/shard/parent/<id>-<file>", () => {
  assertEquals(
    buildStorageKey({
      entity: "tickets",
      condominiumId: "CD5678",
      parentId: "x_aaaaaaaa",
      attachmentId: "tat_00000001",
      filename: "avaria.png",
    }),
    "CD5678/tickets/x/_/x_aaaaaaaa/tat_00000001-avaria.png",
  );
});

Deno.test("buildStorageKey: cid começa o path (para backup/restore por condomínio)", () => {
  const key = buildStorageKey({
    entity: "charges",
    condominiumId: "AB1234",
    parentId: "ch_XY",
    attachmentId: "att_1",
    filename: "fatura.pdf",
  });
  assertEquals(key.startsWith("AB1234/"), true);
});

Deno.test("buildStorageKey: filenames com chars problemáticos passam intactos (caller sanitiza)", () => {
  // Documenta o contrato: o caller é responsável por sanitizar o filename
  // antes de chamar - buildStorageKey não faz nada.
  const key = buildStorageKey({
    entity: "tickets",
    condominiumId: "C",
    parentId: "p1",
    attachmentId: "a1",
    filename: "raw with spaces.png",
  });
  assertEquals(key.endsWith("a1-raw with spaces.png"), true);
});
