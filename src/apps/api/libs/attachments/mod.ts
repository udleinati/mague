// Helpers unificados para attachments (upload, serve, soft-delete, list, get).
// Cada helper recebe `entityType` + `entityId`; o caller só valida que o pai
// existe e pertence ao condo (anti-IDOR) antes de chamar. Storage via
// `buildStorageKey` (sharded); MIME validado pela allowlist em
// `validate_attachment.ts`.

import { and, eq, isNull } from "drizzle-orm";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import type {
  AttachmentEntityType,
  AttachmentInsert,
  AttachmentSelect,
} from "$api/libs/postgres/schemas/attachment.ts";
import {
  deleteObject,
  ensureBucket,
  getObject,
  putObject,
  type PutResult,
} from "$api/libs/storage/s3.ts";
import { buildStorageKey } from "$api/libs/storage/storage_key.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import {
  safeAttachmentServeHeaders,
  validateAttachmentMime,
} from "$api/libs/shared/validate_attachment.ts";
import type { ActorSnapshot } from "$api/libs/postgres/schemas/_audit.ts";

import { env } from "$config/env.ts";
const MAX_FILE_SIZE = env.upload.maxFileSizeBytes;

/** Mapeia entityType → folder no S3 (plural).
 *  charge→charges, ticket→tickets, etc. */
const ENTITY_FOLDER: Record<AttachmentEntityType, string> = {
  charge: "charges",
  ticket: "tickets",
  inspection: "inspections",
  assembly: "assemblies",
  insurance: "insurance",
  document: "documents",
  pathology: "pathologies",
};

/** Prefixo do id do attachment por tipo. Mantém compat visual com IDs
 *  antigos (cat_*, tat_*, att_*). Para entidades novas usa `at_`. */
const ENTITY_ID_PREFIX: Record<AttachmentEntityType, string> = {
  charge: "cat",
  ticket: "tat",
  inspection: "att",
  assembly: "asa",
  insurance: "ina",
  document: "doc",
  pathology: "pat",
};

export interface UploadArgs {
  postgres: Postgres;
  condominiumId: string;
  entityType: AttachmentEntityType;
  entityId: string;
  actor: ActorSnapshot;
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}

export async function uploadAttachment(args: UploadArgs): Promise<AttachmentSelect> {
  if (args.bytes.length === 0) {
    throw new AppError({
      message: "Ficheiro vazio",
      statusCode: STATUS_CODE.BadRequest,
      code: "EMPTY_FILE",
    });
  }
  if (args.bytes.length > MAX_FILE_SIZE) {
    throw new AppError({
      message: `Ficheiro muito grande (max ${MAX_FILE_SIZE / 1024 / 1024} MB)`,
      statusCode: STATUS_CODE.ContentTooLarge,
      code: "FILE_TOO_LARGE",
    });
  }
  validateAttachmentMime(args.mimeType || "application/octet-stream", args.bytes);

  await ensureBucket();
  // Decompõe NFD e remove diacríticos ANTES de sanitizar: senão a cedilha
  // (não-`\w`) virava `_` e `ORÇAMENTO` ficava `ORC_AMENTO` (macOS dá NFD).
  const safeName = args.filename
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w.\-]/g, "_")
    .slice(0, 80) || "anexo";
  const attachmentId = `${ENTITY_ID_PREFIX[args.entityType]}_${
    crypto.randomUUID().substring(0, 10)
  }`;
  const storageKey = buildStorageKey({
    entity: ENTITY_FOLDER[args.entityType],
    condominiumId: args.condominiumId,
    parentId: args.entityId,
    attachmentId,
    filename: safeName,
  });

  let put: PutResult;
  try {
    put = await putObject(storageKey, args.bytes, args.mimeType || "application/octet-stream");
  } catch (e) {
    throw new AppError({
      message: `Falha a guardar ficheiro no S3: ${(e as Error).message}`,
      statusCode: STATUS_CODE.InternalServerError,
      code: "S3_PUT_FAILED",
    });
  }

  const insert: AttachmentInsert = {
    id: attachmentId,
    condominiumId: args.condominiumId,
    entityType: args.entityType,
    entityId: args.entityId,
    filename: safeName,
    mimeType: args.mimeType || "application/octet-stream",
    storageKey,
    storageEtag: put.etag ?? null,
    fileSize: put.size,
    fileSha256: put.sha256,
    createdBy: args.actor,
  };
  const rows = await args.postgres.query((db) =>
    db.insert(schema.attachment).values(insert).returning()
  );
  return rows[0];
}

export interface CopyToEntityArgs {
  postgres: Postgres;
  condominiumId: string;
  source: { entityType: AttachmentEntityType; entityId: string };
  target: { entityType: AttachmentEntityType; entityId: string };
  actor: ActorSnapshot;
}

// Copia (DUPLICA, não move) os attachments não-deletados de uma entidade para
// outra: cada cópia tem novo S3 key + nova row; o original fica intacto. Caso
// canónico: promover ticket a patologia sem que apagar a patologia afete o
// ticket. Falhas individuais não abortam o batch (devolve contagem).
export async function copyAttachmentsToEntity(
  args: CopyToEntityArgs,
): Promise<{ copied: number; failed: number; total: number }> {
  const sourceList = await listAttachmentsForEntity({
    postgres: args.postgres,
    condominiumId: args.condominiumId,
    entityType: args.source.entityType,
    entityId: args.source.entityId,
  });

  let copied = 0;
  let failed = 0;
  for (const src of sourceList) {
    try {
      const bytes = await getObject(src.storageKey);
      // Re-upload produz novo storage key sharded sob o novo parent + nova row.
      await uploadAttachment({
        postgres: args.postgres,
        condominiumId: args.condominiumId,
        entityType: args.target.entityType,
        entityId: args.target.entityId,
        actor: args.actor,
        filename: src.filename,
        mimeType: src.mimeType,
        bytes,
      });
      copied++;
    } catch (e) {
      console.warn(
        `copyAttachmentsToEntity: falhou para ${src.id} (${src.storageKey}): ${
          (e as Error).message
        }`,
      );
      failed++;
    }
  }
  return { copied, failed, total: sourceList.length };
}

