// Geração de quotas de um budget aprovado. Dois modos:
//   - principal: 1 quota por mês de Janeiro até ao mês de `throughDate` (÷12).
//   - suplementar (obra): N prestações (`budget.installments`) a partir de um
//     mês à escolha (`firstMonth`, default próximo mês), meses consecutivos,
//     podendo cruzar o ano. O valor por prestação = total ÷ N (não ÷12).
// O algoritmo de distribuição por permillage vive em quota_distribution.ts.
// Idempotente por (budget, unit, competence): re-correr só preenche o que
// falta. Cada charge inserida chama applyAutoOffset (consome credit_balance).

import { and, eq, isNull } from "drizzle-orm";
import type { Postgres, TxClient } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import type { ActorSnapshot } from "$api/libs/postgres/schemas/_audit.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { STATUS_CODE } from "@std/http";
import { applyAutoOffset } from "$api/modules/admin/charge/auto_offset.ts";
// Charge code é atribuído por BEFORE INSERT trigger (component
// 010_trg_charge_code.sql) - não precisa de orquestração TS.
import {
  type CompetenceMonth,
  computeInstallmentAmounts,
  computeInstallmentPeriods,
  computeMaxMonth,
  computeMonthlyWithFcr,
  distributeByPermillage,
  parseYearMonth,
} from "./quota_distribution.ts";
import { loadDistributionInputs } from "./_distribution_inputs.ts";

export interface QuotaGenerationInput {
  condominiumId: string;
  budgetId: string;
  /** YYYY-MM-DD. Só usado no principal. Default: 31-Dez do budget.year. */
  throughDate: string;
  /** YYYY-MM (ou YYYY-MM-DD). Só usado no suplementar - mês da 1ª prestação.
   *  Default: próximo mês. Ignorado se o budget já tem first_competence_period. */
  firstMonth?: string;
  notes?: string | null;
  /** ActorSnapshot completo (ADR 0011) - propagado para charges + settlements
   *  + quota_generation_run.created_by. `{}` para chamadas sem actor humano. */
  actor: ActorSnapshot;
}

export interface QuotaGenerationResult {
  runId: string;
  chargesCreated: number;
  /** true se alguma prestação cai num ano diferente do ano do budget. */
  crossesYear: boolean;
}

// Uma "fatia" a gerar: competence_period + due_date + distribuição por fração.
interface GenerationSlice {
  refDate: string; // YYYY-MM-01
  dueDate: string; // YYYY-MM-DD
  description: string;
  distribution: Map<string, number>;
}

