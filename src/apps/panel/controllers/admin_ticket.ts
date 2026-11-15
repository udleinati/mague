// Panel admin/ticket - listagem, detalhe e operações de tickets pelo gestor.

import { render } from "$panel/render.ts";
import { type Ticket } from "$shared/client/mod.ts";
import { currentCondominiumId } from "$panel/context.ts";
import { parseFormBool, parseFormString } from "$panel/libs/form_parsing.ts";
import { client } from "$panel/client.ts";

// Labels PT - aqui (não nos templates) por serem precisas em KPIs/filtros.
export const CATEGORY_LABELS: Record<string, string> = {
  elevator: "Elevador",
  lighting: "Iluminação",
  plumbing: "Canalizações / Infiltrações",
  hvac: "AVAC / Ventilação",
  common_area: "Áreas comuns",
  facade: "Fachada / Exterior",
  parking: "Estacionamento",
  garden: "Jardim / Espaços verdes",
  security: "Segurança",
  cleaning: "Limpeza",
  other: "Outros",
};

export const PRIORITY_LABELS: Record<string, string> = {
  low: "Baixa",
  normal: "Normal",
  high: "Alta",
  urgent: "Urgente",
};

export const STATUS_LABELS: Record<string, string> = {
  open: "Aberto",
  in_progress: "Em progresso",
  resolved: "Resolvido",
  closed: "Fechado",
};

function summarize(rows: Ticket[]) {
  const s = { open: 0, in_progress: 0, resolved: 0, closed: 0 };
  for (const r of rows) {
    if (r.status in s) s[r.status as keyof typeof s]++;
  }
  return s;
}

export async function listPage(
  params: { status?: string; category?: string; priority?: string; unitId?: string } = {},
  flash?: { type: string; message: string },
) {
  const [ticketsResult, unitsResult] = await Promise.all([
    client.admin.listTickets(params),
    // Para filtro/select de fração no form (admin escolhe).
    client.admin.listUnits(),
  ]);

  const tickets = ticketsResult.data;
  return await render("pages/ticket/list.vto", {
    title: "Ocorrências",
    section: "tickets",
    tickets,
    units: unitsResult.data,
    summary: summarize(tickets),
    filters: params,
    categoryLabels: CATEGORY_LABELS,
    priorityLabels: PRIORITY_LABELS,
    statusLabels: STATUS_LABELS,
    flash,
  });
}

export async function newPage(flash?: { type: string; message: string }) {
  const unitsResult = await client.admin.listUnits();
  return await render("pages/ticket/new.vto", {
    title: "Nova ocorrência",
    section: "tickets",
    units: unitsResult.data,
    categoryLabels: CATEGORY_LABELS,
    priorityLabels: PRIORITY_LABELS,
    flash,
  });
}

export async function showPage(
  ticketId: string,
  flash?: { type: string; message: string },
) {
  const [ticketResult, unitsResult, pathologiesResult] = await Promise.all([
    client.admin.getTicket(ticketId),
    client.admin.listUnits(),
    // Patologias para o modal "Associar a patologia existente"; `.catch()`
    // defensivo deixa o modal vazio em vez de derrubar a página.
    client.admin.listPathologies().catch(() => ({ data: [] })),
  ]);
  // Resolve só o ocupante deste submitter (filtro server-side por userId).
  // Manager externo sem record de ocupante devolve [] - template cai para email.
  const submitterUserId = ticketResult.data.submittedBy?.userId;
  const submitterName = submitterUserId
    ? await client.admin.listOccupants({ userId: submitterUserId })
      .then((r) => r.data[0]?.name ?? null)
      .catch(() => null)
    : null;
  const t = ticketResult.data;
  const label = t.code;
  return await render("pages/ticket/show.vto", {
    title: `Ocorrência ${label}`,
    section: "tickets",
    ticket: ticketResult.data,
    units: unitsResult.data,
    submitterName,
    pathologies: pathologiesResult.data,
    categoryLabels: CATEGORY_LABELS,
    priorityLabels: PRIORITY_LABELS,
    statusLabels: STATUS_LABELS,
    flash,
  });
}

/**
 * Render parcial dos POSTs (update/status/comments/attachments) em HX-Request:
 * outerHTML swap do `<div id="ticket-body">` + toast OOB. Espelha as queries de
 * `showPage` (sem condominium - vem do layout).
 */
export async function renderTicketBody(
  ticketId: string,
  toast?: { message: string },
): Promise<string> {
  const [ticketResult, unitsResult] = await Promise.all([
    client.admin.getTicket(ticketId),
    client.admin.listUnits(),
  ]);
  const submitterUserId = ticketResult.data.submittedBy?.userId;
  const submitterName = submitterUserId
    ? await client.admin.listOccupants({ userId: submitterUserId })
      .then((r) => r.data[0]?.name ?? null)
      .catch(() => null)
    : null;
  return await render("pages/ticket/_ticket_body.vto", {
    ticket: ticketResult.data,
    units: unitsResult.data,
    submitterName,
    categoryLabels: CATEGORY_LABELS,
    priorityLabels: PRIORITY_LABELS,
    statusLabels: STATUS_LABELS,
    currentCondominiumId: currentCondominiumId(),
    toast: toast ?? null,
  });
}

