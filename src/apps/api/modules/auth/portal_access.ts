// ensurePortalAccess - garante que o destinatário pode aceder ao Portal antes
// de receber comunicação. Devolve o `linkUrl` para o email: `directUrl` se já
// tem user; caso contrário convida (token + email) e devolve a accept-invite URL
// com `next=<path de directUrl>`. Best-effort: se falhar, devolve `directUrl` (`inviteSent=false`).

import { Postgres } from "$api/libs/postgres/postgres.ts";
import type { OccupantSelect } from "$api/libs/postgres/schemas/occupant.ts";
import type { ActorSnapshot } from "$api/libs/postgres/schemas/_audit.ts";
import { inviteOccupant, type InviteOccupantResult } from "./invite_flow.ts";

export interface EnsurePortalAccessInput {
  postgres: Postgres;
  /** Snapshot do ocupante destinatário. `userId === null` dispara o convite. */
  occupant: Pick<OccupantSelect, "id" | "userId" | "email" | "name">;
  /** URL absoluta direta para o destino final (ex: portalReceiptUrl). */
  directUrl: string;
  panelBaseUrl: string;
  condominium: {
    id: string;
    name: string;
    designationType?: "building" | "condominium" | null;
  };
  actor: ActorSnapshot | null;
}

export interface EnsurePortalAccessResult {
  /** URL que o caller deve incluir no email de comunicação. */
  linkUrl: string;
  /** True se o ocupante já tinha user (linkUrl === directUrl). */
  hadUser: boolean;
  /** True se o convite foi gerado e enviado nesta chamada. */
  inviteSent: boolean;
  /** Razão para falha do convite (se aplicável). Caller pode usar para audit. */
  inviteSkipped?: InviteOccupantResult["skipped"];
}

/** Best-effort: nunca atira. Em falha devolve `directUrl` + `inviteSent: false`. */
export async function ensurePortalAccess(
  input: EnsurePortalAccessInput,
): Promise<EnsurePortalAccessResult> {
  const { postgres, occupant, directUrl, panelBaseUrl, condominium, actor } = input;

  // Já tem user → comunicação direta.
  if (occupant.userId) {
    return { linkUrl: directUrl, hadUser: true, inviteSent: false };
  }

  // Sem user → tenta convidar (best-effort).
  const result = await inviteOccupant({
    postgres,
    occupant,
    panelBaseUrl,
    condominium,
    actor,
    // Só o path: o panel recusa `next` absoluto (anti open-redirect).
    next: new URL(directUrl).pathname,
    mode: "best-effort",
    // Convite automático do sistema: só contas que não abrem outro condomínio.
    managedCondominiumIds: [condominium.id],
  });

  if (result.sent && result.acceptUrl) {
    return { linkUrl: result.acceptUrl, hadUser: false, inviteSent: true };
  }

  // Falhou: caller usa directUrl (login no Portal vai pedir credenciais).
  return {
    linkUrl: directUrl,
    hadUser: false,
    inviteSent: false,
    inviteSkipped: result.skipped,
  };
}
