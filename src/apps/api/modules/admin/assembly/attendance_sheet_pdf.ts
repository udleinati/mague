// Pré-visualização (read-only) da folha de presenças, como `convocation_pdf.ts`:
//   GET .../attendance-sheet.pdf - documento em branco para a reunião.
// 1 linha por fração (coproprietários juntos), permilagem para o quórum (Art. 1432.º
// CC) e coluna de assinatura para preencher à mão. Não muda `status` nem arquiva em
// S3; o PDF é gerado a cada pedido.

import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import type { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { byIdInCondo } from "$api/libs/shared/by_id_in_condo.ts";
import { unitNaturalOrder } from "$api/libs/postgres/order_by.ts";
import { renderTemplate } from "$api/libs/templates/render.ts";
import { renderPdf } from "$api/libs/pdf/render.ts";
import { formatPermillage } from "$shared/format/mod.ts";

interface AttendanceFraction {
  designation: string;
  identifier: string | null;
  permillageLabel: string;
  ownerNames: string[];
}

export interface AttendanceSheetContext {
  assembly: {
    type: string;
    scheduledAt: unknown;
    secondConvocationAt: unknown;
    location: string | null;
  };
  condominium: { name: string; fiscalNumber: string | null; address: string | null };
  round: "first" | "second";
  fractions: AttendanceFraction[];
  totals: { count: number; permillageLabel: string; requiredFirstRoundLabel: string };
}

// Frações do condomínio (ordem natural, ADR 0014) + proprietários ativos hoje, agrupados
// por fração. Espelha a resolução de destinatários, mas só owners e 1 linha por fração.
export async function loadAttendanceSheetContext(
  postgres: Postgres,
  args: { condominiumId: string; assemblyId: string },
): Promise<AttendanceSheetContext> {
  const { condominiumId, assemblyId } = args;

  const assemblyRow = await postgres.query((db) =>
    db.query.assembly.findFirst({
      where: byIdInCondo(schema.assembly, assemblyId, condominiumId),
      columns: {
        type: true,
        scheduledAt: true,
        secondConvocationAt: true,
        location: true,
        convocationRound: true,
      },
    })
  );
  const assembly = findEntityOrFail(assemblyRow, "Assembleia") as Record<string, unknown>;

  const condoRow = await postgres.query((db) =>
    db.query.condominium.findFirst({
      where: (c, ops) => ops.eq(c.id, condominiumId),
      columns: { name: true, fiscalNumber: true, address: true },
    })
  );
  const condominium = {
    name: condoRow?.name ?? "(condomínio)",
    fiscalNumber: condoRow?.fiscalNumber ?? null,
    address: condoRow?.address ?? null,
  };

  // Frações em ordem natural (ADR 0014) - rótulo + ordem das linhas.
  const units = await postgres.query((db) =>
    db.query.unit.findMany({
      where: (u, ops) => ops.and(ops.eq(u.condominiumId, condominiumId), ops.isNull(u.deletedAt)),
      orderBy: unitNaturalOrder(schema.unit.designation),
      columns: { id: true, designation: true, identifier: true, permillage: true },
    })
  );

  // Proprietários com ligação ativa hoje. (Filtro de `occupant.deletedAt` em TS - o
  // `where` de relations aninhadas não suporta predicados nas colunas do occupant.)
  const today = new Date().toISOString().slice(0, 10);
  const ownerRows = units.length === 0
    ? []
    : await postgres.query((db) =>
      db.query.unitOccupant.findMany({
        where: (uo, ops) =>
          ops.and(
            ops.inArray(uo.unitId, units.map((u) => u.id)),
            ops.eq(uo.relationshipType, "owner"),
            ops.isNull(uo.deletedAt),
            ops.lte(uo.startDate, today),
            ops.or(ops.isNull(uo.endDate), ops.gte(uo.endDate, today)),
          ),
        orderBy: (uo, { asc }) => [asc(uo.startDate)],
        with: { occupant: { columns: { name: true, deletedAt: true } } },
      })
    );

  const ownersByUnit = new Map<string, string[]>();
  for (const r of ownerRows) {
    if (!r.occupant || r.occupant.deletedAt) continue;
    const arr = ownersByUnit.get(r.unitId) ?? [];
    arr.push(r.occupant.name);
    ownersByUnit.set(r.unitId, arr);
  }

  const fractions: AttendanceFraction[] = units.map((u) => ({
    designation: u.designation,
    identifier: u.identifier ?? null,
    permillageLabel: formatPermillage(u.permillage),
    ownerNames: ownersByUnit.get(u.id) ?? [],
  }));

  const totalPermillage = units.reduce((sum, u) => sum + (Number(u.permillage) || 0), 0);

  return {
    assembly: {
      type: String(assembly.type ?? "ordinary"),
      scheduledAt: assembly.scheduledAt,
      secondConvocationAt: assembly.secondConvocationAt,
      location: (assembly.location as string | null) ?? null,
    },
    condominium,
    round: assembly.convocationRound === "second" ? "second" : "first",
    fractions,
    totals: {
      count: units.length,
      permillageLabel: formatPermillage(totalPermillage),
      requiredFirstRoundLabel: formatPermillage(totalPermillage / 2),
    },
  };
}

// GET /v1/admin/condominiums/:cid/assemblies/:assemblyId/attendance-sheet.pdf
export const getAssemblyAttendanceSheetPdf = async (ctx: Context, postgres: Postgres) => {
  const data = await loadAttendanceSheetContext(postgres, {
    condominiumId: requireCondominiumId(ctx),
    assemblyId: requireParam(ctx, "assemblyId"),
  });

  const html = await renderTemplate("assembly_attendance_sheet.vto", {
    ...data,
    generatedAt: new Date().toISOString(),
  });

  let pdfBytes: Uint8Array;
  try {
    pdfBytes = await renderPdf({ html });
  } catch (err) {
    console.error("[assembly.attendance_sheet_pdf] renderPdf falhou", err);
    return ctx.json(
      {
        error: {
          code: "PDF_GENERATION_FAILED",
          message: "Não foi possível gerar a folha de presenças.",
        },
      },
      STATUS_CODE.InternalServerError,
    );
  }

  ctx.header("content-type", "application/pdf");
  // `inline` (não `attachment`): pré-visualização - o panel abre numa nova aba.
  ctx.header(
    "content-disposition",
    `inline; filename="lista-presencas-${requireParam(ctx, "assemblyId")}.pdf"`,
  );
  ctx.header("cache-control", "no-store");
  // Cast: mesmo workaround de strict mode de `convocation_pdf.ts`.
  return ctx.body(pdfBytes as unknown as ArrayBuffer);
};
