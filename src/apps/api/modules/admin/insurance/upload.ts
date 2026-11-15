// Upload + OCR + attachments da apólice:
//   mimeToPolicyExtension          - MIME -> ext do storage key.
//   requireCoverageDates           - vigência obrigatória dos caminhos do admin.
//   extractPolicyOcr               - OCR best-effort de um ficheiro.
//   addInsurancePolicyAttachment   - INSERT multi-file (ADR 0006).
//   uploadInsurancePolicy          - cria policy pending_review + 1o ficheiro +
//                                    OCR best-effort + limpeza do draft anterior
//                                    do mesmo uploader.
// Ler e servir os anexos vive em `attachments.ts`.

import { and, eq } from "drizzle-orm";
import { STATUS_CODE } from "@std/http";
import { AppError } from "$api/libs/error/app_error.ts";
import type { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import type { ActorSnapshot } from "$api/libs/postgres/schemas/_audit.ts";
import type {
  AttachmentSelect,
  EvidenceSource,
  InsurancePolicySelect,
  OcrExtracted,
} from "$api/libs/postgres/schemas/mod.ts";
import { softDeleteAttachmentsForEntity, uploadAttachment } from "$api/libs/attachments/mod.ts";
import { extractInsuranceFields } from "$api/libs/ocr/extract_pdf.ts";
import { addOneYear } from "$shared/insurance/policy_status.ts";

// MIME -> ext do storage key. Suporta PDF + imagens (foto da apólice).
export function mimeToPolicyExtension(mimeType: string): string {
  switch (mimeType) {
    case "application/pdf":
      return "pdf";
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/heic":
    case "image/heif":
      return "heic";
    default:
      return "bin";
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Vigência decidida por quem tem o documento à frente - obrigatória nos dois
// caminhos do admin (renovar com documento e registar de raiz). Gravar a
// aritmética que ninguém conferiu contra o papel é pior do que recusar.
export function requireCoverageDates(
  dates?: { validFrom: string; validTo: string },
): { validFrom: string; validTo: string } {
  const validFrom = dates?.validFrom ?? "";
  const validTo = dates?.validTo ?? "";
  if (!ISO_DATE.test(validFrom) || !ISO_DATE.test(validTo)) {
    throw new AppError({
      message: "Indica o início e o fim da vigência (AAAA-MM-DD).",
      statusCode: STATUS_CODE.UnprocessableEntity,
      code: "VALIDATION_ERROR",
    });
  }
  if (validFrom > validTo) {
    throw new AppError({
      message: `A data de início (${validFrom}) é posterior à data de fim (${validTo}).`,
      statusCode: STATUS_CODE.UnprocessableEntity,
      code: "VALIDATION_ERROR",
    });
  }
  return { validFrom, validTo };
}

// Só PDF (`extract_pdf` assume .pdf); imagens ficam sem candidatas e o
// utilizador preenche à mão. Falha não impede o registo da apólice.
export async function extractPolicyOcr(
  bytes: Uint8Array,
  mimeType: string,
): Promise<{ ocr: OcrExtracted; ocrConfidence: string | null }> {
  if (mimeType !== "application/pdf") return { ocr: {}, ocrConfidence: null };
  try {
    const r = await extractInsuranceFields(bytes);
    return {
      ocr: {
        candidatesValidUntil: r.candidatesValidUntil,
        candidatesValidFrom: r.candidatesValidFrom,
        rawText: r.rawText,
        policyNumberCandidate: r.policyNumberCandidate,
        insurerCandidate: r.insurerCandidate,
      },
      ocrConfidence: r.confidence,
    };
  } catch (e) {
    console.warn(`[insurance:upload] OCR falhou:`, (e as Error).message);
    return { ocr: {}, ocrConfidence: null };
  }
}

// Attachments via `core.attachment` (polimórfica); a apólice não tem
// `storageKey` próprio.
// Multi-file: uma apólice pode ter N ficheiros (apólice + recibo + foto + ...).
// Sem `kind` tipado - cada attachment é bag de ficheiros.
export async function addInsurancePolicyAttachment(
  postgres: Postgres,
  args: {
    condominiumId: string;
    policyId: string;
    bytes: Uint8Array;
    mimeType: string;
    filename: string;
    actor: ActorSnapshot;
  },
): Promise<AttachmentSelect> {
  // Valida que a policy existe e pertence ao condo - anti-IDOR.
  const policy = await postgres.query((db) =>
    db.query.insurancePolicy.findFirst({
      where: (p, ops) =>
        ops.and(
          ops.eq(p.id, args.policyId),
          ops.eq(p.condominiumId, args.condominiumId),
        ),
      columns: { id: true },
    })
  );
  if (!policy) {
    throw new AppError({
      message: "Apólice não encontrada",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }
  return await uploadAttachment({
    postgres,
    condominiumId: args.condominiumId,
    entityType: "insurance",
    entityId: args.policyId,
    actor: args.actor,
    filename: args.filename,
    mimeType: args.mimeType,
    bytes: args.bytes,
  });
}

export async function uploadInsurancePolicy(
  postgres: Postgres,
  args: {
    condominiumId: string;
    unitId: string;
    bytes: Uint8Array;
    mimeType: string;
    actor: ActorSnapshot;
    /** Quem entregou a prova: `unit` no portal, `admin` no documento que chegou
     *  à administração. Sem default - herdá-lo por distração
     *  poria o badge a mentir. */
    evidenceSource: EvidenceSource;
    /** Vigência já decidida por quem submete. Sem ela manda o OCR (é o portal,
     *  onde a fração ainda vai confirmar os dados). */
    dates?: { validFrom: string; validTo: string };
  },
): Promise<InsurancePolicySelect> {
  const { condominiumId, unitId, bytes, mimeType, actor, evidenceSource } = args;

  // 1. OCR best-effort.
  const { ocr, ocrConfidence } = await extractPolicyOcr(bytes, mimeType);

  // Fallback sem validUntil: +1 ano a partir do início (ou de hoje). Apólices PT
  // são tipicamente anuais; user corrige no form de confirmação. Com a vigência
  // já decidida não se inventa candidato nenhum - `ocr_extracted` fica só com o
  // que o documento deu.
  const today = new Date().toISOString().slice(0, 10);
  if (!args.dates && (!ocr.candidatesValidUntil || ocr.candidatesValidUntil.length === 0)) {
    const start = ocr.candidatesValidFrom?.[0] ?? today;
    ocr.candidatesValidUntil = [addOneYear(start)];
    if (!ocr.candidatesValidFrom || ocr.candidatesValidFrom.length === 0) {
      ocr.candidatesValidFrom = [start];
    }
  }

  // 2. INSERT em pending_review. valid_from/valid_to NOT NULL:
  //    usa a vigência do formulário, o melhor candidate OCR ou today/+1y.
  const validFrom = args.dates?.validFrom ?? ocr.candidatesValidFrom?.[0] ?? today;
  const validTo = args.dates?.validTo ?? ocr.candidatesValidUntil?.[0] ?? addOneYear(validFrom);
  const inserted = await postgres.query((db) =>
    db.insert(schema.insurancePolicy).values({
      condominiumId,
      unitId,
      validFrom,
      validTo,
      ocrExtracted: ocr,
      ocrConfidence: ocrConfidence ?? undefined,
      uploadedBy: actor,
      createdBy: actor,
      status: "pending_review",
      // O passo 3 anexa sempre o ficheiro, logo a marca nunca fica a mentir.
      evidenceSource,
    }).returning()
  );
  const policy = inserted[0];

  // 3. Attachment via factory polimórfica (ADR 0006).
  const ext = mimeToPolicyExtension(mimeType);
  await uploadAttachment({
    postgres,
    condominiumId,
    entityType: "insurance",
    entityId: policy.id,
    actor,
    filename: `apolice.${ext}`,
    mimeType,
    bytes,
  });

  // 4. Limpa o draft anterior DESTE uploader (evita duplicados de re-submissão).
  //    active/rejected ficam intactas (history válida) e os drafts de outros
  //    ocupantes também (ADR 0017: proprietário e inquilino coexistem).
  //    Só no portal: do lado do admin "o mesmo uploader" é a conta de gestão, e
  //    isto apagaria a renovação por rever que ele próprio submeteu - com o
  //    documento dela.
  if (evidenceSource === "unit") {
    await deleteOwnPendingDrafts(postgres, {
      condominiumId,
      unitId,
      currentPolicyId: policy.id,
      actor,
    });
  }

  return policy;
}

// Hard-delete dos drafts pending_review pendurados do mesmo uploader + cleanup
// attachments (soft-delete cuida do S3). Best-effort: falhas individuais não
// desfazem nada. Sem `user_id` no actor não apaga nada - não há dono a comparar.
async function deleteOwnPendingDrafts(
  postgres: Postgres,
  args: {
    condominiumId: string;
    unitId: string;
    currentPolicyId: string;
    actor: ActorSnapshot;
  },
): Promise<void> {
  const uploaderId = args.actor.user_id;
  if (!uploaderId) return;
  const pending = await postgres.query((db) =>
    db.query.insurancePolicy.findMany({
      where: (p, ops) =>
        ops.and(
          ops.eq(p.condominiumId, args.condominiumId),
          ops.eq(p.unitId, args.unitId),
          ops.eq(p.status, "pending_review"),
          ops.ne(p.id, args.currentPolicyId),
        ),
      columns: { id: true, uploadedBy: true },
    })
  );
  const oldPending = pending.filter((p) => p.uploadedBy?.user_id === uploaderId);

  for (const old of oldPending) {
    // Cascata S3 aos anexos PRIMEIRO (ADR 0021); a linha é hard-deleted a
    // seguir, por isso engolir a falha do S3 deixaria o ficheiro sem dono.
    await softDeleteAttachmentsForEntity({
      postgres,
      condominiumId: args.condominiumId,
      entityType: "insurance",
      entityId: old.id,
      actor: args.actor,
    });
    await postgres.query((db) =>
      db.delete(schema.insurancePolicy)
        .where(and(
          eq(schema.insurancePolicy.id, old.id),
          eq(schema.insurancePolicy.condominiumId, args.condominiumId),
        ))
    );
  }
  if (oldPending.length > 0) {
    console.info(
      `[insurance:upload] apagou ${oldPending.length} draft(s) pending_review do uploader ` +
        `${uploaderId} para unit=${args.unitId}`,
    );
  }
}
