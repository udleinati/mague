// POST /v1/admin/condominiums/:cid/users/:userId/reset-password
//
// Reset assistido: o admin gera uma password temporária de 6 chars e entrega-a
// à pessoa por fora (telefone, WhatsApp). Existe porque o fluxo por email
// (/v1/auth/forgot-password) falha em silêncio quando o email não chega - e
// nesse caso não há forma de o admin desbloquear ninguém.
//
// A password é devolvida em claro UMA vez, nesta response, e nunca é guardada
// nem registada: na BD fica só o hash bcrypt, como em qualquer outra password.
// Não invalida sessões abertas do utilizador (o Valkey não tem índice
// user -> sessões), em paridade com o reset por token em auth/forgot_password.ts.

import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { and, eq, isNull } from "drizzle-orm";
import bcrypt from "npm:bcryptjs@2.4.3";
import type { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { accountReachableOutside, loadUserMembership } from "$api/libs/membership/mod.ts";
import { requireActor } from "$api/middleware/api_auth.ts";
import { generateTemporaryPassword } from "$api/modules/auth/_token.ts";

export const resetUserPassword = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const actor = requireActor(ctx);

  const userId = ctx.req.param("userId");
  if (!userId) {
    throw new AppError({
      message: "userId é obrigatório",
      statusCode: STATUS_CODE.BadRequest,
      code: "VALIDATION_ERROR",
    });
  }

  // Mesmo gate de tenant do updateUser: sem vínculo a este condomínio, o user
  // não existe para quem pergunta. Sem isto, um admin de A repunha a password
  // de alguém de B só por saber o id.
  const membership = await loadUserMembership(postgres, userId, { includeInactive: true });
  if (!membership || !membership.inCondo(condominiumId).isRelated) {
    throw new AppError({
      message: "Utilizador não encontrado",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }

  // Um super com fração no condomínio é "relacionado" pelo teste acima. Repor
  // a password dele daria a um admin de condomínio a conta que gere todos.
  if (membership.isSuper && ctx.get("role") !== "super") {
    throw new AppError({
      message: "Sem permissão para repor a password desta conta.",
      statusCode: STATUS_CODE.Forbidden,
      code: "FORBIDDEN",
    });
  }

  // A password é da conta, não do condomínio: se a conta abre um condomínio que
  // quem pede não gere, repô-la dava-lhe esse condomínio.
  if (ctx.get("role") !== "super") {
    const managed: string[] = ctx.get("managedCondominiumIds") ?? [];
    if (accountReachableOutside(membership, managed)) {
      throw new AppError({
        message:
          "Esta conta também dá acesso a outro condomínio: a password só pode ser reposta por um super.",
        statusCode: STATUS_CODE.Forbidden,
        code: "FORBIDDEN",
      });
    }
  }

  // Login e forgot-password filtram ambos por `is_active = true` (ADR 0020):
  // com a conta inativa, a password nova não abre nada. Falhar aqui em vez de
  // devolver ao admin um código que não vai funcionar.
  if (!membership.user.isActive) {
    throw new AppError({
      message: "Utilizador inativo: reative a conta antes de repor a password.",
      statusCode: STATUS_CODE.Conflict,
      code: "USER_INACTIVE",
    });
  }

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await bcrypt.hash(temporaryPassword, 10);

  await postgres.transaction(async (tx) => {
    await tx.update(schema.user)
      .set({
        passwordHash,
        passwordChangedAt: new Date(),
        // Zera o contador de falhas: a pessoa vai entrar com credenciais novas
        // e o histórico de tentativas com a password antiga deixa de fazer fé.
        failedLoginAttempts: 0,
        updatedAt: new Date(),
        updatedBy: actor,
      })
      .where(and(eq(schema.user.id, userId), isNull(schema.user.deletedAt)));

    // Tokens de invite/reset por abrir passam a inválidos: depois disto a
    // password é esta, e um link antigo no email dava um segundo caminho.
    await tx.update(schema.inviteToken)
      .set({ usedAt: new Date() })
      .where(and(
        eq(schema.inviteToken.userId, userId),
        isNull(schema.inviteToken.usedAt),
      ));
  });

  return ctx.json({
    data: {
      userId,
      name: membership.user.name,
      email: membership.user.email,
      // Só aqui. Não vai para log, email ou audit - o admin copia-a agora ou
      // repõe outra vez.
      temporaryPassword,
      resetAt: new Date().toISOString(),
    },
  });
};
