// Controllers do módulo de recibos. Wrappers finos sobre a API (snapshots,
// PDF, S3, email vivem lá).
//
//   GET  receipts/pending            → candidatos a emitir
//   GET  receipts                    → histórico filtrado
//   GET  receipts/:id                → detalhe + anular + re-enviar
//   GET  receipts/emit-to            → modal "Emitir para…" (escolha do destinatário)
//   POST receipts/preview            → HTML do recibo antes de emitir (JSON { html })
//   POST receipts/emit               → emite 1; emit-bulk → todos
//   POST receipts/:id/void           → anula com justificação
//   POST receipts/:id/resend-email   → re-envia
//   GET  receipts/:id/pdf            → proxy do PDF do S3

import { render } from "$panel/render.ts";
import { currentCondominiumId } from "$panel/context.ts";
import { buildPaginationMeta, paginationParamsFromQuery } from "$panel/libs/pagination.ts";
import { proxyDownload } from "$panel/libs/download_proxy.ts";
import { resolveServerYearParam } from "$shared/year_filter/mod.ts";
import { parseFormString } from "$panel/libs/form_parsing.ts";
import { client } from "$panel/client.ts";
import type { ReceiptRecipientChoice } from "$shared/client/mod.ts";

type Rec = Record<string, unknown>;

/** GET receipts/pending - fila para emitir + tab Ignoradas. Carrega ambas as
 *  listas (a oposta serve só para o badge de contagem da tab). */
export async function pendingPage(tab: "pending" | "skipped" = "pending") {
  const [pendingRes, skippedRes, unitsRes, bankAccountsRes] = await Promise.all([
    client.admin.listPendingReceipts(),
    client.admin.listSkippedReceipts(),
    client.admin.listUnits(),
    client.admin.listBankAccounts(),
  ]);

  const pending = pendingRes.data;
  const skipped = skippedRes.data;
  const units = unitsRes.data;
  const bankAccounts = bankAccountsRes.data as Array<
    Rec & { id: string; bankName: string; accountName: string | null; kind: string }
  >;

  const unitById = new Map(units.map((u) => [u.id, u]));
  const baById = new Map(bankAccounts.map((b) => [b.id, b]));

  const enrichRow = <T extends { unitId: string; bankAccountId: string }>(p: T) => ({
    ...p,
    unitDesignation: unitById.get(p.unitId)?.designation ?? "-",
    unitIdentifier: unitById.get(p.unitId)?.identifier ?? null,
    bankAccountName: baById.get(p.bankAccountId)?.accountName ??
      baById.get(p.bankAccountId)?.bankName ??
      "-",
    bankAccountKind: baById.get(p.bankAccountId)?.kind ?? "bank",
  });

  const enrichedPending = pending.map(enrichRow);
  const enrichedSkipped = skipped.map(enrichRow);

  return await render("pages/receipts/pending.vto", {
    title: "Recibos pendentes",
    section: "receipts",
    tab,
    pending: enrichedPending,
    skipped: enrichedSkipped,
    totalAmount: enrichedPending.reduce((s, p) => s + Number(p.recipientAmount ?? 0), 0),
  });
}

/** Fetch + prepara dados da listagem de recibos. Reusado por listPage (página)
 *  e listFragment (HTMX partial). */
async function fetchReceiptsData(params: Record<string, string>) {
  // Filtro de ano server-side: default ano atual, "" = Todos, "YYYY" = esse ano
  // (resolveServerYearParam). currentYear é reusado nos availableYears.
  const currentYear = new Date().getUTCFullYear();
  const filterYear = resolveServerYearParam(params.year, currentYear);

  const filters: Record<string, string> = {};
  if (filterYear !== null) filters.year = String(filterYear);
  if (params.unitId) filters.unitId = params.unitId;
  if (params.voided && params.voided !== "all") filters.voided = params.voided;

  // Paginação: helper partilhado, default 500/página.
  const pp = paginationParamsFromQuery(params);
  filters.page = pp.page;
  filters.perPage = pp.perPage;

  const [receiptsRes, unitsRes] = await Promise.all([
    client.admin.listReceiptsWithMeta(filters),
    client.admin.listUnits(),
  ]);

  const receipts = receiptsRes.data;
  const units = unitsRes.data;
  const unitById = new Map(units.map((u) => [u.id, u]));

  const enriched = receipts.map((r) => ({
    ...r,
    unitDesignation: unitById.get(r.unitId)?.designation ?? "-",
    unitIdentifier: unitById.get(r.unitId)?.identifier ?? null,
  }));

  // availableYears vem da API (todos os anos com recibos). Garantimos
  // que o ano atual está sempre presente para o user filtrar.
  const availableYearsSet = new Set<number>(receiptsRes.meta.availableYears);
  availableYearsSet.add(currentYear);
  const availableYears = [...availableYearsSet].sort((a, b) => b - a);

  const stats = {
    total: receipts.length,
    active: receipts.filter((r) => !r.isVoided).length,
    voided: receipts.filter((r) => r.isVoided).length,
    totalAmount: receipts.filter((r) => !r.isVoided).reduce(
      (s, r) => s + Number(r.amountCents ?? 0),
      0,
    ),
  };

  const pagination = receiptsRes.pagination
    ? buildPaginationMeta(receiptsRes.pagination, params, [
      "year",
      "unitId",
      "voided",
      "perPage",
    ])
    : null;

  return {
    title: "Recibos",
    section: "receipts",
    receipts: enriched,
    units,
    availableYears,
    filterYear, // number | null
    filterUnitId: params.unitId ?? "",
    filterVoided: params.voided ?? "all",
    stats,
    pagination,
  };
}

