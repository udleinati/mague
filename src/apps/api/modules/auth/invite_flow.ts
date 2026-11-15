// inviteOccupant - coordena o fluxo de convite (ensure user → token → url → email)
// num só sítio, partilhado pelos 2 callers (invite manual e auto-invite no recibo).
//
// Modos: `"strict"` atira em qualquer falha (invite manual); `"best-effort"`
// devolve `{sent: false}` (auto-invite ao emitir recibo, que já está commitado).
// Pré-condição: occupant.email - strict atira, best-effort devolve `skipped: "no-email"`.

import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import type { OccupantSelect } from "$api/libs/postgres/schemas/occupant.ts";
import type { ActorSnapshot } from "$api/libs/postgres/schemas/_audit.ts";
import { inviteEmailHtml, sendEmail } from "$api/libs/email/send.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { accountReachableOutside, loadUserMembership } from "$api/libs/membership/mod.ts";
import { TOKEN_TTL_LABEL } from "./_token.ts";
import {
  buildAcceptInviteUrl,
  createInviteToken,
  ensureUserForOccupant,
  findExistingUserIdForOccupant,
} from "./_invite_helpers.ts";

// A conta que o convite usaria é super ou abre condomínios fora de `managed`?
async function accountBeyondInviter(
  postgres: Postgres,
  occupant: Pick<OccupantSelect, "userId" | "email">,
  managed: readonly string[],
): Promise<boolean> {
  const userId = await findExistingUserIdForOccupant(postgres, occupant);
  if (!userId) return false;
  const membership = await loadUserMembership(postgres, userId, { includeInactive: true });
  if (!membership) return false;
  return membership.isSuper || accountReachableOutside(membership, managed);
}

export interface InviteOccupantInput {
  postgres: Postgres;
  occupant: Pick<OccupantSelect, "id" | "userId" | "email" | "name">;
  panelBaseUrl: string;
  /** Subject/header do email. `bccEmail`/`replyToEmail` resolvidos por `sendEmail` via `condominiumId`. */
  condominium: {
    id: string;
    name: string;
    designationType?: "building" | "condominium" | null;
  };
  /** ActorSnapshot (ADR 0011); `null` em fluxo público (forgot-password). */
  actor: ActorSnapshot | null;
  /** Redirect `/portal/...` pós-password (auto-invite aponta para o recibo). */
  next?: string;
  /** Strict atira em qualquer erro; best-effort apanha e devolve {sent:false}. */
  mode?: "strict" | "best-effort";
  /** Condomínios geridos por quem convida; `null` = super (sem limite). */
  managedCondominiumIds: readonly string[] | null;
}

export interface InviteOccupantResult {
  /** UserID do `core.user` (recém-criado ou existente). */
  userId: string | null;
  /** Token gerado (null se não chegou a gerar - apenas em best-effort). */
  token: string | null;
  /** Validade do token (null se token nunca foi criado). */
  expiresAt: Date | null;
  /** URL absoluta do `/accept-invite?token=…&next=…`. */
  acceptUrl: string | null;
  /** Foi enviado email? false em best-effort com falha. */
  sent: boolean;
  /** Razão para `sent === false`. */
  skipped?:
    | "no-email"
    | "send-failed"
    | "ensure-user-failed"
    | "token-failed"
    | "account-elsewhere";
  /** Erro original em best-effort (debugging). */
  error?: Error;
}

/** Coordena ensure user → token → url → email. Strict atira; best-effort devolve `sent: false`. */
export async function inviteOccupant(
  input: InviteOccupantInput,
): Promise<InviteOccupantResult> {
  const { postgres, occupant, panelBaseUrl, condominium, actor, next } = input;
  const mode = input.mode ?? "strict";
  const failSoft = mode === "best-effort";

  if (!occupant.email || !occupant.email.trim()) {
    if (failSoft) {
      return {
        userId: occupant.userId ?? null,
        token: null,
        expiresAt: null,
        acceptUrl: null,
        sent: false,
        skipped: "no-email",
      };
    }
    throw new Error("inviteOccupant: occupant sem email");
  }

  // Aceitar o convite define a password da conta, e o link fica no registo de emails e
  // no BCC do condomínio. Mesma regra do reset assistido (admin/user/reset_password.ts).
  if (
    input.managedCondominiumIds !== null &&
    await accountBeyondInviter(postgres, occupant, input.managedCondominiumIds)
  ) {
    if (failSoft) {
      return {
        userId: occupant.userId ?? null,
        token: null,
        expiresAt: null,
        acceptUrl: null,
        sent: false,
        skipped: "account-elsewhere",
      };
    }
    throw new AppError({
      message:
        "Esta conta também dá acesso a outro condomínio: o convite só pode ser enviado por um super.",
      statusCode: STATUS_CODE.Forbidden,
      code: "FORBIDDEN",
    });
  }

  let userId: string;
  try {
    userId = await ensureUserForOccupant(postgres, occupant);
  } catch (e) {
    if (failSoft) {
      return {
        userId: occupant.userId ?? null,
        token: null,
        expiresAt: null,
        acceptUrl: null,
        sent: false,
        skipped: "ensure-user-failed",
        error: e as Error,
      };
    }
    throw e;
  }

  let token: string;
  let expiresAt: Date;
  try {
    const r = await createInviteToken(postgres, userId, actor ?? {});
    token = r.token;
    expiresAt = r.expiresAt;
  } catch (e) {
    if (failSoft) {
      return {
        userId,
        token: null,
        expiresAt: null,
        acceptUrl: null,
        sent: false,
        skipped: "token-failed",
        error: e as Error,
      };
    }
    throw e;
  }

  const acceptUrl = buildAcceptInviteUrl(panelBaseUrl, token, next);

  try {
    await sendEmail({
      to: occupant.email,
      subject: `Convite para o portal · ${condominium.name}`,
      category: "invite",
      // BCC + Reply-To resolvidos pelo `sendEmail` a partir de `condominiumId`.
      condominiumId: condominium.id,
      occupantId: occupant.id,
      postgres,
      actor,
      html: inviteEmailHtml({
        occupantName: occupant.name,
        condominiumName: condominium.name,
        designationType: condominium.designationType ?? "condominium",
        acceptUrl,
        ttl: TOKEN_TTL_LABEL.invite,
      }),
    });
  } catch (e) {
    if (failSoft) {
      return {
        userId,
        token,
        expiresAt,
        acceptUrl,
        sent: false,
        skipped: "send-failed",
        error: e as Error,
      };
    }
    throw e;
  }

  return { userId, token, expiresAt, acceptUrl, sent: true };
}
