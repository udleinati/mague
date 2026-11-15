// Controller do módulo de seguros (portal do condómino). client.portal.*
// atrás de requirePortalAccessToUnit; cada caller vê só a sua fração.
// O estado da fração vem do endpoint `/insurance/status` (agregado do ADR 0017,
// o mesmo do admin) - nunca se recalcula aqui.

import { render } from "$panel/render.ts";
import { currentPortalUnitId } from "$panel/context.ts";
import { proxyDownload } from "$panel/libs/download_proxy.ts";
import { insurancePresumedPending } from "$panel/libs/insurance_status.ts";
import { addOneYear } from "$shared/insurance/policy_status.ts";
import { parseEurosToCents } from "$shared/money/parse_euros.ts";
import { client } from "$panel/client.ts";

function unitId(): string {
  const id = currentPortalUnitId();
  if (!id) throw new Error("portalUnitId não definido - middleware deveria ter bloqueado.");
  return id;
}

interface Policy {
  id: string;
  unitId: string;
  status: string; // 'active' | 'pending_review' | 'rejected' | 'superseded'
  /** Estado computado pela API; os templates usam este, não o `status` cru. */
  kind: string;
  /** Gates de ação já resolvidos pela API (ADR 0040). */
  can: Record<string, boolean>;
  /** Linhagem (ADR 0040): o id do predecessor e a sua referência já resolvida. */
  renewedFromId?: string | null;
  renewedFrom?: {
    id: string;
    policyNumber: string | null;
    validFrom: string | null;
    validTo: string | null;
  } | null;
  validFrom?: string | null;
  validTo?: string | null;
  insurer?: string | null;
  policyNumber?: string | null;
  rejectedReason?: string | null;
  confirmedAt?: string | null;
  createdAt?: string;
  presumedAt?: string | null;
  supersededAt?: string | null;
  coverageAmountCents?: number | null;
}

export interface RenewalChain {
  /** A vigência mais recente do ramo - é a que o histórico mostra em destaque. */
  policy: Policy;
  /** Predecessores, da mais recente para a mais antiga. */
  previous: Policy[];
}

/**
 * Agrupa a cadeia de renovações. Sem isto, o histórico listava a mesma cobertura
 * uma vez por renovação, em linhas soltas, sem dizer que eram a mesma apólice a
 * continuar. `seen` fecha a porta a um ciclo em `renewed_from_id` (só possível
 * por SQL manual) transformar isto num loop infinito.
 */
export function groupByRenewalChain(policies: Policy[]): RenewalChain[] {
  const byId = new Map(policies.map((p) => [p.id, p]));
  const hasSuccessor = new Set(
    policies.map((p) => p.renewedFromId).filter((id): id is string => !!id && byId.has(id)),
  );
  return policies
    .filter((p) => !hasSuccessor.has(p.id))
    .map((policy) => {
      const previous: Policy[] = [];
      const seen = new Set<string>([policy.id]);
      let cursor = policy.renewedFromId ? byId.get(policy.renewedFromId) : undefined;
      while (cursor && !seen.has(cursor.id)) {
        seen.add(cursor.id);
        previous.push(cursor);
        cursor = cursor.renewedFromId ? byId.get(cursor.renewedFromId) : undefined;
      }
      return { policy, previous };
    });
}

async function commonContext() {
  const [{ data: condominium }, { data: unit }] = await Promise.all([
    client.portal.getCondominium(),
    client.portal.getUnit(unitId()),
  ]);
  return { condominium, unit };
}

// Flash vem do layout via globalFlash (ADR 0012); pages do portal não recebem `flash`.
export async function listPage(): Promise<string> {
  const myUid = unitId();
  const [common, { data: rawPolicies }, { data: unitStatus }] = await Promise.all([
    commonContext(),
    client.portal.listInsurancePolicies(myUid),
    client.portal.getInsuranceStatus(myUid),
  ]);
  const policies = rawPolicies as unknown as Policy[];
  const status = { unit: { id: myUid }, status: unitStatus.status };

  return await render("pages/portal/insurance/index.vto", {
    title: "Seguro",
    section: "insurance",
    ...common,
    status,
    chains: groupByRenewalChain(policies),
  });
}

export async function uploadPage(): Promise<string> {
  const common = await commonContext();
  return await render("pages/portal/insurance/upload.vto", {
    title: "Submeter apólice",
    section: "insurance",
    ...common,
  });
}

