// CRUD de `core.assembly_attendee` - presenças e procurações (Art. 1432.º + 1431.º nº 5 CC).
// 1 row por (assembleia × unit); procuração = row com is_proxy=true. Permilagem é snapshot
// (`permillageAtMeeting`); ocupante atual da unit em `occupantId`.

import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { dtoValidator } from "$api/libs/shared/dto_validator.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { byIdInCondo } from "$api/libs/shared/by_id_in_condo.ts";
import { assertOccupantBelongs, assertOwnership } from "$api/libs/shared/assert_ownership.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { requireActor } from "$api/middleware/api_auth.ts";

// ─── Schemas ────────────────────────────────────────────────────────────────

const attendeeCreateSchema = z.object({
  unitId: z.string().min(1),
  // Titular da fração (FK). Quando is_proxy=true, é o representado;
  // quando false, é quem está presente em causa própria.
  occupantId: z.string().min(1),
  permillageAtMeeting: z.number().positive(),
  isProxy: z.boolean().default(false),
  // Convocatória onde a presença está registada (default 'first'); "passar para 2ª" cria rows novas.
  convocationRound: z.enum(["first", "second"]).optional(),
  // Portador da procuração interno (outro occupant registado).
  proxyHolderOccupantId: z.string().nullable().optional(),
  // Portador externo (fora do sistema). Mutually exclusive com o interno (CHECK na BD).
  proxyHolderExternalName: z.string().nullable().optional(),
  arrivedAt: z.string().datetime().nullable().optional(),
  leftAt: z.string().datetime().nullable().optional(),
  notes: z.string().nullable().optional(),
}).refine(
  (v) => {
    const hasInt = !!v.proxyHolderOccupantId;
    const hasExt = !!v.proxyHolderExternalName;
    if (v.isProxy) return (hasInt || hasExt) && !(hasInt && hasExt);
    return !hasInt && !hasExt;
  },
  {
    message:
      "is_proxy=true exige exatamente UM de proxy_holder_occupant_id ou proxy_holder_external_name; " +
      "is_proxy=false não permite nenhum dos dois",
  },
);

const attendeeUpdateSchema = z.object({
  permillageAtMeeting: z.number().positive().optional(),
  arrivedAt: z.string().datetime().nullable().optional(),
  leftAt: z.string().datetime().nullable().optional(),
  notes: z.string().nullable().optional(),
});

// ─── Validação cross-FK ─────────────────────────────────────────────────────

async function loadAssembly(postgres: Postgres, condominiumId: string, assemblyId: string) {
  const row = await postgres.query((db) =>
    db.query.assembly.findFirst({
      where: byIdInCondo(schema.assembly, assemblyId, condominiumId),
    })
  );
  return findEntityOrFail(row, "Assembleia");
}

// ─── GET /assemblies/:id/attendees ──────────────────────────────────────────

export const listAttendees = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const assemblyId = requireParam(ctx, "assemblyId");
  await loadAssembly(postgres, condominiumId, assemblyId);

  const rows = await postgres.query((db) =>
    db.query.assemblyAttendee.findMany({
      where: (e, ops) => ops.and(ops.eq(e.assemblyId, assemblyId), ops.isNull(e.deletedAt)),
      orderBy: (e, ops) => ops.asc(e.createdAt),
    })
  );
  return ctx.json({ data: rows });
};

// ─── POST /assemblies/:id/attendees ─────────────────────────────────────────