export interface ListArgs {
  postgres: Postgres;
  condominiumId: string;
  entityType: AttachmentEntityType;
  entityId: string;
}

export async function listAttachmentsForEntity(args: ListArgs): Promise<AttachmentSelect[]> {
  return await args.postgres.query((db) =>
    db.query.attachment.findMany({
      where: (a, ops) =>
        ops.and(
          ops.eq(a.condominiumId, args.condominiumId),
          ops.eq(a.entityType, args.entityType),
          ops.eq(a.entityId, args.entityId),
          ops.isNull(a.deletedAt),
        ),
      orderBy: (a, ops) => [ops.desc(a.createdAt)],
    })
  );
}

export interface GetArgs {
  postgres: Postgres;
  condominiumId: string;
  entityType: AttachmentEntityType;
  entityId: string;
  attachmentId: string;
}

export async function getAttachmentById(args: GetArgs): Promise<AttachmentSelect | null> {
  // 4-way scope: id + cid + entity_type + entity_id (anti-IDOR completo).
  const found = await args.postgres.query((db) =>
    db.query.attachment.findFirst({
      where: (a, ops) =>
        ops.and(
          ops.eq(a.id, args.attachmentId),
          ops.eq(a.condominiumId, args.condominiumId),
          ops.eq(a.entityType, args.entityType),
          ops.eq(a.entityId, args.entityId),
          ops.isNull(a.deletedAt),
        ),
    })
  );
  return found ?? null;
}

export async function serveAttachmentBytes(storageKey: string): Promise<Uint8Array> {
  try {
    return await getObject(storageKey);
  } catch (e) {
    throw new AppError({
      message: `Erro a servir ficheiro: ${(e as Error).message}`,
      statusCode: STATUS_CODE.NotFound,
      code: "STORAGE_NOT_FOUND",
    });
  }
}

/** Headers seguros para servir o ficheiro (CSP + nosniff + correct Content-Type). */
export function serveHeaders(att: AttachmentSelect, byteLength: number): Record<string, string> {
  return safeAttachmentServeHeaders(att.mimeType, att.filename, byteLength);
}

export interface DeleteArgs {
  postgres: Postgres;
  condominiumId: string;
  entityType: AttachmentEntityType;
  entityId: string;
  attachmentId: string;
  actor: ActorSnapshot;
}

export interface CascadeArgs {
  postgres: Postgres;
  condominiumId: string;
  entityType: AttachmentEntityType;
  entityId: string;
  actor: ActorSnapshot;
}

/**
 * Cascata pai -> anexos do ADR 0021: apaga os bytes de TODOS os anexos vivos da
 * entidade antes de o caller tocar na linha do pai. Devolve quantos apagou.
 *
 * Fail-fast por contrato: se o S3 falhar, lança e o pai fica vivo (deleteObject
 * é idempotente, o admin repete). Engolir o erro e apagar o pai à mesma é o que
 * produz o ficheiro órfão - linha fora, bytes lá.
 *
 * Chamar SEMPRE antes do soft-delete/delete do pai. O `attachment_cascade_test`
 * falha se alguma entidade com anexos apagar sem passar por aqui.
 */
export async function softDeleteAttachmentsForEntity(args: CascadeArgs): Promise<number> {
  const live = await listAttachmentsForEntity({
    postgres: args.postgres,
    condominiumId: args.condominiumId,
    entityType: args.entityType,
    entityId: args.entityId,
  });
  for (const att of live) {
    await softDeleteAttachment({
      postgres: args.postgres,
      condominiumId: args.condominiumId,
      entityType: args.entityType,
      entityId: args.entityId,
      attachmentId: att.id,
      actor: args.actor,
    });
  }
  return live.length;
}

export async function softDeleteAttachment(args: DeleteArgs): Promise<boolean> {
  // 1. Buscar storage_key antes do UPDATE; false se já soft-deleted.
  const att = await getAttachmentById({
    postgres: args.postgres,
    condominiumId: args.condominiumId,
    entityType: args.entityType,
    entityId: args.entityId,
    attachmentId: args.attachmentId,
  });
  if (!att) return false;

  // 2. Apagar S3 PRIMEIRO (ADR 0021): falhar aqui aborta antes de tocar na BD,
  //    para não deixar ficheiros órfãos. DeleteObject é idempotente.
  try {
    await deleteObject(att.storageKey);
  } catch (e) {
    throw new AppError({
      message: `Falha a apagar do S3: ${(e as Error).message}`,
      statusCode: STATUS_CODE.InternalServerError,
      code: "S3_DELETE_FAILED",
    });
  }

  // 3. Soft-delete na BD (mantemos row para audit trail).
  const r = await args.postgres.query((db) =>
    db.update(schema.attachment)
      .set({ deletedAt: new Date(), deletedBy: args.actor })
      .where(and(
        eq(schema.attachment.id, args.attachmentId),
        eq(schema.attachment.condominiumId, args.condominiumId),
        eq(schema.attachment.entityType, args.entityType),
        eq(schema.attachment.entityId, args.entityId),
        isNull(schema.attachment.deletedAt),
      ))
      .returning({ id: schema.attachment.id })
  );
  return r.length > 0;
}
