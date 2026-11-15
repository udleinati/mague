// Helper para inspeccionar emails entregues a Mailpit (SMTP de dev).
//
// O Mague usa Mailpit como SMTP local em dev/teste - emails reais não saem.
// O Mailpit tem API HTTP em http://localhost:8025/api/v1 que permite
// query + delete dos messages recebidos. Estes helpers servem para os
// test_api validarem que `sendEmail` realmente entregou um email com os
// headers esperados (BCC, Reply-To) - não só que o transport não atirou.
//
// Workflow típico num test:
//   1. await flushMailpit()              // limpa inbox antes do test
//   2. <trigger email via API>           // ex: emit receipt
//   3. const m = await waitForEmail({to: 'a@x.pt'})
//   4. assertEquals(m.headers.bcc, "...")
//
// Polling: o INSERT no Mailpit é via SMTP async - pode haver lag de
// dezenas de ms entre `sendEmail()` resolver e o message aparecer na API.
// `waitForEmail` faz polling com timeout.

const BASE = Deno.env.get("MAILPIT_URL") ?? "http://localhost:8025";

export interface MailpitMessageSummary {
  ID: string;
  From: { Address: string; Name?: string };
  To: Array<{ Address: string }>;
  Bcc?: Array<{ Address: string }>;
  Subject: string;
  Created: string;
}

export interface MailpitMessage extends MailpitMessageSummary {
  Cc: Array<{ Address: string }>;
  Bcc: Array<{ Address: string }>;
  ReplyTo: Array<{ Address: string }>;
  ReturnPath: string;
  HTML: string;
  Text: string;
  Attachments: Array<{
    PartID: string;
    FileName: string;
    ContentType: string;
    Size: number;
  }>;
}

/** Apaga todos os messages do Mailpit. Idempotente. Chamar antes de cada test. */
export async function flushMailpit(): Promise<void> {
  const r = await fetch(`${BASE}/api/v1/messages`, { method: "DELETE" });
  if (!r.ok) {
    throw new Error(`Mailpit DELETE messages falhou: HTTP ${r.status}`);
  }
  await r.body?.cancel();
}

/** Lista todos os messages na inbox (até 200 mais recentes). */
export async function listMessages(): Promise<MailpitMessageSummary[]> {
  const r = await fetch(`${BASE}/api/v1/messages?limit=200`);
  if (!r.ok) throw new Error(`Mailpit list messages: HTTP ${r.status}`);
  const body = await r.json();
  return body.messages ?? [];
}

/** Carrega o detalhe completo de um message (HTML, BCC, ReplyTo, attachments). */
export async function getMessage(id: string): Promise<MailpitMessage> {
  const r = await fetch(`${BASE}/api/v1/message/${id}`);
  if (!r.ok) throw new Error(`Mailpit get message ${id}: HTTP ${r.status}`);
  return await r.json();
}

export interface WaitForEmailOptions {
  /** Filtro por endereço destinatário (To). Match exato, case-insensitive. */
  to?: string;
  /** Filtro por substring no Subject. Case-insensitive. */
  subjectIncludes?: string;
  /** Timeout total em ms. Default 5000. */
  timeoutMs?: number;
  /** Intervalo entre polls. Default 100ms. */
  pollMs?: number;
}

/**
 * Aguarda até que um message com os filtros especificados apareça em Mailpit.
 * Polling até timeout. Atira `Error` se nenhum message corresponder a tempo.
 *
 * Devolve o message detalhado (já hidratado com HTML/BCC/ReplyTo).
 */
export async function waitForEmail(
  opts: WaitForEmailOptions = {},
): Promise<MailpitMessage> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const pollMs = opts.pollMs ?? 100;
  const target = opts.to?.toLowerCase();
  const subj = opts.subjectIncludes?.toLowerCase();
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const summary = await listMessages();
    const match = summary.find((m) => {
      if (target) {
        const found = m.To.some((t) => t.Address.toLowerCase() === target);
        if (!found) return false;
      }
      if (subj && !m.Subject.toLowerCase().includes(subj)) return false;
      return true;
    });
    if (match) return await getMessage(match.ID);
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(
    `Mailpit waitForEmail timeout (${timeoutMs}ms): nenhum email com to=${
      opts.to ?? "*"
    } subjectIncludes="${opts.subjectIncludes ?? "*"}"`,
  );
}

/** Devolve só o array de endereços (lower-case) de um campo address-list do
 *  Mailpit. Útil para asserts simples. */
export function addresses(field: Array<{ Address: string }>): string[] {
  return field.map((a) => a.Address.toLowerCase());
}

/**
 * Descarrega os bytes de um attachment (parte MIME) de um message do Mailpit.
 * Útil para validar que um PDF anexado chega íntegro ao destinatário (compara
 * SHA-256 com o ficheiro original - anti-regressão para corrupção de encoding
 * SMTP, ver `transport.ts`).
 */
export async function getMessageAttachmentBytes(
  id: string,
  partID: string,
): Promise<Uint8Array> {
  const r = await fetch(`${BASE}/api/v1/message/${id}/part/${partID}`);
  if (!r.ok) {
    throw new Error(`Mailpit get part ${id}/${partID}: HTTP ${r.status}`);
  }
  return new Uint8Array(await r.arrayBuffer());
}

/** SHA-256 hex de um buffer - wrapper trivial para asserts de integridade. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
