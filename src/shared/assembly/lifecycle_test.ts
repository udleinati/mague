// Testes da máquina de vida da assembleia (plano convocatoria-assembleia, B).
//
// Pure functions - sem DB, sem HTTP. WHY (Rule 9): a regra "o que foi
// convocado trava ao passar a `scheduled`, mas o registo da reunião continua
// editável até `held`" é a invariante legal do feature (Art. 1430-1434 CC).
// Estes testes falham se essa regra mudar - tanto o enforcement do API como
// os gates da UI derivam destas mesmas funções (fonte de verdade única).

import { assertEquals } from "@std/assert";
import {
  ASSEMBLY_TRANSITIONS,
  canEditAgenda,
  canRecordMeeting,
  canSendConvocation,
  isValidAssemblyTransition,
  meetingDateReached,
} from "./lifecycle.ts";

// ─── canEditAgenda: ordem do dia + textos da convocatória ───────────────────

Deno.test("canEditAgenda: só em rascunho", () => {
  // A ordem do dia monta-se em `draft`; convocar trava-a.
  assertEquals(canEditAgenda("draft"), true);
  assertEquals(canEditAgenda("scheduled"), false);
  assertEquals(canEditAgenda("held"), false);
  assertEquals(canEditAgenda("cancelled"), false);
});

Deno.test("canEditAgenda: null/indefinido não destrava", () => {
  assertEquals(canEditAgenda(null), false);
  assertEquals(canEditAgenda(undefined), false);
});

// ─── canRecordMeeting: presenças, votos, assinatura, acta ───────────────────

Deno.test("canRecordMeeting: só quando convocada", () => {
  // O que aconteceu na reunião regista-se com a assembleia já convocada;
  // em rascunho ainda não há reunião, depois de `held` está selada.
  assertEquals(canRecordMeeting("scheduled"), true);
  assertEquals(canRecordMeeting("draft"), false);
  assertEquals(canRecordMeeting("held"), false);
  assertEquals(canRecordMeeting("cancelled"), false);
});

// ─── canSendConvocation: envio bloqueado em rascunho ────────────────────────

Deno.test("canSendConvocation: bloqueado só em rascunho", () => {
  // Em `draft` a convocatória ainda pode mudar - envio bloqueado.
  assertEquals(canSendConvocation("draft"), false);
  assertEquals(canSendConvocation("scheduled"), true);
  assertEquals(canSendConvocation("held"), true);
  assertEquals(canSendConvocation("cancelled"), true);
});

// ─── Transições válidas ─────────────────────────────────────────────────────

Deno.test("isValidAssemblyTransition: ciclo draft<->scheduled->held", () => {
  // Convocar e retificar são livres entre rascunho e convocada.
  assertEquals(isValidAssemblyTransition("draft", "scheduled"), true);
  assertEquals(isValidAssemblyTransition("scheduled", "draft"), true);
  assertEquals(isValidAssemblyTransition("scheduled", "held"), true);
});

Deno.test("isValidAssemblyTransition: cancelar a partir de qualquer estado vivo", () => {
  assertEquals(isValidAssemblyTransition("draft", "cancelled"), true);
  assertEquals(isValidAssemblyTransition("scheduled", "cancelled"), true);
  assertEquals(isValidAssemblyTransition("held", "cancelled"), true);
});

Deno.test("isValidAssemblyTransition: rejeita saltos e estados terminais", () => {
  // Não se salta convocatória (draft -> held), nem se ressuscita.
  assertEquals(isValidAssemblyTransition("draft", "held"), false);
  assertEquals(isValidAssemblyTransition("held", "scheduled"), false);
  assertEquals(isValidAssemblyTransition("held", "draft"), false);
  assertEquals(isValidAssemblyTransition("cancelled", "draft"), false);
});

Deno.test("isValidAssemblyTransition: estados inválidos/nulos → false", () => {
  assertEquals(isValidAssemblyTransition(null, "scheduled"), false);
  assertEquals(isValidAssemblyTransition("scheduled", null), false);
  assertEquals(isValidAssemblyTransition("bogus", "held"), false);
});

Deno.test("ASSEMBLY_TRANSITIONS: cancelled é terminal", () => {
  assertEquals(ASSEMBLY_TRANSITIONS.cancelled.length, 0);
});

// ─── meetingDateReached: fase de registo abre na data da reunião ────────────
// WHY (Rule 9): o painel só revela presenças/deliberar/acta a partir da data
// agendada. Comparação ao nível do dia; data passada (acta histórica) abre já.

Deno.test("meetingDateReached: dia da reunião ainda no futuro → false", () => {
  const now = new Date("2026-06-04T10:00:00Z");
  assertEquals(meetingDateReached("2026-06-24T19:00:00Z", now), false);
});

Deno.test("meetingDateReached: no próprio dia (antes da hora) → true", () => {
  // Reunião às 19:00; admin prepara presenças de manhã - já deve abrir.
  const now = new Date("2026-06-24T09:00:00Z");
  assertEquals(meetingDateReached("2026-06-24T19:00:00Z", now), true);
});

Deno.test("meetingDateReached: data no passado (acta histórica) → true", () => {
  const now = new Date("2026-06-04T10:00:00Z");
  assertEquals(meetingDateReached("2024-01-15T19:00:00Z", now), true);
});

Deno.test("meetingDateReached: sem data → false", () => {
  const now = new Date("2026-06-04T10:00:00Z");
  assertEquals(meetingDateReached(null, now), false);
  assertEquals(meetingDateReached(undefined, now), false);
  assertEquals(meetingDateReached("", now), false);
});
