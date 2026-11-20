import vento from "vento";
import { fromFileUrl } from "@std/path";
import { Client } from "$shared/client/mod.ts";
import { panelConfig } from "./config.ts";
import {
  currentCondominiumId,
  currentFlash,
  currentPortalOccupant,
  currentPortalUnitId,
  currentToken,
  currentUser,
} from "./context.ts";
import { loadPortalUnitContext } from "./portal/portal_context.ts";
import { loadCurrentCondominium } from "./condominium.ts";
import { type OwnerWindow } from "$shared/portal/owner_window.ts";
import { condoUrl } from "./urls.ts";
import { formatDate, formatMoney, formatPermillage } from "$shared/format/mod.ts";
import { formatRemaining } from "$shared/time/remaining.ts";
import { UPLOAD_ACCEPT_ATTR } from "$shared/upload/mime.ts";
import { env } from "$config/env.ts";
import { chargeStatusBadge, isChargeOverdue } from "$panel/libs/charge_status.ts";
import { insuranceHero, insuranceStatusBadge } from "$panel/libs/insurance_status.ts";
import { buildAdminNav } from "./nav.ts";

const TEMPLATES_DIR = fromFileUrl(new URL("./templates/", import.meta.url));

async function getAvailableCondominiums() {
  const user = currentUser();
  const token = currentToken();
  if (!user || !token) return [];
  const client = new Client({
    baseUrl: panelConfig.apiUrl,
    defaultHeaders: { Authorization: `Bearer ${token}` },
  });
  try {
    if (user.role === "super") {
      const r = await client.super.listCondominiums();
      return r.data;
    }
    // Manager: /v1/super/* bloqueado; buscar cada condo gerido via getMe.
    const results = await Promise.all(
      user.managedCondominiumIds.map((cid) =>
        client.admin.forCondominium(cid).getMe()
          .then((r) => r.data)
          .catch(() => null)
      ),
    );
    return results.filter((c): c is NonNullable<typeof c> => c != null);
  } catch {
    return [];
  }
}

/** Janela do owner para o banner do portal. Cache per-request via
 *  loadPortalUnitContext(). Null fora do portal ou em erro (defensivo). */
async function getPortalOwnerWindow(): Promise<OwnerWindow | null> {
  if (!currentPortalUnitId()) return null;
  try {
    const ctx = await loadPortalUnitContext();
    return ctx.ownerWindow;
  } catch {
    return null;
  }
}

/** Conta inspeções due_soon + expired para o badge do menu. 0 em erro ou
 *  para roles sem acesso - nunca bloqueia o render do layout. */
async function getInspectionAlertCount(): Promise<number> {
  const user = currentUser();
  const cid = currentCondominiumId();
  const token = currentToken();
  if (!user || !cid || !token) return 0;
  // Badge só visível a super ou administradores ativos do condo (ADR 0002).
  if (user.role !== "super" && !user.managedCondominiumIds.includes(cid)) return 0;
  const client = new Client({
    baseUrl: panelConfig.apiUrl,
    defaultHeaders: { Authorization: `Bearer ${token}` },
    condominiumId: cid,
  });
  try {
    const { data } = await client.admin.countInspectionAlerts();
    return data.count;
  } catch {
    return 0;
  }
}

const ventoEnv = vento({
  includes: TEMPLATES_DIR,
  autoescape: true,
});

// Helpers globais - disponíveis em todos os templates
ventoEnv.filters.formatMoney = (cents: unknown): string => formatMoney(cents);
ventoEnv.filters.formatDate = (value: unknown): string => formatDate(value);
ventoEnv.filters.formatDateTime = (value: unknown): string => formatDateTime(value);
ventoEnv.filters.formatMonth = (value: unknown): string => formatMonth(value);
ventoEnv.filters.formatPermillage = (value: unknown): string => formatPermillage(value);
ventoEnv.filters.num = (
  value: unknown,
): number => (typeof value === "number" ? value : Number(value));
ventoEnv.filters.condoPath = (path: unknown): string => condoUrl(String(path ?? ""));
// `now` resolvido a cada render (snapshot) - badges de cooldown.
ventoEnv.filters.formatRemaining = (until: unknown): string =>
  formatRemaining(until as string | Date | null, new Date());

// Formatadores partilhados com a API (PDFs/emails) - ver $shared/format.
export { formatDate, formatMoney, formatPermillage };

