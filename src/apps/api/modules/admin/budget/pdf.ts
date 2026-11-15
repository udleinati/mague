// GET /v1/admin/condominiums/:cid/budgets/:budgetId/pdf
//
// PDF do orçamento gerado on-the-fly (rubricas + totais + mapa por fração).
// Mesmo padrão dos PDFs de assembleia: renderTemplate -> renderPdf, sem S3.
// Funciona em draft (proposta para a assembleia) e aprovado.

import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { renderTemplate } from "$api/libs/templates/render.ts";
import { renderPdf } from "$api/libs/pdf/render.ts";
import { loadBudgetPdfPayload } from "./_pdf_payload.ts";

// Descrição -> slug para o nome do ficheiro: sem acentos, espaços -> "-",
// resto dos caracteres estranhos cai.
function slugifyNotes(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .slice(0, 60)
    .replace(/^-|-$/g, "");
}

export const getBudgetPdf = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const budgetId = requireParam(ctx, "budgetId");

  const payload = await loadBudgetPdfPayload(postgres, condominiumId, budgetId);
  if (!payload) {
    throw new AppError({
      message: "Orçamento não encontrado",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }
  const { budget, quotaMap, grandTotal, installmentValue } = payload;

  const condoRow = await postgres.query((db) =>
    db.query.condominium.findFirst({
      where: (c, ops) => ops.eq(c.id, condominiumId),
      columns: { name: true, fiscalNumber: true, address: true, postalCode: true, city: true },
    })
  );
  const condominium = {
    name: condoRow?.name ?? "(condomínio)",
    fiscalNumber: condoRow?.fiscalNumber ?? null,
    address: condoRow?.address ?? null,
    postalCode: condoRow?.postalCode ?? null,
    city: condoRow?.city ?? null,
  };

  const html = await renderTemplate("budget.vto", {
    condominium,
    budget,
    quotaMap,
    grandTotal,
    installmentValue,
    generatedAt: new Date().toISOString(),
  });

  let pdfBytes: Uint8Array;
  try {
    pdfBytes = await renderPdf({ html });
  } catch (err) {
    console.error("[budget.pdf] renderPdf falhou", err);
    return ctx.json(
      {
        error: {
          code: "PDF_GENERATION_FAILED",
          message: "Não foi possível gerar o orçamento em PDF.",
        },
      },
      STATUS_CODE.InternalServerError,
    );
  }

  const kind = budget.type === "suplementar" ? "suplementar" : "principal";
  const slug = budget.type === "suplementar" ? slugifyNotes(budget.notes) : "";
  const filename = `orcamento-${budget.year}-${kind}${slug ? `-${slug}` : ""}.pdf`;
  ctx.header("content-type", "application/pdf");
  ctx.header("content-disposition", `inline; filename="${filename}"`);
  ctx.header("cache-control", "no-store");
  // Cast: Uint8Array<ArrayBufferLike> não casa com `Data` em strict mode
  // (mesmo workaround de receipt/serve_pdf.ts e assembly/minutes_pdf.ts).
  return ctx.body(pdfBytes as unknown as ArrayBuffer);
};
