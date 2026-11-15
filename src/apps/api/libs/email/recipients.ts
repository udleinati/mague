// Ocupantes elegíveis para um email escopado a uma fração (lembrete de cobrança,
// lembrete de seguro). Concentra a query + filtro de elegibilidade + MISSING_EMAIL
// que `billing_reminder/_reminder.ts` e `insurance/_reminder.ts` replicavam quase
// à letra - diferiam só no filtro de `relationship_type`. Cada domínio mantém o
// seu wrapper fino por cima (mesmo padrão do primitivo `cooldown`).

import { STATUS_CODE } from "@std/http";
import type { Postgres } from "$api/libs/postgres/postgres.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { unitLabel } from "$shared/labels/mod.ts";

export type OccupantRelationship = "owner" | "tenant" | "resident";

/** Destinatário elegível de um email de fração: já traz os labels do condo e
 *  da fração prontos para subject/body. */
export interface UnitEmailRecipient {
  occupantId: string;
  name: string;
  email: string;
  condoName: string;
  condoDesignationType: "building" | "condominium";
  unitLabel: string;
}

/**
 * Carrega os ocupantes ativos da fração (janela start/end) com email válido.
 * `relationshipTypes` restringe por tipo de ligação (cobrança: owner+resident,
 * Art. 1424 CC exclui tenants); omitido = todos os ocupantes ativos (seguro).
 * Atira `MISSING_EMAIL` (422) com a mensagem do caller quando ninguém qualifica.
 */
export async function resolveUnitEmailRecipients(
  postgres: Postgres,
  args: {
    condominiumId: string;
    unitId: string;
    relationshipTypes?: ReadonlyArray<OccupantRelationship>;
    missingEmailMessage: (unitDesignation: string) => string;
  },
): Promise<UnitEmailRecipient[]> {
  const today = new Date().toISOString().slice(0, 10);
  const rels = args.relationshipTypes;
  const recRows = await postgres.query((db) =>
    db.query.unitOccupant.findMany({
      where: (uo, ops) =>
        ops.and(
          ops.eq(uo.unitId, args.unitId),
          ops.isNull(uo.deletedAt),
          ops.lte(uo.startDate, today),
          ops.or(ops.isNull(uo.endDate), ops.gte(uo.endDate, today)),
          rels ? ops.inArray(uo.relationshipType, [...rels]) : undefined,
        ),
      with: {
        occupant: {
          columns: { id: true, name: true, email: true, deletedAt: true, condominiumId: true },
        },
        unit: {
          columns: { designation: true, identifier: true, condominiumId: true },
          with: { condominium: { columns: { name: true, designationType: true } } },
        },
      },
    })
  );

  // Filtros não expressáveis no `where` da relation top-level (Drizzle não
  // suporta predicados em colunas de relations aninhadas). Fração e ocupante
  // têm de ser do condomínio de quem envia: uma ligação cruzada mandava o email para fora.
  const eligible: UnitEmailRecipient[] = recRows
    .filter((uo) =>
      uo.occupant &&
      uo.unit.condominiumId === args.condominiumId &&
      uo.occupant.condominiumId === args.condominiumId &&
      uo.occupant.deletedAt === null &&
      uo.occupant.email !== null &&
      uo.occupant.email.trim() !== ""
    )
    .map((uo) => ({
      occupantId: uo.occupant.id,
      name: uo.occupant.name,
      email: uo.occupant.email!,
      condoName: uo.unit.condominium.name,
      condoDesignationType: uo.unit.condominium.designationType as "building" | "condominium",
      unitLabel: unitLabel({
        id: args.unitId,
        designation: uo.unit.designation,
        identifier: uo.unit.identifier ?? null,
      }),
    }));

  if (eligible.length === 0) {
    // Busca o nome da fração para a mensagem ficar legível ao admin.
    const u = await postgres.query((db) =>
      db.query.unit.findFirst({
        where: (unit, ops) =>
          ops.and(ops.eq(unit.id, args.unitId), ops.eq(unit.condominiumId, args.condominiumId)),
        columns: { designation: true },
      })
    );
    const designation = u?.designation ?? args.unitId;
    throw new AppError({
      message: args.missingEmailMessage(designation),
      statusCode: STATUS_CODE.UnprocessableEntity,
      code: "MISSING_EMAIL",
    });
  }
  return eligible;
}
