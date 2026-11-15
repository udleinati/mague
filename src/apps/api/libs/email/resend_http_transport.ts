// Resend HTTP API transport - alternativa ao SMTP para entrega byte-exata de
// anexos binários (o gateway SMTP trunca base64 com os limites de linha do
// RFC 5321; a HTTP API codifica o anexo uma vez e evita a superfície MIME).
// API key vem de SMTP_PASS (mesma key do adapter SMTP).

import { Buffer } from "node:buffer";
import type { EmailMessage, EmailTransport } from "./transport.ts";
import { sanitizeEmailAddress, stripCRLF } from "./transport.ts";
import { env } from "$config/env.ts";

const RESEND_API_URL = "https://api.resend.com/emails";

export const resendHttpTransport: EmailTransport = {
  send: (msg) => sendViaResend(msg, env.smtp.pass),
};

// API key explícita para permitir testes sem env; produção usa `resendHttpTransport`.
export async function sendViaResend(msg: EmailMessage, apiKey: string): Promise<void> {
  const safeTo = sanitizeEmailAddress(msg.to);
  if (!safeTo) throw new Error("Resend HTTP transport: campo `to` vazio ou inválido");
  if (!apiKey) throw new Error("Resend HTTP transport: SMTP_PASS (API key) em falta.");

  const bcc = sanitizeEmailAddress(msg.bcc);
  const replyTo = sanitizeEmailAddress(msg.replyTo);

  const body = {
    from: msg.from ?? env.smtp.from,
    to: [safeTo],
    bcc: bcc ? [bcc] : undefined,
    reply_to: replyTo || undefined,
    subject: stripCRLF(msg.subject),
    html: msg.html,
    text: msg.text,
    attachments: msg.attachments?.map((a) => ({
      filename: a.filename,
      content: Buffer.from(a.content).toString("base64"),
      content_type: a.contentType,
    })),
  };

  const res = await fetch(RESEND_API_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let errMsg = `Resend HTTP ${res.status} ${res.statusText}`;
    try {
      const errBody = await res.json();
      if (errBody?.message) errMsg = `Resend ${res.status}: ${errBody.message}`;
    } catch {
      // resposta sem JSON - fica a mensagem genérica
    }
    throw new Error(errMsg);
  }
}