// Timestamp → "dd/mm/yyyy HH:mm" (formato PT). Para campos onde a hora conta.
export function formatDateTime(value: unknown): string {
  if (value == null) return "";
  const d = value instanceof Date ? value : new Date(value as string | number);
  if (Number.isNaN(d.getTime())) return "";
  const dd = d.getDate().toString().padStart(2, "0");
  const mm = (d.getMonth() + 1).toString().padStart(2, "0");
  const yyyy = d.getFullYear().toString();
  const hh = d.getHours().toString().padStart(2, "0");
  const mi = d.getMinutes().toString().padStart(2, "0");
  return `${dd}/${mm}/${yyyy} ${hh}:${mi}`;
}

// Mês contabilístico → "Mês/AAAA" (PT abreviado). Aceita "YYYY-MM" ou
// "YYYY-MM-DD"; vazio/null/inválido → "".
const PT_MONTHS = [
  "Jan",
  "Fev",
  "Mar",
  "Abr",
  "Mai",
  "Jun",
  "Jul",
  "Ago",
  "Set",
  "Out",
  "Nov",
  "Dez",
];
export function formatMonth(value: unknown): string {
  if (value == null) return "";
  const m = String(value).match(/^(\d{4})-(\d{2})/);
  if (!m) return "";
  const year = m[1];
  const monthIdx = Number.parseInt(m[2], 10) - 1;
  if (monthIdx < 0 || monthIdx > 11) return "";
  return `${PT_MONTHS[monthIdx]}/${year}`;
}

// Renderiza um template Vento. Path relativo a `src/panel/templates/`.
export async function render(
  templatePath: string,
  data: Record<string, unknown> = {},
): Promise<string> {
  const [availableCondominiums, inspectionAlertCount, globalOwnerWindow, currentCondominium] =
    await Promise
      .all([
        getAvailableCondominiums(),
        getInspectionAlertCount(),
        getPortalOwnerWindow(),
        loadCurrentCondominium(),
      ]);
  const globalFlash = currentFlash();
  // Fonte única do menu admin + lista do command palette (ver nav.ts). `section`
  // vem do controller via `data`; resolve o estado ativo. Inerte no portal.
  const user = currentUser();
  const adminNav = buildAdminNav({
    cid: currentCondominiumId(),
    activeSection: typeof data.section === "string" ? data.section : null,
    inspectionAlertCount,
    availableCondominiums,
    occupantUnits: user?.occupantUnits ?? [],
  });
  const result = await ventoEnv.run(templatePath, {
    // Condomínio ativo (cache per-request). `condominium` em `data` precede.
    condominium: currentCondominium,
    availableCondominiums,
    currentCondominiumId: currentCondominiumId(),
    currentUser: currentUser(),
    currentPortalUnitId: currentPortalUnitId(),
    currentPortalOccupant: currentPortalOccupant(),
    // Limite de upload em MB - evita hard-coding nos templates.
    uploadMaxMb: env.upload.maxFileSizeMb,
    // `accept` dos dropzones - mesma allowlist que o servidor valida (mime.ts).
    uploadAccept: UPLOAD_ACCEPT_ATTR,
    inspectionAlertCount,
    // Menu admin + palette gerados de nav.ts (null no portal / sem cid).
    adminNav,
    // Injectado pelo ALS (`?flash=…`). `flash` do controller precede via ...data.
    globalFlash,
    // Banner de impersonate em portal.vto, em TODAS as páginas do portal.
    globalOwnerWindow,
    // Regra canónica do "Vencido" (ADR 0037). NUNCA `c.status === "overdue"`
    // num template (gravado na criação, não recalculado).
    chargeStatusBadge,
    isChargeOverdue,
    // Copy + tom do estado do seguro (`kind` do domínio -> PT-PT). NUNCA
    // escrever a escada `kind === "active" ? "Ativa" : ...` num template.
    insuranceStatusBadge,
    // Título e CTA do hero do portal, pela mesma fonte que os badges.
    insuranceHero,
    ...data,
  });
  return result.content;
}

// Renderiza source Vento inline (sem ficheiro). Usado pelos testes de
// partials para exercitar `{{ layout }}` (corpo como slot). Includes
// resolvem contra `templates/`.
export async function renderString(
  source: string,
  data: Record<string, unknown> = {},
): Promise<string> {
  const result = await ventoEnv.runString(source, data);
  return result.content;
}
