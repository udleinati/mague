// Helpers do módulo pathology: attachments polimórficos, softDeletePathology
// (cascade S3 ADR 0021), syncPathologyUnits (lista N:N pathology_unit).

import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import {
  listAttachmentsForEntity,
  softDeleteAttachmentsForEntity,
} from "$api/libs/attachments/mod.ts";
import type { ActorSnapshot } from "$api/libs/postgres/schemas/_audit.ts";
import type { AttachmentSelect } from "$api/libs/postgres/schemas/mod.ts";

export async function listPathologyAttachments(
  postgres: Postgres,
  condominiumId: string,
  pathologyId: string,
): Promise<AttachmentSelect[]> {
  return await listAttachmentsForEntity({
    postgres,
    condominiumId,
    entityType: "pathology",
    entityId: pathologyId,
  });
}

// Substitui o conjunto N:N de units pela `targetIds`. Validação "âmbito tem que
// existir" fica no caller (handler).
export async function syncPathologyUnits(
  postgres: Postgres,
  pathologyId: string,
  targetIds: string[],
): Promise<void> {
  const target = new Set(targetIds);
  const existingRows = await postgres.query((db) =>
    db.query.pathologyUnit.findMany({
      where: (e, ops) => ops.eq(e.pathologyId, pathologyId),
    })
  );
  const existing = new Set(existingRows.map((r) => r.unitId));

  const toAdd = [...target].filter((id) => !existing.has(id));
  const toRemove = [...existing].filter((id) => !target.has(id));

  if (toAdd.length > 0) {
    await postgres.query((db) =>
      db.insert(schema.pathologyUnit).values(
        toAdd.map((unitId) => ({ pathologyId, unitId })),
      )
    );
  }
  if (toRemove.length > 0) {
    await postgres.query((db) =>
      db.delete(schema.pathologyUnit).where(
        and(
          eq(schema.pathologyUnit.pathologyId, pathologyId),
          inArray(schema.pathologyUnit.unitId, toRemove),
        ),
      )
    );
  }
}

// Soft-delete + cascade S3 (ADR 0021): apaga bytes dos anexos vivos PRIMEIRO,
// só depois marca deleted_at. Fail-fast: se S3 falhar, a pathology mantém-se viva.
// `pathology_unit` mantém-se (pai é só soft-deleted).
export async function softDeletePathology(
  postgres: Postgres,
  args: { condominiumId: string; pathologyId: string; actor: ActorSnapshot },
): Promise<boolean> {
  // 1. Cascata S3 aos anexos vivos.
  await softDeleteAttachmentsForEntity({
    postgres,
    condominiumId: args.condominiumId,
    entityType: "pathology",
    entityId: args.pathologyId,
    actor: args.actor,
  });

  // 2. SET NULL manual em tickets associados (ADR 0024): o FK ON DELETE SET NULL
  // só dispara em DELETE real; como soft-delete é UPDATE, limpa-se à mão.
  await postgres.query((db) =>
    db.update(schema.ticket)
      .set({ pathologyId: null, updatedAt: new Date() })
      .where(and(
        eq(schema.ticket.pathologyId, args.pathologyId),
        eq(schema.ticket.condominiumId, args.condominiumId),
      ))
  );

  // 3. Soft-delete da pathology. `pathology_unit` rows mantêm-se (histórico).
  const rows = await postgres.query((db) =>
    db.update(schema.pathology)
      .set({ deletedAt: new Date(), deletedBy: args.actor, updatedAt: new Date() })
      .where(and(
        eq(schema.pathology.id, args.pathologyId),
        eq(schema.pathology.condominiumId, args.condominiumId),
        isNull(schema.pathology.deletedAt),
      ))
      .returning({ id: schema.pathology.id })
  );
  return rows.length > 0;
}
