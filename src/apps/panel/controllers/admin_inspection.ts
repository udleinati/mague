// Controller do módulo de inspeções (admin). Wrapper fino sobre o Client.

import { render } from "$panel/render.ts";
import { type Inspection } from "$shared/client/mod.ts";
import { parseFormString } from "$panel/libs/form_parsing.ts";
import { proxyDownload } from "$panel/libs/download_proxy.ts";
import { listAccessibleCondominiums } from "./auth.ts";
import { client } from "$panel/client.ts";

const CATEGORY_LABELS: Record<string, string> = {
  fire_extinguisher: "Extintores",
  fire_detection: "Detecção de incêndio",
  elevator: "Elevador",
  gas: "Gás",
  electricity: "Instalação elétrica",
  lightning_rod: "Pára-raios",
  hvac: "AVAC",
  pool: "Piscina",
  antenna: "Antena",
  other: "Outros",
};

function summarize(rows: Inspection[]) {
  const summary = { ok: 0, due_soon: 0, expired: 0, inactive: 0 };
  for (const r of rows) {
    if (r.status === "ok") summary.ok++;
    else if (r.status === "due_soon") summary.due_soon++;
    else if (r.status === "expired") summary.expired++;
    else if (r.status === "inactive") summary.inactive++;
  }
  return summary;
}

export async function listPage(flash?: { type: string; message: string }): Promise<string> {
  const [{ data: rows }, availableCondominiums] = await Promise.all([
    client.admin.listInspections(),
    listAccessibleCondominiums(),
  ]);

  return await render("pages/inspection/list.vto", {
    title: "Inspeções",
    section: "inspection",
    availableCondominiums,
    inspections: rows,
    summary: summarize(rows),
    categoryLabels: CATEGORY_LABELS,
    flash,
  });
}

export async function newPage(
  values: Record<string, string> = {},
  flash?: { type: string; message: string },
) {
  const [availableCondominiums, { data: suppliers }] = await Promise.all([
    listAccessibleCondominiums(),
    client.admin.listSuppliers().catch(() => ({ data: [] })),
  ]);
  return await render("pages/inspection/new.vto", {
    title: "Nova inspeção",
    section: "inspection",
    availableCondominiums,
    categoryLabels: CATEGORY_LABELS,
    suppliers,
    values,
    flash,
  });
}

export async function showPage(inspectionId: string, flash?: { type: string; message: string }) {
  const [{ data: inspection }, availableCondominiums, { data: suppliers }] = await Promise.all([
    client.admin.getInspection(inspectionId),
    listAccessibleCondominiums(),
    client.admin.listSuppliers().catch(() => ({ data: [] })),
  ]);
  return await render("pages/inspection/show.vto", {
    title: `Inspeção: ${inspection.description}`,
    section: "inspection",
    availableCondominiums,
    inspection,
    categoryLabels: CATEGORY_LABELS,
    suppliers,
    flash,
  });
}

function strOrNull(v: string | File | undefined): string | null {
  if (v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function intOrUndefined(v: string | File | undefined): number | undefined {
  if (v === undefined) return undefined;
  const s = String(v).trim();
  if (s === "") return undefined;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : undefined;
}

export async function createInspection(
  form: Record<string, string | File>,
): Promise<{ id: string }> {
  const category = parseFormString(form, "category");
  const description = parseFormString(form, "description");
  const validUntil = parseFormString(form, "validUntil");
  if (!category) throw new Error("Categoria é obrigatória.");
  if (!description) throw new Error("Descrição é obrigatória.");
  if (!validUntil) throw new Error("Data de validade é obrigatória.");

  const body: Parameters<typeof client.admin.createInspection>[0] = {
    category,
    description,
    validUntil,
    lastDoneDate: strOrNull(form.lastDoneDate),
    notes: strOrNull(form.notes),
    supplierId: strOrNull(form.supplierId),
  };
  const days = intOrUndefined(form.notifyDaysBefore);
  if (days !== undefined) body.notifyDaysBefore = days;

  const r = await client.admin.createInspection(body);
  return { id: r.data.id };
}

export async function updateInspection(
  inspectionId: string,
  form: Record<string, string | File>,
): Promise<void> {
  const patch: Record<string, unknown> = {};
  if (form.category !== undefined) patch.category = parseFormString(form, "category");
  if (form.description !== undefined) patch.description = parseFormString(form, "description");
  if (form.validUntil !== undefined) patch.validUntil = parseFormString(form, "validUntil");
  if (form.lastDoneDate !== undefined) patch.lastDoneDate = strOrNull(form.lastDoneDate);
  if (form.notifyDaysBefore !== undefined) {
    const n = intOrUndefined(form.notifyDaysBefore);
    if (n !== undefined) patch.notifyDaysBefore = n;
  }
  if (form.notes !== undefined) patch.notes = strOrNull(form.notes);
  if (form.supplierId !== undefined) patch.supplierId = strOrNull(form.supplierId);
  await client.admin.updateInspection(inspectionId, patch);
}

export async function deleteInspection(inspectionId: string): Promise<void> {
  await client.admin.deleteInspection(inspectionId);
}

export async function activateInspection(inspectionId: string): Promise<void> {
  await client.admin.activateInspection(inspectionId);
}

export async function deactivateInspection(inspectionId: string): Promise<void> {
  await client.admin.deactivateInspection(inspectionId);
}

export async function addAttachment(inspectionId: string, file: File): Promise<void> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  await client.admin.addInspectionAttachment(
    inspectionId,
    bytes,
    file.name || "anexo",
    file.type || undefined,
  );
}

export async function deleteAttachment(inspectionId: string, attachmentId: string): Promise<void> {
  await client.admin.deleteInspectionAttachment(inspectionId, attachmentId);
}

export async function downloadAttachment(
  inspectionId: string,
  attachmentId: string,
): Promise<Response> {
  const upstream = await client.admin.downloadStream(
    `/inspections/${inspectionId}/attachments/${attachmentId}`,
  );
  return proxyDownload(upstream, { errorPrefix: "Erro a obter anexo" });
}
