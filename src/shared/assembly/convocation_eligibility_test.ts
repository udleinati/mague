// WHY (Rule 9): o cooldown por pessoa decide se "Reenviar" está bloqueado e se
// o 422 COOLDOWN_ACTIVE dispara. A aritmética é testada em `cooldown_test.ts`;
// aqui fixamos o CONTRATO do seam: janela de 1 dia, boundary estrito, null/data
// inválida = nunca enviada. Se a constante mudar de 1, falha de propósito.

import { assertEquals } from "@std/assert";
import {
  CONVOCATION_COOLDOWN_DAYS,
  convocationCooldownEndsAt,
  isInConvocationCooldown,
} from "./convocation_eligibility.ts";

const NOW = new Date("2026-06-04T10:00:00Z");
const DAY = 86_400_000;
const hoursAgo = (n: number) => new Date(NOW.getTime() - n * 3_600_000);

Deno.test("CONVOCATION_COOLDOWN_DAYS é 1 (janela de 24h)", () => {
  assertEquals(CONVOCATION_COOLDOWN_DAYS, 1);
});

Deno.test("isInConvocationCooldown: dentro da janela (enviada há 2h) -> ativo", () => {
  assertEquals(isInConvocationCooldown(hoursAgo(2), NOW), true);
});

Deno.test("isInConvocationCooldown: fora da janela (enviada há 25h) -> inativo", () => {
  assertEquals(isInConvocationCooldown(hoursAgo(25), NOW), false);
});

Deno.test("isInConvocationCooldown: boundary exato (now === endsAt) -> inativo", () => {
  // Enviada há exatamente 24h -> endsAt === now -> remaining 0 -> inativo (estrito).
  assertEquals(isInConvocationCooldown(hoursAgo(24), NOW), false);
});

Deno.test("isInConvocationCooldown: nunca enviada (null) -> inativo", () => {
  assertEquals(isInConvocationCooldown(null, NOW), false);
});

Deno.test("isInConvocationCooldown: data inválida -> inativo (tratada como nunca)", () => {
  assertEquals(isInConvocationCooldown("não-é-data", NOW), false);
});

Deno.test("isInConvocationCooldown: aceita ISO string", () => {
  assertEquals(isInConvocationCooldown(hoursAgo(2).toISOString(), NOW), true);
});

Deno.test("convocationCooldownEndsAt: último envio + 1 dia", () => {
  const last = hoursAgo(2);
  assertEquals(convocationCooldownEndsAt(last)?.getTime(), last.getTime() + DAY);
});

Deno.test("convocationCooldownEndsAt: null quando nunca enviada", () => {
  assertEquals(convocationCooldownEndsAt(null), null);
});

Deno.test("convocationCooldownEndsAt: null quando data inválida", () => {
  assertEquals(convocationCooldownEndsAt("xpto"), null);
});
