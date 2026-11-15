import { assertEquals, assertThrows } from "@std/assert";
import { hasPaymentPlanNote, paymentPlanCreateSchema } from "./payment_plan.ts";

// Plano com duas notas: a partilhada sai no email, a interna
// não. Basta uma das duas - mas um plano sem nenhuma não diz nada a ninguém.

Deno.test("plano: só nota interna é válido (a partilhada é opcional)", () => {
  const out = paymentPlanCreateSchema.parse({ internalNotes: "Ligou a pedir prazo" });
  assertEquals(out.internalNotes, "Ligou a pedir prazo");
  assertEquals(out.notes ?? null, null);
});

Deno.test("plano: só nota partilhada é válido", () => {
  const out = paymentPlanCreateSchema.parse({ notes: "6 prestações de 200 €" });
  assertEquals(out.notes, "6 prestações de 200 €");
});

Deno.test("plano: sem nenhuma nota é recusado", () => {
  assertThrows(() => paymentPlanCreateSchema.parse({}));
  assertThrows(() => paymentPlanCreateSchema.parse({ notes: null, internalNotes: null }));
});

Deno.test("plano: notas só com espaços contam como vazias (e gravam NULL)", () => {
  // Senão um espaço no textarea "partilhava" uma nota vazia no email.
  assertThrows(() => paymentPlanCreateSchema.parse({ notes: "   ", internalNotes: "\n" }));
  const out = paymentPlanCreateSchema.parse({ notes: "  ", internalNotes: "x" });
  assertEquals(out.notes, null);
});

Deno.test("hasPaymentPlanNote: decide sobre o plano combinado (update)", () => {
  assertEquals(hasPaymentPlanNote({ notes: null, internalNotes: "x" }), true);
  assertEquals(hasPaymentPlanNote({ notes: " ", internalNotes: null }), false);
});
