// Auto-compensação de uma charge nova contra charges existentes da mesma fração.
// Mirror da PARTE 2 de fn_charge_ai (component 004), agora em TS, chamado após
// cada charge create. Só receivables com unit_id; procura a nature OPOSTA com
// open_amount > 0 e cria settlement 'charge_offset' via createSettlementInTx
// (validação + ledger via trigger + effects num só seam).

import { and, eq, ne, sql } from "drizzle-orm";
import type { TxClient } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import type { ActorSnapshot } from "$api/libs/postgres/schemas/_audit.ts";
import { createSettlementInTx } from "../settlement/mod.ts";

export interface AutoOffsetInput {
  /** Charge recém-criada que pode despoletar auto-offset. */
  chargeId: string;
  condominiumId: string;
  unitId: string;
  nature: "debit" | "credit";
  /** open_amount atual da charge nova. */
  openAmount: number;
  /** Status da charge nova - só faz offset se NÃO for cancelled/disputed. */
  status: string;
  kind: "receivable" | "payable";
  issueDate: string;
  /** ActorSnapshot completo (ADR 0011) - copiado para o settlement.createdBy. */
  actor: ActorSnapshot;
}

export interface AutoOffsetResult {
  settlements: Array<{ id: string; chargeId: string; amount: number }>;
}

// Pré-condição: a charge já foi inserida na transação tx (ver guards abaixo).
export async function applyAutoOffset(
  tx: TxClient,
  input: AutoOffsetInput,
  today: Date,
): Promise<AutoOffsetResult> {
  const result: AutoOffsetResult = { settlements: [] };

  if (input.kind === "payable") return result;
  if (input.openAmount <= 0) return result;
  if (input.status === "cancelled" || input.status === "disputed") return result;

  const opposite = input.nature === "debit" ? "credit" : "debit";

  const matches = await selectMatches(tx, {
    condominiumId: input.condominiumId,
    unitId: input.unitId,
    nature: opposite,
    excludeId: input.chargeId,
    isNewCredit: input.nature === "credit",
  });

  let remaining = input.openAmount;

  for (const match of matches) {
    if (remaining <= 0) break;

    // Re-lê open_amount atual (pode ter mudado entre offsets).
    const [current] = await tx.select({ openAmount: schema.charge.openAmount })
      .from(schema.charge).where(eq(schema.charge.id, match.id));
    if (!current || current.openAmount <= 0) continue;

    const settleAmt = Math.min(remaining, current.openAmount);

    const debitChargeId = input.nature === "credit" ? match.id : input.chargeId;
    const creditChargeId = input.nature === "credit" ? input.chargeId : match.id;
    const notes = input.nature === "credit"
      ? "Compensação automática"
      : "Compensação automática com crédito existente";

    const { settlementId } = await createSettlementInTx(tx, {
      settlementType: "charge_offset",
      condominiumId: input.condominiumId,
      unitId: input.unitId,
      amount: settleAmt,
      settlementDate: input.issueDate,
      notes,
      actor: input.actor,
      bankTransactionId: null,
      debitChargeId,
      creditChargeId,
    }, today);

    result.settlements.push({ id: settlementId, chargeId: match.id, amount: settleAmt });

    // Re-lê o open_amount da NEW charge (foi atualizado pela cascade).
    const [newCurrent] = await tx.select({ openAmount: schema.charge.openAmount })
      .from(schema.charge).where(eq(schema.charge.id, input.chargeId));
    remaining = newCurrent?.openAmount ?? 0;
  }

  return result;
}

interface MatchSelector {
  condominiumId: string;
  unitId: string;
  nature: "debit" | "credit";
  excludeId: string;
  /** True quando a charge NEW é credit - affecta o ORDER BY (juros primeiro). */
  isNewCredit: boolean;
}

async function selectMatches(tx: TxClient, sel: MatchSelector): Promise<Array<{ id: string }>> {
  const conditions = [
    eq(schema.charge.condominiumId, sel.condominiumId),
    eq(schema.charge.unitId, sel.unitId),
    eq(schema.charge.nature, sel.nature),
    sql`${schema.charge.status} IN ('open', 'partial', 'overdue')`,
    sql`${schema.charge.openAmount} > 0`,
    ne(schema.charge.id, sel.excludeId),
  ];

  // Mirror do ORDER BY de fn_charge_ai (isNewCredit: juros primeiro; senão
  // due_date direto). DELIBERADAMENTE distinto da imputação em allocation/plan.ts
  // - não fundir, são operações diferentes. Ver ADR 0035.
  const orderBy = sel.isNewCredit
    ? sql`(CASE WHEN ${schema.charge.chargeType} = 'interest' THEN 0 ELSE 1 END) ASC,
           ${schema.charge.dueDate} ASC NULLS LAST,
           ${schema.charge.competencePeriod} ASC NULLS LAST,
           ${schema.charge.createdAt} ASC`
    : sql`${schema.charge.dueDate} ASC NULLS LAST,
           ${schema.charge.competencePeriod} ASC NULLS LAST,
           ${schema.charge.createdAt} ASC`;

  return await tx.select({ id: schema.charge.id })
    .from(schema.charge)
    .where(and(...conditions))
    .orderBy(orderBy);
}
