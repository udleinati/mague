// Geração de charges a partir de recurring_template até throughDate. Único caminho de
// produção (não há trigger SQL a gerar charges - ver ADR 0001).
//
// Por template ativo com next_run_date <= throughDate, while (respeitando end_date):
//   INSERT charge + applyAutoOffset + avança next_run_date; depois persiste next_run_date + last_generated_at.
// Idempotência: skip de charge já existente para o mesmo (template_id, competence_period).

import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import type { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import type { ActorSnapshot } from "$api/libs/postgres/schemas/_audit.ts";
import { applyAutoOffset } from "$api/modules/admin/charge/auto_offset.ts";
// Charge code vem de BEFORE INSERT trigger (010_trg_charge_code.sql), sem orquestração TS.
import { advanceByInterval, monthStart } from "./date_helpers.ts";

export interface RecurringGenerationInput {
  condominiumId: string;
  /** YYYY-MM-DD */
  throughDate: string;
  notes?: string | null;
  /** ActorSnapshot completo (ADR 0011), propagado para charges/settlements/run.created_by.
   *  `{}` para chamadas sem actor humano (cron/job futuro). */
  actor: ActorSnapshot;
}

export interface RecurringGenerationResult {
  runId: string;
  templatesGenerated: number;
  chargesCreated: number;
}

export async function runRecurringGeneration(
  input: RecurringGenerationInput,
  postgres: Postgres,
): Promise<RecurringGenerationResult> {
  return await postgres.transaction(async (tx) => {
    // Templates elegíveis: ativos, não-deleted, next_run_date <= throughDate, end_date NULL/>=.
    const templates = await tx.select().from(schema.recurringTemplate).where(and(
      eq(schema.recurringTemplate.condominiumId, input.condominiumId),
      eq(schema.recurringTemplate.isActive, true),
      isNull(schema.recurringTemplate.deletedAt),
      lte(schema.recurringTemplate.nextRunDate, input.throughDate),
      or(
        isNull(schema.recurringTemplate.endDate),
        sql`${schema.recurringTemplate.endDate} >= ${schema.recurringTemplate.nextRunDate}`,
      ),
    ));

    const today = new Date();
    const todayIso = today.toISOString().slice(0, 10);
    let templatesGenerated = 0;
    let chargesCreated = 0;

    for (const tmpl of templates) {
      templatesGenerated++;
      let nextRunDate = tmpl.nextRunDate; // YYYY-MM-DD string

      while (
        nextRunDate <= input.throughDate &&
        (tmpl.endDate === null || tmpl.endDate >= nextRunDate)
      ) {
        const refDate = monthStart(nextRunDate);
        const dueDay = tmpl.dayOfMonth ?? 1;
        const [year, month] = refDate.split("-").map(Number);
        const dueDate = `${year}-${String(month).padStart(2, "0")}-${
          String(dueDay).padStart(2, "0")
        }`;

        // Idempotência: skip se já existe charge deste template para esta competence
        const [existing] = await tx.select({ id: schema.charge.id })
          .from(schema.charge).where(and(
            eq(schema.charge.recurringTemplateId, tmpl.id),
            eq(schema.charge.competencePeriod, refDate),
          )).limit(1);

        if (!existing) {
          const monthLabel = `${String(month).padStart(2, "0")}/${year}`;
          const description = `${tmpl.description} - ${monthLabel}`;
          const status = dueDate < todayIso ? "overdue" : "open";

          const [created] = await tx.insert(schema.charge).values({
            condominiumId: tmpl.condominiumId,
            unitId: tmpl.unitId,
            scope: tmpl.unitId === null ? "condominium" : "unit",
            kind: tmpl.kind,
            nature: "debit",
            chargeType: tmpl.kind === "payable" ? "supplier_service" : "recurring_fee",
            status,
            issueDate: todayIso,
            dueDate,
            competencePeriod: refDate,
            originalAmount: tmpl.amount,
            expectedAmount: tmpl.amount,
            openAmount: tmpl.amount,
            amount: 0,
            description,
            accountId: tmpl.accountId,
            supplierId: tmpl.supplierId,
            contractId: tmpl.contractId,
            recurringTemplateId: tmpl.id,
            // Snapshot do método de pagamento (preserva o vigente à geração, ainda que o template mude).
            // Ver CONTEXT.md "Payment method (da charge)".
            paymentMethod: tmpl.paymentMethod,
            sourceType: "recurring_template",
            sourceId: tmpl.id,
            createdBy: input.actor,
            updatedBy: input.actor,
          }).returning({
            id: schema.charge.id,
            openAmount: schema.charge.openAmount,
            status: schema.charge.status,
          });

          // Auto-offset (só para receivable com unit_id)
          if (tmpl.unitId && tmpl.kind === "receivable") {
            await applyAutoOffset(tx, {
              chargeId: created.id,
              condominiumId: tmpl.condominiumId,
              unitId: tmpl.unitId,
              nature: "debit",
              openAmount: created.openAmount,
              status: created.status,
              kind: "receivable",
              issueDate: todayIso,
              actor: input.actor,
            }, today);
          }
          chargesCreated++;
        }

        nextRunDate = advanceByInterval(nextRunDate, tmpl.intervalType);
      }

      await tx.update(schema.recurringTemplate)
        .set({
          nextRunDate,
          lastGeneratedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.recurringTemplate.id, tmpl.id));
    }

    const [run] = await tx.insert(schema.recurringGenerationRun).values({
      condominiumId: input.condominiumId,
      throughDate: input.throughDate,
      templatesGenerated,
      chargesCreated,
      createdBy: input.actor,
      notes: input.notes ?? null,
    }).returning({ id: schema.recurringGenerationRun.id });

    return { runId: run.id, templatesGenerated, chargesCreated };
  });
}

// Helpers puros vivem em ./date_helpers.ts (testáveis sem DB).
