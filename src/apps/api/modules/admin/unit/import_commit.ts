// POST /v1/admin/c/:cid/units/import/commit (JSON)
// Cria frações novas, ocupantes novos e vínculos em transação.
// Dedup:
//   - Fração existente → mantém (ignora linha)
//   - Ocupante (por email ou NIF) existente → reutiliza
//   - Vínculo (unitId, occupantId) existente e ativo → ignora

import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { z } from "zod";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { dtoValidator } from "$api/libs/shared/dto_validator.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { requireActor } from "$api/middleware/api_auth.ts";
import { RelationshipTypeSchema, UnitTypeSchema } from "$api/libs/enums.ts";

const unitSchema = z.object({
  designation: z.string().min(1).max(50),
  unitType: UnitTypeSchema.default("residential"),
  permillage: z.number().positive(),
  block: z.string().max(50).nullable().optional(),
  floor: z.string().max(20).nullable().optional(),
  door: z.string().max(20).nullable().optional(),
  description: z.string().nullable().optional(),
});
const occupantSchema = z.object({
  name: z.string().min(1).max(255),
  email: z.string().max(255).nullable().optional(),
  phone: z.string().max(30).nullable().optional(),
  nif: z.string().max(20).nullable().optional(),
});
const linkSchema = z.object({
  unitDesignation: z.string().min(1),
  occupantKey: z.string().min(1),
  relationshipType: RelationshipTypeSchema,
});
const bodySchema = z.object({
  units: z.array(unitSchema),
  occupants: z.array(occupantSchema),
  links: z.array(linkSchema),
});

// Replica a mesma função do parser para encontrar os mesmos keys.
function occupantKeyFor(o: { name: string; email?: string | null; nif?: string | null }): string {
  if (o.email) return `e:${o.email.toLowerCase()}`;
  if (o.nif) return `n:${o.nif}`;
  return `name:${o.name.toLowerCase()}`;
}

export const importCommit = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);

  const body = await dtoValidator(bodySchema, await ctx.req.json());
  const actor = requireActor(ctx);

  const result = await postgres.query((db) =>
    db.transaction(async (tx) => {
      // 1. Frações: upsert por (condominiumId, designation).
      const existingUnits = await tx.query.unit.findMany({
        where: (e, ops) =>
          ops.and(
            ops.eq(e.condominiumId, condominiumId),
            ops.isNull(e.deletedAt),
          ),
        columns: { id: true, designation: true },
      });
      const unitIdByDesignation = new Map<string, string>(
        existingUnits.map((u) => [u.designation, u.id]),
      );
      let unitsCreated = 0;
      for (const u of body.units) {
        if (unitIdByDesignation.has(u.designation)) continue;
        const [created] = await tx.insert(schema.unit).values({
          condominiumId,
          designation: u.designation,
          unitType: u.unitType,
          permillage: String(u.permillage),
          block: u.block ?? null,
          floor: u.floor ?? null,
          door: u.door ?? null,
          description: u.description ?? null,
          createdBy: actor,
          updatedBy: actor,
        }).returning({ id: schema.unit.id });
        unitIdByDesignation.set(u.designation, created.id);
        unitsCreated++;
      }

      // 2. Ocupantes: dedup por email/NIF dentro do mesmo condomínio.
      const existingOccupants = await tx.query.occupant.findMany({
        where: (e, ops) =>
          ops.and(
            ops.eq(e.condominiumId, condominiumId),
            ops.isNull(e.deletedAt),
          ),
        columns: { id: true, name: true, email: true, nif: true },
      });
      const occupantIdByKey = new Map<string, string>();
      for (const o of existingOccupants) {
        if (o.email) occupantIdByKey.set(`e:${o.email.toLowerCase()}`, o.id);
        if (o.nif) occupantIdByKey.set(`n:${o.nif}`, o.id);
        occupantIdByKey.set(`name:${o.name.toLowerCase()}`, o.id);
      }
      let occupantsCreated = 0;
      for (const o of body.occupants) {
        const key = occupantKeyFor(o);
        if (occupantIdByKey.has(key)) continue;
        const [created] = await tx.insert(schema.occupant).values({
          condominiumId,
          name: o.name,
          email: o.email ?? null,
          phone: o.phone ?? null,
          nif: o.nif ?? null,
          createdBy: actor,
          updatedBy: actor,
        }).returning({ id: schema.occupant.id });
        occupantIdByKey.set(key, created.id);
        occupantsCreated++;
      }

      // 3. Vínculos: insere se não existir ativo.
      const existingLinks = await tx.query.unitOccupant.findMany({
        where: (e, ops) => ops.isNull(e.deletedAt),
        columns: { unitId: true, occupantId: true, endDate: true },
      });
      const activeLinkKeys = new Set(
        existingLinks.filter((l) => !l.endDate).map((l) => `${l.unitId}|${l.occupantId}`),
      );
      let linksCreated = 0;
      const linkErrors: string[] = [];
      for (const l of body.links) {
        const unitId = unitIdByDesignation.get(l.unitDesignation);
        const occupantId = occupantIdByKey.get(l.occupantKey);
        if (!unitId || !occupantId) {
          linkErrors.push(
            `Vínculo ignorado: fração ${l.unitDesignation} ou ocupante ${l.occupantKey}`,
          );
          continue;
        }
        const key = `${unitId}|${occupantId}`;
        if (activeLinkKeys.has(key)) continue;
        await tx.insert(schema.unitOccupant).values({
          unitId,
          occupantId,
          relationshipType: l.relationshipType,
        });
        activeLinkKeys.add(key);
        linksCreated++;
      }

      return {
        unitsCreated: unitsCreated,
        units_skipped: body.units.length - unitsCreated,
        occupantsCreated: occupantsCreated,
        occupants_skipped: body.occupants.length - occupantsCreated,
        linksCreated: linksCreated,
        link_errors: linkErrors,
      };
    })
  );

  return ctx.json({ data: result }, STATUS_CODE.Created);
};
