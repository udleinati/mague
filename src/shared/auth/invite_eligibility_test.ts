// WHY (Rule 9): impede inundar o condómino com convites e mantém o botão (UI)
// alinhado com o enforcement do API - ambos derivam destas funções. Os limites
// derivam de INVITE_RESEND_COOLDOWN_DAYS (não datas fixas): encodam a intenção
// "dentro/fora da janela", logo sobrevivem a afinações da janela.

import { assertEquals } from "@std/assert";
import {
  INVITE_RESEND_COOLDOWN_DAYS,
  inviteCooldownEndsAt,
  isInInviteResendCooldown,
} from "./invite_eligibility.ts";

const TODAY = new Date("2026-06-03T10:00:00Z");
const daysAgo = (n: number) => new Date(TODAY.getTime() - n * 86_400_000);

// ─── isInInviteResendCooldown ──────────────────────────────────────────

Deno.test("isInInviteResendCooldown: false quando nunca convidou (null)", () => {
  // Primeiro convite nunca deve estar bloqueado.
  assertEquals(isInInviteResendCooldown(null, TODAY), false);
});

Deno.test("isInInviteResendCooldown: true dentro da janela", () => {
  // Convite há (janela - 1) dias → ainda em cooldown.
  const last = daysAgo(INVITE_RESEND_COOLDOWN_DAYS - 1);
  assertEquals(isInInviteResendCooldown(last, TODAY), true);
});

Deno.test("isInInviteResendCooldown: false depois da janela completa", () => {
  // Convite há (janela + 1) dias → fora de cooldown.
  const last = daysAgo(INVITE_RESEND_COOLDOWN_DAYS + 1);
  assertEquals(isInInviteResendCooldown(last, TODAY), false);
});

Deno.test("isInInviteResendCooldown: aceita string ISO (vem do JSON da API)", () => {
  const last = daysAgo(INVITE_RESEND_COOLDOWN_DAYS - 1).toISOString();
  assertEquals(isInInviteResendCooldown(last, TODAY), true);
});

Deno.test("INVITE_RESEND_COOLDOWN_DAYS é um inteiro positivo", () => {
  // Guarda contra 0/negativo (desactivaria o cooldown silenciosamente).
  assertEquals(Number.isInteger(INVITE_RESEND_COOLDOWN_DAYS), true);
  assertEquals(INVITE_RESEND_COOLDOWN_DAYS > 0, true);
});

// ─── inviteCooldownEndsAt ──────────────────────────────────────────────

Deno.test("inviteCooldownEndsAt: null quando nunca convidou", () => {
  assertEquals(inviteCooldownEndsAt(null), null);
});

Deno.test("inviteCooldownEndsAt: último convite + janela", () => {
  const last = new Date("2026-06-03T10:00:00Z");
  const end = inviteCooldownEndsAt(last);
  assertEquals(
    end?.getTime(),
    last.getTime() + INVITE_RESEND_COOLDOWN_DAYS * 86_400_000,
  );
});

Deno.test("inviteCooldownEndsAt: data inválida devolve null", () => {
  assertEquals(inviteCooldownEndsAt("não-é-data"), null);
});
