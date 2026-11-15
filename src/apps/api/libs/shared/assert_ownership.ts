// Validadores de ownership de FKs vindas do body. As FK constraints do Postgres
// só verificam existência, não tenant - sem isto, um manager do condo A criava
// uma charge a apontar para unit de B (cross-tenant IDOR). Validar ANTES do
// insert; 404 (não 403) para não distinguir "não existe" de "outro tenant"
// (anti-enumeração). Usar SEMPRE que um FK id venha do body.

import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { inArray } from "drizzle-orm";
import type { Postgres } from "$api/libs/postgres/postgres.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import type { ApiVariables } from "$api/middleware/api_auth.ts";
import type { ActorSnapshot } from "$api/libs/postgres/schemas/_audit.ts";
import { loadUserMembership } from "$api/libs/membership/mod.ts";

// Frase completa: "não encontrado" concorda com a entidade (Fração não encontrada).
function notFound(message: string): AppError {
  return new AppError({
    message,
    statusCode: STATUS_CODE.NotFound,
    code: "NOT_FOUND",
  });
}

export async function assertUnitBelongs(
  postgres: Postgres,
  unitId: string,
  condominiumId: string,
): Promise<void> {
  const result = await postgres.query((db) =>
    db.query.unit.findFirst({
      columns: { id: true },
      where: (e, ops) =>
        ops.and(
          ops.eq(e.id, unitId),
          ops.eq(e.condominiumId, condominiumId),
          ops.isNull(e.deletedAt),
        ),
    })
  );
  if (!result) throw notFound("Fração não encontrada");
}

export async function assertUnitsBelongBatch(
  postgres: Postgres,
  unitIds: string[],
  condominiumId: string,
): Promise<void> {
  if (unitIds.length === 0) return;
  if (unitIds.length === 1) return assertUnitBelongs(postgres, unitIds[0], condominiumId);
  const found = await postgres.query((db) =>
    db.query.unit.findMany({
      columns: { id: true },
      where: (e, ops) =>
        ops.and(
          inArray(e.id, unitIds),
          ops.eq(e.condominiumId, condominiumId),
          ops.isNull(e.deletedAt),
        ),
    })
  );
  const foundIds = new Set(found.map((r) => r.id));
  for (const uid of unitIds) {
    if (!foundIds.has(uid)) throw notFound("Fração não encontrada");
  }
}

export async function assertSupplierBelongs(
  postgres: Postgres,
  supplierId: string,
  condominiumId: string,
): Promise<void> {
  const result = await postgres.query((db) =>
    db.query.supplier.findFirst({
      columns: { id: true },
      where: (e, ops) =>
        ops.and(
          ops.eq(e.id, supplierId),
          ops.eq(e.condominiumId, condominiumId),
          ops.isNull(e.deletedAt),
        ),
    })
  );
  if (!result) throw notFound("Fornecedor não encontrado");
}

export async function assertOccupantBelongs(
  postgres: Postgres,
  occupantId: string,
  condominiumId: string,
): Promise<void> {
  const result = await postgres.query((db) =>
    db.query.occupant.findFirst({
      columns: { id: true },
      where: (e, ops) =>
        ops.and(
          ops.eq(e.id, occupantId),
          ops.eq(e.condominiumId, condominiumId),
          ops.isNull(e.deletedAt),
        ),
    })
  );
  if (!result) throw notFound("Ocupante não encontrado");
}

// Votos individuais da ordem do dia: a fração e o ocupante (opcional) vão para a ata.
export async function assertVotesBelong(
  postgres: Postgres,
  votes: Array<{ unitId: string; occupantId?: string | null }>,
  condominiumId: string,
): Promise<void> {
  await assertUnitsBelongBatch(postgres, [...new Set(votes.map((v) => v.unitId))], condominiumId);
  const occupantIds = [...new Set(votes.flatMap((v) => v.occupantId ? [v.occupantId] : []))];
  await Promise.all(occupantIds.map((id) => assertOccupantBelongs(postgres, id, condominiumId)));
}

export async function assertBankAccountBelongs(
  postgres: Postgres,
  bankAccountId: string,
  condominiumId: string,
): Promise<void> {
  const result = await postgres.query((db) =>
    db.query.bankAccount.findFirst({
      columns: { id: true },
      where: (e, ops) =>
        ops.and(
          ops.eq(e.id, bankAccountId),
          ops.eq(e.condominiumId, condominiumId),
          ops.isNull(e.deletedAt),
        ),
    })
  );
  if (!result) throw notFound("Conta bancária não encontrada");
}

/**
 * Verifica que o user autenticado pode VER `unitId` - sem isto, `?unitId=` em
 * `/charges`/`/settlements` deixaria um occupant ler dados de outra fração
 * (IDOR). Permite: super; manager do condo (com cross-tenant guard); occupant
 * linkado. Resto → 404 (anti-enumeração, como `assertUnitBelongs`).
 */
