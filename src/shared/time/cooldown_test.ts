// WHY (Rule 9): única fonte da aritmética de janela para convite, cobrança e
// seguro - um bug no boundary (>= vs >), no sinal de remainingMs ou no caso null
// propaga-se aos três. Fixa: boundary estrito, remainingMs >= 0, null seguro.

import { assertEquals } from "@std/assert";
import { cooldown, cooldownEndsAt } from "./cooldown.ts";

const NOW = new Date("2026-06-03T10:00:00Z");
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

// ─── cooldownEndsAt ────────────────────────────────────────────────────

Deno.test("cooldownEndsAt: lastAt + janela", () => {
  const last = new Date("2026-06-03T10:00:00Z");
  assertEquals(cooldownEndsAt(last, 7)?.getTime(), last.getTime() + 7 * DAY);
});

Deno.test("cooldownEndsAt: null quando nunca houve evento", () => {
  assertEquals(cooldownEndsAt(null, 7), null);
});

Deno.test("cooldownEndsAt: data inválida devolve null", () => {
  assertEquals(cooldownEndsAt("não-é-data", 7), null);
});

Deno.test("cooldownEndsAt: aceita ISO string", () => {
  assertEquals(
    cooldownEndsAt("2026-06-03T10:00:00Z", 14)?.toISOString(),
    new Date(NOW.getTime() + 14 * DAY).toISOString(),
  );
});

// ─── cooldown ──────────────────────────────────────────────────────────

Deno.test("cooldown: nunca houve evento → inactivo, sem fim, 0", () => {
  assertEquals(cooldown(null, 7, NOW), { active: false, endsAt: null, remainingMs: 0 });
});

Deno.test("cooldown: dentro da janela → activo + remaining positivo", () => {
  const r = cooldown(daysAgo(2), 7, NOW); // faltam ~5 dias
  assertEquals(r.active, true);
  assertEquals(r.remainingMs, 5 * DAY);
  assertEquals(r.endsAt?.getTime(), daysAgo(2).getTime() + 7 * DAY);
});

Deno.test("cooldown: fora da janela → inactivo, remaining 0", () => {
  const r = cooldown(daysAgo(8), 7, NOW);
  assertEquals(r.active, false);
  assertEquals(r.remainingMs, 0);
});

Deno.test("cooldown: boundary exacto (now === endsAt) → inactivo", () => {
  // last = agora - 7 dias → endsAt === now → remaining 0 → inactivo (estrito).
  const r = cooldown(daysAgo(7), 7, NOW);
  assertEquals(r.active, false);
  assertEquals(r.remainingMs, 0);
});

Deno.test("cooldown: remainingMs nunca é negativo", () => {
  assertEquals(cooldown(daysAgo(100), 7, NOW).remainingMs, 0);
});
