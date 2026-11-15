// Testes para a elegibilidade de envio de Lembrete de cobrança.
//
// Pure functions - sem DB, sem HTTP. Cada teste corresponde a uma regra de
// negócio do ADR 0028: cooldown 14d desde último envio bem-sucedido, e
// guard de "conciliação não está estagnada".

import { assertEquals } from "@std/assert";
import {
  BILLING_REMINDER_COOLDOWN_DAYS,
  billingReminderCooldownEndsAt,
  canSendBillingReminder,
  isInBillingReminderCooldown,
} from "./reminder_eligibility.ts";

// ─── canSendBillingReminder ────────────────────────────────────────────

Deno.test("canSendBillingReminder: bloqueia quando nunca reconciliou (NULL)", () => {
  const r = canSendBillingReminder({
    reconciledThroughDate: null,
    today: new Date("2026-05-20T10:00:00Z"),
  });
  assertEquals(r.ok, false);
  assertEquals(r.reason, "never_reconciled");
});

Deno.test("canSendBillingReminder: bloqueia quando reconciliou há > 3 dias", () => {
  // today = 2026-05-20, reconciliado até 2026-05-16 = 4 dias atrás (> 3).
  const r = canSendBillingReminder({
    reconciledThroughDate: "2026-05-16",
    today: new Date("2026-05-20T10:00:00Z"),
  });
  assertEquals(r.ok, false);
  assertEquals(r.reason, "reconciliation_stale");
});

Deno.test("canSendBillingReminder: permite no boundary (exatamente 3 dias)", () => {
  // today = 2026-05-20, reconciliado até 2026-05-17 = 3 dias atrás (= guard).
  // O guard é "≤ 3 dias permite", "> 3 dias bloqueia" - boundary inclui.
  const r = canSendBillingReminder({
    reconciledThroughDate: "2026-05-17",
    today: new Date("2026-05-20T10:00:00Z"),
  });
  assertEquals(r.ok, true);
  assertEquals(r.reason, undefined);
});

Deno.test("canSendBillingReminder: permite no mesmo dia da reconciliação", () => {
  const r = canSendBillingReminder({
    reconciledThroughDate: "2026-05-20",
    today: new Date("2026-05-20T10:00:00Z"),
  });
  assertEquals(r.ok, true);
});

Deno.test("canSendBillingReminder: permite quando reconciliado no futuro (idempotência)", () => {
  // Caso degenerado: admin marcou reconciledThroughDate amanhã. Não
  // bloquear - é responsabilidade do form de edit validar inputs.
  const r = canSendBillingReminder({
    reconciledThroughDate: "2026-05-21",
    today: new Date("2026-05-20T10:00:00Z"),
  });
  assertEquals(r.ok, true);
});

// ─── isInBillingReminderCooldown ───────────────────────────────────────

Deno.test("isInBillingReminderCooldown: false quando nunca enviou (null)", () => {
  const r = isInBillingReminderCooldown(null, new Date("2026-05-20T10:00:00Z"));
  assertEquals(r, false);
});

Deno.test("isInBillingReminderCooldown: true dentro dos 14 dias", () => {
  // last sent = 2026-05-10, today = 2026-05-20 = 10 dias depois (< 14).
  const r = isInBillingReminderCooldown(
    new Date("2026-05-10T10:00:00Z"),
    new Date("2026-05-20T10:00:00Z"),
  );
  assertEquals(r, true);
});

Deno.test("isInBillingReminderCooldown: false após 14 dias completos", () => {
  // last sent = 2026-05-06T10:00, today = 2026-05-20T10:01 = 14 dias + 1 min.
  // Aceita >= 14 dias como fora de cooldown (limite exato vs estricto).
  const r = isInBillingReminderCooldown(
    new Date("2026-05-06T10:00:00Z"),
    new Date("2026-05-20T10:01:00Z"),
  );
  assertEquals(r, false);
});

Deno.test("isInBillingReminderCooldown: aceita string ISO", () => {
  // O caller pode passar timestamp como string (do JSON da API) ou Date.
  const r = isInBillingReminderCooldown(
    "2026-05-19T10:00:00Z",
    new Date("2026-05-20T10:00:00Z"),
  );
  assertEquals(r, true);
});

// ─── billingReminderCooldownEndsAt ─────────────────────────────────────

Deno.test("billingReminderCooldownEndsAt: null quando nunca enviou", () => {
  assertEquals(billingReminderCooldownEndsAt(null), null);
});

Deno.test("billingReminderCooldownEndsAt: último envio + janela", () => {
  const last = new Date("2026-05-20T10:00:00Z");
  const end = billingReminderCooldownEndsAt(last);
  assertEquals(
    end?.getTime(),
    last.getTime() + BILLING_REMINDER_COOLDOWN_DAYS * 86_400_000,
  );
});

Deno.test("billingReminderCooldownEndsAt: data inválida devolve null", () => {
  assertEquals(billingReminderCooldownEndsAt("não-é-data"), null);
});
