// Manutenção (não transita status): editInsurancePolicyDetails (só
// pending_review) e deleteInsurancePolicy (hard-delete + cleanup attachments,
// ADR 0021: S3 antes da BD).

import { and, eq } from "drizzle-orm";
import { STATUS_CODE } from "@std/http";
import { AppError } from "$api/libs/error/app_error.ts";
import type { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import type { ActorSnapshot } from "$api/libs/postgres/schemas/_audit.ts";
import type { InsurancePolicySelect } from "$api/libs/postgres/schemas/mod.ts";
import { softDeleteAttachmentsForEntity } from "$api/libs/attachments/mod.ts";
import { canDeletePolicy, canEditPolicy } from "$shared/insurance/policy_status.ts";

// Só em `pending_review` (ADR 0016): edit em active/rejected/superseded é
// proibido - admin rejeita primeiro (preserva auditoria).
export async function editInsurancePolicyDetails(
  postgres: Postgres,
  args: {
    policyId: string;
    condominiumId: string;
    fields: {
      validFrom?: string;
      validTo?: string;
      policyNumber?: string;
      insurer?: string;
      coverageAmountCents?: number | null;
    };
    actor: ActorSnapshot;
  },
): Promise<InsurancePolicySelect> {
  const current = await postgres.query((db) =>
    db.query.insurancePolicy.findFirst({
      where: (p, ops) =>
        ops.and(
          ops.eq(p.id, args.policyId),
          ops.eq(p.condominiumId, args.condominiumId),
        ),
    })
  );
  if (!current) {
    throw new AppError({
      message: "Apólice não encontrada",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }
  if (!canEditPolicy(current)) {
    throw new AppError({
      message:
        `Edit só permitido em pending_review (estado atual: ${current.status}). Rejeita primeiro se for ` +
        `necessário corrigir uma apólice ativa.`,
      statusCode: STATUS_CODE.UnprocessableEntity,
      code: "INVALID_STATE",
    });
  }
  const rows = await postgres.query((db) =>
    db.update(schema.insurancePolicy)
      .set({
        ...args.fields,
        updatedBy: args.actor,
        updatedAt: new Date(),
      })
      .where(and(
        eq(schema.insurancePolicy.id, args.policyId),
        eq(schema.insurancePolicy.condominiumId, args.condominiumId),
      ))
      .returning()
  );
  return rows[0];
}

// Hard-delete da apólice + PDF do S3 (tabela sem `deleted_at`; auditoria via
// cdc_log). Gate puro `canDeletePolicy` (ADR 0040): admin apaga tudo exceto
// cobertura viva saudável (rejeitar primeiro); portal só a própria submissão por
// confirmar. Apólice com sucessora → 409 (o ON DELETE RESTRICT da linhagem
// bloquearia na mesma, mas com 500 opaco).
export async function deleteInsurancePolicy(
  postgres: Postgres,
  args: {
    policyId: string;
    condominiumId: string;
    /** Quem apaga: admin (sem dono) ou portal (compara uploader com `userId`). */
    gate: { isAdmin: boolean; userId?: string | null };
    actor: ActorSnapshot;
    /** Override de "hoje" para testes; default new Date(). */
    today?: Date;
  },
): Promise<void> {
  const policy = await postgres.query((db) =>
    db.query.insurancePolicy.findFirst({
      where: (p, ops) =>
        ops.and(
          ops.eq(p.id, args.policyId),
          ops.eq(p.condominiumId, args.condominiumId),
        ),
    })
  );
  if (!policy) {
    throw new AppError({
      message: "Apólice não encontrada",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }
  const uploaderId = policy.uploadedBy?.user_id ?? null;
  const isOwnUpload = !!args.gate.userId && uploaderId === args.gate.userId;
  const today = args.today ?? new Date();
  if (!canDeletePolicy(policy, today, { isAdmin: args.gate.isAdmin, isOwnUpload })) {
    if (!args.gate.isAdmin && !isOwnUpload) {
      throw new AppError({
        message: "Só podes apagar apólices que tu submeteste.",
        statusCode: STATUS_CODE.Forbidden,
        code: "FORBIDDEN",
      });
    }
    const message = args.gate.isAdmin
      ? "Apólice ativa - rejeita primeiro antes de apagar (preserva histórico de cobertura)."
      : "Só podes apagar a apólice enquanto está por confirmar. Confirmada, ativa, vencida " +
        "ou substituída: a eliminação é da administração.";
    throw new AppError({
      message,
      statusCode: STATUS_CODE.UnprocessableEntity,
      code: "INVALID_STATE",
    });
  }
  // Traduz o ON DELETE RESTRICT da linhagem antes de bater no PostgreSQL: o
  // 23503 cru sairia como 500 UNEXPECTED_ERROR sem dizer o que fazer.
  const successor = await postgres.query((db) =>
    db.query.insurancePolicy.findFirst({
      where: (p, ops) =>
        ops.and(
          ops.eq(p.renewedFromId, args.policyId),
          ops.eq(p.condominiumId, args.condominiumId),
        ),
      columns: { id: true },
    })
  );
  if (successor) {
    throw new AppError({
      message: "Esta apólice foi renovada. Apaga primeiro a renovação seguinte.",
      statusCode: STATUS_CODE.Conflict,
      code: "INVALID_STATE",
    });
  }
  // Cascata S3 aos anexos PRIMEIRO (ADR 0021). Fail-fast, ao contrário do
  // best-effort que estava aqui: a linha da apólice é apagada a sério (DELETE,
  // não soft), por isso engolir a falha do S3 deixava o ficheiro sem dono
  // nenhum - o único órfão verdadeiro de todas as cascatas.
  await softDeleteAttachmentsForEntity({
    postgres,
    condominiumId: args.condominiumId,
    entityType: "insurance",
    entityId: args.policyId,
    actor: args.actor,
  });
  await postgres.query((db) =>
    db.delete(schema.insurancePolicy)
      .where(and(
        eq(schema.insurancePolicy.id, args.policyId),
        eq(schema.insurancePolicy.condominiumId, args.condominiumId),
      ))
  );
}