export async function assertUserCanAccessUnit(
  ctx: Context,
  postgres: Postgres,
  unitId: string,
  condominiumId: string,
): Promise<void> {
  const role = ctx.get("role") as ApiVariables["role"];
  const actor = ctx.get("actor") as ActorSnapshot | null;

  if (!actor) {
    throw new AppError({
      message: "Sem sessão",
      statusCode: STATUS_CODE.Unauthorized,
      code: "AUTH_REQUIRED",
    });
  }

  if (role === "super") return;

  // Manager (core.manager ativo, ADR 0002): valida via `managedCondos`. O
  // api_auth já garante o cid na lista, mas revalidamos que a unit pertence
  // ao condo (cross-tenant guard explícito).
  const managedCondos = (ctx.get("managedCondominiumIds") as string[] | undefined) ?? [];
  if (managedCondos.includes(condominiumId)) {
    const unitRes = await postgres.query((db) =>
      db.query.unit.findFirst({
        columns: { id: true },
        where: (u, o) =>
          o.and(
            o.eq(u.id, unitId),
            o.eq(u.condominiumId, condominiumId),
            o.isNull(u.deletedAt),
          ),
      })
    );
    if (!unitRes) throw notFound("Fração não encontrada");
    return;
  }

  // Resto = occupant com unit_occupant ativo. `linkedUnitIds` (membership
  // module) cobre a regra; membership memoizada em ctx por `apiAuth`.
  const membership = (ctx.get("membership") as ApiVariables["membership"]) ??
    await loadUserMembership(postgres, actor.user_id ?? "");
  const linked = !!membership &&
    membership.inCondo(condominiumId).linkedUnitIds.includes(unitId);
  if (!linked) throw notFound("Fração não encontrada");
}

export async function assertDocumentBelongs(
  postgres: Postgres,
  documentId: string,
  condominiumId: string,
): Promise<void> {
  const result = await postgres.query((db) =>
    db.query.document.findFirst({
      columns: { id: true },
      where: (e, ops) =>
        ops.and(
          ops.eq(e.id, documentId),
          ops.eq(e.condominiumId, condominiumId),
          ops.isNull(e.deletedAt),
        ),
    })
  );
  if (!result) throw notFound("Documento não encontrado");
}

export async function assertBudgetBelongs(
  postgres: Postgres,
  budgetId: string,
  condominiumId: string,
): Promise<void> {
  const result = await postgres.query((db) =>
    db.query.budget.findFirst({
      columns: { id: true },
      where: (e, ops) =>
        ops.and(
          ops.eq(e.id, budgetId),
          ops.eq(e.condominiumId, condominiumId),
          ops.isNull(e.deletedAt),
        ),
    })
  );
  if (!result) throw notFound("Orçamento não encontrado");
}

/**
 * Charts of account têm globais (condominium_id IS NULL). Aceita ambas:
 * conta do próprio condomínio OU conta global.
 */
export async function assertAccountBelongs(
  postgres: Postgres,
  accountId: string,
  condominiumId: string,
): Promise<void> {
  const result = await postgres.query((db) =>
    db.query.chartOfAccount.findFirst({
      columns: { id: true },
      where: (e, ops) =>
        ops.and(
          ops.eq(e.id, accountId),
          ops.or(
            ops.eq(e.condominiumId, condominiumId),
            ops.isNull(e.condominiumId),
          ),
        ),
    })
  );
  if (!result) throw notFound("Conta contabilística não encontrada");
}

// ─── Validador declarativo: assertOwnership ───────────────────────────────
// Substitui o Promise.all de asserts por-campo (frágil: esquecer um → IDOR)
// por um spec declarativo. Ignora fields ausentes/null/undefined no body.
// Novo tipo = uma linha em `ASSERTION_BY_TYPE`.

type OwnedEntity =
  | "unit"
  | "supplier"
  | "account"
  | "bankAccount"
  | "occupant"
  | "document"
  | "budget";

const ASSERTION_BY_TYPE: Record<
  OwnedEntity,
  (postgres: Postgres, id: string, condominiumId: string) => Promise<void>
> = {
  unit: assertUnitBelongs,
  supplier: assertSupplierBelongs,
  account: assertAccountBelongs,
  bankAccount: assertBankAccountBelongs,
  occupant: assertOccupantBelongs,
  document: assertDocumentBelongs,
  budget: assertBudgetBelongs,
};

/**
 * Valida ownership em batch dos FK ids do body. `spec` mapeia campo → tipo de
 * entidade; campos null/undefined/vazio são ignorados. Falha → AppError 404
 * (anti-enumeração cross-tenant, como os asserts individuais).
 */
export async function assertOwnership<
  TBody extends Record<string, unknown>,
>(
  postgres: Postgres,
  body: TBody,
  condominiumId: string,
  spec: Partial<Record<OwnedEntity, keyof TBody & string>>,
): Promise<void> {
  const promises: Array<Promise<void>> = [];
  for (
    const [entity, fieldName] of Object.entries(spec) as Array<
      [OwnedEntity, string]
    >
  ) {
    const value = body[fieldName];
    if (typeof value !== "string" || value.length === 0) continue;
    promises.push(ASSERTION_BY_TYPE[entity](postgres, value, condominiumId));
  }
  await Promise.all(promises);
}
