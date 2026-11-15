// Helpers core de inspeções: CRUD + activate/deactivate + attachments (1:N) +
// counter de alertas. handlers.ts são thin wrappers.

import { and, count, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { byIdInCondo } from "$api/libs/shared/by_id_in_condo.ts";
import type { ActorSnapshot } from "$api/libs/postgres/schemas/_audit.ts";
import type {
  InspectionAttachmentSelect,
  InspectionInsert,
  InspectionSelect,
  InspectionUpdate,
} from "$api/libs/postgres/schemas/mod.ts";

// ═══ Counter de alertas (badge no menu) ═══════════════════════════════════════
// Conta linhas em estado due_soon OU expired E ativas (is_active=true).

export async function countInspectionAlerts(
  postgres: Postgres,
  condominiumId: string,
): Promise<number> {
  // Aritmética de intervalos via `sql` helper: o cast a interval é necessário
  // porque notifyDaysBefore é integer e date - int não funciona direto.
  const rows = await postgres.query((db) =>
    db.select({ count: count() })
      .from(schema.inspection)
      .where(and(
        eq(schema.inspection.condominiumId, condominiumId),
        isNull(schema.inspection.deletedAt),
        eq(schema.inspection.isActive, true),
        or(
          lte(schema.inspection.validUntil, sql`CURRENT_DATE`),
          lte(
            sql`${schema.inspection.validUntil} - ${schema.inspection.notifyDaysBefore} * INTERVAL '1 day'`,
            sql`CURRENT_DATE`,
          ),
        ),
      ))
  );
  return Number(rows[0]?.count ?? 0);
}

// ═══ Listagem com filtros + agrupamento de anexos ═════════════════════════════

export interface ListInspectionsFilters {
  category?: string;
  status?: "ok" | "due_soon" | "expired" | "inactive";
  /** Só `is_active=true` (portal da fração não vê inspeções desactivadas). */
  onlyActive?: boolean;
}

export async function listInspections(
  postgres: Postgres,
  condominiumId: string,
  filters: ListInspectionsFilters = {},
  options: { withAttachments?: boolean; withSupplier?: boolean } = {},
): Promise<
  Array<
    InspectionSelect & {
      attachments: InspectionAttachmentSelect[];
      supplier?: { id: string; name: string; nif: string | null } | null;
    }
  >
> {
  const withAttachments = options.withAttachments !== false; // default true
  const rows = await postgres.query((db) =>
    db.query.inspection.findMany({
      where: (i, ops) => {
        const conds = [
          ops.eq(i.condominiumId, condominiumId),
          ops.isNull(i.deletedAt),
        ];
        if (filters.category) conds.push(ops.eq(i.category, filters.category));
        if (filters.onlyActive) {
          conds.push(ops.eq(i.isActive, true));
        }
        return ops.and(...conds);
      },
      // Nome do fornecedor para a listagem admin (opt-in). Portal não pede.
      with: options.withSupplier
        ? { supplier: { columns: { id: true, name: true, nif: true } } }
        : undefined,
      orderBy: (i, ops) => [ops.asc(i.validUntil)],
      limit: 500,
    })
  );

  if (rows.length === 0) return [];

  // Lite mode (withAttachments=false): dashboard só precisa de contagens/datas.
  if (!withAttachments) {
    const enriched = rows.map((row) => ({ ...row, attachments: [] }));
    if (!filters.status) return enriched;
    return filterByStatus(enriched, filters.status);
  }

  // 1 query batch para todos os anexos (evita N+1). Polimórfica core.attachment.
  const ids = rows.map((row) => row.id);
  const attachments = await postgres.query((db) =>
    db.query.attachment.findMany({
      where: (a, ops) =>
        ops.and(
          ops.eq(a.entityType, "inspection"),
          inArray(a.entityId, ids),
          ops.isNull(a.deletedAt),
        ),
      orderBy: (a, ops) => [ops.desc(a.createdAt)],
    })
  );

  const attachmentsByInspection = new Map<string, InspectionAttachmentSelect[]>();
  for (const att of attachments) {
    const arr = attachmentsByInspection.get(att.entityId) ?? [];
    arr.push(att as unknown as InspectionAttachmentSelect);
    attachmentsByInspection.set(att.entityId, arr);
  }

  const enriched = rows.map((row) => ({
    ...row,
    attachments: attachmentsByInspection.get(row.id) ?? [],
  }));

  // Filtra status no nó (SQL não compensa para 500 linhas/condo).
  if (!filters.status) return enriched;
  return filterByStatus(enriched, filters.status);
}

function filterByStatus<T extends InspectionSelect & { attachments: InspectionAttachmentSelect[] }>(
  rows: T[],
  status: NonNullable<ListInspectionsFilters["status"]>,
): T[] {
  const today = new Date().toISOString().slice(0, 10);
  return rows.filter((row) => {
    if (!row.isActive) return status === "inactive";
    if (status === "inactive") return false;
    const validUntil = row.validUntil;
    if (!validUntil) return false;
    if (validUntil <= today) return status === "expired";
    const validTo = new Date(`${validUntil}T00:00:00Z`);
    const threshold = new Date(validTo.getTime() - row.notifyDaysBefore * 86_400_000);
    const thresholdIso = threshold.toISOString().slice(0, 10);
    if (today >= thresholdIso) return status === "due_soon";
    return status === "ok";
  });
}

export async function listAttachmentsFor(
  postgres: Postgres,
  inspectionId: string,
): Promise<InspectionAttachmentSelect[]> {
  const rows = await postgres.query((db) =>
    db.query.attachment.findMany({
      where: (a, ops) =>
        ops.and(
          ops.eq(a.entityType, "inspection"),
          ops.eq(a.entityId, inspectionId),
          ops.isNull(a.deletedAt),
        ),
      orderBy: (a, ops) => [ops.desc(a.createdAt)],
    })
  );
  return rows as unknown as InspectionAttachmentSelect[];
}

// ═══ CRUD inspection ══════════════════════════════════════════════════════════

export async function createInspection(
  postgres: Postgres,
  args: {
    condominiumId: string;
    actor: ActorSnapshot;
    data: {
      category: string;
      description: string;
      validUntil: string;
      lastDoneDate?: string | null;
      notifyDaysBefore?: number;
      notes?: string | null;
      supplierId?: string | null;
    };
  },
): Promise<InspectionSelect> {
  const insert: InspectionInsert = {
    condominiumId: args.condominiumId,
    category: args.data.category,
    description: args.data.description,
    validUntil: args.data.validUntil,
    lastDoneDate: args.data.lastDoneDate ?? null,
    notifyDaysBefore: args.data.notifyDaysBefore ?? 30,
    notes: args.data.notes ?? null,
    supplierId: args.data.supplierId ?? null,
    createdBy: args.actor,
  };
  const inserted = await postgres.query((db) =>
    db.insert(schema.inspection).values(insert).returning()
  );
  return inserted[0];
}

export async function updateInspection(
  postgres: Postgres,
  args: {
    condominiumId: string;
    inspectionId: string;
    actor: ActorSnapshot;
    patch: {
      category?: string;
      description?: string;
      validUntil?: string;
      lastDoneDate?: string | null;
      notifyDaysBefore?: number;
      notes?: string | null;
      supplierId?: string | null;
    };
  },
): Promise<InspectionSelect | null> {
  const cur = await postgres.query((db) =>
    db.query.inspection.findFirst({
      where: byIdInCondo(schema.inspection, args.inspectionId, args.condominiumId),
    })
  );
  if (!cur) return null;

  const patch: InspectionUpdate = {
    updatedBy: args.actor,
    updatedAt: new Date(),
  };
  if (args.patch.category !== undefined) patch.category = args.patch.category;
  if (args.patch.description !== undefined) patch.description = args.patch.description;
  if (args.patch.validUntil !== undefined) patch.validUntil = args.patch.validUntil;
  if (args.patch.lastDoneDate !== undefined) patch.lastDoneDate = args.patch.lastDoneDate;
  if (args.patch.notifyDaysBefore !== undefined) {
    patch.notifyDaysBefore = args.patch.notifyDaysBefore;
  }
  if (args.patch.notes !== undefined) patch.notes = args.patch.notes;
  if (args.patch.supplierId !== undefined) patch.supplierId = args.patch.supplierId;

  const rows = await postgres.query((db) =>
    db.update(schema.inspection)
      .set(patch)
      .where(byIdInCondo(schema.inspection, args.inspectionId, args.condominiumId))
      .returning()
  );
  return rows[0] ?? null;
}

export async function setInspectionActive(
  postgres: Postgres,
  args: {
    condominiumId: string;
    inspectionId: string;
    actor: ActorSnapshot;
    isActive: boolean;
  },
): Promise<InspectionSelect | null> {
  const rows = await postgres.query((db) =>
    db.update(schema.inspection)
      .set({
        isActive: args.isActive,
        updatedBy: args.actor,
        updatedAt: new Date(),
      })
      .where(byIdInCondo(schema.inspection, args.inspectionId, args.condominiumId))
      .returning()
  );
  return rows[0] ?? null;
}

export async function softDeleteInspection(
  postgres: Postgres,
  args: { condominiumId: string; inspectionId: string; actor: ActorSnapshot },
): Promise<boolean> {
  // Cascata S3 aos anexos PRIMEIRO, depois soft-delete (ADR 0021).
  await softDeleteAttachmentsForEntity({
    postgres,
    condominiumId: args.condominiumId,
    entityType: "inspection",
    entityId: args.inspectionId,
    actor: args.actor,
  });

  const rows = await postgres.query((db) =>
    db.update(schema.inspection)
      .set({
        deletedAt: new Date(),
        deletedBy: args.actor,
        updatedAt: new Date(),
      })
      .where(byIdInCondo(schema.inspection, args.inspectionId, args.condominiumId))
      .returning()
  );
  return rows.length > 0;
}

// ═══ Attachments ══════════════════════════════════════════════════════════════
// Wrappers finos sobre `libs/attachments/mod.ts` (core.attachment polimórfica).

import {
  softDeleteAttachment as sharedSoftDelete,
  softDeleteAttachmentsForEntity,
  uploadAttachment as sharedUpload,
} from "$api/libs/attachments/mod.ts";

export async function addAttachment(
  postgres: Postgres,
  args: {
    condominiumId: string;
    inspectionId: string;
    actor: ActorSnapshot;
    filename: string;
    mimeType: string;
    bytes: Uint8Array;
  },
): Promise<InspectionAttachmentSelect> {
  const att = await sharedUpload({
    postgres,
    condominiumId: args.condominiumId,
    entityType: "inspection",
    entityId: args.inspectionId,
    actor: args.actor,
    filename: args.filename,
    mimeType: args.mimeType,
    bytes: args.bytes,
  });
  return att as unknown as InspectionAttachmentSelect;
}

/** Nome próprio (não `softDeleteAttachment`) para não sombrear o canónico de
 *  `libs/attachments/mod.ts` - a colisão obrigava a um comentário em cada uso. */
export async function softDeleteInspectionAttachment(
  postgres: Postgres,
  args: {
    condominiumId: string;
    inspectionId: string;
    attachmentId: string;
    actor: ActorSnapshot;
  },
): Promise<boolean> {
  return await sharedSoftDelete({
    postgres,
    condominiumId: args.condominiumId,
    entityType: "inspection",
    entityId: args.inspectionId,
    attachmentId: args.attachmentId,
    actor: args.actor,
  });
}
