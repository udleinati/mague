// Controller do módulo de seguros (admin). Wrapper fino sobre o Client.

import { render } from "$panel/render.ts";
import { currentCondominiumId } from "$panel/context.ts";
import { proxyDownload } from "$panel/libs/download_proxy.ts";
import { parseEurosToCents } from "$shared/money/parse_euros.ts";
import { parseFormString } from "$panel/libs/form_parsing.ts";
import { buildInsuranceListState, withCooldown, withRenewalDates } from "./insurance_list_state.ts";
import { listAccessibleCondominiums } from "./auth.ts";
import { client } from "$panel/client.ts";

export async function listPage(filters: {
  year?: string | null;
  status?: string | null;
} = {}): Promise<string> {
  // Flash vem do layout via globalFlash (ADR 0012) - não passar `flash` aqui.
  const [{ data: rows }, availableCondominiums] = await Promise.all([
    client.admin.listInsuranceUnitsStatus(),
    listAccessibleCondominiums(),
  ]);

  return await render("pages/insurance/index.vto", {
    title: "Seguros",
    section: "insurance",
    availableCondominiums,
    ...buildInsuranceListState(rows, filters, new Date()),
  });
}

export async function approvePolicy(policyId: string): Promise<void> {
  await client.admin.approveInsurancePolicy(policyId);
}

/**
 * Documento do modal (ficheiro + dados transcritos à frente dele, D8); `null`
 * quando não veio ficheiro. Só viajam com o documento - sem ele o API mantém a
 * aritmética e a herança do caminho presumido.
 */
function readPolicyDocument(form: Record<string, string | File>) {
  const file = form.file;
  if (!(file instanceof File) || file.size === 0) return null;
  const optional = (name: string) => {
    const v = parseFormString(form, name);
    return v === "" ? undefined : v;
  };
  const euros = form.coverageAmountEuros;
  return {
    file,
    contentType: file.type || "application/octet-stream",
    details: {
      validFrom: parseFormString(form, "validFrom"),
      validTo: parseFormString(form, "validTo"),
      policyNumber: optional("policyNumber"),
      insurer: optional("insurer"),
      // Campo ausente do form herda; presente e vazio apaga o capital.
      coverageAmountCents: euros === undefined ? undefined : String(parseEurosToCents(euros) ?? ""),
    },
  };
}

/**
 * Renova. Com documento a nova vigência entra em `pending_review` e a antiga
 * fica ativa até à aprovação (D4); sem ele mantém-se o caminho presumido de
 * hoje. `documented` diz ao route qual das duas mensagens mostrar.
 */
export async function renewPolicy(
  policyId: string,
  form: Record<string, string | File> = {},
): Promise<{ documented: boolean }> {
  const doc = readPolicyDocument(form);
  if (!doc) {
    await client.admin.renewInsurancePolicy(policyId);
    return { documented: false };
  }
  await client.admin.renewInsurancePolicyWithDocument(
    policyId,
    doc.file,
    doc.file.name,
    doc.contentType,
    doc.details,
  );
  return { documented: true };
}

/** Regista de raiz o documento entregue à administração. Ficheiro obrigatório
 *  (D6): sem predecessor não há continuidade de onde presumir a vigência. */
export async function createPolicy(
  unitId: string,
  form: Record<string, string | File>,
): Promise<void> {
  const doc = readPolicyDocument(form);
  if (!doc) throw new Error("Escolhe o documento da apólice.");
  // Só as datas: de raiz não há anterior de onde herdar, os dados saem do OCR.
  await client.admin.createInsurancePolicy(
    unitId,
    doc.file,
    doc.file.name,
    doc.contentType,
    { validFrom: doc.details.validFrom, validTo: doc.details.validTo },
  );
}

export async function undoRenewal(policyId: string): Promise<void> {
  await client.admin.undoInsuranceRenewal(policyId);
}

export async function reopenPolicy(policyId: string): Promise<void> {
  await client.admin.reopenInsurancePolicy(policyId);
}

/**
 * Edita os 6 campos editáveis da apólice (modal único). Gate `pending_review`
 * é enforced no API handler (ADR 0016). Campos vazios não viajam (exceto
 * coverage, onde vazio = null/apaga).
 */
export async function editPolicy(
  policyId: string,
  form: Record<string, string | File>,
): Promise<void> {
  const body: {
    validFrom?: string;
    validTo?: string;
    policyNumber?: string;
    insurer?: string;
    coverageAmountCents?: number | null;
  } = {};

  const vf = parseFormString(form, "validFrom");
  if (vf) body.validFrom = vf;
  const vt = parseFormString(form, "validTo");
  if (vt) body.validTo = vt;
  const pn = parseFormString(form, "policyNumber");
  if (pn) body.policyNumber = pn;
  const ins = parseFormString(form, "insurer");
  if (ins) body.insurer = ins;

  // Coverage: vazio = null (apaga), valor válido = cents.
  if (form.coverageAmountEuros !== undefined) {
    body.coverageAmountCents = parseEurosToCents(form.coverageAmountEuros);
  }

  await client.admin.editInsurancePolicy(policyId, body);
}