/** GET /admin/c/:cid/receipts - histórico filtrado (página completa). */
export async function listPage(params: Record<string, string>) {
  const data = await fetchReceiptsData(params);
  return await render("pages/receipts/list.vto", data);
}

/** GET /admin/c/:cid/receipts (HX-Request) - só o fragmento dinâmico. */
export async function listFragment(params: Record<string, string>) {
  const data = await fetchReceiptsData(params);
  return await render("pages/receipts/_list_fragment.vto", data);
}

/** GET /admin/c/:cid/receipts/:id - detalhe. */
export async function showPage(receiptId: string) {
  const receiptRes = await client.admin.getReceipt(receiptId);

  const receipt = receiptRes.data;
  const recipientsSnapshot = receipt.recipientsSnapshot ?? [];

  // Modal de re-envio precisa do `receive_receipt_emails` ACTUAL (o snapshot
  // pode estar desatualizado). Filtra pelos IDs do snapshot (query targeted),
  // mesmo critério que `resend_email.ts` (o escolhido recebe sempre).
  const occupantIds = recipientsSnapshot.map((r) => r.occupantId).filter((id) => id !== null);
  const occupantsRes = occupantIds.length === 0
    ? { data: [] }
    : await client.admin.listOccupants({ ids: occupantIds.join(",") });
  const occupants = (occupantsRes.data ?? []) as Array<{
    id: string;
    receiveReceiptEmails?: boolean;
  }>;
  const currentReceiveByOccupantId = new Map(
    occupants.map((o) => [o.id, o.receiveReceiptEmails ?? true]),
  );
  const activeRecipients = recipientsSnapshot.filter(
    (r) =>
      r.email &&
      (r.chosen === true ||
        (r.occupantId !== null && currentReceiveByOccupantId.get(r.occupantId) === true)),
  );

  return await render("pages/receipts/show.vto", {
    title: `Recibo ${receipt.number ?? "-"}`,
    section: "receipts",
    receipt,
    activeRecipients,
  });
}

/** GET receipts/emit-to - modal com os ocupantes da fração na data do pagamento + "Outro". */
export async function emitToModal(bankTransactionId: string, unitId: string) {
  const [optionsRes, unitRes] = await Promise.all([
    client.admin.getReceiptRecipientOptions({ bankTransactionId, unitId }),
    client.admin.getUnit(unitId),
  ]);
  return await render("pages/receipts/_emit_to_modal.vto", {
    bankTransactionId,
    unitId,
    unitDesignation: unitRes.data.designation,
    unitIdentifier: unitRes.data.identifier ?? null,
    ...optionsRes.data,
  });
}

// Select do "Emitir para…": occupantId ou "manual" (+ nome/NIF/email). Vazio = regra por defeito.
function recipientFromForm(
  form: Record<string, string | File>,
): ReceiptRecipientChoice | undefined {
  const choice = parseFormString(form, "recipientOccupantId");
  if (!choice) return undefined;
  if (choice !== "manual") return { occupantId: choice };
  return {
    name: parseFormString(form, "recipientName"),
    nif: parseFormString(form, "recipientNif"),
    email: parseFormString(form, "recipientEmail", { emptyAsNull: true }),
  };
}

/** POST receipts/preview - HTML do recibo tal como sairia (mesmos campos do emit). */
export async function previewReceipt(form: Record<string, string | File>) {
  const bankTransactionId = parseFormString(form, "bankTransactionId");
  const unitId = parseFormString(form, "unitId");
  if (!bankTransactionId || !unitId) {
    throw new Error("bankTransactionId e unitId são obrigatórios");
  }
  const result = await client.admin.previewReceipt({
    bankTransactionId,
    unitId,
    recipient: recipientFromForm(form),
  });
  return result.data;
}

/** POST receipts/emit { bankTransactionId, unitId, recipient* } */
export async function emitOne(form: Record<string, string | File>) {
  const bankTransactionId = parseFormString(form, "bankTransactionId");
  const unitId = parseFormString(form, "unitId");
  if (!bankTransactionId || !unitId) {
    throw new Error("bankTransactionId e unitId são obrigatórios");
  }
  const recipient = recipientFromForm(form);
  const result = await client.admin.emitReceipt({ bankTransactionId, unitId, recipient });
  return result.data;
}

