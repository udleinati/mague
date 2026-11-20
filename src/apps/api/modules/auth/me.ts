import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { getSession, refreshSessionTtl } from "$api/libs/session/store.ts";
import { extractSidFromBearer } from "$api/libs/session/jwt.ts";
import { loadUserMembership } from "$api/libs/membership/mod.ts";
import { env } from "$config/env.ts";
import { formatAuthMeForResponse } from "./_projection.ts";

// GET /v1/auth/me via Authorization: Bearer <jwt>.
export const getAuthMe = async (ctx: Context, postgres: Postgres) => {
  const sessionId = await extractSidFromBearer(ctx.req.header("authorization"));
  if (!sessionId) {
    throw new AppError({
      message: "sessão em falta",
      statusCode: STATUS_CODE.Unauthorized,
      code: "NO_SESSION",
    });
  }

  const s = await getSession(sessionId);
  if (!s) {
    throw new AppError({
      message: "sessão inválida ou expirada",
      statusCode: STATUS_CODE.Unauthorized,
      code: "INVALID_SESSION",
    });
  }

  // Sliding TTL (ADR 0020): /v1/auth/* não passa por `apiAuth`, daí o refresh explícito.
  await refreshSessionTtl(sessionId, env.sessionIdleHours * 3600);

  // Regras "active manager"/"occupant ativo" centralizadas em `membership/compute.ts`
  // (single source com api_auth; antes havia 2 cópias que dessincronizaram).
  const membership = await loadUserMembership(postgres, s.userId);
  if (!membership) {
    throw new AppError({
      message: "Utilizador não encontrado",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }

  // Query enriquecida (unit + condominium nested) para o switcher de fração;
  // membership só dá IDs. `occupantId` + `nif` per-unit (NIF vive em occupant)
  // alimentam o banner "Preencha NIF" e o save-nif.
  let occupantUnits: Array<{
    unitId: string;
    condominiumId: string;
    designation: string;
    identifier: string | null;
    condominiumName: string;
    occupantId: string;
    nif: string | null;
  }> = [];
  if (membership.occupantCondoIds.length > 0) {
    const occupants = await postgres.query((db) =>
      db.query.occupant.findMany({
        where: (o, ops) => ops.and(ops.eq(o.userId, s.userId), ops.isNull(o.deletedAt)),
        with: {
          unitOccupants: {
            where: (uo, ops) => ops.and(ops.isNull(uo.deletedAt), ops.isNull(uo.endDate)),
            with: {
              unit: {
                columns: { id: true, designation: true, identifier: true, condominiumId: true },
                with: { condominium: { columns: { name: true } } },
              },
            },
          },
        },
      })
    );
    occupantUnits = occupants.flatMap((o) =>
      (o.unitOccupants ?? [])
        // Mesma regra dos gates do portal (membership): condo do occupant = da
        // fração, condo não apagado e ligação já iniciada.
        .filter((uo) =>
          uo.unit.condominiumId === o.condominiumId &&
          membership.inCondo(o.condominiumId).linkedUnitIds.includes(uo.unit.id)
        )
        .map((uo) => ({
          unitId: uo.unit.id,
          condominiumId: uo.unit.condominiumId,
          designation: uo.unit.designation,
          identifier: uo.unit.identifier ?? null,
          condominiumName: uo.unit.condominium?.name ?? "",
          occupantId: o.id,
          nif: o.nif ?? null,
        }))
    );
  }

  return ctx.json({
    data: formatAuthMeForResponse(
      membership.user,
      membership.activeManagerCondoIds,
      occupantUnits,
    ),
  });
};
