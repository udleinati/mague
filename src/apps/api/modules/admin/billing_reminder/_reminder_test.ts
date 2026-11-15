import { assertEquals } from "@std/assert";
import { billingReminderSubject } from "./_reminder.ts";

// O assunto é a primeira coisa que o condómino lê: quem está a cumprir um plano
// não pode receber "Quotas em atraso" (ADR 0039).
Deno.test("assunto: fração em plano fala do plano, não de atraso", () => {
  const subject = billingReminderSubject({
    condoName: "Edifício X",
    unitLabel: "A",
    inPaymentPlan: true,
  });
  assertEquals(subject, "Plano de pagamento: valores pendentes - Edifício X, fração A");
});

Deno.test("assunto: fração sem plano mantém o assunto de quotas em atraso", () => {
  const subject = billingReminderSubject({
    condoName: "Edifício X",
    unitLabel: "A",
    inPaymentPlan: false,
  });
  assertEquals(subject, "Quotas em atraso - Edifício X, fração A");
});
