import type { Context } from "hono";
import { sql } from "drizzle-orm";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { calculateAssemblyQuorum } from "$api/libs/assembly/quorum_majority.ts";
import { ASSEMBLY_PROJECTION, formatAssemblyForResponse } from "./_projection.ts";
import { type AssemblyScope, buildAssemblyDetailWhere } from "./_query.ts";
import { loadLastConvocation } from "./convocation_history.ts";

// `scope` é injetado pelo caller (ver listAssemblies): admin usa "all", o
// portal força "public". Em "public" um rascunho cai fora do `findFirst` →
// `findEntityOrFail` lança 404 (o que o condómino deve ver). Ver ADR 0003.
export const getAssembly = async (
  ctx: Context,
  postgres: Postgres,
  opts: { scope?: AssemblyScope } = {},
) => {
  const scope = opts.scope ?? "all";
  const condominiumId = requireCondominiumId(ctx);

  const assemblyId = requireParam(ctx, "assemblyId");

  const result = await postgres.query((db) =>
    db.query.assembly.findFirst({
      where: buildAssemblyDetailWhere({ assemblyId, condominiumId, scope }),
      ...ASSEMBLY_PROJECTION,
      with: {
        agendaItems: {
          where: (e, ops) => ops.isNull(e.deletedAt),
          orderBy: (e, { asc }) => [asc(e.sequence), asc(e.createdAt)],
          with: {
            // Votos individuais por fração - re-abrir o ponto (modo Deliberar) com os radios
            // já marcados. Trigger SQL re-agrega para votes_in_favor/against/abstain.
            votes: {
              columns: { unitId: true, vote: true },
              where: (v, ops) => ops.isNull(v.deletedAt),
            },
          },
        },
      },
    })
  );
  const assembly = findEntityOrFail(result, "Assembleia");

  const serialized = formatAssemblyForResponse(assembly);
  const agendaItems = "agendaItems" in assembly
    ? (assembly as { agendaItems: unknown[] }).agendaItems
    : [];

  // Resumo de presenças agregado - portal mostra quórum sem carregar attendees
  // individuais (que expõem identidades). `convocationRound` filtra a ronda atual
  // (1ª vs 2ª têm sets distintos).
  const round = assembly.convocationRound ?? "first";
  const [attendeeAgg, buildingAgg, lastConvocation] = await Promise.all([
    postgres.query((db) =>
      db.select({
        count: sql<string>`COUNT(*)::text`,
        totalPermillage: sql<
          string
        >`COALESCE(SUM(${schema.assemblyAttendee.permillageAtMeeting}), 0)::text`,
      })
        .from(schema.assemblyAttendee)
        .where(
          sql`${schema.assemblyAttendee.assemblyId} = ${assemblyId}
              AND ${schema.assemblyAttendee.convocationRound} = ${round}
              AND ${schema.assemblyAttendee.deletedAt} IS NULL`,
        )
    ),
    postgres.query((db) =>
      db.select({
        total: sql<string>`COALESCE(SUM(${schema.unit.permillage}), 0)::text`,
      })
        .from(schema.unit)
        .where(
          sql`${schema.unit.condominiumId} = ${condominiumId}
              AND ${schema.unit.deletedAt} IS NULL`,
        )
    ),
    // Último snapshot enviado (run mais recente). Alimenta o badge do panel
    // ("ainda não enviada" / "há alterações por enviar") e a vista do portal
    // (mostra o que foi de facto convocado, não um render ao vivo).
    loadLastConvocation(postgres, { condominiumId, assemblyId }),
  ]);
  // Dono único do quórum (Art. 1432.º): soma de permilagem + veredicto calculam-se AQUI;
  // admin/portal só renderizam, nunca re-derivam. Regra em calculateAssemblyQuorum (pura,
  // testada); update.ts re-aplica-a para o gate da transição "held".
  const round3 = (n: number) => Math.round(n * 1000) / 1000;
  const totalAttendeePermillage = round3(Number(attendeeAgg[0]?.totalPermillage ?? 0));
  const totalBuildingPermillage = round3(Number(buildingAgg[0]?.total ?? 0));
  const quorum = calculateAssemblyQuorum({
    totalAttendeePermillage,
    totalBuildingPermillage,
    round: round as "first" | "second",
  });
  const attendeeSummary = {
    count: Number(attendeeAgg[0]?.count ?? 0),
    totalPermillage: totalAttendeePermillage,
    totalBuildingPermillage,
    convocationRound: round,
    hasQuorum: quorum.hasQuorum,
    reason: quorum.reason,
    requiredPermillage: quorum.requiredPermillage,
  };

  // Nomes do presidente + secretário (FKs em `core.occupant`), sobretudo p/ o portal
  // (sem endpoint `listOccupants`). Single roundtrip via inArray; skipa se nenhum preenchido.
  const sigIds = [assembly.presidentOccupantId, assembly.secretaryOccupantId]
    .filter((x): x is string => !!x);
  type SigName = { id: string; name: string };
  let signers: SigName[] = [];
  if (sigIds.length > 0) {
    // Audit-trail: NÃO filtra `deletedAt`. A assinatura legal da ata (Art. 1434.º CC)
    // preserva quem assinou mesmo que o ocupante seja soft-deleted depois.
    const rows = await postgres.query((db) =>
      db.query.occupant.findMany({
        where: (o, ops) => ops.inArray(o.id, sigIds),
        columns: { id: true, name: true },
      })
    );
    signers = rows.map((r) => ({ id: r.id, name: r.name }));
  }
  const presidentOccupant = signers.find((s) => s.id === assembly.presidentOccupantId) ?? null;
  const secretaryOccupant = signers.find((s) => s.id === assembly.secretaryOccupantId) ?? null;

  return ctx.json({
    data: {
      ...serialized,
      agendaItems,
      attendeeSummary,
      presidentOccupant,
      secretaryOccupant,
      lastConvocation,
    },
  });
};
