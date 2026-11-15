// Controller do módulo de patologias (portal do condómino). Requests a nível
// CONDOMÍNIO (/v1/portal/condominiums/:cid/pathologies); requirePortalAccessToCondo
// reforça na API (occupant tem >=1 unit no condo). Read-only por design (ADR 0024).

import { render } from "$panel/render.ts";
import { currentCondominiumId, currentPortalUnitId } from "$panel/context.ts";
import { proxyDownload } from "$panel/libs/download_proxy.ts";
import { client } from "$panel/client.ts";

function requireUnitId(): string {
  const id = currentPortalUnitId();
  if (!id) throw new Error("portalUnitId não definido - middleware deveria ter bloqueado.");
  return id;
}

// Mantém-se em sync com o módulo admin (panel/controllers/pathology.ts).
const CATEGORY_LABELS: Record<string, string> = {
  crack: "Fissura",
  infiltration: "Infiltração",
  humidity: "Humidade",
  efflorescence: "Eflorescência",
  detachment: "Descolagem",
  corrosion: "Oxidação/corrosão",
  mould: "Bolor / Fungos",
  structural: "Estrutural",
  other: "Outra",
};

// Labels finos por status; o bucket agregado usa STATUS_GROUP_LABELS.
const STATUS_LABELS: Record<string, string> = {
  identified: "Identificada",
  awaiting_quotes: "A aguardar cotações",
  quote_approved: "Cotação aprovada",
  awaiting_repair_start: "A aguardar obra",
  in_repair: "Em obra",
  resolved: "Resolvida",
  dismissed: "Encerrada",
};

// Cor semântica da pill por status. Mustard inline porque text-warning
// daisyUI tem mau contraste em light.
const STATUS_COLOR: Record<string, string> = {
  identified: "info",
  awaiting_quotes: "warning_mustard",
  quote_approved: "primary",
  awaiting_repair_start: "warning_mustard",
  in_repair: "info",
  resolved: "success",
  dismissed: "base-content/50",
};

const STATUS_GROUP_LABELS: Record<string, string> = {
  active: "Activas",
  resolved: "Resolvidas",
  dismissed: "Encerradas",
};

const VALID_STATUS_GROUPS = new Set(["active", "resolved", "dismissed"]);

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

type PathologyRec = Record<string, unknown> & {
  id: string;
  code: string;
  title: string;
  description: string | null;
  category: string;
  status: string;
  affectsCommonArea: boolean;
  detectedAt: string | null;
  resolvedAt: string | null;
  dismissedAt: string | null;
  attachments?: Array<Record<string, unknown> & { mimeType?: string }>;
  units: Array<{ id: string; designation: string; identifier: string | null }>;
};

export async function listPage(
  params: { statusGroup?: string } = {},
): Promise<string> {
  const filterGroup = params.statusGroup && VALID_STATUS_GROUPS.has(params.statusGroup)
    ? params.statusGroup
    : null;

  // Pedimos sempre ALL: contadores das tabs precisam do total; a lista visível
  // filtra-se client-side conforme filterGroup.
  const [common, allRes] = await Promise.all([
    commonContext(),
    client.portal.listPathologies().catch(() => ({
      data: [] as Array<Record<string, unknown>>,
    })),
  ]);
  const all = (allRes.data ?? []) as unknown as PathologyRec[];

  // Buckets (mesmos do _query.ts). Mantém-se sync server-side.
  const inActive = (p: PathologyRec) =>
    p.status === "identified" ||
    p.status === "awaiting_quotes" ||
    p.status === "quote_approved" ||
    p.status === "awaiting_repair_start" ||
    p.status === "in_repair";

  const counts = {
    all: all.length,
    active: all.filter(inActive).length,
    resolved: all.filter((p) => p.status === "resolved").length,
    dismissed: all.filter((p) => p.status === "dismissed").length,
  };

  const visible = filterGroup === "active"
    ? all.filter(inActive)
    : filterGroup === "resolved"
    ? all.filter((p) => p.status === "resolved")
    : filterGroup === "dismissed"
    ? all.filter((p) => p.status === "dismissed")
    : all;

  return await render("pages/portal/pathologies/list.vto", {
    title: "Patologias",
    section: "pathologies",
    condominium: common.condominium,
    unit: common.unit,
    currentCondominiumId: common.currentCondominiumId,
    currentPortalUnitId: common.currentPortalUnitId,
    pathologies: visible,
    counts,
    filterGroup,
    categoryLabels: CATEGORY_LABELS,
    statusLabels: STATUS_LABELS,
    statusColor: STATUS_COLOR,
    statusGroupLabels: STATUS_GROUP_LABELS,
  });
}

/** Detalhe (show) de uma patologia. 404 se draft ou cross-condo. */
export async function showPage(pathologyId: string): Promise<string> {
  const [common, pRes] = await Promise.all([
    commonContext(),
    client.portal.getPathology(pathologyId),
  ]);
  const target = pRes.data as unknown as PathologyRec;

  return await render("pages/portal/pathologies/show.vto", {
    title: target.title,
    section: "pathologies",
    condominium: common.condominium,
    unit: common.unit,
    currentCondominiumId: common.currentCondominiumId,
    currentPortalUnitId: common.currentPortalUnitId,
    target,
    categoryLabels: CATEGORY_LABELS,
    statusLabels: STATUS_LABELS,
    statusColor: STATUS_COLOR,
  });
}

/** Proxy do anexo da patologia (filtro status!=draft no API). */
export async function attachmentProxy(
  pathologyId: string,
  attachmentId: string,
): Promise<Response> {
  const upstream = await client.portal.downloadStream(
    `/pathologies/${pathologyId}/attachments/${attachmentId}`,
  );
  return proxyDownload(upstream, {
    errorPrefix: "Erro a obter anexo",
    fallbackDisposition: `inline; filename="foto-${attachmentId}"`,
  });
}
