// Unit tests do ResendHttpTransport. Anti-regressão do bug que motivou o
// adapter: garantir que bytes binários passam byte-a-byte na conversão
// Uint8Array -> base64 (validado por SHA-256), fronteira que o pipeline
// SMTP/MIME corrompia. `fetch` é mockado; nunca sai para a Resend real.

import { assertEquals, assertRejects } from "@std/assert";
import { Buffer } from "node:buffer";
import { sendViaResend } from "./resend_http_transport.ts";

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** Mock `fetch` por scope de teste. Devolve uma função de restore. */
function mockFetch(impl: (req: CapturedRequest) => Response): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const req = new Request(input, init);
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      headers[k] = v;
    });
    const text = await req.text();
    return impl({
      url: req.url,
      method: req.method,
      headers,
      body: text ? JSON.parse(text) : {},
    });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

Deno.test("resendHttpTransport - anexo binário sobrevive byte-a-byte (SHA-256)", async () => {
  // Construímos bytes que cobrem todos os valores 0-255 (incluindo CR=13,
  // LF=10 e o sequencial CRLF=\r\n) e o magic header de PDF - exatamente
  // o cocktail que partia o pipeline SMTP/MIME.
  const pdfBytes = new Uint8Array(2048);
  pdfBytes.set([0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x34, 0x0A], 0); // %PDF-1.4\n
  for (let i = 9; i < pdfBytes.length; i++) pdfBytes[i] = (i * 37 + 13) & 0xff;
  const expectedHash = await sha256Hex(pdfBytes);

  let captured: CapturedRequest | null = null;
  const restore = mockFetch((req) => {
    captured = req;
    return new Response(JSON.stringify({ id: "msg_test_123" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  try {
    await sendViaResend(
      {
        to: "test@example.pt",
        subject: "Recibo 2026/00001",
        html: "<p>Em anexo</p>",
        attachments: [
          { filename: "recibo.pdf", content: pdfBytes, contentType: "application/pdf" },
        ],
      },
      "re_test_xxx",
    );
  } finally {
    restore();
  }

  if (!captured) throw new Error("fetch não foi chamado");
  const c = captured as CapturedRequest;
  assertEquals(c.url, "https://api.resend.com/emails");
  assertEquals(c.method, "POST");
  assertEquals(c.headers["authorization"], "Bearer re_test_xxx");
  assertEquals(c.headers["content-type"], "application/json");

  const attachments = c.body.attachments as Array<{
    filename: string;
    content: string;
    content_type: string;
  }>;
  assertEquals(attachments.length, 1);
  assertEquals(attachments[0].filename, "recibo.pdf");
  assertEquals(attachments[0].content_type, "application/pdf");

  // Decodifica base64 de volta e confirma SHA-256 idêntico - o anti-bug.
  const decoded = new Uint8Array(Buffer.from(attachments[0].content, "base64"));
  assertEquals(decoded.byteLength, pdfBytes.byteLength, "tamanho diferente após round-trip");
  assertEquals(await sha256Hex(decoded), expectedHash, "SHA-256 mismatch - base64 corrompeu bytes");
});

Deno.test("resendHttpTransport - sanitização CRLF em to/bcc/subject (defesa header injection)", async () => {
  let captured: CapturedRequest | null = null;
  const restore = mockFetch((req) => {
    captured = req;
    return new Response(JSON.stringify({ id: "x" }), { status: 200 });
  });

  try {
    await sendViaResend(
      {
        to: "victim@example.pt\r\nBcc: attacker@evil.com",
        subject: "Recibo\nInjected: header",
        html: "<p>oi</p>",
        bcc: "bcc@x.pt\r\nFake-Header: x",
        replyTo: "rt@x.pt\r\nX-Fake: y",
      },
      "re_test_xxx",
    );
  } finally {
    restore();
  }

  if (!captured) throw new Error("fetch não foi chamado");
  const c = captured as CapturedRequest;
  assertEquals((c.body.to as string[])[0], "victim@example.pt Bcc: attacker@evil.com");
  assertEquals(c.body.subject, "Recibo Injected: header");
  assertEquals((c.body.bcc as string[])[0], "bcc@x.pt Fake-Header: x");
  assertEquals(c.body.reply_to, "rt@x.pt X-Fake: y");
});

Deno.test("resendHttpTransport - sem bcc/replyTo → campos omitidos do JSON", async () => {
  let captured: CapturedRequest | null = null;
  const restore = mockFetch((req) => {
    captured = req;
    return new Response(JSON.stringify({ id: "x" }), { status: 200 });
  });

  try {
    await sendViaResend(
      { to: "x@y.pt", subject: "Test", html: "<p>oi</p>" },
      "re_test_xxx",
    );
  } finally {
    restore();
  }

  if (!captured) throw new Error("fetch não foi chamado");
  const c = captured as CapturedRequest;
  // Resend rejeita BCC vazio - confirmamos que omitimos quando não há.
  assertEquals(c.body.bcc, undefined);
  assertEquals(c.body.reply_to, undefined);
  assertEquals(c.body.attachments, undefined);
});

Deno.test("resendHttpTransport - erro 422 da Resend propaga com message do JSON", async () => {
  const restore = mockFetch(() =>
    new Response(
      JSON.stringify({
        name: "validation_error",
        message: "The `from` address is not from a verified domain.",
        statusCode: 422,
      }),
      { status: 422, headers: { "content-type": "application/json" } },
    )
  );

  try {
    await assertRejects(
      () =>
        sendViaResend(
          { to: "x@y.pt", subject: "Test", html: "<p>oi</p>" },
          "re_test_xxx",
        ),
      Error,
      "verified domain",
    );
  } finally {
    restore();
  }
});

Deno.test("resendHttpTransport - 5xx sem JSON cai no fallback genérico", async () => {
  const restore = mockFetch(() => new Response("Gateway timeout", { status: 504 }));

  try {
    await assertRejects(
      () =>
        sendViaResend(
          { to: "x@y.pt", subject: "Test", html: "<p>oi</p>" },
          "re_test_xxx",
        ),
      Error,
      "504",
    );
  } finally {
    restore();
  }
});

Deno.test("resendHttpTransport - API key vazia rebenta antes de chamar a Resend", async () => {
  let called = false;
  const restore = mockFetch(() => {
    called = true;
    return new Response("", { status: 200 });
  });

  try {
    await assertRejects(
      () => sendViaResend({ to: "x@y.pt", subject: "T", html: "<p>oi</p>" }, ""),
      Error,
      "SMTP_PASS",
    );
    assertEquals(called, false, "fetch não devia ter sido chamado sem API key");
  } finally {
    restore();
  }
});

Deno.test("resendHttpTransport - `to` vazio/inválido rebenta antes de chamar a Resend", async () => {
  let called = false;
  const restore = mockFetch(() => {
    called = true;
    return new Response("", { status: 200 });
  });

  try {
    await assertRejects(
      () => sendViaResend({ to: "  ", subject: "T", html: "<p>oi</p>" }, "re_x"),
      Error,
      "`to` vazio",
    );
    assertEquals(called, false);
  } finally {
    restore();
  }
});
