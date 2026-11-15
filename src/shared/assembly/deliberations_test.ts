// Testes da completude das deliberações antes de selar a ata (`held`).
//
// Pure function - sem DB, sem HTTP. WHY (Rule 9): a regra "não se sela uma ata
// como realizada com pontos da ordem do dia por deliberar" é a invariante que
// impede marcar uma assembleia como realizada sem registar os resultados das
// votações (Art. 1432.º/1433.º CC). O enforcement no API (update de status)
// deriva desta função - se a regra mudar, estes testes falham.

import { assertEquals } from "@std/assert";
import {
  type DeliberableItem,
  findPendingDeliberations,
  hasPendingDeliberations,
} from "./deliberations.ts";

const item = (over: Partial<DeliberableItem>): DeliberableItem => ({
  sequence: 1,
  subject: "Ponto",
  itemType: null,
  approved: null,
  refId: null,
  ...over,
});

Deno.test("ponto votável sem resultado (approved=null) bloqueia", () => {
  // Caso real: ponto 'Aprovar orçamento' com orçamento ligado mas nunca votado.
  const pending = findPendingDeliberations([
    item({ sequence: 1, itemType: "info" }),
    item({ sequence: 2, itemType: "approve_budget", refId: "b1", approved: null }),
    item({ sequence: 3, itemType: "info" }),
  ]);
  assertEquals(pending.undeliberated.map((i) => i.sequence), [2]);
  assertEquals(pending.missingBudgetRef.length, 0);
  assertEquals(hasPendingDeliberations(pending), true);
});

Deno.test("pontos 'info' não se votam - nunca contam como pendentes", () => {
  const pending = findPendingDeliberations([
    item({ sequence: 1, itemType: "info", approved: null }),
    item({ sequence: 2, itemType: "info", approved: null }),
  ]);
  assertEquals(hasPendingDeliberations(pending), false);
});

Deno.test("todos os pontos votáveis deliberados (true/false) - sem pendências", () => {
  const pending = findPendingDeliberations([
    item({ sequence: 1, itemType: "approve_budget", refId: "b1", approved: true }),
    item({ sequence: 2, itemType: "other", approved: false }),
    item({ sequence: 3, itemType: "info" }),
  ]);
  assertEquals(hasPendingDeliberations(pending), false);
});

Deno.test("'Aprovar orçamento' deliberado mas sem orçamento indicado bloqueia", () => {
  // Já votado (approved=true) mas refId em falta - "apontar o orçamento".
  const pending = findPendingDeliberations([
    item({ sequence: 1, itemType: "approve_budget", approved: true, refId: null }),
  ]);
  assertEquals(pending.undeliberated.length, 0);
  assertEquals(pending.missingBudgetRef.map((i) => i.sequence), [1]);
  assertEquals(hasPendingDeliberations(pending), true);
});

Deno.test("orçamento por deliberar E sem refId só aparece uma vez (em undeliberated)", () => {
  // approved=null + refId=null: já é capturado por 'por deliberar'; não duplica
  // em missingBudgetRef (que só olha aos já deliberados).
  const pending = findPendingDeliberations([
    item({ sequence: 1, itemType: "approve_budget", approved: null, refId: null }),
  ]);
  assertEquals(pending.undeliberated.map((i) => i.sequence), [1]);
  assertEquals(pending.missingBudgetRef.length, 0);
});

Deno.test("'other' e tipo null são votáveis (exigem resultado)", () => {
  const pending = findPendingDeliberations([
    item({ sequence: 1, itemType: "other", approved: null }),
    item({ sequence: 2, itemType: null, approved: null }),
  ]);
  assertEquals(pending.undeliberated.map((i) => i.sequence), [1, 2]);
});

Deno.test("ordem do dia vazia - sem pendências", () => {
  assertEquals(hasPendingDeliberations(findPendingDeliberations([])), false);
});