export async function runQuotaGeneration(
  input: QuotaGenerationInput,
  postgres: Postgres,
): Promise<QuotaGenerationResult> {
  return await postgres.transaction(async (tx) => {
    // 1. Carrega + valida budget
    const [budget] = await tx.select({
      id: schema.budget.id,
      condominiumId: schema.budget.condominiumId,
      year: schema.budget.year,
      type: schema.budget.type,
      status: schema.budget.status,
      fcrPercentage: schema.budget.fcrPercentage,
      installments: schema.budget.installments,
      firstCompetencePeriod: schema.budget.firstCompetencePeriod,
      quotasGeneratedAt: schema.budget.quotasGeneratedAt,
    }).from(schema.budget).where(and(
      eq(schema.budget.id, input.budgetId),
      eq(schema.budget.condominiumId, input.condominiumId),
      isNull(schema.budget.deletedAt),
    ));

    if (!budget) {
      throw new AppError({
        message: `Orçamento ${input.budgetId} não existe no condomínio`,
        statusCode: STATUS_CODE.NotFound,
        code: "NOT_FOUND",
      });
    }
    if (budget.status !== "approved") {
      throw new AppError({
        message: `Só orçamentos aprovados podem gerar quotas (status: ${budget.status})`,
        statusCode: STATUS_CODE.Conflict,
        code: "INVALID_STATE",
      });
    }

    const budgetYear = Number(budget.year);
    const fcrPct = Number(budget.fcrPercentage);
    const isSuplementar = budget.type === "suplementar";
    const today = new Date();

    // 2. quota_day_of_month do condomínio
    const [condo] = await tx.select({
      quotaDayOfMonth: schema.condominium.quotaDayOfMonth,
    }).from(schema.condominium).where(eq(schema.condominium.id, input.condominiumId));
    const dueDay = condo?.quotaDayOfMonth ?? 1;

    // 3-4. Inputs da distribuição (totalPm, big unit, totalAnnual, units) -
    // mesma fonte que a previsão (computeQuotaPreview), ver _distribution_inputs.
    const { totalAnnual, totalPm, bigUnitId, units } = await loadDistributionInputs(
      tx,
      input.condominiumId,
      input.budgetId,
    );
    if (totalPm <= 0) {
      throw new AppError({
        message: `Condomínio ${input.condominiumId} sem unidades ativas com permillage`,
        statusCode: STATUS_CODE.UnprocessableEntity,
        code: "INVALID_STATE",
      });
    }
    if (totalAnnual <= 0) {
      const runId = await insertRun(tx, input, `${budgetYear}-12-31`, 0);
      return { runId, chargesCreated: 0, crossesYear: false };
    }

    // 5. Constrói as fatias a gerar (mensal ou prestações).
    let slices: GenerationSlice[];
    let crossesYear = false;
    let lockFirstPeriod: string | null = null; // suplementar: grava na 1ª geração
    let effectiveThroughDate: string;

    if (isSuplementar) {
      const n = budget.installments ?? 0;
      if (n < 1) {
        throw new AppError({
          message: "Orçamento suplementar sem nº de prestações definido",
          statusCode: STATUS_CODE.UnprocessableEntity,
          code: "INVALID_STATE",
        });
      }
      // Mês da 1ª prestação: travado se já gerado antes; senão input ou default.
      const first: CompetenceMonth = budget.firstCompetencePeriod
        ? parseYearMonth(budget.firstCompetencePeriod)
        : input.firstMonth
        ? parseYearMonth(input.firstMonth)
        : nextMonth(today);

      const amounts = computeInstallmentAmounts(totalAnnual, fcrPct, n);
      const periods = computeInstallmentPeriods(first.year, first.month, n);
      crossesYear = periods.some((p) => p.year !== budgetYear);

      slices = periods.map((p, i) => {
        const mm = String(p.month).padStart(2, "0");
        const refDate = `${p.year}-${mm}-01`;
        const fcrNote = fcrPct > 0 ? ` (FCR ${fcrPct}%)` : "";
        return {
          refDate,
          dueDate: `${p.year}-${mm}-${String(dueDay).padStart(2, "0")}`,
          description: `Quota suplementar ${i + 1}/${n} ${mm}/${p.year}${fcrNote}`,
          distribution: distributeByPermillage(
            amounts[i],
            amounts[i],
            units,
            totalPm,
            bigUnitId,
          ),
        };
      });

      const firstMm = String(first.month).padStart(2, "0");
      lockFirstPeriod = budget.firstCompetencePeriod ?? `${first.year}-${firstMm}-01`;
      effectiveThroughDate = slices[slices.length - 1].refDate;
    } else {
      const vMaxMonth = computeMaxMonth(input.throughDate, budgetYear);
      effectiveThroughDate = input.throughDate;
      if (vMaxMonth === 0) {
        const runId = await insertRun(tx, input, effectiveThroughDate, 0);
        return { runId, chargesCreated: 0, crossesYear: false };
      }
      const monthly = computeMonthlyWithFcr(totalAnnual, fcrPct);
      const distribution = distributeByPermillage(
        monthly.value,
        monthly.rounded,
        units,
        totalPm,
        bigUnitId,
      );
      slices = [];
      for (let month = 1; month <= vMaxMonth; month++) {
        const mm = String(month).padStart(2, "0");
        slices.push({
          refDate: `${budgetYear}-${mm}-01`,
          dueDate: `${budgetYear}-${mm}-${String(dueDay).padStart(2, "0")}`,
          description: `Quota ordinária ${mm}/${budgetYear} (FCR ${fcrPct}%)`,
          distribution,
        });
      }
    }

    // 6. Insere charges (idempotente por competence) + applyAutoOffset.
    const todayIso = today.toISOString().slice(0, 10);
    let chargesCreated = 0;

    for (const slice of slices) {
      for (const [unitId, amount] of slice.distribution) {
        if (amount <= 0) continue;

        const [existing] = await tx.select({ id: schema.charge.id })
          .from(schema.charge).where(and(
            eq(schema.charge.sourceType, "budget"),
            eq(schema.charge.sourceId, input.budgetId),
            eq(schema.charge.unitId, unitId),
            eq(schema.charge.competencePeriod, slice.refDate),
          )).limit(1);
        if (existing) continue;

        const status = slice.dueDate < todayIso ? "overdue" : "open";
        const [created] = await tx.insert(schema.charge).values({
          condominiumId: input.condominiumId,
          unitId,
          scope: "unit",
          nature: "debit",
          chargeType: isSuplementar ? "extraordinary_quota" : "quota",
          status,
          issueDate: todayIso,
          dueDate: slice.dueDate,
          competencePeriod: slice.refDate,
          originalAmount: amount,
          expectedAmount: amount,
          settledAmount: 0,
          openAmount: amount,
          description: slice.description,
          kind: "receivable",
          sourceType: "budget",
          sourceId: input.budgetId,
          createdBy: input.actor,
          updatedBy: input.actor,
        }).returning({
          id: schema.charge.id,
          openAmount: schema.charge.openAmount,
          status: schema.charge.status,
        });

        await applyAutoOffset(tx, {
          chargeId: created.id,
          condominiumId: input.condominiumId,
          unitId,
          nature: "debit",
          openAmount: created.openAmount,
          status: created.status,
          kind: "receivable",
          issueDate: todayIso,
          actor: input.actor,
        }, today);

        chargesCreated++;
      }
    }

    // 7. Marca quotas_generated_at + trava o mês inicial (1ª geração).
    if (chargesCreated > 0 && !budget.quotasGeneratedAt) {
      await tx.update(schema.budget)
        .set({
          quotasGeneratedAt: new Date(),
          ...(lockFirstPeriod ? { firstCompetencePeriod: lockFirstPeriod } : {}),
        })
        .where(eq(schema.budget.id, input.budgetId));
    }

    // 8. Regista o run
    const runId = await insertRun(tx, input, effectiveThroughDate, chargesCreated);
    return { runId, chargesCreated, crossesYear };
  });
}

// Próximo mês civil relativo a `ref` (rollover de Dezembro).
function nextMonth(ref: Date): CompetenceMonth {
  const y = ref.getUTCFullYear();
  const m = ref.getUTCMonth() + 1; // 1-12 (mês atual)
  return m === 12 ? { year: y + 1, month: 1 } : { year: y, month: m + 1 };
}

async function insertRun(
  tx: TxClient,
  input: QuotaGenerationInput,
  throughDate: string,
  chargesCreated: number,
): Promise<string> {
  const [run] = await tx.insert(schema.quotaGenerationRun).values({
    condominiumId: input.condominiumId,
    budgetId: input.budgetId,
    throughDate,
    chargesCreated,
    // Actor em `created_by` jsonb (ADR 0011).
    createdBy: input.actor,
    notes: input.notes ?? null,
  }).returning({ id: schema.quotaGenerationRun.id });
  return run.id;
}
