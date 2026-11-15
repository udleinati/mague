// GET /v1/admin/condominiums/:cid/assemblies/:assemblyId/minutes.pdf - gera a ata on-the-fly.
// NÃO arquiva em S3: re-gerada a cada pedido (dados mudam: texto, pontos, presenças). Para
// arquivar, o admin descarrega e faz upload à área de anexos.

import type { Context } from "hono";
import { and, eq, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { STATUS_CODE } from "@std/http";
import type { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { unitNaturalOrder } from "$api/libs/postgres/order_by.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { byIdInCondo } from "$api/libs/shared/by_id_in_condo.ts";
import { renderTemplate } from "$api/libs/templates/render.ts";
import { renderPdf } from "$api/libs/pdf/render.ts";
import {
  type BudgetPdfPayload,
  loadBudgetPdfPayload,
} from "$api/modules/admin/budget/_pdf_payload.ts";

interface AttendeeForPdf {
  occupantName: string | null;
  unitDesignation: string | null;
  unitIdentifier: string | null;
  permillageAtMeeting: string | number;
  // Nome do portador da procuração (interno ou externo) quando a presença é por
  // procuração; null quando o titular está presente em causa própria.
  proxyHolderName: string | null;
}

interface SignerLookup {
  id: string;
  name: string;
}

// Fração discordante (voto contra/abstenção) nomeada na ata.
interface DissentEntry {
  designation: string;
  identifier: string | null;
}

// Ordem natural (ADR 0014) em TS: comprimento ASC, depois alfabética.
function naturalUnitCompare(a: DissentEntry, b: DissentEntry): number {
  return a.designation.length - b.designation.length ||
    a.designation.localeCompare(b.designation, "pt");
}

export const getAssemblyMinutesPdf = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const assemblyId = requireParam(ctx, "assemblyId");

  // 1. Assembly + ordem do dia (pontos) nested (mesmo query que retrieve.ts).
  const result = await postgres.query((db) =>
    db.query.assembly.findFirst({
      where: byIdInCondo(schema.assembly, assemblyId, condominiumId),
      with: {
        agendaItems: {
          where: (e, ops) => ops.isNull(e.deletedAt),
          orderBy: (e, { asc }) => [asc(e.sequence), asc(e.createdAt)],
          // Votos discordantes (contra/abstenção) por fração - para a ata nomear
          // a minoria de uma deliberação aprovada (Art. 1433.º CC).
          with: {
            votes: {
              where: (v, ops) =>
                ops.and(ops.isNull(v.deletedAt), ops.inArray(v.vote, ["against", "abstain"])),
              with: { unit: { columns: { designation: true, identifier: true } } },
            },
          },
        },
      },
    })
  );
  const assembly = findEntityOrFail(result, "Assembleia");

  // 2. Condomínio (nome + NIF + morada).
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

  // 3. Attendees + JOIN explícito a occupant + unit (Drizzle relational
  //    `with` aqui não funciona - assemblyAttendee não tem `relations()`
  //    declaradas no schema). 1 query com 2 LEFT JOINs evita N+1.
  const round = assembly.convocationRound ?? "first";
  // Alias de occupant para o portador da procuração (XOR com nome externo).
  const proxyHolder = alias(schema.occupant, "proxy_holder");
  const attendeesRows = await postgres.query((db) =>
    db.select({
      occupantName: schema.occupant.name,
      unitDesignation: schema.unit.designation,
      unitIdentifier: schema.unit.identifier,
      permillageAtMeeting: schema.assemblyAttendee.permillageAtMeeting,
      isProxy: schema.assemblyAttendee.isProxy,
      proxyHolderOccupantName: proxyHolder.name,
      proxyHolderExternalName: schema.assemblyAttendee.proxyHolderExternalName,
    })
      .from(schema.assemblyAttendee)
      .leftJoin(
        schema.occupant,
        eq(schema.assemblyAttendee.occupantId, schema.occupant.id),
      )
      .leftJoin(
        schema.unit,
        eq(schema.assemblyAttendee.unitId, schema.unit.id),
      )
      .leftJoin(
        proxyHolder,
        eq(schema.assemblyAttendee.proxyHolderOccupantId, proxyHolder.id),
      )
      .where(and(
        eq(schema.assemblyAttendee.assemblyId, assemblyId),
        eq(schema.assemblyAttendee.convocationRound, round),
        isNull(schema.assemblyAttendee.deletedAt),
      ))
      // Ordem natural pela designação da fração (igual à página da assembleia
      // e ao resto da UI - ADR 0014), não pela ordem de registo das presenças.
      .orderBy(...unitNaturalOrder(schema.unit.designation))
  );
  const attendees: AttendeeForPdf[] = attendeesRows.map((a) => ({
    occupantName: a.occupantName ?? null,
    unitDesignation: a.unitDesignation ?? null,
    unitIdentifier: a.unitIdentifier ?? null,
    permillageAtMeeting: a.permillageAtMeeting as string,
    proxyHolderName: a.isProxy
      ? (a.proxyHolderOccupantName ?? a.proxyHolderExternalName ?? null)
      : null,
  }));

  // Base das percentagens de votação na ata: permilagem presente (presentes =
  // 100%), não os 1000‰ do edifício. A permilagem exata por sentido fica em ‰
  // (valor legal da maioria, Art. 1432.º/1433.º CC).
  const presentPermillage = Math.round(
    attendees.reduce((sum, a) => sum + Number(a.permillageAtMeeting ?? 0), 0) * 1000,
  ) / 1000;

  // 4. Nomes do presidente + secretário (snapshot do momento - se entretanto
  //    o ocupante foi soft-deleted, mantém-se para preservar a ata legal).
  const signerIds = [assembly.presidentOccupantId, assembly.secretaryOccupantId]
    .filter((x): x is string => !!x);
  let signers: SignerLookup[] = [];
  if (signerIds.length > 0) {
    const rows = await postgres.query((db) =>
      db.query.occupant.findMany({
        where: (o, ops) => ops.inArray(o.id, signerIds),
        columns: { id: true, name: true },
      })
    );
    signers = rows.map((r) => ({ id: r.id, name: r.name }));
  }
  const presidentName = signers.find((s) => s.id === assembly.presidentOccupantId)?.name ?? null;
  const secretaryName = signers.find((s) => s.id === assembly.secretaryOccupantId)?.name ?? null;

  // 5. Anexos: corpo do orçamento por cada ponto da ordem do dia ligado a um
  //    orçamento (refType "budget" + refId). Mesmos valores que a página/PDF do
  //    orçamento (loadBudgetPdfPayload). Pontos sem orçamento ligado (ou com
  //    orçamento apagado) não geram anexo - saltam em silêncio. Cada ponto fica
  //    com `annexNumber` para a ata referenciar "ver Anexo N".
  const decisions = (assembly as unknown as {
    agendaItems: Array<
      Record<string, unknown> & {
        refType?: string | null;
        refId?: string | null;
        annexNumber?: number;
        approved?: boolean | null;
        votes?: Array<{ vote: string; unit: DissentEntry | null }>;
        dissentAgainst?: DissentEntry[];
        dissentAbstain?: DissentEntry[];
      }
    >;
  }).agendaItems ?? [];
  const annexes: Array<{ label: string } & BudgetPdfPayload> = [];
  for (const item of decisions) {
    // Minoria de uma deliberação aprovada: nomeia as frações que votaram contra
    // ou se abstiveram (Art. 1433.º CC). Só em pontos aprovados; vazio = nada.
    if (item.approved === true) {
      const named = (dir: string) =>
        (item.votes ?? [])
          .filter((v) => v.vote === dir && v.unit)
          .map((v) => ({
            designation: v.unit!.designation,
            identifier: v.unit!.identifier ?? null,
          }))
          .sort(naturalUnitCompare);
      item.dissentAgainst = named("against");
      item.dissentAbstain = named("abstain");
    }

    if (item.refType !== "budget" || !item.refId) continue;
    const payload = await loadBudgetPdfPayload(postgres, condominiumId, item.refId);
    if (!payload) continue;
    // Anexo 1 é sempre a folha de presenças; os orçamentos seguem a partir do 2.
    const number = annexes.length + 2;
    item.annexNumber = number;
    annexes.push({ label: `Anexo ${number}`, ...payload });
  }

  // 6. Renderiza HTML + gera PDF.
  const html = await renderTemplate("assembly_minutes.vto", {
    condominium,
    assembly,
    decisions,
    attendees,
    presentPermillage,
    presidentName,
    secretaryName,
    annexes,
    generatedAt: new Date().toISOString(),
  });
  let pdfBytes: Uint8Array;
  try {
    pdfBytes = await renderPdf({
      html,
      // Margens da ata (iguais ao @page do template); a inferior acolhe o rodapé.
      margin: { top: "25mm", right: "20mm", bottom: "18mm", left: "25mm" },
      // Rodapé: "Página X/Y" centrado (numeração para atas com vários pontos/anexos).
      footerTemplate: '<div style="width:100%;font-size:8pt;color:#888;text-align:center;">' +
        'Página <span class="pageNumber"></span>/<span class="totalPages"></span></div>',
    });
  } catch (err) {
    // Logging defensivo - Chromium pode falhar (memória, timeout). Devolve
    // 500 com mensagem genérica e o erro fica no log do API.
    console.error("[assembly.minutes_pdf] renderPdf falhou", err);
    return ctx.json(
      {
        error: {
          code: "PDF_GENERATION_FAILED",
          message: "Não foi possível gerar a ata em PDF.",
        },
      },
      STATUS_CODE.InternalServerError,
    );
  }

  // 7. Nome do ficheiro: "ata-N42-condominio.pdf" (ou fallback "ata-id").
  const slug = assembly.minutesNumber
    ? `ata-N${String(assembly.minutesNumber).replace(/[^\w-]/g, "")}`
    : `ata-${assemblyId}`;
  const filename = `${slug}.pdf`;

  ctx.header("content-type", "application/pdf");
  // `inline` (não `attachment`): pré-visualização - o panel abre numa nova aba.
  ctx.header("content-disposition", `inline; filename="${filename}"`);
  ctx.header("cache-control", "no-store");
  // Cast: `Uint8Array<ArrayBufferLike>` não casa diretamente com o tipo `Data`
  // do `ctx.body` em strict mode (mesmo workaround de `receipt/serve_pdf.ts`).
  return ctx.body(pdfBytes as unknown as ArrayBuffer);
};
