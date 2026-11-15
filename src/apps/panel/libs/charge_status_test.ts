// Testes da regra canónica do "Vencido" (ADR 0037). Cada caso encode o
// PORQUÊ: o status gravado mente nos dois sentidos e o cutoff é quem manda.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { chargeStatusBadge, isChargeOverdue } from "./charge_status.ts";
import { render } from "$panel/render.ts";

const CUTOFF = "2026-05-31";

Deno.test("overdue gravado SEM cutoff não é Vencido (não acusar atraso sem conciliação afirmada)", () => {
  const c = { status: "overdue", dueDate: "2026-01-10", openAmount: 1000 };
  assertEquals(isChargeOverdue(c, null), false);
  assertEquals(chargeStatusBadge(c, null).label, "Aberto");
});

Deno.test("open gravado com due_date <= cutoff e saldo aberto É Vencido (gravado está obsoleto)", () => {
  const c = { status: "open", dueDate: "2026-04-01", openAmount: 1000 };
  assertEquals(isChargeOverdue(c, CUTOFF), true);
  assertEquals(chargeStatusBadge(c, CUTOFF), { label: "Vencido", tone: "error" });
});

Deno.test("due_date depois do cutoff não é Vencido mesmo que já tenha passado no calendário", () => {
  // O admin só conciliou até 31/05 - uma quota de 15/06 pode já estar paga
  // no banco sem o sistema saber. Não acusar.
  const c = { status: "open", dueDate: "2026-06-15", openAmount: 1000 };
  assertEquals(isChargeOverdue(c, CUTOFF), false);
});

Deno.test("sem saldo aberto nunca é Vencido", () => {
  const c = { status: "overdue", dueDate: "2026-01-10", openAmount: 0 };
  assertEquals(isChargeOverdue(c, CUTOFF), false);
});

Deno.test("paid e cancelled têm precedência absoluta", () => {
  assertEquals(
    chargeStatusBadge({ status: "paid", dueDate: "2026-01-01", openAmount: 0 }, CUTOFF),
    { label: "Pago", tone: "success" },
  );
  assertEquals(
    chargeStatusBadge({ status: "cancelled", dueDate: "2026-01-01", openAmount: 500 }, CUTOFF),
    { label: "Cancelado", tone: "muted" },
  );
});

Deno.test("partial dentro do prazo é Parcial; partial vencida é Vencido", () => {
  const dentroDoPrazo = { status: "partial", dueDate: "2026-06-15", openAmount: 500 };
  assertEquals(chargeStatusBadge(dentroDoPrazo, CUTOFF), { label: "Parcial", tone: "warning" });

  const vencida = { status: "partial", dueDate: "2026-04-01", openAmount: 500 };
  assertEquals(chargeStatusBadge(vencida, CUTOFF), { label: "Vencido", tone: "error" });
});

Deno.test("openAmount como string (API JSON) é tratado como número", () => {
  const c = { status: "open", dueDate: "2026-04-01", openAmount: "1000" };
  assertEquals(isChargeOverdue(c, CUTOFF), true);
});

Deno.test("wiring: charge_status.vto renderiza o estado efetivo via helper injetado", async () => {
  // Prova end-to-end do fix: charge gravada como "open" mas vencida pela
  // regra do cutoff tem de aparecer como Vencido no partial.
  const html = await render("partials/charge_status.vto", {
    c: { status: "open", dueDate: "2026-04-01", openAmount: 1000 },
    cutoff: CUTOFF,
  });
  assertStringIncludes(html, "Vencido");
  assertStringIncludes(html, "bg-error");
});

Deno.test("paidLabel/openLabel permitem contexto de créditos (Aplicado / Por aplicar)", () => {
  const paga = { status: "paid", dueDate: null, openAmount: 0 };
  assertEquals(chargeStatusBadge(paga, CUTOFF, { paidLabel: "Aplicado" }).label, "Aplicado");

  const aberta = { status: "open", dueDate: null, openAmount: 500 };
  assertEquals(
    chargeStatusBadge(aberta, CUTOFF, { openLabel: "Por aplicar" }).label,
    "Por aplicar",
  );
});
