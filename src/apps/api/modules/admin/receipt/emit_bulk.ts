// POST /v1/admin/condominiums/:cid/receipts/bulk - emite recibos pendentes em lote.
// Sequencial (não paralelo) para evitar contention no advisory lock da numeração.
// Cap MAX_BULK_EMIT por chamada (~500ms/recibo, 100 ~ 50s < timeout de proxies); previne
// timeouts e bloqueios da connection pool. Acima disso, repetir a operação.

import type { Context } from "hono";
import { sql } from "drizzle-orm";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { requireActor } from "$api/middleware/api_auth.ts";
import { emitReceipt } from "./emit_orchestrator.ts";

const MAX_BULK_EMIT = 100;

export const emitBulkReceipts = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);

  const actor = requireActor(ctx);

  const { safePanelBaseUrl } = await import("$api/libs/shared/panel_base_url.ts");
  const panelBaseUrl = safePanelBaseUrl(ctx);

  // Conta total para informar o cliente quantos ficaram fora deste lote.
  const totalPendingRow = await postgres.query((db) =>
    db.execute<{ count: number }>(sql`
      SELECT COUNT(*)::int AS count
        FROM finance.vw_pending_receipts
       WHERE condominium_id = ${condominiumId}
    `)
  );
  const totalPending = Number(totalPendingRow[0]?.count ?? 0);

  // Lista pendências (cap MAX_BULK_EMIT)
  const tuples = await postgres.query((db) =>
    db.execute<{ bank_transaction_id: string; unit_id: string }>(sql`
      SELECT bank_transaction_id, unit_id
        FROM finance.vw_pending_receipts
       WHERE condominium_id = ${condominiumId}
       ORDER BY payment_date, bank_transaction_id, unit_id
       LIMIT ${MAX_BULK_EMIT}
    `)
  );

  const results: Array<
    {
      bankTransactionId: string;
      unitId: string;
      status: string;
      receiptId?: string;
      number?: string;
      error?: string;
    }
  > = [];
  let success = 0;
  let failed = 0;

  for (const t of tuples) {
    try {
      const r = await emitReceipt(postgres, {
        condominiumId,
        bankTransactionId: t.bank_transaction_id,
        unitId: t.unit_id,
        actor: {
          id: actor.user_id ?? "",
          name: actor.email ?? (actor.user_id ?? ""),
          email: actor.email,
        },
        panelBaseUrl,
      });
      success++;
      results.push({
        bankTransactionId: t.bank_transaction_id,
        unitId: t.unit_id,
        status: "success",
        receiptId: r.receiptId,
        number: r.number,
      });
    } catch (e) {
      failed++;
      results.push({
        bankTransactionId: t.bank_transaction_id,
        unitId: t.unit_id,
        status: "failed",
        error: (e as Error).message,
      });
    }
  }

  return ctx.json({
    data: {
      total: tuples.length,
      success,
      failed,
      pendingRemaining: Math.max(0, totalPending - tuples.length),
      results,
    },
  });
};