/** Re-fetch de 1 fração (filtro server-side, não carrega a view toda). */
async function findUnitInResponse(unitId: string) {
  const { data } = await client.admin.listInsuranceUnitsStatus({ unitId });
  return data[0] ?? null;
}

/**
 * Render OOB das duas linhas da fração (`_rows.vto`) com cooldown; `null` se a
 * fração desapareceu. Partilhado pelas ações de policy e pelo "lembrar".
 */
async function renderUnitRowsPartial(unitId: string): Promise<string | null> {
  const u = await findUnitInResponse(unitId);
  if (!u) return null;
  return await render("pages/insurance/_rows.vto", {
    u: withRenewalDates(withCooldown(u, new Date())),
    currentCondominiumId: currentCondominiumId(),
    oob: true,
  });
}

export async function renderUnitRowsHtmx(
  unitId: string,
  toastMessage: string,
  toastType: "success" | "warning" = "success",
): Promise<string> {
  const partial = await renderUnitRowsPartial(unitId);
  if (partial === null) {
    // Fração desapareceu (não deveria acontecer) - só toast.
    return await render("pages/reconciliation/_toast.vto", {
      toast: { type: "warning", message: "Fração não encontrada após ação." },
    });
  }
  const toast = await render("pages/reconciliation/_toast.vto", {
    toast: { type: toastType, message: toastMessage },
  });
  return partial + toast;
}

/**
 * Helper para respostas HTMX quando uma apólice (que pode ser a única)
 * é apagada. Re-fetch da unit e devolve OOB swap.
 */
export function renderUnitRowsAfterDeleteHtmx(
  unitId: string,
  toastMessage: string,
): Promise<string> {
  return renderUnitRowsHtmx(unitId, toastMessage, "success");
}

export async function rejectPolicy(policyId: string, body: { reason: string }): Promise<void> {
  await client.admin.rejectInsurancePolicy(policyId, body);
}

export async function deletePolicy(policyId: string): Promise<void> {
  await client.admin.deleteInsurancePolicy(policyId);
}

export async function sendReminder(unitId: string): Promise<{ sent: number; failed: number }> {
  const { data } = await client.admin.sendInsuranceReminder(unitId);
  return data;
}

/**
 * Versão HTMX do "lembrar": API + re-render OOB da linha inteira + toast.
 * Linha inteira (não só a célula) porque o envio põe a fração em cooldown
 * (badge + botão desactivado). Sem redirect - preserva filtros da URL.
 */
export async function sendReminderHtmx(
  unitId: string,
  form: Record<string, string | File>,
): Promise<string> {
  const { runHtmxAction } = await import("../routes/_htmx_action.ts");
  return await runHtmxAction<{ sent: number; failed: number }>(form, {
    apiCall: async () => {
      const { data } = await client.admin.sendInsuranceReminder(unitId);
      return data;
    },
    successPartial: async () => (await renderUnitRowsPartial(unitId)) ?? "",
    successMsg: ({ result }) =>
      `${result.sent} email(s) enviado(s)${
        result.failed > 0 ? `, ${result.failed} falharam` : ""
      }.`,
    errorPrefix: "Erro a enviar lembrete",
  });
}

export async function sendBulkReminders(): Promise<
  {
    unitsTargeted: number;
    evidenceTargeted?: number;
    sent: number;
    failed: number;
    skippedNoEmail?: string[];
  }
> {
  const { data } = await client.admin.sendInsuranceRemindersBulk();
  return data;
}

/** Grava a nota livre da administração no condomínio (topo do email de seguro). */
export async function saveNote(note: string | null) {
  await client.admin.updateMe({ insuranceReminderNote: note });
  return { ok: true };
}

export async function downloadPdf(policyId: string): Promise<Response> {
  const upstream = await client.admin.downloadStream(`/insurance/${policyId}/pdf`);
  return proxyDownload(upstream, {
    errorPrefix: "Erro a obter PDF",
    contentType: "application/pdf",
    disposition: `inline; filename="seguro-${policyId}.pdf"`,
  });
}

/**
 * Serve bytes de um attachment específico (multi-file UI). MIME e
 * disposição vêm do API (que serve com `safeAttachmentServeHeaders`).
 */
export async function serveAttachment(
  policyId: string,
  attachmentId: string,
): Promise<Response> {
  const upstream = await client.admin.downloadStream(
    `/insurance/${policyId}/attachments/${attachmentId}`,
  );
  return proxyDownload(upstream, { disposition: "inline" });
}
