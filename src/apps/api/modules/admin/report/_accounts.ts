// Mapa `account_code -> nome` do plano de contas, com precedência do
// condomínio sobre a conta global (mesmo code pode existir nas duas formas).
// Partilhado pelos relatórios: o ledger guarda o code, não o id da conta.

import { sql } from "drizzle-orm";
import type { Postgres } from "$api/libs/postgres/postgres.ts";

export type AccountNames = Map<string, string>;

export async function loadAccountNames(
  postgres: Postgres,
  condominiumId: string,
): Promise<AccountNames> {
  const rows = await postgres.query((db) =>
    db.execute<{ code: string; name: string; condominium_id: string | null }>(sql`
      SELECT code, name, condominium_id
      FROM finance.chart_of_account
      WHERE deleted_at IS NULL
        AND (condominium_id = ${condominiumId} OR condominium_id IS NULL)
      ORDER BY condominium_id NULLS FIRST
    `)
  );
  // Global primeiro, específico do condo sobrescreve.
  const map: AccountNames = new Map();
  for (const r of rows) map.set(r.code, r.name);
  return map;
}