export const createAttendee = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const assemblyId = requireParam(ctx, "assemblyId");
  const assembly = await loadAssembly(postgres, condominiumId, assemblyId);

  // Edição de presenças só faz sentido enquanto a assembleia está em
  // `scheduled`. Após `held` a ata é imutável (Art. 1434.º).
  if (assembly.status !== "scheduled") {
    throw new AppError({
      message: "Presenças só podem ser editadas em assembleias 'scheduled'.",
      statusCode: STATUS_CODE.Conflict,
      code: "ASSEMBLY_LOCKED",
    });
  }

  const body = await dtoValidator(attendeeCreateSchema, await ctx.req.json());
  const actor = requireActor(ctx);
  await assertOwnership(postgres, body, condominiumId, { unit: "unitId", occupant: "occupantId" });
  if (body.proxyHolderOccupantId) {
    await assertOccupantBelongs(postgres, body.proxyHolderOccupantId, condominiumId);
  }

  // Round: usa o explícito do body, ou o atual da assembleia. Permite
  // ao admin marcar presenças diretamente para a convocatória em curso.
  const round = body.convocationRound ?? assembly.convocationRound ?? "first";

  // Anti-duplicado: 1 attendee ativo por (assembleia, unit, round). Uma
  // mesma unit pode ter linhas separadas para 1ª e 2ª convocatória.
  const existing = await postgres.query((db) =>
    db.query.assemblyAttendee.findFirst({
      where: (e, ops) =>
        ops.and(
          ops.eq(e.assemblyId, assemblyId),
          ops.eq(e.unitId, body.unitId),
          ops.eq(e.convocationRound, round),
          ops.isNull(e.deletedAt),
        ),
    })
  );
  if (existing) {
    throw new AppError({
      message: "Esta fração já está registada como presente nesta convocatória.",
      statusCode: STATUS_CODE.Conflict,
      code: "DUPLICATE_ATTENDEE",
    });
  }

  const [created] = await postgres.query((db) =>
    db.insert(schema.assemblyAttendee).values({
      assemblyId,
      unitId: body.unitId,
      occupantId: body.occupantId,
      convocationRound: round,
      permillageAtMeeting: String(body.permillageAtMeeting),
      isProxy: body.isProxy,
      proxyHolderOccupantId: body.proxyHolderOccupantId ?? null,
      proxyHolderExternalName: body.proxyHolderExternalName ?? null,
      arrivedAt: body.arrivedAt ? new Date(body.arrivedAt) : null,
      leftAt: body.leftAt ? new Date(body.leftAt) : null,
      notes: body.notes ?? null,
      createdBy: actor,
      updatedBy: actor,
    }).returning()
  );

  return ctx.json({ data: created }, STATUS_CODE.Created);
};

// ─── PATCH /assemblies/:id/attendees/:attendeeId ────────────────────────────

export const updateAttendee = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const assemblyId = requireParam(ctx, "assemblyId");
  const attendeeId = requireParam(ctx, "attendeeId");
  const assembly = await loadAssembly(postgres, condominiumId, assemblyId);

  if (assembly.status !== "scheduled") {
    throw new AppError({
      message: "Presenças só podem ser editadas em assembleias 'scheduled'.",
      statusCode: STATUS_CODE.Conflict,
      code: "ASSEMBLY_LOCKED",
    });
  }

  const body = await dtoValidator(attendeeUpdateSchema, await ctx.req.json());
  const actor = requireActor(ctx);

  const existing = await postgres.query((db) =>
    db.query.assemblyAttendee.findFirst({
      where: (e, ops) =>
        ops.and(
          ops.eq(e.id, attendeeId),
          ops.eq(e.assemblyId, assemblyId),
          ops.isNull(e.deletedAt),
        ),
    })
  );
  const current = findEntityOrFail(existing, "Presença");

  const [updated] = await postgres.query((db) =>
    db.update(schema.assemblyAttendee)
      .set({
        permillageAtMeeting: body.permillageAtMeeting !== undefined
          ? String(body.permillageAtMeeting)
          : current.permillageAtMeeting,
        arrivedAt: body.arrivedAt !== undefined
          ? (body.arrivedAt ? new Date(body.arrivedAt) : null)
          : current.arrivedAt,
        leftAt: body.leftAt !== undefined
          ? (body.leftAt ? new Date(body.leftAt) : null)
          : current.leftAt,
        notes: body.notes !== undefined ? body.notes : current.notes,
        updatedAt: new Date(),
        updatedBy: actor,
      })
      .where(and(
        eq(schema.assemblyAttendee.id, attendeeId),
        isNull(schema.assemblyAttendee.deletedAt),
      ))
      .returning()
  );

  return ctx.json({ data: updated }, STATUS_CODE.OK);
};

// ─── DELETE /assemblies/:id/attendees/:attendeeId ───────────────────────────

export const deleteAttendee = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const assemblyId = requireParam(ctx, "assemblyId");
  const attendeeId = requireParam(ctx, "attendeeId");
  const assembly = await loadAssembly(postgres, condominiumId, assemblyId);

  if (assembly.status !== "scheduled") {
    throw new AppError({
      message: "Presenças só podem ser eliminadas em assembleias 'scheduled'.",
      statusCode: STATUS_CODE.Conflict,
      code: "ASSEMBLY_LOCKED",
    });
  }

  const actor = requireActor(ctx);
  await postgres.query((db) =>
    db.update(schema.assemblyAttendee)
      .set({ deletedAt: new Date(), deletedBy: actor })
      .where(and(
        eq(schema.assemblyAttendee.id, attendeeId),
        eq(schema.assemblyAttendee.assemblyId, assemblyId),
        isNull(schema.assemblyAttendee.deletedAt),
      ))
  );

  return new Response(null, { status: STATUS_CODE.NoContent });
};
