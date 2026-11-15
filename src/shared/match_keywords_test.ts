// Unit tests para o match de keywords contra descrições bancárias.
// Correr:  deno test --allow-env src/shared/match_keywords_test.ts

import { assertEquals } from "@std/assert";
import { findKeywordMatches, normalize } from "./match_keywords.ts";

// ── normalize ───────────────────────────────────────────────────────────────

Deno.test("normalize: lowercase + remove diacríticos (NFD)", () => {
  // O input bancário traz acentos/maiúsculas inconsistentes; o match tem de os ignorar.
  assertEquals(normalize("Beatriz Leitão"), "beatriz leitao");
  assertEquals(normalize("São JOÃO"), "sao joao");
  assertEquals(normalize("Éç"), "ec");
});

Deno.test("normalize: null/undefined → string vazia", () => {
  assertEquals(normalize(null), "");
  assertEquals(normalize(undefined), "");
});

// ── findKeywordMatches ───────────────────────────────────────────────────────

Deno.test("findKeywordMatches: keyword é substring da descrição (accent-insensitive)", () => {
  const items: Array<{ id: string; matchKeywords?: readonly string[] | null }> = [
    { id: "a", matchKeywords: ["beatriz leitao"] },
    { id: "b", matchKeywords: ["joão silva"] },
  ];
  const r = findKeywordMatches("TRF DE BEATRIZ LEITÃO REF QUOTA", items);
  assertEquals(r.map((x) => x.id), ["a"]);
});

Deno.test("findKeywordMatches: descrição vazia/null nunca bate", () => {
  const items = [{ id: "a", matchKeywords: ["x"] }];
  assertEquals(findKeywordMatches("", items), []);
  assertEquals(findKeywordMatches(null, items), []);
  assertEquals(findKeywordMatches(undefined, items), []);
});

Deno.test("findKeywordMatches: keyword vazia ou ausente nunca bate", () => {
  // Uma keyword "" daria substring trivial de qualquer descrição: tem de ser rejeitada.
  const items: Array<{ id: string; matchKeywords?: readonly string[] | null }> = [
    { id: "a", matchKeywords: [""] },
    { id: "b", matchKeywords: null },
    { id: "c" },
  ];
  assertEquals(findKeywordMatches("qualquer descrição longa", items), []);
});

Deno.test("findKeywordMatches: basta UMA das várias keywords bater", () => {
  const items = [{ id: "a", matchKeywords: ["xpto", "quota"] }];
  const r = findKeywordMatches("pagamento de quota mensal", items);
  assertEquals(r.length, 1);
});
