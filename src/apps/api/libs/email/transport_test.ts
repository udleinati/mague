// Unit tests do EmailTransport - só helpers puros (CRLF defence).
// O Adapter SMTP em si requer um servidor; é exercitado via E2E
// (api_security_email_crlf_test.ts) e pelos receipt tests.
// HTML→text vive em html_to_text.ts, com tests dedicados.

import { assertEquals } from "@std/assert";
import {
  type EmailTransport,
  getEmailTransport,
  resetEmailTransport,
  sanitizeEmailAddress,
  setEmailTransport,
  stripCRLF,
} from "./transport.ts";

// ─── stripCRLF ──────────────────────────────────────────────────────────────

Deno.test("stripCRLF - null/undefined viram string vazia", () => {
  assertEquals(stripCRLF(null), "");
  assertEquals(stripCRLF(undefined), "");
});

Deno.test("stripCRLF - string normal fica intacta (trim)", () => {
  assertEquals(stripCRLF("  hello  "), "hello");
});

Deno.test("stripCRLF - LF removido", () => {
  assertEquals(stripCRLF("Recibo\nBcc: attacker@evil.pt"), "Recibo Bcc: attacker@evil.pt");
});

Deno.test("stripCRLF - CRLF removido", () => {
  assertEquals(stripCRLF("Recibo\r\nBcc: x@y"), "Recibo Bcc: x@y");
});

Deno.test("stripCRLF - múltiplas linhas colapsam para 1 espaço", () => {
  assertEquals(stripCRLF("a\n\nb\r\nc"), "a b c");
});

// ─── sanitizeEmailAddress ───────────────────────────────────────────────────

Deno.test("sanitizeEmailAddress - vazio devolve undefined", () => {
  assertEquals(sanitizeEmailAddress(""), undefined);
  assertEquals(sanitizeEmailAddress(null), undefined);
  assertEquals(sanitizeEmailAddress("   "), undefined);
});

Deno.test("sanitizeEmailAddress - normal fica intacto", () => {
  assertEquals(sanitizeEmailAddress("foo@bar.pt"), "foo@bar.pt");
});

Deno.test("sanitizeEmailAddress - CRLF removido (defesa header injection)", () => {
  assertEquals(sanitizeEmailAddress("foo@bar.pt\r\nBcc: evil@x"), "foo@bar.pt Bcc: evil@x");
});

// ─── transport injection ────────────────────────────────────────────────────

Deno.test("setEmailTransport / resetEmailTransport - troca o adapter ativo", () => {
  const fake: EmailTransport = { send: () => Promise.resolve() };
  const original = getEmailTransport();
  setEmailTransport(fake);
  assertEquals(getEmailTransport(), fake);
  resetEmailTransport();
  assertEquals(getEmailTransport(), original);
});

Deno.test("EmailTransport fake - capta a chamada para inspeção em testes", async () => {
  const calls: Array<{ to: string; subject: string }> = [];
  const fake: EmailTransport = {
    send(msg) {
      calls.push({ to: msg.to, subject: msg.subject });
      return Promise.resolve();
    },
  };
  setEmailTransport(fake);
  try {
    await getEmailTransport().send({
      to: "x@y.pt",
      subject: "Teste",
      html: "<p>oi</p>",
    });
    assertEquals(calls.length, 1);
    assertEquals(calls[0].to, "x@y.pt");
    assertEquals(calls[0].subject, "Teste");
  } finally {
    resetEmailTransport();
  }
});
