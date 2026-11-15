// Resolução de destinatários da convocatória. Enviada por fração (ADR 0034): um despacho por
// ligação ativa (occupant × fração) de owner+resident, SEM dedup por pessoa - cada (pessoa,
// fração) recebe a sua procuração (voto da permilagem, Art. 1431.º nº 5 CC). Tenants excluídos
// (ADR 0028). Sem email não é saltado: entra `hasEmail=false` e o envio regista `failed`.
// Dois passos (Rule 9): resolveConvocationRecipients (I/O) + classifyConvocationRecipients (puro).

import type { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { unitNaturalOrder } from "$api/libs/postgres/order_by.ts";

export type PersonType = "singular" | "collective";

/** Linha crua (1 por ligação fração-occupant ativa) antes do filtro. */
export interface RawConvocationRow {
  occupantId: string;
  occupantName: string;
  occupantEmail: string | null;
  occupantNif: string | null;
  /** Natureza jurídica crua do occupant (`singular` | `collective`). */
  occupantPersonType: string;
  occupantDeleted: boolean;
  relationshipType: string;
  unitId: string;
  unitDesignation: string;
  unitIdentifier: string | null;
}

/** Destinatário por (occupant × fração), pronto para o loop de envio. */
export interface ConvocationRecipient {
  occupantId: string;
  /** Fração a que ESTE despacho diz respeito (a procuração é por fração). */
  unitId: string;
  name: string;
  /** NIF/NIPC do destinatário, ou null quando o registo não o tem. */
  nif: string | null;
  personType: PersonType;
  /** Email não-vazio, ou null quando a pessoa não tem email registado. */
  email: string | null;
  hasEmail: boolean;
  /** Papel desta pessoa NESTA fração (tenant nunca chega cá). */
  relationshipType: "owner" | "resident";
  unitDesignation: string;
  /** Coluna calculada da fração ("Bloco X - Nº Letra"); alimenta unitLabel(). */
  unitIdentifier: string | null;
  // Nomes dos proprietários (com voto) desta fração. Só para `resident` (a nota do
  // email diz-lhe quem o pode nomear representante); `[]` para owner. Ver ADR 0034.
  ownerNamesOfUnit: string[];
}

const ELIGIBLE_RELATIONSHIPS = new Set(["owner", "resident"]);

// Chave lógica (occupant, fração) do cooldown/histórico/reenvio - isola a janela entre
// frações da mesma pessoa (reenviar a fração A não mexe na B).
export function recipientKey(occupantId: string, unitId: string): string {
  return `${occupantId}:${unitId}`;
}

// Filtra (owner+resident, occupant vivo) e classifica hasEmail, um destinatário por
// ligação (occupant × fração), sem dedup. Puro; as `rows` já chegam só ativas e a ordem
// de saída segue a delas (a ordenação natural das frações é do caller de I/O).
export function classifyConvocationRecipients(
  rows: RawConvocationRow[],
): ConvocationRecipient[] {
  // Fração -> nomes dos proprietários vivos. Construído de TODAS as linhas owner antes
  // do filtro, para o residente saber quem o pode nomear mesmo que o dono não receba
  // email; acumula todos em compropriedade. Ver ADR 0034.
  const ownerNamesByUnit = new Map<string, string[]>();
  for (const r of rows) {
    if (r.occupantDeleted) continue;
    if (r.relationshipType !== "owner") continue;
    const names = ownerNamesByUnit.get(r.unitId) ?? [];
    names.push(r.occupantName);
    ownerNamesByUnit.set(r.unitId, names);
  }

  const out: ConvocationRecipient[] = [];

  for (const r of rows) {
    if (r.occupantDeleted) continue;
    if (!ELIGIBLE_RELATIONSHIPS.has(r.relationshipType)) continue;

    const email = r.occupantEmail && r.occupantEmail.trim() !== "" ? r.occupantEmail.trim() : null;

    const relationshipType = r.relationshipType === "owner" ? "owner" : "resident";

    out.push({
      occupantId: r.occupantId,
      unitId: r.unitId,
      name: r.occupantName,
      nif: r.occupantNif,
      personType: r.occupantPersonType === "collective" ? "collective" : "singular",
      email,
      hasEmail: email !== null,
      relationshipType,
      unitDesignation: r.unitDesignation,
      unitIdentifier: r.unitIdentifier,
      ownerNamesOfUnit: relationshipType === "resident"
        ? (ownerNamesByUnit.get(r.unitId) ?? [])
        : [],
    });
  }

  return out;
}

// Ligações fração-occupant ativas do condomínio -> um destinatário por (occupant × fração),
// em ordem natural das frações (ADR 0014). Não atira quando ninguém tem email: o caller (bulk)
// precisa de reportar quantos ficaram sem email, não de abortar.
export async function resolveConvocationRecipients(
  postgres: Postgres,
  args: { condominiumId: string },
): Promise<ConvocationRecipient[]> {
  const today = new Date().toISOString().slice(0, 10);

  // 1. Frações em ordem natural (ADR 0014) - rótulo + ordem final dos destinatários.
  const units = await postgres.query((db) =>
    db.query.unit.findMany({
      where: (u, ops) =>
        ops.and(ops.eq(u.condominiumId, args.condominiumId), ops.isNull(u.deletedAt)),
      orderBy: unitNaturalOrder(schema.unit.designation),
      columns: { id: true, designation: true, identifier: true },
    })
  );
  if (units.length === 0) return [];
  const unitById = new Map(units.map((u) => [u.id, u]));
  const orderIndex = new Map(units.map((u, i) => [u.id, i]));
  const unitIds = units.map((u) => u.id);

  // 2. Ligações ativas com o occupant. (O `where` de relations aninhadas não suporta
  //    predicados em colunas do occupant - filtramos a seguir, como o `_reminder.ts`.)
  const recRows = await postgres.query((db) =>
    db.query.unitOccupant.findMany({
      where: (uo, ops) =>
        ops.and(
          ops.inArray(uo.unitId, unitIds),
          ops.isNull(uo.deletedAt),
          ops.lte(uo.startDate, today),
          ops.or(ops.isNull(uo.endDate), ops.gte(uo.endDate, today)),
        ),
      orderBy: (uo, { asc }) => [asc(uo.startDate)],
      with: {
        occupant: {
          columns: {
            id: true,
            name: true,
            email: true,
            nif: true,
            personType: true,
            deletedAt: true,
          },
        },
      },
    })
  );

  const raw: RawConvocationRow[] = recRows
    .filter((uo) => uo.occupant)
    .map((uo) => {
      const u = unitById.get(uo.unitId);
      return {
        occupantId: uo.occupant.id,
        occupantName: uo.occupant.name,
        occupantEmail: uo.occupant.email,
        occupantNif: uo.occupant.nif,
        occupantPersonType: uo.occupant.personType ?? "singular",
        occupantDeleted: uo.occupant.deletedAt !== null,
        relationshipType: uo.relationshipType,
        unitId: uo.unitId,
        unitDesignation: u?.designation ?? uo.unitId,
        unitIdentifier: u?.identifier ?? null,
      };
    });

  const recipients = classifyConvocationRecipients(raw);
  // Ordem natural das frações (ADR 0014); estável dentro da mesma fração (o
  // Array.sort do JS é estável, preservando a ordem por start_date do SQL).
  recipients.sort((a, b) => (orderIndex.get(a.unitId) ?? 0) - (orderIndex.get(b.unitId) ?? 0));
  return recipients;
}
