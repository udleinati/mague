// Helpers do fluxo de convite, partilhados por invite_by_occupant.ts e
// admin/receipt/notify.ts (auto-invite na 1ª emissão de recibo).

import { and, eq, isNull } from "drizzle-orm";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import type { OccupantSelect } from "$api/libs/postgres/schemas/occupant.ts";
import type { ActorSnapshot } from "$api/libs/postgres/schemas/_audit.ts";
import { generateAuthToken, TOKEN_TTL } from "./_token.ts";

/** Conta que o convite vai usar, se já existir: a ligada ao occupant ou a do mesmo email. */
export async function findExistingUserIdForOccupant(
  postgres: Postgres,
  occupant: Pick<OccupantSelect, "userId" | "email">,
): Promise<string | null> {
  if (occupant.userId) return occupant.userId;
  if (!occupant.email || !occupant.email.trim()) return null;
  const existingByEmail = await postgres.query((db) =>
    db.query.user.findFirst({
      columns: { id: true },
      where: (u, ops) =>
        ops.and(
          ops.eq(u.email, occupant.email!.toLowerCase()),
          ops.isNull(u.deletedAt),
        ),
    })
  );
  return existingByEmail?.id ?? null;
}

/**
 * Garante um `core.user` para o occupant: cria, ou reutiliza por email, e liga.
 * Devolve o `userId`. O user não copia nif/phone do occupant.
 */
export async function ensureUserForOccupant(
  postgres: Postgres,
  occupant: Pick<OccupantSelect, "id" | "userId" | "email" | "name">,
): Promise<string> {
  if (occupant.userId) return occupant.userId;
  if (!occupant.email || !occupant.email.trim()) {
    throw new Error("ensureUserForOccupant: occupant sem email");
  }

  const existingUserId = await findExistingUserIdForOccupant(postgres, occupant);

  let userId: string;
  if (existingUserId) {
    userId = existingUserId;
  } else {
    // role=NULL (condómino vive em `core.unit_occupant`);
    // password null até aceitar o convite.
    const inserted = await postgres.query((db) =>
      db.insert(schema.user).values({
        email: occupant.email!.toLowerCase(),
        name: occupant.name,
        isActive: true,
      }).returning({ id: schema.user.id })
    );
    userId = inserted[0].id;
  }

  await postgres.query((db) =>
    db.update(schema.occupant)
      .set({ userId, updatedAt: new Date() })
      .where(eq(schema.occupant.id, occupant.id))
  );

  return userId;
}

/**
 * Invalida tokens anteriores do user e cria novo token de convite.
 * `actor`: ActorSnapshot (ADR 0011), ou `{}` em fluxo público (forgot-password).
 * `scopeCondominiumIds`: condomínios de quem convida (`null` = super), revalidados no aceite.
 */
export async function createInviteToken(
  postgres: Postgres,
  userId: string,
  actor: ActorSnapshot,
  scopeCondominiumIds: readonly string[] | null,
): Promise<{ token: string; expiresAt: Date }> {
  await postgres.query((db) =>
    db.update(schema.inviteToken)
      .set({ usedAt: new Date() })
      .where(and(
        eq(schema.inviteToken.userId, userId),
        isNull(schema.inviteToken.usedAt),
      ))
  );

  const token = generateAuthToken();
  const expiresAt = new Date(Date.now() + TOKEN_TTL.invite * 1000);
  await postgres.query((db) =>
    db.insert(schema.inviteToken).values({
      token,
      userId,
      purpose: "invite",
      createdBy: actor,
      scopeCondominiumIds: scopeCondominiumIds === null ? null : [...scopeCondominiumIds],
      expiresAt,
    })
  );

  return { token, expiresAt };
}

/** URL de aceitação do convite; `next` opcional redireciona após definir password. */
export function buildAcceptInviteUrl(
  baseUrl: string,
  token: string,
  next?: string,
): string {
  const qs = new URLSearchParams({ token });
  if (next) qs.set("next", next);
  return `${baseUrl}/accept-invite?${qs.toString()}`;
}