// ── Mutations (chamadas pelos handlers POST do panel router) ────────────

export async function createTicket(form: Record<string, string | File>) {
  const title = parseFormString(form, "title");
  const category = String(form.category ?? "");
  const priority = String(form.priority ?? "normal");
  const description = parseFormString(form, "description", { emptyAsNull: true });
  const location = parseFormString(form, "location", { emptyAsNull: true });
  const unitId = parseFormString(form, "unitId", { emptyAsNull: true });

  // Visibilidade: admin_only | admin_unit | public, default
  // admin_only. Caller garante admin_unit→unitId !== null (UI esconde a opção).
  const visibilityRaw = parseFormString(form, "visibility");
  const visibility = (["admin_only", "admin_unit", "public"] as const).includes(
      visibilityRaw as never,
    )
    ? (visibilityRaw as "admin_only" | "admin_unit" | "public")
    : "admin_only";

  const result = await client.admin.createTicket({
    title,
    description,
    category: category as never,
    priority: priority as never,
    unitId,
    location,
    visibility,
  });
  return result.data;
}

export async function updateTicket(ticketId: string, form: Record<string, string | File>) {
  const patch: Record<string, unknown> = {};
  if (form.title !== undefined) patch.title = parseFormString(form, "title");
  if (form.description !== undefined) {
    patch.description = parseFormString(form, "description", { emptyAsNull: true });
  }
  if (form.category) patch.category = String(form.category);
  if (form.priority) patch.priority = String(form.priority);
  if (form.status) patch.status = String(form.status);
  if (form.location !== undefined) {
    patch.location = parseFormString(form, "location", { emptyAsNull: true });
  }
  if (form.resolutionNotes !== undefined) {
    patch.resolutionNotes = parseFormString(form, "resolutionNotes", { emptyAsNull: true });
  }
  if (form.unitId !== undefined) {
    patch.unitId = parseFormString(form, "unitId", { emptyAsNull: true });
  }
  // Visibilidade: só interpreta quando o form a envia (update parcial).
  // Valor inválido = ignora (backend rejeita com 422).
  if (form.visibility !== undefined) {
    const v = parseFormString(form, "visibility");
    if (["admin_only", "admin_unit", "public"].includes(v)) {
      patch.visibility = v;
    }
  }
  // pathologyId: string vazia/sentinel "null" → null (desassociar);
  // string com valor → set; omissão → não toca (ADR 0024).
  if (form.pathologyId !== undefined) {
    patch.pathologyId = parseFormString(form, "pathologyId", { emptyAsNull: true });
  }
  await client.admin.updateTicket(ticketId, patch);
  return { ok: true };
}

export async function addComment(ticketId: string, form: Record<string, string | File>) {
  const comment = parseFormString(form, "comment");
  if (!comment) throw new Error("Comentário em falta");
  // Checkbox "internal" no form: vazio quando desmarcado, "on" quando marcado.
  const isInternal = parseFormBool(form, "isInternal");
  await client.admin.addTicketComment(ticketId, { comment, isInternal });
  return { ok: true };
}

export async function deleteTicket(ticketId: string) {
  await client.admin.deleteTicket(ticketId);
  return { ok: true };
}

export async function deleteComment(ticketId: string, commentId: string) {
  await client.admin.deleteTicketComment(ticketId, commentId);
  return { ok: true };
}

// ── Attachments ─────────────────────────────────────────────────────────

export async function uploadAttachment(ticketId: string, file: File) {
  const result = await client.admin.uploadTicketAttachment(ticketId, file);
  return result.data;
}

export async function deleteAttachment(ticketId: string, attachmentId: string) {
  await client.admin.deleteTicketAttachment(ticketId, attachmentId);
  return { ok: true };
}

/**
 * "Promover ticket a patologia" (ADR 0024): cria a patologia a partir do form
 * + PATCH do ticket com `pathology_id`. O ticket não muda de estado. Devolve
 * o ID da patologia para o caller redireccionar.
 */
export async function promoteTicketToPathology(
  ticketId: string,
  form: Record<string, string | File>,
): Promise<{ pathologyId: string; pathologyCode: string }> {
  const title = parseFormString(form, "title");
  if (!title) throw new Error("Título da patologia é obrigatório");
  const description = parseFormString(form, "description", { emptyAsNull: true });
  const category = parseFormString(form, "category", { default: "other" }) as never;
  const affectsCommonArea = form.affectsCommonArea === "1" ||
    form.affectsCommonArea === "true";
  const detectedAt = parseFormString(form, "detectedAt") || undefined;

  const created = await client.admin.createPathology({
    title,
    description,
    category,
    affectsCommonArea,
    detectedAt,
  });
  const pathologyId = created.data.id;

  // Copia (não move) os attachments para a patologia: se esta for apagada, as
  // fotos originais ficam. Falha não-fatal - o ticket continua promovido.
  await client.admin.copyAttachmentsFromTicket(pathologyId, ticketId).catch((e) => {
    console.warn(
      `promoteTicketToPathology: copy attachments falhou (ticket=${ticketId} → pathology=${pathologyId}): ${
        (e as Error).message
      }`,
    );
  });

  await client.admin.updateTicket(ticketId, { pathologyId });
  return { pathologyId, pathologyCode: created.data.code };
}
