// Destinatários do recibo ("Recebido de" no PDF + email). Por defeito: owners + residents ativos
// à data do pagamento (inquilinos de fora, Art. 1424 CC). Com escolha do admin: só a pessoa
// escolhida (qualquer ocupante ligado à fração nessa data) ou um destinatário manual.

import { sql } from "drizzle-orm";
import { STATUS_CODE } from "@std/http";
import { AppError } from "$api/libs/error/app_error.ts";
import type { Postgres } from "$api/libs/postgres/postgres.ts";
import type { RecipientSnapshot } from "$api/libs/postgres/schemas/receipt.ts";
import type { ReceiptRecipientChoice, RecipientLive } from "./_shared.ts";

export interface RecipientCandidate extends RecipientLive {
  occupantId: string;
  relationshipType: "owner" | "tenant" | "resident";
}

const DEFAULT_RELATIONSHIPS = new Set(["owner", "resident"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Ocupantes ligados à fração na data do pagamento (qualquer relação), por nome.
export async function listRecipientCandidates(
  postgres: Postgres,
  args: { condominiumId: string; unitId: string; paymentDate: string },
): Promise<RecipientCandidate[]> {
  const rows = await postgres.query((db) =>
    db.execute<{
      occupant_id: string;
      user_id: string | null;
      name: string;
      nif: string | null;
      email: string | null;
      phone: string | null;
      receive_receipt_emails: boolean;
      relationship_type: RecipientCandidate["relationshipType"];
    }>(
      sql`
        SELECT o.id AS occupant_id, o.user_id, o.name, o.nif, o.email, o.phone,
               o.receive_receipt_emails, uo.relationship_type
          FROM core.unit_occupant uo
          JOIN core.occupant o ON o.id = uo.occupant_id
         WHERE uo.unit_id = ${args.unitId}
           AND uo.deleted_at IS NULL
           AND uo.start_date <= ${args.paymentDate}::date
           AND (uo.end_date IS NULL OR uo.end_date >= ${args.paymentDate}::date)
           AND o.deleted_at IS NULL
           AND o.condominium_id = ${args.condominiumId}
         ORDER BY o.name
      `,
    )
  );
  return rows.map((r: typeof rows[0]) => ({
    occupantId: String(r.occupant_id),
    userId: r.user_id ?? null,
    name: String(r.name),
    nif: r.nif ?? null,
    email: r.email ?? null,
    phone: r.phone ?? null,
    receiveEmails: Boolean(r.receive_receipt_emails),
    relationshipType: r.relationship_type,
  }));
}

// Body `recipient` do POST /receipts. Ausente = regra por defeito.
export function parseRecipientChoice(raw: unknown): ReceiptRecipientChoice | undefined {
  if (raw === undefined || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const occupantId = String(r.occupantId ?? "").trim();
  if (occupantId) return { occupantId };

  const name = String(r.name ?? "").trim();
  const nif = String(r.nif ?? "").replace(/\s+/g, "");
  const email = String(r.email ?? "").trim() || null;
  if (!name || !nif) throw validationError("Destinatário manual exige nome e NIF");
  if (name.length > 200 || nif.length > 20) {
    throw validationError("Nome ou NIF do destinatário demasiado longo");
  }
  if (email && !EMAIL_RE.test(email)) throw validationError("Email do destinatário inválido");
  return { name, nif, email };
}

export function resolveRecipients(
  candidates: RecipientCandidate[],
  choice: ReceiptRecipientChoice | undefined,
  paymentDate: string,
): { recipients: RecipientSnapshot[]; recipientsLive: RecipientLive[] } {
  let live: RecipientLive[];
  if (!choice) {
    live = candidates.filter((c) => DEFAULT_RELATIONSHIPS.has(c.relationshipType));
    if (live.length === 0) {
      throw new AppError({
        message:
          `Sem destinatário (owner/resident) registado em ${paymentDate} - corrige unit_occupant primeiro`,
        statusCode: STATUS_CODE.UnprocessableEntity,
        code: "INVALID_STATE",
      });
    }
  } else if ("occupantId" in choice) {
    const found = candidates.find((c) => c.occupantId === choice.occupantId);
    if (!found) {
      throw new AppError({
        message: `O destinatário escolhido não está ligado à fração em ${paymentDate}`,
        statusCode: STATUS_CODE.UnprocessableEntity,
        code: "INVALID_RECIPIENT",
      });
    }
    live = [{ ...found, chosen: true }];
  } else {
    live = [{
      occupantId: null,
      userId: null,
      name: choice.name,
      nif: choice.nif,
      email: choice.email,
      phone: null,
      receiveEmails: choice.email !== null,
      chosen: true,
    }];
  }

  const recipientsLive = live.map((c) => ({
    occupantId: c.occupantId,
    userId: c.userId,
    name: c.name,
    nif: c.nif,
    email: c.email,
    phone: c.phone,
    receiveEmails: c.receiveEmails,
    ...(c.chosen ? { chosen: true } : {}),
  }));
  const recipients: RecipientSnapshot[] = recipientsLive.map((c) => ({
    occupantId: c.occupantId,
    name: c.name,
    nif: c.nif,
    email: c.email,
    receiveEmails: c.receiveEmails,
    ...(c.chosen ? { chosen: true } : {}),
  }));
  return { recipients, recipientsLive };
}

// O escolhido recebe sempre; os restantes conforme `receive_receipt_emails`.
export function shouldEmailRecipient(r: { chosen?: boolean }, receiveEmails: boolean): boolean {
  return r.chosen === true || receiveEmails;
}

function validationError(message: string): AppError {
  return new AppError({ message, statusCode: STATUS_CODE.BadRequest, code: "VALIDATION_ERROR" });
}
