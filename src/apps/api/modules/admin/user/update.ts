import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { and, count, eq, isNull } from "drizzle-orm";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { dtoValidator } from "$api/libs/shared/dto_validator.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { userUpdateSchema } from "$api/libs/model/user.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { accountReachableOutside, loadUserMembership } from "$api/libs/membership/mod.ts";
import { formatUserForResponse } from "./_projection.ts";
import { requireActor } from "$api/middleware/api_auth.ts";

export const updateUser = async (ctx: Context, postgres: Postgres) => {
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

  const body = await dtoValidator(userUpdateSchema, await ctx.req.json());

  // `includeInactive`: admin pode editar users com `is_active=false` (ADR 0020).
  const membership = await loadUserMembership(postgres, userId, { includeInactive: true });
  if (!membership) {
    throw new AppError({
      message: "Utilizador não encontrado",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }

  const condoMembership = membership.inCondo(condominiumId);
  if (!condoMembership.isRelated) {
    throw new AppError({
      message: "Utilizador não encontrado",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }

  // O nome é da conta: numa conta que abre outro condomínio mudava-o lá. Mesma regra do
  // reset_password. O painel reenvia sempre o nome, por isso só conta se mudar.
  const nameChanges = body.name !== undefined && body.name !== membership.user.name;
  if (nameChanges && ctx.get("role") !== "super") {
    const managed: string[] = ctx.get("managedCondominiumIds") ?? [];
    if (membership.isSuper || accountReachableOutside(membership, managed)) {
      throw new AppError({
        message:
          "Esta conta também dá acesso a outro condomínio: o nome só pode ser alterado por um super.",
        statusCode: STATUS_CODE.Forbidden,
        code: "FORBIDDEN",
      });
    }
  }

  // isManager toggle (ADR 0002): idempotente, soft-delete para preservar audit,
  // bloqueia (409 LAST_MANAGER) ao remover o último admin ativo do condo.
  if (body.isManager !== undefined) {
    if (body.isManager && !condoMembership.isManager) {
      // Ativar: restaurar registo soft-deleted ou criar novo.
      if (condoMembership.managerRecord) {
        await postgres.query((db) =>
          db.update(schema.manager)
            .set({ deletedAt: null, isActive: true, updatedAt: new Date(), updatedBy: actor })
            .where(and(
              eq(schema.manager.userId, userId),
              eq(schema.manager.condominiumId, condominiumId),
            ))
        );
      } else {
        await postgres.query((db) =>
          db.insert(schema.manager).values({
            condominiumId,
            userId,
            createdBy: actor,
            updatedBy: actor,
          })
        );
      }
    } else if (!body.isManager && condoMembership.isManager) {
      // Desactivar: bloquear se for o último admin ativo do condo.
      const [{ value: activeCount }] = await postgres.query((db) =>
        db.select({ value: count() })
          .from(schema.manager)
          .where(and(
            eq(schema.manager.condominiumId, condominiumId),
            isNull(schema.manager.deletedAt),
          ))
      );

      if (activeCount <= 1) {
        throw new AppError({
          message:
            "Não é possível remover o último administrador ativo. Atribua outro administrador primeiro.",
          statusCode: STATUS_CODE.Conflict,
          code: "LAST_MANAGER",
        });
      }

      await postgres.query((db) =>
        db.update(schema.manager)
          .set({
            deletedAt: new Date(),
            deletedBy: actor,
            updatedAt: new Date(),
            updatedBy: actor,
          })
          .where(and(
            eq(schema.manager.userId, userId),
            eq(schema.manager.condominiumId, condominiumId),
            isNull(schema.manager.deletedAt),
          ))
      );
    }
  }

  const existingData = membership.user;
  const update = await postgres.transaction((tx) =>
    tx.update(schema.user)
      .set({
        name: body.name !== undefined ? body.name : existingData.name,
        updatedAt: new Date(),
        updatedBy: actor,
      })
      .where(and(
        eq(schema.user.id, userId),
        isNull(schema.user.deletedAt),
      ))
      .returning()
  );

  const updated = update[0];
  if (!updated) {
    throw new AppError({
      message: "Utilizador não encontrado",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }

  // isManager pós-operação: valor do body se veio (pós-toggle), senão o
  // snapshot pré-update da membership.
  const finalIsManager = body.isManager !== undefined ? body.isManager : condoMembership.isManager;

  return ctx.json({ data: formatUserForResponse(updated, finalIsManager) }, STATUS_CODE.OK);
};
