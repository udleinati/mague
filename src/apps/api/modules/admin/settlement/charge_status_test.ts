import { assertEquals } from "@std/assert";
import { computeChargeStatus } from "./charge_status.ts";

// Regra pura do status gravado da charge (fonte única; não há gémea
// SQL). A regra de negócio:
//   • cancelled/disputed → manter (terminal states, não dependem de montantes)
//   • open <= 0 → paid (settled cobre tudo)
//   • settled > 0 com open > 0 → partial
//   • dueDate ultrapassada → overdue
//   • caso contrário → open
//
// Inverter qualquer destas regras parte cobranças downstream (ledger,
// bank balance views, panel KPIs). Tests pinning a invariante.

const TODAY = new Date("2026-05-08T00:00:00Z");

Deno.test("cancelled é terminal - montantes ignorados", () => {
  assertEquals(computeChargeStatus(0, 0, "2026-01-01", "cancelled", TODAY), "cancelled");
  assertEquals(computeChargeStatus(100, 100, "2026-01-01", "cancelled", TODAY), "cancelled");
});

Deno.test("disputed é terminal", () => {
  assertEquals(computeChargeStatus(0, 50, null, "disputed", TODAY), "disputed");
});

Deno.test("open <= 0 → paid (totalmente settled)", () => {
  assertEquals(computeChargeStatus(100, 0, "2026-04-01", "open", TODAY), "paid");
});

Deno.test("open=0 com dueDate vencida - paid (paid > overdue)", () => {
  // Charge totalmente paga não pode ser overdue mesmo se a dueDate passou.
  assertEquals(computeChargeStatus(100, 0, "2024-01-01", "open", TODAY), "paid");
});

Deno.test("settled > 0 e open > 0 → partial", () => {
  assertEquals(computeChargeStatus(40, 60, "2026-06-01", "open", TODAY), "partial");
});

Deno.test("partial > overdue (mesmo com dueDate vencida)", () => {
  // Se já houve algum settled, status é partial - não overdue.
  assertEquals(computeChargeStatus(20, 80, "2024-01-01", "open", TODAY), "partial");
});

Deno.test("dueDate < today (não settled) → overdue", () => {
  assertEquals(computeChargeStatus(0, 100, "2026-01-01", "open", TODAY), "overdue");
});

Deno.test("dueDate = today → ainda open (boundary)", () => {
  // O check é `dueDate < today` (strict). Charges que vencem hoje são open.
  assertEquals(computeChargeStatus(0, 100, "2026-05-08", "open", TODAY), "open");
});

Deno.test("dueDate null (sem prazo) → open mesmo com tempo decorrido", () => {
  assertEquals(computeChargeStatus(0, 100, null, "open", TODAY), "open");
});

Deno.test("dueDate futura → open", () => {
  assertEquals(computeChargeStatus(0, 100, "2027-01-01", "open", TODAY), "open");
});

Deno.test("status corrente arbitrário (`partial`) não impede recomputação", () => {
  // Quando recomputas após settle adicional, o status anterior não tranca:
  // se agora open=0, vira paid mesmo vindo de partial.
  assertEquals(computeChargeStatus(100, 0, "2026-01-01", "partial", TODAY), "paid");
});
