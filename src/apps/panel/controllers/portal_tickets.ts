// Controller do módulo de ocorrências (portal do condómino). Só callers com
// unit_occupant ativa na fração chegam aqui (requirePortalAccessToUnit na API).
// Write-once (list + create); o ciclo de vida fica no admin, o condómino só reporta.

import { render } from "$panel/render.ts";
import { currentCondominiumId, currentPortalUnitId } from "$panel/context.ts";
import { parseFormString } from "$panel/libs/form_parsing.ts";
import { client } from "$panel/client.ts";

function requireUnitId(): string {
  const id = currentPortalUnitId();
  if (!id) throw new Error("portalUnitId não definido - middleware deveria ter bloqueado.");
  return id;
}

// Em sync com handlers.ts (admin): novas categorias na API replicam-se aqui.
const CATEGORY_LABELS: Record<string, string> = {
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

const PRIORITY_LABELS: Record<string, string> = {
  low: "Baixa",
  normal: "Normal",
  high: "Alta",
  urgent: "Urgente",
};

async function commonContext() {
  const uid = requireUnitId();
  const [unitRes, condominiumRes] = await Promise.all([
    client.portal.getUnit(uid),
    client.portal.getCondominium(),
  ]);
  return {
    unit: unitRes.data,
    condominium: condominiumRes.data,
    currentPortalUnitId: uid,
    currentCondominiumId: currentCondominiumId(),
  };
}

const STATUS_LABELS: Record<string, string> = {
  open: "Aberto",
  in_progress: "Em progresso",
  resolved: "Resolvido",
  closed: "Fechado",
};

// Flash vem do layout via globalFlash (ADR 0012).
export async function listPage(params: { status?: string } = {}): Promise<string> {
  const uid = requireUnitId();
  const [common, ticketsRes] = await Promise.all([
    commonContext(),
    client.portal.listTickets(uid).catch(() => ({ data: [] as Array<Record<string, unknown>> })),
  ]);
  type T = Record<string, unknown> & { status?: string };
  const all = ticketsRes.data as unknown as T[];

  // Filtro server-side por estado (mesmo pattern de portal/documents).
  const VALID = new Set(Object.keys(STATUS_LABELS));
  const filterStatus = params.status && VALID.has(params.status) ? params.status : null;
  const visible = filterStatus ? all.filter((t) => t.status === filterStatus) : all;

  // Contadores para os tabs - calculados sobre `all`, não sobre `visible`.
  const statusCounts: Record<string, number> = {
    all: all.length,
    open: 0,
    in_progress: 0,
    resolved: 0,
    closed: 0,
  };
  for (const t of all) {
    if (t.status && statusCounts[t.status] !== undefined) statusCounts[t.status]++;
  }

  return await render("pages/portal/tickets.vto", {
    title: "Ocorrências",
    section: "tickets",
    ...common,
    tickets: visible,
    statusCounts,
    filterStatus,
    statusLabels: STATUS_LABELS,
    categoryLabels: CATEGORY_LABELS,
    priorityLabels: PRIORITY_LABELS,
  });
}

export async function showPage(ticketId: string): Promise<string> {
  const uid = requireUnitId();
  const [common, ticketRes] = await Promise.all([
    commonContext(),
    client.portal.getTicket(uid, ticketId),
  ]);
  const ticket = ticketRes.data as Record<string, unknown>;
  const label = ticket.code as string;
  return await render("pages/portal/ticket_show.vto", {
    title: `Ocorrência ${label}`,
    section: "tickets",
    ...common,
    ticket,
    categoryLabels: CATEGORY_LABELS,
    priorityLabels: PRIORITY_LABELS,
    statusLabels: STATUS_LABELS,
  });
}

export async function createTicket(form: Record<string, string | File>): Promise<{ id: string }> {
  const uid = requireUnitId();
  const title = parseFormString(form, "title");
  const description = parseFormString(form, "description", { emptyAsNull: true });
  const category = parseFormString(form, "category", { default: "other" });
  const priority = parseFormString(form, "priority", { default: "normal" });
  const location = parseFormString(form, "location", { emptyAsNull: true });

  if (title.length < 3) {
    throw new Error("Título obrigatório (mínimo 3 caracteres).");
  }

  const result = await client.portal.createTicket(uid, {
    title,
    description,
    category,
    priority,
    location,
  });
  return { id: String((result.data as { id?: string }).id ?? "") };
}

export async function updateTicket(
  ticketId: string,
  form: Record<string, string | File>,
): Promise<void> {
  const uid = requireUnitId();
  const patch: {
    title?: string;
    description?: string | null;
    category?: string;
    priority?: string;
    location?: string | null;
  } = {};
  if (form.title !== undefined) {
    const t = parseFormString(form, "title");
    if (t.length < 3) throw new Error("Título obrigatório (mínimo 3 caracteres).");
    patch.title = t;
  }
  if (form.description !== undefined) {
    patch.description = parseFormString(form, "description", { emptyAsNull: true });
  }
  if (form.category !== undefined) patch.category = String(form.category);
  if (form.priority !== undefined) patch.priority = String(form.priority);
  if (form.location !== undefined) {
    patch.location = parseFormString(form, "location", { emptyAsNull: true });
  }
  await client.portal.updateTicket(uid, ticketId, patch);
}

export async function addComment(
  ticketId: string,
  form: Record<string, string | File>,
): Promise<void> {
  const uid = requireUnitId();
  const comment = parseFormString(form, "comment");
  if (!comment) throw new Error("Comentário em falta.");
  await client.portal.addTicketComment(uid, ticketId, comment);
}

export async function deleteTicket(ticketId: string): Promise<void> {
  const uid = requireUnitId();
  await client.portal.deleteTicket(uid, ticketId);
}

export async function uploadAttachment(ticketId: string, file: File): Promise<void> {
  const uid = requireUnitId();
  await client.portal.uploadTicketAttachment(uid, ticketId, file);
}

export async function deleteAttachment(
  ticketId: string,
  attachmentId: string,
): Promise<void> {
  const uid = requireUnitId();
  await client.portal.deleteTicketAttachment(uid, ticketId, attachmentId);
}
