// Panel admin/pathology - controllers SSR. Chama a API real (substitui o
// `pathology_mock.ts`). Padrão idêntico aos outros recursos: client HTTP
// partilhado, templates Vento, redirects com `?flash=...` para feedback.

import { render } from "$panel/render.ts";
import type { Pathology, PathologyCategory, PathologyStatus, Unit } from "$shared/client/mod.ts";
import { parseFormString } from "$panel/libs/form_parsing.ts";
import { proxyDownload } from "$panel/libs/download_proxy.ts";
import { client } from "$panel/client.ts";

// ─── Labels e cores (single source - template lê via context) ─────────────

export const CATEGORY_LABELS: Record<PathologyCategory, string> = {
  crack: "Fissura",
  infiltration: "Infiltração",
  humidity: "Humidade",
  efflorescence: "Eflorescência",
  detachment: "Descolamento",
  corrosion: "Corrosão",
  mould: "Fungos",
  structural: "Estrutural",
  other: "Outra",
};

export const STATUS_LABELS: Record<PathologyStatus, string> = {
  draft: "Rascunho",
  identified: "Identificada",
  awaiting_quotes: "A aguardar cotações",
  quote_approved: "Cotação aprovada",
  awaiting_repair_start: "Aguarda início",
  in_repair: "Em obra",
  resolved: "Resolvida",
  dismissed: "Dispensada",
};

export const STATUS_SHORT: Record<PathologyStatus, string> = {
  draft: "Rascunho",
  identified: "Identificada",
  awaiting_quotes: "Cotações",
  quote_approved: "Aprovada",
  awaiting_repair_start: "Aguarda obra",
  in_repair: "Em obra",
  resolved: "Resolvida",
  dismissed: "Dispensada",
};

// Cor semântica de cada status. `warning_mustard` é sentinel - o template
// renderiza com `style="color:#A16207"` por causa do contraste fraco do
// `text-warning` daisyUI em light theme. Replicado em show.vto + list.vto.
export const STATUS_COLOR: Record<PathologyStatus, string> = {
  draft: "base-content/40",
  identified: "info",
  awaiting_quotes: "warning_mustard",
  quote_approved: "info",
  awaiting_repair_start: "warning_mustard",
  in_repair: "primary",
  resolved: "success",
  dismissed: "base-content/40",
};

// ─── Render ────────────────────────────────────────────────────────────────

export async function listPathologies(filter: { status?: string } = {}) {
  const [listRes, unitsRes] = await Promise.all([
    client.admin.listPathologies(filter.status ? { status: filter.status as PathologyStatus } : {}),
    client.admin.listUnits().catch(() => ({ data: [] as Unit[] })),
  ]);
  const pathologies = listRes.data;
  const units = unitsRes.data.map((u) => ({
    id: u.id,
    designation: u.designation,
    identifier: u.identifier ?? null,
  }));

  // KPIs sobre o conjunto NÃO filtrado - chama de novo sem filtro quando há
  // filtro ativo. Custo pequeno (lista pequena por condomínio).
  let all: Pathology[] = pathologies;
  if (filter.status) {
    const allRes = await client.admin.listPathologies();
    all = allRes.data;
  }
  const summary = {
    total: all.length,
    active:
      all.filter((p) => p.status !== "draft" && p.status !== "resolved" && p.status !== "dismissed")
        .length,
    inRepair: all.filter((p) => p.status === "in_repair").length,
    awaiting: all.filter((p) =>
      p.status === "awaiting_quotes" || p.status === "quote_approved" ||
      p.status === "awaiting_repair_start"
    ).length,
    resolved: all.filter((p) => p.status === "resolved").length,
    draft: all.filter((p) => p.status === "draft").length,
  };

  // Photo count derivado da contagem de attachments. Como list endpoint não
  // devolve attachments, mostramos sempre 0 na listagem (template trata).
  // Detail page tem attachments completos.
  const pathologiesWithCount = pathologies.map((p) => ({
    ...p,
    photosCount: p.attachments?.length ?? 0,
  }));

  return await render("pages/pathology/list.vto", {
    title: "Patologias",
    section: "pathology",
    pathologies: pathologiesWithCount,
    units,
    summary,
    filter,
    categoryLabels: CATEGORY_LABELS,
    statusLabels: STATUS_LABELS,
    statusShort: STATUS_SHORT,
    statusColor: STATUS_COLOR,
  });
}

