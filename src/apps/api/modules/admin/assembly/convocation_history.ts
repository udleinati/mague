// "Último envio por (pessoa, fração)" da convocatória, para derivar o cooldown
// (ADR 0032). Por (occupant, fração) porque a convocatória é enviada por fração (ADR 0034):
// reenviar a fração A não mexe na janela de B. Só conta `status == "sent"`; runs SUPERSEDED
// por retificação são ignorados (`superseded_at IS NULL`) - zera o cooldown.

import { sql } from "drizzle-orm";
import type { Postgres } from "$api/libs/postgres/postgres.ts";
import type { ConvocationSnapshot } from "$shared/assembly/convocation_snapshot.ts";
import { recipientKey } from "./convocation_recipients.ts";

// Map `recipientKey -> Date do último envio sent` desta assembleia. Pares nunca
// enviados ficam ausentes (caller trata ausente = nunca enviada = fora de cooldown).
export async function loadLastConvocationSentAt(
  postgres: Postgres,
  args: { condominiumId: string; assemblyId: string },
): Promise<Map<string, Date>> {
  const rows = await postgres.query((db) =>
    db.execute<{ occupantId: string; unitId: string | null; sentAt: string }>(sql`
      SELECT r->>'occupantId' AS "occupantId",
             r->>'unitId'     AS "unitId",
             MAX(r->>'sentAt') AS "sentAt"
        FROM core.assembly_convocation ac
        CROSS JOIN LATERAL jsonb_array_elements(ac.recipients) AS r
       WHERE ac.assembly_id = ${args.assemblyId}
         AND ac.condominium_id = ${args.condominiumId}
         AND ac.superseded_at IS NULL
         AND r->>'status' = 'sent'
       GROUP BY r->>'occupantId', r->>'unitId'
    `)
  );

  const out = new Map<string, Date>();
  for (const row of rows) {
    const d = new Date(row.sentAt);
    if (!Number.isNaN(d.getTime())) {
      out.set(recipientKey(row.occupantId, row.unitId ?? ""), d);
    }
  }
  return out;
}

// Último run da convocatória: snapshot + quando + bulk/individual. Sem `recipients`
// (PII) nem `sent_by` - serve o portal e o badge "há alterações por enviar".
export interface LastConvocation {
  snapshot: ConvocationSnapshot | null;
  sentAt: string;
  trigger: "individual" | "bulk";
}

// Run ativo mais recente (`sent_at` máximo) desta assembleia, ou null se nunca enviada
// (runs superseded não contam). Um run existe assim que há tentativa de envio (mesmo que
// todas falhem); é o sinal "0 runs = ainda não enviada", distinto de `convocation_sent_at`.
export async function loadLastConvocation(
  postgres: Postgres,
  args: { condominiumId: string; assemblyId: string },
): Promise<LastConvocation | null> {
  const row = await postgres.query((db) =>
    db.query.assemblyConvocation.findFirst({
      where: (c, ops) =>
        ops.and(
          ops.eq(c.assemblyId, args.assemblyId),
          ops.eq(c.condominiumId, args.condominiumId),
          ops.isNull(c.supersededAt),
        ),
      orderBy: (c, { desc }) => [desc(c.sentAt)],
      columns: { snapshot: true, sentAt: true, trigger: true },
    })
  );
  if (!row) return null;
  return {
    snapshot: row.snapshot ?? null,
    sentAt: row.sentAt instanceof Date ? row.sentAt.toISOString() : String(row.sentAt),
    trigger: row.trigger === "individual" ? "individual" : "bulk",
  };
}
