// POST /v1/admin/c/:cid/units/import/preview (multipart file)
// Parseia xlsx + verifica colisões com frações/ocupantes já existentes no
// condomínio. Devolve preview, sem gravar nada.

import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { parseUnitsImport } from "$api/libs/unit_import/parser.ts";

export const importPreview = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);

  const form = await ctx.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    throw new AppError({
      message: "Ficheiro em falta (campo 'file')",
      statusCode: STATUS_CODE.BadRequest,
      code: "VALIDATION_ERROR",
    });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const parsed = parseUnitsImport(bytes);

  // Flag frações que já existem.
  const existingUnits = await postgres.query((db) =>
    db.query.unit.findMany({
      columns: { id: true, designation: true },
      where: (e, ops) =>
        ops.and(
          ops.eq(e.condominiumId, condominiumId),
          ops.isNull(e.deletedAt),
        ),
    })
  );
  const existingDesignations = new Set(existingUnits.map((u) => u.designation));

  // Flag ocupantes já existentes (por email ou NIF).
  const existingOccupants = await postgres.query((db) =>
    db.query.occupant.findMany({
      columns: { id: true, email: true, nif: true, name: true },
      where: (e, ops) =>
        ops.and(
          ops.eq(e.condominiumId, condominiumId),
          ops.isNull(e.deletedAt),
        ),
    })
  );
  const existingByEmail = new Map<string, string>();
  const existingByNif = new Map<string, string>();
  for (const o of existingOccupants) {
    if (o.email) existingByEmail.set(o.email.toLowerCase(), o.name);
    if (o.nif) existingByNif.set(o.nif, o.name);
  }

  const units = parsed.units.map((u) => ({
    ...u,
    isDuplicate: existingDesignations.has(u.designation),
  }));

  const occupants = parsed.occupants.map((o) => {
    const existingName = (o.email && existingByEmail.get(o.email.toLowerCase())) ||
      (o.nif && existingByNif.get(o.nif)) ||
      null;
    return { ...o, isDuplicate: existingName != null, existingName };
  });

  return ctx.json({
    data: {
      filename: file.name,
      units,
      occupants,
      links: parsed.links,
      warnings: parsed.warnings,
      summary: {
        totalUnits: units.length,
        newUnits: units.filter((u) => !u.isDuplicate).length,
        totalOccupants: occupants.length,
        newOccupants: occupants.filter((o) => !o.isDuplicate).length,
        totalLinks: parsed.links.length,
      },
    },
  });
};
