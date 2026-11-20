// Regras de destinatário do recibo. O PDF ("Recebido de") e o email saem destes valores, por isso
// um erro aqui põe o nome errado num documento legal ou manda o recibo à pessoa errada.

import { assertEquals, assertThrows } from "@std/assert";
import { AppError } from "$api/libs/error/app_error.ts";
import {
  parseRecipientChoice,
  type RecipientCandidate,
  resolveRecipients,
  shouldEmailRecipient,
} from "./recipients.ts";

const candidate = (
  occupantId: string,
  relationshipType: RecipientCandidate["relationshipType"],
  receiveEmails = true,
): RecipientCandidate => ({
  occupantId,
  userId: null,
  name: `Pessoa ${occupantId}`,
  nif: "123456789",
  email: `${occupantId}@example.pt`,
  phone: null,
  receiveEmails,
  relationshipType,
});

const UNIT = [
  candidate("own", "owner", false),
  candidate("ten", "tenant"),
  candidate("res", "resident"),
];

// ─── resolveRecipients ──────────────────────────────────────────────────────

Deno.test("resolveRecipients - sem escolha: owners + residents, inquilino de fora (Art. 1424 CC)", () => {
  const { recipients } = resolveRecipients(UNIT, undefined, "2026-09-24");
  assertEquals(recipients.map((r) => r.occupantId), ["own", "res"]);
  assertEquals(recipients.some((r) => r.chosen), false);
});

Deno.test("resolveRecipients - sem escolha e sem owner/resident → erro (não emite sem nome)", () => {
  assertThrows(
    () => resolveRecipients([candidate("ten", "tenant")], undefined, "2026-09-24"),
    AppError,
    "Sem destinatário",
  );
});

Deno.test("resolveRecipients - ocupante escolhido: só ele no recibo, mesmo sendo inquilino", () => {
  const { recipients, recipientsLive } = resolveRecipients(
    UNIT,
    { occupantId: "ten" },
    "2026-09-24",
  );
  assertEquals(recipients.length, 1);
  assertEquals(recipients[0].occupantId, "ten");
  assertEquals(recipients[0].chosen, true);
  // userId segue para o auto-invite; não entra no snapshot JSONB.
  assertEquals("userId" in recipients[0], false);
  assertEquals(recipientsLive[0].userId, null);
});

Deno.test("resolveRecipients - escolhido mantém a preferência real no snapshot (auditoria)", () => {
  const { recipients } = resolveRecipients(UNIT, { occupantId: "own" }, "2026-09-24");
  assertEquals(recipients[0].receiveEmails, false);
  assertEquals(recipients[0].chosen, true);
});

Deno.test("resolveRecipients - ocupante que não está na fração nessa data → INVALID_RECIPIENT", () => {
  const err = assertThrows(
    () => resolveRecipients(UNIT, { occupantId: "outra-fracao" }, "2026-09-24"),
    AppError,
  );
  assertEquals(err.code, "INVALID_RECIPIENT");
});

Deno.test("resolveRecipients - manual: sem ocupante, escolhido, recebe email se o tiver", () => {
  const { recipients } = resolveRecipients(
    UNIT,
    { name: "Externa, Lda", nif: "502626836", email: "geral@externa.pt" },
    "2026-09-24",
  );
  assertEquals(recipients, [{
    occupantId: null,
    name: "Externa, Lda",
    nif: "502626836",
    email: "geral@externa.pt",
    receiveEmails: true,
    chosen: true,
  }]);
});

// ─── shouldEmailRecipient ───────────────────────────────────────────────────

Deno.test("shouldEmailRecipient - escolha do admin vale mais que o opt-out", () => {
  assertEquals(shouldEmailRecipient({ chosen: true }, false), true);
});

Deno.test("shouldEmailRecipient - sem escolha segue a preferência", () => {
  assertEquals(shouldEmailRecipient({}, false), false);
  assertEquals(shouldEmailRecipient({}, true), true);
});

// ─── parseRecipientChoice ───────────────────────────────────────────────────

Deno.test("parseRecipientChoice - ausente → regra por defeito", () => {
  assertEquals(parseRecipientChoice(undefined), undefined);
  assertEquals(parseRecipientChoice(null), undefined);
});

Deno.test("parseRecipientChoice - occupantId tem prioridade sobre campos manuais", () => {
  assertEquals(
    parseRecipientChoice({ occupantId: " occ1 ", name: "X", nif: "1" }),
    { occupantId: "occ1" },
  );
});

Deno.test("parseRecipientChoice - manual normaliza NIF e email vazio", () => {
  assertEquals(
    parseRecipientChoice({ name: " Externa ", nif: "502 626 836", email: "" }),
    { name: "Externa", nif: "502626836", email: null },
  );
});

Deno.test("parseRecipientChoice - manual sem nome ou NIF é recusado (o PDF precisa de ambos)", () => {
  assertThrows(() => parseRecipientChoice({ name: "Externa", nif: "" }), AppError, "nome e NIF");
  assertThrows(() => parseRecipientChoice({ name: "", nif: "502626836" }), AppError, "nome e NIF");
});

Deno.test("parseRecipientChoice - email inválido é recusado", () => {
  assertThrows(
    () => parseRecipientChoice({ name: "Externa", nif: "502626836", email: "sem-arroba" }),
    AppError,
    "Email",
  );
});