/** POST receipts/emit (HX-Request) - emite e devolve OOB swaps:
 *    1. `<td>` da action cell → link "✓ Emitido · NNNN"
 *    2. toast no #toast-container
 *  Em erro devolve só o toast (a row fica intacta para o user re-tentar). */
export async function emitOneHtmx(form: Record<string, string | File>) {
  const { runHtmxAction } = await import("../routes/_htmx_action.ts");
  return await runHtmxAction(form, {
    required: ["bankTransactionId", "unitId"],
    validationMsg: "Dados insuficientes para emitir.",
    apiCall: async (f) => {
      const r = await client.admin.emitReceipt({
        bankTransactionId: f.bankTransactionId,
        unitId: f.unitId,
        recipient: recipientFromForm(f),
      });
      return r.data;
    },
    successPartial: ({ form: f, result }) =>
      render("pages/receipts/_pending_action_emitted.vto", {
        currentCondominiumId: currentCondominiumId(),
        bankTransactionId: f.bankTransactionId,
        unitId: f.unitId,
        receiptId: result.receiptId,
        receiptNumber: result.number,
      }),
    successMsg: ({ result }) => `Recibo ${result.number} emitido.`,
    errorPrefix: "Erro ao emitir.",
  });
}

/** POST receipts/emit-bulk - emite todos os pendentes. */
export async function emitBulk() {
  const result = await client.admin.emitBulkReceipts();
  return result.data;
}

/** POST receipts/skip (HX-Request) - ignora a tupla; OOB substitui a célula
 *  de ação por "○ Ignorada · razão" com link "retomar" (mesmo padrão do
 *  emitir). A row mantém-se visível na tab Pendentes. */
export async function skipReceiptHtmx(form: Record<string, string | File>) {
  const { runHtmxAction } = await import("../routes/_htmx_action.ts");
  return await runHtmxAction(form, {
    required: ["bankTransactionId", "unitId"],
    validationMsg: "Dados insuficientes para ignorar.",
    apiCall: async (f) => {
      await client.admin.skipReceipt({
        bankTransactionId: f.bankTransactionId,
        unitId: f.unitId,
        reason: f.reason || undefined,
      });
    },
    successPartial: ({ form: f }) =>
      render("pages/receipts/_pending_action_skipped.vto", {
        currentCondominiumId: currentCondominiumId(),
        bankTransactionId: f.bankTransactionId,
        unitId: f.unitId,
        reason: f.reason || undefined,
      }),
    successMsg: "Linha ignorada.",
    errorPrefix: "Erro ao ignorar.",
  });
}

/** POST receipts/unskip (HX-Request) - retoma a tupla.
 *  - Tab "Ignoradas": row substituído por outerHTML="" → desaparece.
 *  - Tab "Pendentes": OOB `pending-action-...` restaura a célula (na tab
 *    Ignoradas esse id não existe e o swap é ignorado). */
export async function unskipReceiptHtmx(form: Record<string, string | File>) {
  const { runHtmxAction } = await import("../routes/_htmx_action.ts");
  return await runHtmxAction(form, {
    required: ["bankTransactionId", "unitId"],
    validationMsg: "Dados insuficientes para retomar.",
    apiCall: async (f) => {
      await client.admin.unskipReceipt({
        bankTransactionId: f.bankTransactionId,
        unitId: f.unitId,
        reason: f.reason || undefined,
      });
    },
    successPartial: ({ form: f }) =>
      render("pages/receipts/_pending_action_pending.vto", {
        currentCondominiumId: currentCondominiumId(),
        bankTransactionId: f.bankTransactionId,
        unitId: f.unitId,
      }),
    successMsg: "Linha retomada.",
    errorPrefix: "Erro ao retomar.",
  });
}

/** POST receipts/:id/void { reason } */
export async function voidOne(receiptId: string, form: Record<string, string | File>) {
  const reason = parseFormString(form, "reason");
  if (!reason) throw new Error("Justificação obrigatória para anular recibo");
  const result = await client.admin.voidReceipt(receiptId, { reason });
  return result.data;
}

/** POST receipts/:id/resend-email - re-envia notificação. */
export async function resendEmail(receiptId: string) {
  const result = await client.admin.resendReceiptEmail(receiptId);
  return result.data;
}

/** GET receipts/:id/pdf - proxy ao endpoint /pdf da API (mesmo content-type/disposition). */
export async function downloadPdf(receiptId: string): Promise<Response> {
  const upstream = await client.admin.downloadStream(`/receipts/${receiptId}/pdf`);
  return proxyDownload(upstream, {
    errorPrefix: "Erro ao obter PDF",
    contentType: "application/pdf",
    cacheControl: "private, max-age=3600",
  });
}