export async function showPathology(pathologyId: string) {
  const [{ data: target }, unitsRes] = await Promise.all([
    client.admin.getPathology(pathologyId),
    client.admin.listUnits().catch(() => ({ data: [] as Unit[] })),
  ]);
  const units = unitsRes.data.map((u) => ({
    id: u.id,
    designation: u.designation,
    identifier: u.identifier ?? null,
  }));
  const targetWithCount = {
    ...target,
    photosCount: target.attachments?.length ?? 0,
  };
  return await render("pages/pathology/show.vto", {
    title: `${target.code} · ${target.title}`,
    section: "pathology",
    target: targetWithCount,
    units,
    categoryLabels: CATEGORY_LABELS,
    statusLabels: STATUS_LABELS,
    statusShort: STATUS_SHORT,
    statusColor: STATUS_COLOR,
  });
}

// ─── Mutations ────────────────────────────────────────────────────────────

function parseUnitIds(form: Record<string, string | File>): string[] {
  // Form do panel pode enviar `unitIds[]` como array OU múltiplos campos
  // com a mesma key. Hono parseBody devolve string OU array. Normalizar.
  const raw = form["unitIds[]"] ?? form.unitIds;
  if (raw === undefined) return [];
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === "string");
  if (typeof raw === "string") return raw ? [raw] : [];
  return [];
}

export async function createPathology(form: Record<string, string | File>) {
  const unitIds = parseUnitIds(form);
  const body = {
    title: parseFormString(form, "title"),
    description: parseFormString(form, "description", { emptyAsNull: true }),
    category: parseFormString(form, "category", { default: "other" }) as PathologyCategory,
    affectsCommonArea: form.affectsCommonArea === "1" || form.affectsCommonArea === "true",
    unitIds,
    detectedAt: String(form.detectedAt ?? "") || undefined,
  };
  const r = await client.admin.createPathology(body);
  return r.data;
}

export async function updatePathology(
  pathologyId: string,
  form: Record<string, string | File>,
) {
  const unitIds = form["unitIds[]"] !== undefined || form.unitIds !== undefined
    ? parseUnitIds(form)
    : undefined;
  const patch: Record<string, unknown> = {};
  if (form.title !== undefined) patch.title = parseFormString(form, "title");
  if (form.description !== undefined) {
    patch.description = parseFormString(form, "description", { emptyAsNull: true });
  }
  if (form.category) patch.category = String(form.category);
  // Sentinel para checkbox (sem este, desligar não distinguia de "campo omitido").
  if (form.affectsCommonAreaSubmitted === "1") {
    patch.affectsCommonArea = form.affectsCommonArea === "1" || form.affectsCommonArea === "true";
  }
  if (unitIds !== undefined) patch.unitIds = unitIds;
  if (form.resolutionNotes !== undefined) {
    patch.resolutionNotes = parseFormString(form, "resolutionNotes", { emptyAsNull: true });
  }
  if (form.dismissedReason !== undefined) {
    patch.dismissedReason = parseFormString(form, "dismissedReason", { emptyAsNull: true });
  }
  if (form.detectedAt) patch.detectedAt = String(form.detectedAt);
  // Datas terminais (resolvida/dispensada): `""` limpa a data (NULL), omitido mantém.
  if (form.resolvedAt !== undefined) {
    patch.resolvedAt = parseFormString(form, "resolvedAt", { emptyAsNull: true });
  }
  if (form.dismissedAt !== undefined) {
    patch.dismissedAt = parseFormString(form, "dismissedAt", { emptyAsNull: true });
  }
  await client.admin.updatePathology(pathologyId, patch);
  return { ok: true };
}

export async function changePathologyStatus(
  pathologyId: string,
  status: PathologyStatus,
  dismissedReason?: string,
) {
  const patch: Record<string, unknown> = { status };
  if (status === "dismissed" && dismissedReason) {
    patch.dismissedReason = dismissedReason;
  }
  await client.admin.updatePathology(pathologyId, patch);
  return { ok: true };
}

export async function deletePathology(pathologyId: string) {
  await client.admin.deletePathology(pathologyId);
  return { ok: true };
}

export async function uploadPathologyAttachment(pathologyId: string, file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  await client.admin.uploadPathologyAttachment(
    pathologyId,
    bytes,
    file.name || "foto",
    file.type || "application/octet-stream",
  );
}

export async function deletePathologyAttachment(pathologyId: string, attachmentId: string) {
  await client.admin.deletePathologyAttachment(pathologyId, attachmentId);
}

/** Proxy do GET ao API para servir os bytes do anexo. */
export async function downloadPathologyAttachment(
  pathologyId: string,
  attachmentId: string,
): Promise<Response> {
  const upstream = await client.admin.downloadStream(
    `/pathologies/${pathologyId}/attachments/${attachmentId}`,
  );
  return proxyDownload(upstream, {
    errorPrefix: "Erro a obter anexo",
    fallbackDisposition: `inline; filename="anexo-${attachmentId}"`,
  });
}
