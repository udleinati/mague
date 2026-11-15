// EmailTransport - interface mínima para entrega de emails. Dois adapters:
// `smtpTransport` (dev/MailHog) e `resendHttpTransport` (produção). Selecção
// via `env.email.provider`; testes injectam fake via `setEmailTransport(...)`.
// Subject e endereços são normalizados (CRLF) aqui antes dos headers.

import nodemailer from "npm:nodemailer@6.9.16";
import { Buffer } from "node:buffer";
import { env } from "$config/env.ts";
import { resendHttpTransport } from "./resend_http_transport.ts";

export interface EmailMessage {
  to: string;
  from?: string;
  subject: string;
  html: string;
  text?: string;
  bcc?: string | null;
  /**
   * Reply-To header. Quando preenchido, "responder" no email cai aqui em
   * vez do `from` (tipicamente noreply). Tipicamente vem do
   * `condominium.reply_to_email` configurado no panel super.
   */
  replyTo?: string | null;
  attachments?: Array<{
    filename: string;
    /**
     * Aceita `Uint8Array` ou `Buffer`. Internamente é sempre convertido para
     * `Buffer` antes de chegar ao nodemailer (ver `smtpTransport.send`).
     */
    content: Uint8Array | Buffer;
    contentType?: string;
  }>;
}

export interface EmailTransport {
  send(msg: EmailMessage): Promise<void>;
}

let cachedNodemailer: ReturnType<typeof nodemailer.createTransport> | null = null;

function nodemailerTransporter() {
  if (cachedNodemailer) return cachedNodemailer;
  if (!env.smtp.host) {
    throw new Error("SMTP_HOST não está configurado - não é possível enviar emails.");
  }
  cachedNodemailer = nodemailer.createTransport({
    host: env.smtp.host,
    port: env.smtp.port,
    // 465 = TLS implícito; 587 = STARTTLS; 1025 = Mailpit dev (sem TLS).
    secure: env.smtp.port === 465,
    auth: env.smtp.user ? { user: env.smtp.user, pass: env.smtp.pass } : undefined,
  });
  return cachedNodemailer;
}

/** Adapter default - nodemailer + SMTP via env. */
export const smtpTransport: EmailTransport = {
  async send(msg) {
    const safeTo = sanitizeEmailAddress(msg.to);
    if (!safeTo) throw new Error("EmailTransport: campo `to` vazio ou inválido");
    // Nodemailer precisa de `Buffer`: um `Uint8Array` plain passa o type-check
    // mas o SMTP corrompe os bytes do anexo. Converter (mesmo backing, sem cópia).
    const attachments = msg.attachments?.map((a) => ({
      filename: a.filename,
      content: a.content instanceof Uint8Array ? Buffer.from(a.content) : a.content,
      contentType: a.contentType,
    }));
    await nodemailerTransporter().sendMail({
      from: msg.from ?? env.smtp.from,
      to: safeTo,
      bcc: sanitizeEmailAddress(msg.bcc) || undefined,
      replyTo: sanitizeEmailAddress(msg.replyTo) || undefined,
      subject: stripCRLF(msg.subject),
      html: msg.html,
      text: msg.text,
      attachments,
    });
  },
};

function defaultTransport(): EmailTransport {
  return env.email.provider === "resend-http" ? resendHttpTransport : smtpTransport;
}

let activeTransport: EmailTransport = defaultTransport();

/** Substitui o transport ativo (para testes ou para um 2.º provider). */
export function setEmailTransport(t: EmailTransport): void {
  activeTransport = t;
}

/** Repõe o transport default (escolhido por `env.email.provider`). */
export function resetEmailTransport(): void {
  activeTransport = defaultTransport();
}

/** Adapter ativo - usado por `sendEmail` para entregar mensagens. */
export function getEmailTransport(): EmailTransport {
  return activeTransport;
}

// ─── Defesa CRLF + helpers ──────────────────────────────────────────────────

// Remove CR/LF de strings que entram em headers - defesa em profundidade
// contra header injection (inputs upstream podem trazer `\r\n`).
export function stripCRLF(s: string | null | undefined): string {
  return (s ?? "").replace(/[\r\n]+/g, " ").trim();
}

export function sanitizeEmailAddress(addr: string | null | undefined): string | undefined {
  const cleaned = stripCRLF(addr);
  return cleaned || undefined;
}
