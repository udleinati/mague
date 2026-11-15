// Read-model dos destinatários da convocatória + cooldown, para a tabela admin. Compõe
// resolveConvocationRecipients (1 por fração, ADR 0034), loadLastConvocationSentAt e
// convocation_eligibility. `inCooldown`/`cooldownUntil` calculados aqui com o mesmo `now` e
// primitivos do enforcement do reenvio - display e guard não divergem (cf. `listUnitsStatus`).

import type { Context } from "hono";
import type { Postgres } from "$api/libs/postgres/postgres.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { byIdInCondo } from "$api/libs/shared/by_id_in_condo.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { unitLabel } from "$shared/labels/mod.ts";
import {
  convocationCooldownEndsAt,
  isInConvocationCooldown,
} from "$shared/assembly/convocation_eligibility.ts";
import { recipientKey, resolveConvocationRecipients } from "./convocation_recipients.ts";
import { loadLastConvocationSentAt } from "./convocation_history.ts";

/** Destinatário (pessoa × fração) + estado de envio/cooldown, para a tabela admin. */
export interface ConvocationRecipientStatus {
  occupantId: string;
  /** Fração deste despacho - alimenta o reenvio individual e a chave de cooldown. */
  unitId: string;
  name: string;
  /** Rótulo da fração ("designation - identifier"). */
  unitLabel: string;
  /** Email não-vazio, ou null quando a pessoa não tem email registado. */
  email: string | null;
  hasEmail: boolean;
  /** ISO do último envio bem-sucedido a esta (pessoa, fração), ou null. */
  lastSentAt: string | null;
  inCooldown: boolean;
  /** ISO do fim do cooldown (= último envio + janela), ou null. */
  cooldownUntil: string | null;
}

// Projeta por (pessoa, fração) o último envio + cooldown avaliado em `now`. Ordem =
// `resolveConvocationRecipients` (ordem natural das frações, ADR 0014).
export async function loadConvocationRecipientStatus(
  postgres: Postgres,
  args: { condominiumId: string; assemblyId: string; now: Date },
): Promise<ConvocationRecipientStatus[]> {
  const [recipients, lastSentByRecipient] = await Promise.all([
    resolveConvocationRecipients(postgres, { condominiumId: args.condominiumId }),
    loadLastConvocationSentAt(postgres, {
      condominiumId: args.condominiumId,
      assemblyId: args.assemblyId,
    }),
  ]);

  return recipients.map((r) => {
    const lastSentAt = lastSentByRecipient.get(recipientKey(r.occupantId, r.unitId)) ?? null;
    const endsAt = convocationCooldownEndsAt(lastSentAt);
    return {
      occupantId: r.occupantId,
      unitId: r.unitId,
      name: r.name,
      unitLabel: unitLabel({
        id: r.unitId,
        designation: r.unitDesignation,
        identifier: r.unitIdentifier,
      }),
      email: r.email,
      hasEmail: r.hasEmail,
      lastSentAt: lastSentAt ? lastSentAt.toISOString() : null,
      inCooldown: isInConvocationCooldown(lastSentAt, args.now),
      cooldownUntil: endsAt ? endsAt.toISOString() : null,
    };
  });
}

// GET /v1/admin/condominiums/:cid/assemblies/:assemblyId/convocation/recipients
// Read-only: destinatários elegíveis + cooldown. Tenant-scoped (resolução filtra `condominium_id`).
export const listAssemblyConvocationRecipients = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const assemblyId = requireParam(ctx, "assemblyId");
  // Assembleia de outro condomínio devolvia os destinatários deste em vez de 404.
  const assembly = await postgres.query((db) =>
    db.query.assembly.findFirst({
      columns: { id: true },
      where: byIdInCondo(schema.assembly, assemblyId, condominiumId),
    })
  );
  findEntityOrFail(assembly, "Assembleia");

  const recipients = await loadConvocationRecipientStatus(postgres, {
    condominiumId,
    assemblyId,
    now: new Date(),
  });
  return ctx.json({ data: recipients });
};
