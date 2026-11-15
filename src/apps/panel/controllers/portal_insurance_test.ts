// Agrupamento da cadeia de renovações no histórico do portal (B5 / ADR 0040).
// WHY: o `renewed_from_id` era gravado e projetado mas nunca aparecia. Sem
// agrupar, o histórico mostra a mesma cobertura uma vez por renovação, em linhas
// soltas, e o condómino não percebe que são a mesma apólice a continuar.

import { assertEquals } from "@std/assert";
import { groupByRenewalChain } from "./portal_insurance.ts";

/** Apólice mínima com o shape que o agrupador lê. */
const pol = (id: string, renewedFromId?: string) =>
  ({
    id,
    unitId: "u1",
    status: "active",
    kind: "active",
    can: {},
    renewedFromId: renewedFromId ?? null,
  }) as unknown as Parameters<typeof groupByRenewalChain>[0][number];

Deno.test("cadeia de 3 vigências → 1 entrada com 2 anteriores, da mais recente para a mais antiga", () => {
  // c renovou b, que renovou a. A entrada é a `c`; `a` e `b` ficam por baixo.
  const chains = groupByRenewalChain([pol("c", "b"), pol("b", "a"), pol("a")]);
  assertEquals(chains.length, 1);
  assertEquals(chains[0].policy.id, "c");
  assertEquals(chains[0].previous.map((p) => p.id), ["b", "a"]);
});

Deno.test("apólices sem linhagem ficam cada uma na sua entrada", () => {
  // Proprietário e inquilino com coberturas independentes (ADR 0017): não são
  // uma cadeia, são dois ramos.
  const chains = groupByRenewalChain([pol("x"), pol("y")]);
  assertEquals(chains.map((c) => c.policy.id), ["x", "y"]);
  assertEquals(chains.every((c) => c.previous.length === 0), true);
});

Deno.test("ordem de entrada não muda o resultado (a raiz do ramo é sempre a sucessora)", () => {
  const chains = groupByRenewalChain([pol("a"), pol("b", "a")]);
  assertEquals(chains.length, 1);
  assertEquals(chains[0].policy.id, "b");
  assertEquals(chains[0].previous.map((p) => p.id), ["a"]);
});

Deno.test("predecessor fora da lista não engole a entrada", () => {
  // A lista do portal está limitada a 100; se o predecessor não veio, a apólice
  // continua a ser mostrada (só não tem cadeia por baixo).
  const chains = groupByRenewalChain([pol("b", "desaparecida")]);
  assertEquals(chains.length, 1);
  assertEquals(chains[0].policy.id, "b");
  assertEquals(chains[0].previous, []);
});

Deno.test("ciclo em renewed_from_id não trava o agrupamento", () => {
  // Só possível por SQL manual, mas um loop infinito aqui pendurava o pedido.
  const chains = groupByRenewalChain([pol("a", "b"), pol("b", "a")]);
  assertEquals(chains.length, 0);
});

Deno.test("lista vazia → sem cadeias", () => {
  assertEquals(groupByRenewalChain([]), []);
});