export async function submitUpload(files: File[]): Promise<{ policyId: string }> {
  // Multi-file sob `file`: primeiro = principal (OCR-eligible), resto = anexos.
  const { data } = await client.portal.uploadInsurancePolicy(
    unitId(),
    files,
    files[0]?.name || "policy.pdf",
  );
  return { policyId: String((data as { id?: string }).id ?? "") };
}

export async function confirmPage(policyId: string): Promise<string> {
  const [common, { data: policy }, { data: attachments }] = await Promise.all([
    commonContext(),
    client.portal.getInsurancePolicy(unitId(), policyId),
    client.portal.listInsurancePolicyAttachments(unitId(), policyId),
  ]);
  return await render("pages/portal/insurance/confirm.vto", {
    title: "Confirmar apólice",
    section: "insurance",
    ...common,
    policy,
    attachments,
  });
}

// Read-only, para apólices fora de pending_review (active/superseded/rejected).
// pending_review usa confirmPage (form de confirmação).
export async function viewPage(policyId: string): Promise<string> {
  const [common, { data: policy }, { data: attachments }] = await Promise.all([
    commonContext(),
    client.portal.getInsurancePolicy(unitId(), policyId),
    client.portal.listInsurancePolicyAttachments(unitId(), policyId),
  ]);
  return await render("pages/portal/insurance/show.vto", {
    title: "Detalhes da apólice",
    section: "insurance",
    ...common,
    policy,
    attachments,
    // Mesma regra do `presumedEvidenceGap`; o template recompunha-a com
    // `kind !== "superseded"` e mostrava o aviso numa rejeitada.
    presumedPending: insurancePresumedPending(
      policy as { status?: string; presumedAt?: string | null },
      attachments.length,
    ),
  });
}

/**
 * Formulário de renovação da fração: os dados chegam já preenchidos com os do
 * predecessor e as datas com +1 ano. `renewFrom`/`renewTo` são sugestão - o que
 * fica registado é o que o condómino submeter.
 */
export async function renewPage(policyId: string): Promise<string> {
  const [common, { data: policy }] = await Promise.all([
    commonContext(),
    client.portal.getInsurancePolicy(unitId(), policyId),
  ]);
  const renewFrom = String((policy as { validTo?: string }).validTo ?? "");
  return await render("pages/portal/insurance/renew.vto", {
    title: "Renovar apólice",
    section: "insurance",
    ...common,
    policy,
    renewFrom,
    renewTo: renewFrom ? addOneYear(renewFrom) : "",
  });
}

export async function submitRenewal(policyId: string, file: File, body: {
  validFrom: string;
  validTo: string;
  policyNumber?: string;
  insurer?: string;
  coverageAmountEuros?: string;
}): Promise<void> {
  await client.portal.renewInsurancePolicy(unitId(), policyId, file, {
    validFrom: body.validFrom,
    validTo: body.validTo,
    policyNumber: body.policyNumber || undefined,
    insurer: body.insurer || undefined,
    coverageAmountCents: body.coverageAmountEuros === undefined
      ? undefined
      : String(parseEurosToCents(body.coverageAmountEuros) ?? ""),
  });
}

export async function submitConfirm(policyId: string, body: {
  validFrom: string;
  validTo: string;
  policyNumber: string;
  insurer: string;
  coverageAmountCents?: number | null;
}): Promise<void> {
  await client.portal.confirmInsurancePolicy(unitId(), policyId, body);
}

export async function addAttachment(policyId: string, file: File): Promise<void> {
  await client.portal.addInsurancePolicyAttachment(unitId(), policyId, file);
}

export async function deleteAttachment(policyId: string, attachmentId: string): Promise<void> {
  await client.portal.deleteInsurancePolicyAttachment(unitId(), policyId, attachmentId);
}

export async function serveAttachment(
  policyId: string,
  attachmentId: string,
): Promise<Response> {
  const upstream = await client.portal.downloadStream(
    `/units/${unitId()}/insurance/${policyId}/attachments/${attachmentId}`,
  );
  return proxyDownload(upstream, { disposition: "inline" });
}

export async function deletePolicy(policyId: string): Promise<void> {
  await client.portal.deleteInsurancePolicy(unitId(), policyId);
}

export async function downloadPdf(policyId: string): Promise<Response> {
  const upstream = await client.portal.downloadStream(
    `/units/${unitId()}/insurance/${policyId}/pdf`,
  );
  return proxyDownload(upstream, {
    contentType: "application/pdf",
    disposition: "inline",
  });
}
