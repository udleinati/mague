// Helpers DB para lembretes de cobrança (ADR 0028). Espelha o módulo
// `insurance/`. Cada função é uma operação atómica de leitura/escrita -
// orquestração vive em `_reminder.ts`.

import { and, desc, eq, sql } from "drizzle-orm";
import type { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import type { BillingReminderSelect } from "$api/libs/postgres/schemas/mod.ts";
import {
  BILLING_REMINDER_COOLDOWN_DAYS,
  billingReminderCooldownEndsAt,
  canSendBillingReminder,
  isInBillingReminderCooldown,
  OVERDUE_THRESHOLD_DAYS,
} from "$shared/billing/reminder_eligibility.ts";
import {
  type BillingEmailTotals,
  type ChargeLike,
  computeBillingEmailTotals,
  isChargeOverdueForBilling,
  overdueDaysAgainst,
} from "$shared/billing/overdue.ts";
import { unitLabelMap } from "$shared/labels/mod.ts";

/** Filtros da página de lembretes (ADR 0039). `minOverdueDays` é o limiar
 *  cumulativo do bloco (1/30/60/90); `plan` filtra por presença de plano ativo. */
export interface OverdueUnitFilters {
  minOverdueDays?: number;
  plan?: "all" | "with" | "without";
}

/** Linha do resumo "frações elegíveis" mostrada no painel admin. */
export interface OverdueUnitRow {
  unitId: string;
  /** Etiqueta legível, e.g. "A1" ou "1A - 3º Esq." (calculada pelo caller). */
  unitLabel: string;
  /** Total vencido: em-dívida de todos os débitos receivable com `due_date <= ref`. */
  totalOwedCents: number;
  /** Subset vencido há mais do que o limiar do bloco selecionado (coluna
   *  "Vencido"). 30 por defeito; 1/60/90 conforme o filtro. */
  overdueBeyondThresholdCents: number;
  /** Crédito existente (settlements em excesso). 0 quando não há. */
  creditCents: number;
  /** Charge mais antiga em atraso além do gatilho do bloco. ISO date. */
  oldestOverdueDueDate: string;
  /** Timestamp ISO do último envio com pelo menos 1 recipient sent. null = nunca. */
  lastReminderAt: string | null;
  /** true se ainda está dentro dos 14d desde o último envio. */
  inCooldown: boolean;
  /** Instante ISO em que o cooldown termina (null fora de cooldown). */
  cooldownUntil: string | null;
  /** true se a fração tem um plano de pagamento ativo (ADR 0039). O bulk-send
   *  salta-as; a UI mostra um badge. */
  hasActivePlan: boolean;
  /** Resumo do plano ativo para o badge/tooltip do admin (null quando não há). */
  paymentPlan:
    | { notes: string | null; internalNotes: string | null; endDate: string | null }
    | null;
}

// `reconciled_through_date` do condomínio (null se nunca reconciliou).
export async function getReconciledThroughDate(
  postgres: Postgres,
  condominiumId: string,
): Promise<string | null> {
  const row = await postgres.query((db) =>
    db.query.condominium.findFirst({
      where: (c, ops) => ops.eq(c.id, condominiumId),
      columns: { reconciledThroughDate: true },
    })
  );
  return row?.reconciledThroughDate ?? null;
}

// Frações com >=1 dívida em atraso além do gatilho do bloco (>30d; o bloco +1
// baixa para >=1d). Qualquer débito receivable dispara e entra no total - quota,
// quota extraordinária, refaturação, saldo inicial (ADR 0028).
// Resolve total devido, charge mais antiga e cooldown por fração.
export async function findOverdueUnits(
  postgres: Postgres,
  condominiumId: string,
  filters: OverdueUnitFilters = {},
): Promise<OverdueUnitRow[]> {
  const ref = await getReconciledThroughDate(postgres, condominiumId);
  if (ref === null) return []; // nunca reconciliou - nada elegível

  // Limiar do bloco selecionado (1/30/60/90). Filtra que frações aparecem (3b) E
  // define a coluna "Vencido" (subset vencido há mais do que o limiar).
  const minOverdueDays = filters.minOverdueDays ?? 30;
  // Bloco +1: gatilho e coluna baixam para "vencida há >= 1 dia" (> 0). Nos
  // blocos 30/60/90 o gatilho mantém-se > 30 (ADR 0028); 60/90 restringem em 3b.
  const triggerThresholdDays = minOverdueDays === 1 ? 0 : OVERDUE_THRESHOLD_DAYS;
  const columnThresholdDays = minOverdueDays === 1 ? 0 : minOverdueDays;

  // 1. Charges receivable em aberto do condomínio com unit_id. `finance.charge`
  //    não tem soft-delete; `charge_type` distingue quota de outros tipos.
  type ChargeRow = {
    id: string;
    unitId: string | null;
    kind: string; // charge_type real (ex: "quota", "refacturation")
    nature: string; // debit = dívida da fração; credit = a favor dela
    dueDate: string | null;
    amountCents: number;
    settledCents: number;
  };
  const rows = await postgres.query((db) =>
    db.execute(sql`
      SELECT
        c.id,
        c.unit_id AS "unitId",
        c.charge_type AS "kind",
        c.nature,
        c.due_date::text AS "dueDate",
        c.original_amount AS "amountCents",
        c.settled_amount AS "settledCents"
      FROM finance.charge c
      WHERE c.condominium_id = ${condominiumId}
        AND c.kind = 'receivable'
        AND c.status <> 'cancelled'
        AND c.unit_id IS NOT NULL
    `)
  ) as unknown as ChargeRow[];

  // 2. Agrupa por unit. Para cada unit verifica se tem PELO MENOS 1 quota
  //    em atraso (gatilho). Se sim, calcula totais sobre TODOS os débitos
  //    receivable em aberto da fração.
  type UnitAccum = { hasOverdue: boolean; oldestDue: string | null; charges: ChargeLike[] };
  const byUnit = new Map<string, UnitAccum>();
  for (const r of rows) {
    if (!r.unitId) continue;
    const charge: ChargeLike = {
      kind: r.kind,
      nature: r.nature,
      dueDate: r.dueDate,
      amountCents: r.amountCents,
      settledCents: r.settledCents,
    };
    let acc = byUnit.get(r.unitId);
    if (!acc) {
      acc = { hasOverdue: false, oldestDue: null, charges: [] };
      byUnit.set(r.unitId, acc);
    }
    acc.charges.push(charge);
    if (isChargeOverdueForBilling(charge, ref, triggerThresholdDays)) {
      acc.hasOverdue = true;
      if (acc.oldestDue === null || (charge.dueDate && charge.dueDate < acc.oldestDue)) {
        acc.oldestDue = charge.dueDate;
      }
    }
  }

  // 3. Filtra só as que disparam o gatilho. Para cada, calcula totais e
  //    cooldown.
  const eligible: Array<{ unitId: string; totals: BillingEmailTotals; oldestDue: string }> = [];
  for (const [unitId, acc] of byUnit) {
    if (!acc.hasOverdue || !acc.oldestDue) continue;
    const totals = computeBillingEmailTotals(acc.charges, ref, columnThresholdDays);
    eligible.push({ unitId, totals, oldestDue: acc.oldestDue });
  }

  if (eligible.length === 0) return [];

  // 3b. Filtro de bloco (ADR 0039): limiar cumulativo sobre a idade da quota
  //     vencida mais antiga (= oldestDue). +30d mantém todas (já são > 30 pelo
  //     gatilho); +60d/+90d restringem. Comparador estrito, coerente com o > 30.
  const bucketed = minOverdueDays > 30
    ? eligible.filter((e) => overdueDaysAgainst(ref, e.oldestDue) > minOverdueDays)
    : eligible;
  if (bucketed.length === 0) return [];

  // 4. Resolve unit labels (formato canónico - $shared/labels).
  const unitIds = bucketed.map((e) => e.unitId);
  const unitRows = await postgres.query((db) =>
    db.query.unit.findMany({
      where: (u, ops) =>
        ops.and(
          ops.inArray(u.id, unitIds),
          ops.eq(u.condominiumId, condominiumId),
          ops.isNull(u.deletedAt),
        ),
      columns: { id: true, designation: true, identifier: true },
    })
  );
  const labelByUnit = unitLabelMap(unitRows);

  // 5. Resolve último envio com pelo menos 1 sent por fração. 1 query
  //    agregada via JSONB - evita N+1.
  type LastSentRow = { unitId: string; sentAt: string };
  const lastSentRows = await postgres.query((db) =>
    db.execute(sql`
      SELECT br.unit_id AS "unitId", MAX(br.sent_at)::text AS "sentAt"
      FROM core.billing_reminder br
      WHERE br.condominium_id = ${condominiumId}
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(br.recipients) AS r
          WHERE r->>'status' = 'sent'
        )
      GROUP BY br.unit_id
    `)
  ) as unknown as LastSentRow[];
  const lastSentByUnit = new Map<string, string>();
  for (const r of lastSentRows) lastSentByUnit.set(r.unitId, r.sentAt);

  // 6. Plano de pagamento ativo por fração (ADR 0039). Sempre resolvido (badge
  //    + exclusão do bulk), independentemente do filtro `plan`.
  const activePlanRows = await postgres.query((db) =>
    db.query.paymentPlan.findMany({
      where: (p, ops) =>
        ops.and(
          ops.eq(p.condominiumId, condominiumId),
          ops.eq(p.status, "active"),
          ops.isNull(p.deletedAt),
          ops.inArray(p.unitId, unitIds),
        ),
      columns: { unitId: true, notes: true, internalNotes: true, endDate: true },
    })
  );
  const planByUnit = new Map<string, NonNullable<OverdueUnitRow["paymentPlan"]>>();
  for (const p of activePlanRows) {
    planByUnit.set(p.unitId, {
      notes: p.notes,
      internalNotes: p.internalNotes,
      endDate: p.endDate ?? null,
    });
  }

  const now = new Date();
  const resultRows = bucketed.map((e): OverdueUnitRow => {
    const lastReminderAt = lastSentByUnit.get(e.unitId) ?? null;
    const inCooldown = isInBillingReminderCooldown(lastReminderAt, now);
    const plan = planByUnit.get(e.unitId) ?? null;
    return {
      unitId: e.unitId,
      unitLabel: labelByUnit.get(e.unitId) ?? e.unitId,
      totalOwedCents: e.totals.totalOwedCents,
      overdueBeyondThresholdCents: e.totals.overdueBeyondThresholdCents,
      creditCents: e.totals.creditCents,
      oldestOverdueDueDate: e.oldestDue,
      lastReminderAt,
      inCooldown,
      cooldownUntil: inCooldown
        ? (billingReminderCooldownEndsAt(lastReminderAt)?.toISOString() ?? null)
        : null,
      hasActivePlan: plan !== null,
      paymentPlan: plan,
    };
  });

  // 7. Filtro por plano (ADR 0039): "with" / "without" / "all" (default).
  const planFilter = filters.plan ?? "all";
  const filtered = planFilter === "with"
    ? resultRows.filter((r) => r.hasActivePlan)
    : planFilter === "without"
    ? resultRows.filter((r) => !r.hasActivePlan)
    : resultRows;

  return filtered.sort((a, b) => a.oldestOverdueDueDate.localeCompare(b.oldestOverdueDueDate));
}

/** Carrega charges em aberto de uma fração para compor o email. Inclui
 *  TODAS as receivable em aberto com `due_date ≤ reconciledThroughDate`
 *  (não só quotas - o gatilho é quota mas o conteúdo mistura). */
export async function loadOverdueChargesForEmail(
  postgres: Postgres,
  args: { condominiumId: string; unitId: string },
): Promise<{
  reconciledThroughDate: string | null;
  charges: Array<ChargeLike & { id: string; description: string | null }>;
}> {
  const ref = await getReconciledThroughDate(postgres, args.condominiumId);
  if (ref === null) return { reconciledThroughDate: null, charges: [] };
  type ChargeRow = {
    id: string;
    description: string | null;
    kind: string;
    nature: string;
    dueDate: string | null;
    amountCents: number;
    settledCents: number;
  };
  const rows = await postgres.query((db) =>
    db.execute(sql`
      SELECT
        c.id,
        c.description,
        c.charge_type AS "kind",
        c.nature,
        c.due_date::text AS "dueDate",
        c.original_amount AS "amountCents",
        c.settled_amount AS "settledCents"
      FROM finance.charge c
      WHERE c.condominium_id = ${args.condominiumId}
        AND c.unit_id = ${args.unitId}
        AND c.kind = 'receivable'
        AND c.status <> 'cancelled'
      ORDER BY c.due_date ASC NULLS LAST
    `)
  ) as unknown as ChargeRow[];
  return { reconciledThroughDate: ref, charges: rows };
}

/** Devolve o último envio (registo + estado de cooldown). Usado pelo
 *  handler de envio para validar antes de criar nova row. */
export async function getLastSuccessfulReminder(
  postgres: Postgres,
  args: { condominiumId: string; unitId: string },
): Promise<BillingReminderSelect | null> {
  const rows = await postgres.query((db) =>
    db.select()
      .from(schema.billingReminder)
      .where(and(
        eq(schema.billingReminder.condominiumId, args.condominiumId),
        eq(schema.billingReminder.unitId, args.unitId),
        sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${schema.billingReminder.recipients}) r WHERE r->>'status' = 'sent')`,
      ))
      .orderBy(desc(schema.billingReminder.sentAt))
      .limit(1)
  );
  return rows[0] ?? null;
}

export { BILLING_REMINDER_COOLDOWN_DAYS, canSendBillingReminder };
