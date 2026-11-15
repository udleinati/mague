// State machine de `insurance_policy` (ADR 0016):
//   pending_review - confirm -> pending_review (condómino confirma OCR)
//   pending_review - approve -> active (+ supersede do predecessor, se houver)
//   pending_review - reject  -> rejected
//   active|rejected - reopen -> pending_review (admin corrige)
//   active - renew -> active (nova vigência presumed_at, velha -> superseded)
//   active - renew com documento -> pending_review (velha fica active até aprovar)
//   renew - undo -> apaga a presumida e devolve o predecessor a active
// edit/delete vivem em `edit.ts` (manutenção, não transições).

import { and, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { STATUS_CODE } from "@std/http";
import { AppError } from "$api/libs/error/app_error.ts";
import type { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import type { ActorSnapshot } from "$api/libs/postgres/schemas/_audit.ts";
import type { InsurancePolicySelect } from "$api/libs/postgres/schemas/mod.ts";
import {
  type ApproveRefusal,
  approveRefusal,
  canEditPolicy,
  canRejectPolicy,
  canRenew,
  canReopen,
  classifyPolicy,
  type UndoRenewalRefusal,
  undoRenewalRefusal,
} from "$shared/insurance/policy_status.ts";
import { addInsurancePolicyAttachment, extractPolicyOcr, requireCoverageDates } from "./upload.ts";
import { deleteInsurancePolicy } from "./edit.ts";

/** Recusa de uma mutação: mensagem de domínio + o erro HTTP que lhe assenta. */
interface MutationRefusal {
  message: string;
  status?: number;
  code?: string;
}

/** Decide se esta apólice aceita a mutação. `null` = aceita. */
type PolicyGate = (
  policy: InsurancePolicySelect,
  today: Date,
) => MutationRefusal | null;

/**
 * Carrega a apólice do condomínio e aplica o gate antes de qualquer escrita.
 * TODAS as transições deste ficheiro entram por aqui.
 *
 * O `gate` é obrigatório por assinatura, e é isso que interessa: cada mutação
 * repetia o mesmo `findFirst` + 404 e depois lembrava-se (ou não) de verificar o
 * estado. O `reject` não se lembrava - rejeitava uma apólice `superseded` ou já
 * rejeitada sem uma palavra. Uma transição nova não compila sem decidir quem
 * pode; para não restringir nada, passa-se `noGate` e isso lê-se no código.
 */
async function requirePolicy(
  postgres: Postgres,
  args: {
    policyId: string;
    condominiumId: string;
    gate: PolicyGate;
    today?: Date;
  },
): Promise<InsurancePolicySelect> {
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
  const refusal = args.gate(policy, args.today ?? new Date());
  if (refusal) {
    throw new AppError({
      message: refusal.message,
      statusCode: refusal.status ?? STATUS_CODE.UnprocessableEntity,
      code: refusal.code ?? "INVALID_STATE",
    });
  }
  return policy;
}

/** Sem restrição de estado à entrada. Usar SÓ quando a decisão vive noutro sítio
 *  e está escrito onde - nunca como atalho para não pensar no gate. */
const noGate: PolicyGate = () => null;

const APPROVE_REFUSAL_MESSAGES: Record<ApproveRefusal, (p: InsurancePolicySelect) => string> = {
  not_pending: (p) => `Apólice não está em pending_review (estado: ${p.status})`,
  unconfirmed: () => "Condómino ainda não confirmou os dados",
};

// Condómino confirma os dados OCR. NÃO ativa: fica em pending_review até approve.
// Bloqueia validTo no passado (apólice já vencida); validTo é NOT NULL - toda a
// vigência tem fim, e prolongá-la é sempre um "renovar" explícito.
// Gate de estado simétrico ao do admin em `edit.ts` (ADR 0016): fora de
// pending_review a apólice é imutável - senão o condómino reescrevia datas de uma
// apólice já aprovada e prolongava a cobertura sem nova revisão.
export async function confirmInsurancePolicy(
  postgres: Postgres,
  args: {
    policyId: string;
    condominiumId: string;
    validFrom: string;
    validTo: string;
    policyNumber: string;
    insurer: string;
    coverageAmountCents?: number;
    actor: ActorSnapshot;
  },
): Promise<InsurancePolicySelect> {
  await requirePolicy(postgres, {
    policyId: args.policyId,
    condominiumId: args.condominiumId,
    gate: (p) =>
      canEditPolicy(p) ? null : {
        message:
          `Esta apólice já não está por confirmar (estado: ${p.status}). A correção de uma ` +
          `apólice ativa, rejeitada ou substituída é da administração.`,
      },
  });

  const today = new Date().toISOString().slice(0, 10);
  if (args.validTo < today) {
    throw new AppError({
      message:
        `A data de fim de cobertura (${args.validTo}) é anterior a hoje - apólice já está vencida.`,
      statusCode: STATUS_CODE.UnprocessableEntity,
      code: "VALIDATION_ERROR",
    });
  }
  if (args.validFrom > args.validTo) {
    throw new AppError({
      message: `A data de início (${args.validFrom}) é posterior à data de fim (${args.validTo}).`,
      statusCode: STATUS_CODE.UnprocessableEntity,
      code: "VALIDATION_ERROR",
    });
  }

  const rows = await postgres.query((db) =>
    db.update(schema.insurancePolicy)
      .set({
        validFrom: args.validFrom,
        validTo: args.validTo,
        policyNumber: args.policyNumber,
        insurer: args.insurer,
        coverageAmountCents: args.coverageAmountCents,
        confirmedBy: args.actor,
        confirmedAt: new Date(),
        updatedBy: args.actor,
        updatedAt: new Date(),
      })
      .where(and(
        eq(schema.insurancePolicy.id, args.policyId),
        eq(schema.insurancePolicy.condominiumId, args.condominiumId),
      ))
      .returning()
  );
  if (rows.length === 0) {
    throw new AppError({
      message: "Apólice não encontrada",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }
  return rows[0];
}

/**
 * pending_review -> active. Requer `confirmed_at IS NOT NULL` (condómino já
 * confirmou) - exceto no documento entregue à administração, onde não há quem
 * confirme (ADR 0016). Fecha também a renovação: se a apólice tem
 * predecessor, é aqui que ele passa a `superseded`, atómico com a ativação.
 */
export async function approveInsurancePolicy(
  postgres: Postgres,
  args: {
    policyId: string;
    condominiumId: string;
    actor: ActorSnapshot;
  },
): Promise<InsurancePolicySelect> {
  // O gate da confirmação pertence ao caminho do portal: a fração submete,
  // confirma os dados e só então o admin aprova. Com o documento entregue à
  // administração não há segundo interveniente - o admin confirma e aprova no
  // mesmo ato, e `confirmed_at` mantém o significado "alguém verificou os dados".
  const policy = await requirePolicy(postgres, {
    policyId: args.policyId,
    condominiumId: args.condominiumId,
    gate: (p) => {
      const refusal = approveRefusal(p);
      return refusal ? { message: APPROVE_REFUSAL_MESSAGES[refusal](p) } : null;
    },
  });
  const adminEvidence = policy.evidenceSource === "admin";

  const now = new Date();
  // Ativação e supersede do predecessor na mesma transação: em dois passos
  // soltos, uma falha a meio deixava a fração com duas apólices ativas.
  return await postgres.transaction(async (tx) => {
    const rows = await tx.update(schema.insurancePolicy)
      .set({
        status: "active",
        approvedBy: args.actor,
        approvedAt: now,
        updatedBy: args.actor,
        updatedAt: now,
        // Só quando ninguém confirmou ainda - reaprovar não reescreve a
        // confirmação original da fração.
        ...(adminEvidence && !policy.confirmedAt
          ? { confirmedBy: args.actor, confirmedAt: now }
          : {}),
      })
      .where(eq(schema.insurancePolicy.id, args.policyId))
      .returning();

    // A renovação com documento deixa o predecessor `active` até aqui, para a
    // fração não aparecer por cobrir enquanto a nova espera revisão. `active` no
    // WHERE serializa; zero linhas não é erro (outro caminho já o substituiu).
    if (policy.renewedFromId) {
      const superseded = await tx.update(schema.insurancePolicy)
        .set({
          status: "superseded",
          supersededAt: now,
          updatedBy: args.actor,
          updatedAt: now,
        })
        .where(and(
          eq(schema.insurancePolicy.id, policy.renewedFromId),
          eq(schema.insurancePolicy.condominiumId, args.condominiumId),
          eq(schema.insurancePolicy.status, "active"),
        ))
        .returning({ id: schema.insurancePolicy.id });
      if (superseded.length === 0) {
        console.info(
          `[insurance:${args.policyId}] predecessor ${policy.renewedFromId} não estava active ` +
            `ao aprovar - nada a substituir.`,
        );
      }
    }
    return rows[0];
  });
}

// active|rejected -> pending_review (admin corrige aprovação/rejeição errada).
// Limpa approved_*/rejected_*; mantém confirmed_at. Superseded não reabre (histórico).
export async function reopenInsurancePolicy(
  postgres: Postgres,
  args: {
    policyId: string;
    condominiumId: string;
    actor: ActorSnapshot;
  },
): Promise<InsurancePolicySelect> {
  await requirePolicy(postgres, {
    policyId: args.policyId,
    condominiumId: args.condominiumId,
    gate: (p) =>
      canReopen(p) ? null : {
        message: `Apólice não pode ser reaberta a partir de ${p.status}. Só active/rejected.`,
      },
  });
  const rows = await postgres.query((db) =>
    db.update(schema.insurancePolicy)
      .set({
        status: "pending_review",
        approvedAt: null,
        approvedBy: null,
        rejectedAt: null,
        rejectedBy: null,
        rejectedReason: null,
        updatedBy: args.actor,
        updatedAt: new Date(),
      })
      .where(eq(schema.insurancePolicy.id, args.policyId))
      .returning()
  );
  return rows[0];
}

export interface RenewalAttachment {
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
}

/** Campos que o admin transcreve do documento da renovação. `undefined` = herda
 *  o da apólice anterior; `null` no capital = apaga-o. */
export interface RenewalDetails {
  policyNumber?: string;
  insurer?: string;
  coverageAmountCents?: number | null;
}

// Sem documento: nova vigência presumed_at (sem evidência ainda) e a velha passa
// a superseded (ADR 0016: admin clica, não carrega). valid_from = old.valid_to;
// valid_to = +1 ano. Com o documento que chegou à administração, o caminho é
// outro - ver `renewWithDocument`. Renova ativa/a-expirar OU vencida há <= 1 ano
// (ADR 0040); vencida há mais recusa-se (nasceria já vencida - nova de raiz).
export async function renewInsurancePolicy(
  postgres: Postgres,
  args: {
    policyId: string;
    condominiumId: string;
    actor: ActorSnapshot;
    /** Documento que chegou à administração fora do portal. Sem ele, renovação
     *  presumida de sempre. */
    attachment?: RenewalAttachment;
    /** Vigência decidida no modal, com o documento à frente do admin.
     *  Obrigatória com anexo; ignorada sem ele (a aritmética manda). */
    dates?: { validFrom: string; validTo: string };
    /** Dados transcritos do documento. Cada campo ausente herda o da anterior;
     *  ignorados no caminho presumido, onde não há papel de onde transcrever. */
    details?: RenewalDetails;
  },
): Promise<InsurancePolicySelect> {
  const old = await requirePolicy(postgres, {
    policyId: args.policyId,
    condominiumId: args.condominiumId,
    gate: (p, today) => {
      if (canRenew(p, today)) return null;
      const cls = classifyPolicy(p, today);
      return {
        message: cls.kind === "expired"
          ? `Apólice vencida há ${cls.daysOverdue} dias (mais de 1 ano). Submete uma apólice nova ` +
            `em vez de renovar - a renovação nasceria já vencida.`
          : `Apólice não está ativa (estado: ${p.status}). Só apólices ativas, a-expirar ou ` +
            `vencidas há até 1 ano podem ser renovadas.`,
      };
    },
  });
  if (args.attachment) {
    return await renewWithDocument(postgres, {
      old,
      condominiumId: args.condominiumId,
      actor: args.actor,
      attachment: args.attachment,
      dates: args.dates,
      details: args.details,
    });
  }
  // date+interval em SQL para evitar edge cases de timezone TS-side.
  const r = await postgres.query((db) =>
    db.execute<{ next_from: string; next_to: string }>(sql`
      SELECT
        ${old.validTo}::date          AS next_from,
        ((${old.validTo}::date) + INTERVAL '1 year')::date AS next_to
    `)
  );
  const newValidFrom = r[0].next_from;
  const newValidTo = r[0].next_to;

  const now = new Date();
  // Supersede + insert numa só transação: em dois passos soltos, uma falha a
  // meio deixava a fração com duas apólices ativas. O `status = 'active'` no
  // WHERE serializa duplo-clique e retry - a segunda tentativa não vê linhas.
  const inserted = await postgres.transaction(async (tx) => {
    const superseded = await tx.update(schema.insurancePolicy)
      .set({
        status: "superseded",
        supersededAt: now,
        updatedBy: args.actor,
        updatedAt: now,
      })
      .where(and(
        eq(schema.insurancePolicy.id, old.id),
        eq(schema.insurancePolicy.condominiumId, args.condominiumId),
        eq(schema.insurancePolicy.status, "active"),
      ))
      .returning({ id: schema.insurancePolicy.id });
    if (superseded.length === 0) {
      throw new AppError({
        message:
          "Esta apólice mudou de estado entretanto (renovada ou reaberta noutro pedido). Recarrega a página.",
        statusCode: STATUS_CODE.Conflict,
        code: "INVALID_STATE",
      });
    }
    const rows = await tx.insert(schema.insurancePolicy).values({
      condominiumId: args.condominiumId,
      unitId: old.unitId,
      validFrom: newValidFrom,
      validTo: newValidTo,
      policyNumber: old.policyNumber,
      insurer: old.insurer,
      coverageAmountCents: old.coverageAmountCents,
      status: "active",
      presumedAt: now,
      // Linhagem (ADR 0040): a nova aponta para o predecessor imediato.
      renewedFromId: old.id,
      uploadedBy: args.actor,
      createdBy: args.actor,
      // Marca confirmed/approved como now também - admin é a autoridade,
      // não há ciclo pending_review→active no caminho renew.
      confirmedAt: now,
      confirmedBy: args.actor,
      approvedAt: now,
      approvedBy: args.actor,
    }).returning();
    return rows[0];
  });

  // Email de evidência de renovação ('renewal_evidence') é disparado pelo
  // handler (renewPolicyHandler), best-effort, fora desta transação.
  return inserted;
}

/**
 * Renovação com o documento que a fração entregou à administração fora do
 * portal (ADR 0016). Difere da presumida em três pontos que
 * andam juntos:
 *
 * - nasce em `pending_review` - o valor está em rever o que o OCR extraiu;
 * - marca `evidence_source='admin'` e não `presumed_at` - há papel, não presunção;
 * - NÃO substitui a antiga. O supersede é do `approve`, senão a fração caía para
 *   `awaiting_approval` e o painel dizia que estava por cobrir uma que está.
 *
 * As datas vêm do modal e não da aritmética: o admin tem o documento à frente e
 * a renovação pode não ser de um ano certo.
 */
async function renewWithDocument(
  postgres: Postgres,
  args: {
    old: InsurancePolicySelect;
    condominiumId: string;
    actor: ActorSnapshot;
    attachment: RenewalAttachment;
    dates?: { validFrom: string; validTo: string };
    details?: RenewalDetails;
  },
): Promise<InsurancePolicySelect> {
  const { old, condominiumId, actor, attachment, details } = args;
  const { validFrom, validTo } = requireCoverageDates(args.dates);

  // Antes do INSERT: uma falha de OCR não pode custar a transação, e assim os
  // candidatos ficam gravados de origem (o admin consulta-os na revisão).
  const { ocr, ocrConfidence } = await extractPolicyOcr(attachment.bytes, attachment.mimeType);

  return await insertDocumentedRenewal(postgres, {
    old,
    condominiumId,
    actor,
    attachment,
    values: {
      validFrom,
      validTo,
      policyNumber: details?.policyNumber ?? old.policyNumber,
      insurer: details?.insurer ?? old.insurer,
      coverageAmountCents: details?.coverageAmountCents === undefined
        ? old.coverageAmountCents
        : details.coverageAmountCents,
      ocrExtracted: ocr,
      ocrConfidence: ocrConfidence ?? undefined,
      evidenceSource: "admin",
      // `confirmed_*`/`approved_*` ficam NULL - preenchidos no approve.
    },
  });
}

/** Campos que o chamador decide. Os que definem a linhagem, o tenant e a
 *  auditoria são do helper - divergirem seria quebrar a cadeia em silêncio. */
type DocumentedRenewalValues = Omit<
  typeof schema.insurancePolicy.$inferInsert,
  "condominiumId" | "unitId" | "renewedFromId" | "uploadedBy" | "createdBy" | "status"
>;

/**
 * Mecânica das renovações que nascem com documento (admin ou fração): guard de
 * concorrência, insert em transação e rollback se o anexo falhar. A proveniência
 * (OCR, `evidence_source`, quem confirmou) é de quem chama - o que não pode
 * divergir entre caminhos é isto.
 */
async function insertDocumentedRenewal(
  postgres: Postgres,
  args: {
    old: InsurancePolicySelect;
    condominiumId: string;
    actor: ActorSnapshot;
    attachment: RenewalAttachment;
    values: DocumentedRenewalValues;
  },
): Promise<InsurancePolicySelect> {
  const { old, condominiumId, actor, attachment } = args;
  const inserted = await postgres.transaction(async (tx) => {
    // Sem o supersede da antiga, deixa de haver `WHERE status = 'active'` a
    // serializar o duplo-clique. Esta leitura estreita a janela mas não a fecha
    // (READ COMMITTED): dois pedidos em paralelo podem não se ver um ao outro.
    const pending = await tx.query.insurancePolicy.findFirst({
      where: (p, ops) =>
        ops.and(
          ops.eq(p.renewedFromId, old.id),
          ops.eq(p.condominiumId, condominiumId),
          ops.eq(p.status, "pending_review"),
        ),
      columns: { id: true },
    });
    if (pending) {
      throw new AppError({
        message: "Esta apólice já tem uma renovação por rever. Aprova ou rejeita essa primeiro.",
        statusCode: STATUS_CODE.Conflict,
        code: "INVALID_STATE",
      });
    }
    const rows = await tx.insert(schema.insurancePolicy).values({
      ...args.values,
      condominiumId,
      unitId: old.unitId,
      status: "pending_review",
      // Linhagem (ADR 0040): a nova aponta para o predecessor imediato.
      renewedFromId: old.id,
      uploadedBy: actor,
      createdBy: actor,
    }).returning();
    return rows[0];
  });

  // Uma apólice marcada como documentada sem documento seria uma mentira
  // gravada: se o anexo falha, a linha desaparece com ele (o delete canónico
  // cuida do S3 primeiro, ADR 0021).
  try {
    await addInsurancePolicyAttachment(postgres, {
      condominiumId,
      policyId: inserted.id,
      bytes: attachment.bytes,
      mimeType: attachment.mimeType,
      filename: attachment.filename,
      actor,
    });
  } catch (e) {
    await deleteInsurancePolicy(postgres, {
      policyId: inserted.id,
      condominiumId,
      actor,
      gate: { isAdmin: true },
    }).catch((cleanupError) => {
      console.error(
        `[insurance:${inserted.id}] rollback da renovação sem documento falhou:`,
        cleanupError,
      );
    });
    throw e;
  }

  return inserted;
}

/**
 * Renovação submetida pela própria fração (ADR 0016). Ao
 * contrário da do admin, o recibo é obrigatório e os dados vêm já confirmados:
 * é passo único, o formulário É a confirmação, e sem `confirmed_at` o
 * `approveRefusal` recusaria a aprovação com "unconfirmed".
 *
 * Não corre OCR: numa renovação tácita o papel é um recibo de prémio, que não
 * tem estrutura de apólice de onde extrair. O supersede da anterior continua a
 * ser do approve - a fração não tira cobertura a ninguém ao submeter.
 */
export async function renewInsurancePolicyFromUnit(
  postgres: Postgres,
  args: {
    policyId: string;
    condominiumId: string;
    unitId: string;
    actor: ActorSnapshot;
    attachment: RenewalAttachment;
    dates?: { validFrom: string; validTo: string };
    details?: RenewalDetails;
  },
): Promise<InsurancePolicySelect> {
  const old = await requirePolicy(postgres, {
    policyId: args.policyId,
    condominiumId: args.condominiumId,
    gate: (p, today) => {
      if (p.unitId !== args.unitId) return { message: "Apólice não encontrada" };
      if (canRenew(p, today)) return null;
      const cls = classifyPolicy(p, today);
      return {
        message: cls.kind === "expired"
          ? `Apólice vencida há ${cls.daysOverdue} dias (mais de 1 ano). Submete uma apólice nova ` +
            `em vez de renovar.`
          : `Esta apólice não está em condições de ser renovada (estado: ${p.status}).`,
      };
    },
  });
  const { validFrom, validTo } = requireCoverageDates(args.dates);
  const now = new Date();

  return await insertDocumentedRenewal(postgres, {
    old,
    condominiumId: args.condominiumId,
    actor: args.actor,
    attachment: args.attachment,
    values: {
      validFrom,
      validTo,
      policyNumber: args.details?.policyNumber ?? old.policyNumber,
      insurer: args.details?.insurer ?? old.insurer,
      coverageAmountCents: args.details?.coverageAmountCents === undefined
        ? old.coverageAmountCents
        : args.details.coverageAmountCents,
      evidenceSource: "unit",
      confirmedAt: now,
      confirmedBy: args.actor,
    },
  });
}

// Mensagens de domínio por motivo de recusa; o predicado puro decide, o handler
// só traduz (ADR 0040).
const UNDO_REFUSAL_MESSAGES: Record<UndoRenewalRefusal, string> = {
  not_a_renewal: "Esta apólice não foi criada por renovação - não há nada para desfazer.",
  not_presumed: "Esta apólice tem evidência própria e não é uma renovação presumida.",
  not_current:
    "Esta renovação já foi substituída ou reaberta. Desfaz primeiro a renovação mais recente.",
  has_evidence:
    "Esta renovação já tem comprovativo anexado. Desfazer apagaria o documento - rejeita ou elimina a apólice em vez disso.",
};

/**
 * Desfaz uma renovação feita por engano: apaga a apólice presumida e devolve o
 * predecessor a `active`, limpando `superseded_at`. Sem isto a fração ficava com
 * uma `superseded` órfã - `computeAggregateStatus` não a conta e a cobertura
 * documentada desaparecia do sistema.
 *
 * Tudo dentro de uma transação, incluindo a contagem de anexos: entre o gate e o
 * commit o condómino pode carregar o comprovativo, e o delete levava-o com ele.
 * É também o que dispensa o cleanup S3 do ADR 0021 - só se apaga com zero
 * ficheiros. Devolve o predecessor restaurado.
 */
export async function undoRenewalInsurancePolicy(
  postgres: Postgres,
  args: {
    policyId: string;
    condominiumId: string;
    actor: ActorSnapshot;
  },
): Promise<InsurancePolicySelect> {
  // `noGate` de propósito: aqui a decisão TEM de ser dentro da transação, junto
  // com a contagem de anexos (ver `undoRenewalRefusal` abaixo). Recusar à
  // entrada seria uma segunda cópia da regra, e a que conta é a de lá.
  const policy = await requirePolicy(postgres, {
    policyId: args.policyId,
    condominiumId: args.condominiumId,
    gate: noGate,
  });

  return await postgres.transaction(async (tx) => {
    const atts = await tx.query.attachment.findMany({
      where: (a, ops) =>
        ops.and(
          ops.eq(a.condominiumId, args.condominiumId),
          ops.eq(a.entityType, "insurance"),
          ops.eq(a.entityId, args.policyId),
          ops.isNull(a.deletedAt),
        ),
      columns: { id: true },
    });
    const refusal = undoRenewalRefusal({ ...policy, attachmentCount: atts.length });
    if (refusal) {
      throw new AppError({
        message: UNDO_REFUSAL_MESSAGES[refusal],
        statusCode: STATUS_CODE.UnprocessableEntity,
        code: "INVALID_STATE",
      });
    }

    const deleted = await tx.delete(schema.insurancePolicy)
      .where(and(
        eq(schema.insurancePolicy.id, args.policyId),
        eq(schema.insurancePolicy.condominiumId, args.condominiumId),
        eq(schema.insurancePolicy.status, "active"),
      ))
      .returning({ id: schema.insurancePolicy.id });
    if (deleted.length === 0) {
      throw new AppError({
        message: "Esta renovação mudou de estado entretanto. Recarrega a página.",
        statusCode: STATUS_CODE.Conflict,
        code: "INVALID_STATE",
      });
    }

    // `superseded` no WHERE: se o predecessor já foi reaberto ou renovado por
    // outro caminho, não o pisamos - a transação inteira volta atrás.
    const restored = await tx.update(schema.insurancePolicy)
      .set({
        status: "active",
        supersededAt: null,
        updatedBy: args.actor,
        updatedAt: new Date(),
      })
      .where(and(
        eq(schema.insurancePolicy.id, policy.renewedFromId!),
        eq(schema.insurancePolicy.condominiumId, args.condominiumId),
        eq(schema.insurancePolicy.status, "superseded"),
      ))
      .returning();
    if (restored.length === 0) {
      throw new AppError({
        message: "A apólice anterior já não está substituída - nada a restaurar.",
        statusCode: STATUS_CODE.Conflict,
        code: "INVALID_STATE",
      });
    }
    return restored[0];
  });
}

export async function rejectInsurancePolicy(
  postgres: Postgres,
  args: {
    policyId: string;
    condominiumId: string;
    reason: string;
    actor: ActorSnapshot;
  },
): Promise<InsurancePolicySelect> {
  await requirePolicy(postgres, {
    policyId: args.policyId,
    condominiumId: args.condominiumId,
    gate: (p) =>
      canRejectPolicy(p) ? null : {
        message: p.status === "rejected"
          ? "Esta apólice já está rejeitada."
          : `Uma apólice substituída é histórico e não se rejeita (estado: ${p.status}).`,
      },
  });
  const rows = await postgres.query((db) =>
    db.update(schema.insurancePolicy)
      .set({
        status: "rejected",
        rejectedBy: args.actor,
        rejectedAt: new Date(),
        rejectedReason: args.reason,
        updatedBy: args.actor,
        updatedAt: new Date(),
      })
      .where(and(
        eq(schema.insurancePolicy.id, args.policyId),
        eq(schema.insurancePolicy.condominiumId, args.condominiumId),
      ))
      .returning()
  );
  if (rows.length === 0) {
    throw new AppError({
      message: "Apólice não encontrada",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }
  return rows[0];
}
