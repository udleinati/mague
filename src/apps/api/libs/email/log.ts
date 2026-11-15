// Escrita em `audit.email_log`, separada do transport para que enviar e auditar
// sejam independentes e o log seja best-effort (nunca atira). Grava metadados +
// corpo HTML + nomes dos anexos; NÃO grava o conteúdo dos anexos
// nem actor/bcc são expostos na API.

import type { Postgres } from "$api/libs/postgres/postgres.ts";
import type { ActorSnapshot, EmailAttachmentMeta } from "$api/libs/postgres/schemas/_audit.ts";

export type EmailCategory =
  | "password_reset"
  | "invite"
  | "receipt"
  | "insurance_reminder"
  // Fora da família dos lembretes: notifica um registo feito, não pede nada.
  | "insurance_admin_evidence"
  | "billing_reminder"
  | "assembly_convocation"
  | "ticket_created"
  | "ticket_activity";

export interface EmailLogEntry {
  category: EmailCategory;
  recipient: string;
  subject: string;
  bcc?: string | null;
  condominiumId?: string | null;
  unitId?: string | null;
  occupantId?: string | null;
  actor?: ActorSnapshot | null;
  status: "sent" | "failed";
  error?: string | null;
  bodyHtml?: string | null;
  attachments?: EmailAttachmentMeta[] | null;
}

// Best-effort: falha do INSERT emite `console.warn` mas nunca atira.
// `password_reset` é skipped por privacidade (auditável só pelo dono).
export async function recordEmailSent(
  postgres: Postgres,
  entry: EmailLogEntry,
): Promise<void> {
  if (entry.category === "password_reset") return;
  try {
    const { emailLog } = await import("$api/libs/postgres/schemas/_audit.ts");
    await postgres.query((db) =>
      db.insert(emailLog).values({
        category: entry.category,
        recipient: entry.recipient,
        bcc: entry.bcc ?? null,
        subject: entry.subject,
        condominiumId: entry.condominiumId ?? null,
        unitId: entry.unitId ?? null,
        occupantId: entry.occupantId ?? null,
        actor: entry.actor ?? null,
        status: entry.status,
        error: entry.error ?? null,
        bodyHtml: entry.bodyHtml ?? null,
        attachments: entry.attachments ?? null,
      })
    );
  } catch (logErr) {
    console.warn("[email_log] insert falhou:", (logErr as Error).message);
  }
}
