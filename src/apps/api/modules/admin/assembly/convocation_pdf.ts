// Pré-visualização (read-only) dos PDFs da convocatória, como `minutes_pdf.ts` da ata:
//   GET .../convocation.pdf - convocatória (estado atual da assembleia).
//   GET .../proxy.pdf - modelo de procuração genérico, campos de identificação em branco.
// Não mudam `status` nem criam runs; o PDF é gerado a cada pedido (não arquivado em S3).

import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import type { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { byIdInCondo } from "$api/libs/shared/by_id_in_condo.ts";
import { renderTemplate } from "$api/libs/templates/render.ts";
import { renderPdf } from "$api/libs/pdf/render.ts";

export interface ConvocationContext {
  assemblyId: string;
  // `assembly` traz todas as colunas + `agendaItems` aninhados (ordem do dia).
  assembly: Record<string, unknown> & { agendaItems?: unknown[] };
  condominium: { name: string; fiscalNumber: string | null; address: string | null };
  agendaItems: unknown[];
  // Email da nota de correção dos emails (ADR 0034): `replyToEmail ?? email`, ou null.
  // Não vai para o PDF.
  correctionEmail: string | null;
}

// Assembleia (com ordem do dia) + cabeçalho do condomínio. Recebe ids (não `ctx`)
// porque é partilhado pela pré-visualização E pelo loop de envio. Espelha `minutes_pdf.ts`.
export async function loadConvocationContext(
  postgres: Postgres,
  args: { condominiumId: string; assemblyId: string },
): Promise<ConvocationContext> {
  const { condominiumId, assemblyId } = args;

  const result = await postgres.query((db) =>
    db.query.assembly.findFirst({
      where: byIdInCondo(schema.assembly, assemblyId, condominiumId),
      with: {
        agendaItems: {
          where: (e, ops) => ops.isNull(e.deletedAt),
          orderBy: (e, { asc }) => [asc(e.sequence), asc(e.createdAt)],
        },
      },
    })
  );
  const assembly = findEntityOrFail(result, "Assembleia") as
    & Record<string, unknown>
    & { agendaItems?: unknown[] };

  const condoRow = await postgres.query((db) =>
    db.query.condominium.findFirst({
      where: (c, ops) => ops.eq(c.id, condominiumId),
      columns: { name: true, fiscalNumber: true, address: true, email: true, replyToEmail: true },
    })
  );
  const condominium = {
    name: condoRow?.name ?? "(condomínio)",
    fiscalNumber: condoRow?.fiscalNumber ?? null,
    address: condoRow?.address ?? null,
  };
  // Nota de correção: prefere o `replyToEmail` (quem gere o condo); cai no
  // `email` geral; null se nenhum existir. Trata "" como ausente.
  const nonEmpty = (s: string | null | undefined) => (s && s.trim() !== "" ? s.trim() : null);
  const correctionEmail = nonEmpty(condoRow?.replyToEmail) ?? nonEmpty(condoRow?.email);

  return {
    assemblyId,
    assembly,
    condominium,
    agendaItems: assembly.agendaItems ?? [],
    correctionEmail,
  };
}

// Gera o PDF e devolve `application/pdf`, ou 500 (Chromium pode falhar). O
// nome do ficheiro vem por argumento; `errLabel` identifica a rota no log.
async function pdfResponse(
  ctx: Context,
  html: string,
  filename: string,
  errLabel: string,
): Promise<Response> {
  let pdfBytes: Uint8Array;
  try {
    pdfBytes = await renderPdf({ html });
  } catch (err) {
    console.error(`[assembly.${errLabel}] renderPdf falhou`, err);
    return ctx.json(
      {
        error: {
          code: "PDF_GENERATION_FAILED",
          message: "Não foi possível gerar o PDF.",
        },
      },
      STATUS_CODE.InternalServerError,
    );
  }
  ctx.header("content-type", "application/pdf");
  // `inline` (não `attachment`): são pré-visualizações - o panel abre-as numa
  // nova aba (target="_blank"); o filename serve se o utilizador guardar.
  ctx.header("content-disposition", `inline; filename="${filename}"`);
  ctx.header("cache-control", "no-store");
  // Cast: `Uint8Array<ArrayBufferLike>` não casa diretamente com o tipo `Data`
  // do `ctx.body` em strict mode (mesmo workaround de `receipt/serve_pdf.ts`).
  return ctx.body(pdfBytes as unknown as ArrayBuffer);
}

// GET /v1/admin/condominiums/:cid/assemblies/:assemblyId/convocation.pdf
export const getAssemblyConvocationPdf = async (ctx: Context, postgres: Postgres) => {
  const { assemblyId, assembly, condominium, agendaItems } = await loadConvocationContext(
    postgres,
    { condominiumId: requireCondominiumId(ctx), assemblyId: requireParam(ctx, "assemblyId") },
  );

  const html = await renderTemplate("assembly_convocation.vto", {
    condominium,
    assembly,
    agendaItems,
    generatedAt: new Date().toISOString(),
  });
  return pdfResponse(ctx, html, `convocatoria-${assemblyId}.pdf`, "convocation_pdf");
};

// GET /v1/admin/condominiums/:cid/assemblies/:assemblyId/proxy.pdf
// Modelo genérico: `recipient` a null, identificação em branco. O render personalizado
// por destinatário acontece no envio.
export const getAssemblyProxyPdf = async (ctx: Context, postgres: Postgres) => {
  const { assemblyId, assembly, condominium } = await loadConvocationContext(
    postgres,
    { condominiumId: requireCondominiumId(ctx), assemblyId: requireParam(ctx, "assemblyId") },
  );

  const html = await renderTemplate("assembly_proxy.vto", {
    condominium,
    assembly,
    // Preview: sem destinatário concreto - placeholders em nome, NIF e fração
    // (modelo genérico, natureza singular). No envio real, um proprietário sem
    // NIF registado mostra antes uma linha em branco para preencher à mão.
    recipient: {
      name: null,
      nif: "[NIF do condómino]",
      personType: null,
      unitLabel: null,
    },
    generatedAt: new Date().toISOString(),
  });
  return pdfResponse(ctx, html, `procuracao-${assemblyId}.pdf`, "proxy_pdf");
};
