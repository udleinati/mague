// Anexos de uma apólice: listar, projetar e servir bytes. Existia escrito quatro
// vezes (admin `/pdf`, admin `/attachments/:id`, portal `/pdf`, portal
// `/attachments/:id`), sempre com list-then-find em memória em vez do lookup
// de 4 chaves que o `getAttachmentById` faz. Os gates de estado NÃO vivem aqui -
// são os predicados de `$shared/insurance/policy_status.ts`, chamados por quem
// monta o handler; aqui só se decide qual o ficheiro e como sai.

import { STATUS_CODE } from "@std/http";
import type { Postgres } from "$api/libs/postgres/postgres.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import type { AttachmentSelect } from "$api/libs/postgres/schemas/attachment.ts";
import {
  getAttachmentById as defaultGetAttachmentById,
  listAttachmentsForEntity as defaultListAttachmentsForEntity,
  serveAttachmentBytes as defaultServeAttachmentBytes,
  serveHeaders as defaultServeHeaders,
} from "$api/libs/attachments/mod.ts";

/** Mesmo padrão do `AttachmentLibDeps` do manager: os testes passam fakes e a
 *  composição exercita-se sem S3 nem BD. */
export interface PolicyAttachmentDeps {
  listAttachmentsForEntity: typeof defaultListAttachmentsForEntity;
  getAttachmentById: typeof defaultGetAttachmentById;
  serveAttachmentBytes: typeof defaultServeAttachmentBytes;
  serveHeaders: typeof defaultServeHeaders;
}

const defaultDeps: PolicyAttachmentDeps = {
  listAttachmentsForEntity: defaultListAttachmentsForEntity,
  getAttachmentById: defaultGetAttachmentById,
  serveAttachmentBytes: defaultServeAttachmentBytes,
  serveHeaders: defaultServeHeaders,
};

/** Metadata pública: sem `storageKey` nem ActorSnapshots (ADR 0011). */
export function policyAttachmentResponse(a: AttachmentSelect) {
  return {
    id: a.id,
    filename: a.filename,
    mimeType: a.mimeType,
    fileSize: a.fileSize,
    createdAt: a.createdAt,
  };
}

export function listPolicyAttachments(
  postgres: Postgres,
  args: { condominiumId: string; policyId: string },
  deps: Partial<PolicyAttachmentDeps> = {},
): Promise<AttachmentSelect[]> {
  const d = { ...defaultDeps, ...deps };
  return d.listAttachmentsForEntity({
    postgres,
    condominiumId: args.condominiumId,
    entityType: "insurance",
    entityId: args.policyId,
  });
}

/**
 * Bytes de um anexo da apólice. Sem `attachmentId` serve o **principal** (o mais
 * recente) - é o que o link "PDF" histórico aponta, e o que distingue os dois
 * 404: sem ficheiro nenhum a apólice ainda não tem evidência (`NO_ATTACHMENT`);
 * com um id que não bate é o ficheiro que não existe (`NOT_FOUND`).
 *
 * Quem chama já provou que a apólice é do condomínio (e, no portal, da fração).
 */
export async function servePolicyAttachment(
  postgres: Postgres,
  args: { condominiumId: string; policyId: string; attachmentId?: string | null },
  deps: Partial<PolicyAttachmentDeps> = {},
): Promise<Response> {
  const d = { ...defaultDeps, ...deps };
  const att = args.attachmentId
    ? await d.getAttachmentById({
      postgres,
      condominiumId: args.condominiumId,
      entityType: "insurance",
      entityId: args.policyId,
      attachmentId: args.attachmentId,
    })
    : (await listPolicyAttachments(postgres, args, d))[0] ?? null;

  if (!att) {
    throw args.attachmentId
      ? new AppError({
        message: "Ficheiro não encontrado",
        statusCode: STATUS_CODE.NotFound,
        code: "NOT_FOUND",
      })
      : new AppError({
        message: "Esta apólice ainda não tem ficheiro carregado",
        statusCode: STATUS_CODE.NotFound,
        code: "NO_ATTACHMENT",
      });
  }

  const bytes = await d.serveAttachmentBytes(att.storageKey);
  return new Response(bytes as unknown as BodyInit, {
    status: STATUS_CODE.OK,
    headers: d.serveHeaders(att, bytes.byteLength),
  });
}
