import { render } from "$panel/render.ts";
import { currentCondominiumId } from "$panel/context.ts";
import { parseFormString } from "$panel/libs/form_parsing.ts";
import { proxyDownload } from "$panel/libs/download_proxy.ts";
import {
  canEditAgenda,
  canRecordMeeting,
  canSendConvocation,
  meetingDateReached,
} from "$shared/assembly/lifecycle.ts";
import { type ConvocationSnapshot } from "$shared/assembly/convocation_snapshot.ts";
import { client } from "$panel/client.ts";

export async function listAssemblies() {
  const assemblies = await client.admin.listAssemblies();

  return await render("pages/assembly/list.vto", {
    title: "Assembleias",
    section: "assembly",
    assemblies: assemblies.data,
  });
}

export async function getAssembly(assemblyId: string) {
  const [
    assembly,
    budgets,
    attachments,
    attendees,
    units,
    occupants,
    convocationRecipients,
  ] = await Promise.all([
    client.admin.getAssembly(assemblyId),
    client.admin.listBudgets(),
    client.admin.listAssemblyAttachments(assemblyId).catch(() => ({ data: [] })),
    client.admin.listAssemblyAttendees(assemblyId).catch(() => ({ data: [] })),
    client.admin.listUnits().catch(() => ({ data: [] })),
    client.admin.listOccupants().catch(() => ({ data: [] })),
    // Destinatários + cooldown. Fetch incondicional (roundtrip leve);
    // falha defensiva para [] não bloqueia o detalhe.
    client.admin.listAssemblyConvocationRecipients(assemblyId).catch(() => ({ data: [] })),
  ]);

  // `occupants` nested popula o select do modal de attendee com os
  // proprietários da fração (relationship_type='owner').
  type UnitWithOwners = {
    id: string;
    designation: string;
    permillage: string;
    occupants?: Array<{
      occupantId: string;
      relationshipType: string;
      endDate: string | null;
      occupant: { id: string; name: string };
    }>;
  };
  const unitList = units.data as UnitWithOwners[];

  // Map unitId → owners com ligação ativa (endDate null).
  const ownersByUnit: Record<string, Array<{ id: string; name: string }>> = {};
  for (const u of unitList) {
    ownersByUnit[u.id] = (u.occupants ?? [])
      .filter((uo) => uo.relationshipType === "owner" && !uo.endDate)
      .map((uo) => ({ id: uo.occupant.id, name: uo.occupant.name }));
  }
  const allAttendees = attendees.data as Array<Record<string, unknown>>;
  const round = ((assembly.data as { convocationRound?: string }).convocationRound ?? "first") as
    | "first"
    | "second";
  // Filtra presenças pela convocatória atual (cada ronda tem o seu set).
  // Sem `convocationRound` cai em "first" (= default BD).
  const attendeeList = allAttendees.filter(
    (a) => ((a.convocationRound as string | undefined) ?? "first") === round,
  );
  // Ordem natural pela designação (A, B, ..., AA, BB), igual ao resto da UI
  // (ADR 0014 / unitNaturalOrder na API). A API devolve por createdAt.
  const designationByUnitId = new Map<string, string>(
    unitList.map((u) => [u.id, u.designation]),
  );
  attendeeList.sort((a, b) => {
    const dA = designationByUnitId.get(String(a.unitId ?? "")) ?? "";
    const dB = designationByUnitId.get(String(b.unitId ?? "")) ?? "";
    if (dA.length !== dB.length) return dA.length - dB.length;
    return dA.localeCompare(dB);
  });
  // Quórum vem calculado da API (retrieve.ts é o dono único, regra Art. 1432.º).
  // O panel só renderiza; `round` acima ainda filtra a lista de presenças.
  const attendeeSummary = (assembly.data as {
    attendeeSummary?: {
      totalPermillage: number;
      totalBuildingPermillage: number;
      hasQuorum: boolean;
      reason: string;
    };
  }).attendeeSummary;

  // Set de unitIds já presentes (para filtrar combobox).
  const presentUnitIds = new Set<string>(
    attendeeList.map((a) => String(a.unitId ?? "")),
  );
  const availableUnits = unitList.filter((u) => !presentUnitIds.has(u.id));

  // Sinal "ainda não enviada" (convocada mas 0 envios); só em `scheduled`.
  const a = assembly.data as {
    status?: string;
    scheduledAt?: string | null;
    secondConvocationAt?: string | null;
    lastConvocation?: { snapshot: ConvocationSnapshot | null } | null;
  };
  const isScheduledStatus = a.status === "scheduled";
  const lastConvocation = a.lastConvocation ?? null;
  const convocationNeverSent = isScheduledStatus && !lastConvocation;

  return await render("pages/assembly/show.vto", {
    title: `Assembleia ${assembly.data.minutesNumber ?? ""}`,
    section: "assembly",
    target: assembly.data,
    budgets: budgets.data,
    attachments: attachments.data,
    attendees: attendeeList,
    units: unitList,
    availableUnits,
    ownersByUnit,
    occupants: occupants.data,
    convocationRecipients: convocationRecipients.data,
    convocationNeverSent,
    // Fase de registo (presenças, deliberar, ata, anexos) só abre a partir da
    // data da reunião; antes disso, em convocada, só a convocatória/envio.
    meetingReached: meetingDateReached(a.scheduledAt),
    quorum: {
      hasQuorum: attendeeSummary?.hasQuorum ?? false,
      reason: attendeeSummary?.reason ?? "",
      totalAttendeePermillage: attendeeSummary?.totalPermillage ?? 0,
      totalBuildingPermillage: attendeeSummary?.totalBuildingPermillage ?? 0,
      round,
    },
  });
}

// ─── Attachments handlers ─────────────────────────────────────────────────
export async function uploadAssemblyAttachment(assemblyId: string, file: File) {
  await client.admin.uploadAssemblyAttachment(assemblyId, file);
  return { ok: true };
}

export async function deleteAssemblyAttachment(assemblyId: string, attachmentId: string) {
  await client.admin.deleteAssemblyAttachment(assemblyId, attachmentId);
  return { ok: true };
}

/** Converte datetime-local HTML (`2099-08-15T19:00`) → ISO 8601 com offset. */
function toIso(dtLocal: string): string {
  if (!dtLocal) return "";
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(dtLocal)) return dtLocal;
  const d = new Date(dtLocal);
  return Number.isNaN(d.getTime()) ? dtLocal : d.toISOString();
}

export async function createAssembly(form: Record<string, string | File>) {
  // 2ª convocatória definida na abertura (Art. 1432.º nº 4 CC). Vazio = só 1ª.
  const secondRaw = parseFormString(form, "secondConvocationAt");
  const created = await client.admin.createAssembly({
    type: String(form.type ?? "ordinary"),
    scheduledAt: toIso(String(form.scheduledAt ?? "")),
    secondConvocationAt: secondRaw ? toIso(secondRaw) : null,
    location: String(form.location ?? "") || null,
    minutesNumber: String(form.minutesNumber ?? "") || null,
    notes: String(form.notes ?? "") || null,
  });
  return { created: created.data };
}

// Body de create/update de um ponto da ordem do dia. Form bipartido (ADR 0033):
// cada campo só viaja quando presente. Rascunho envia o enunciado anunciado
// (ordem/assunto/tipo); a deliberação (convocada + data) envia descrição +
// referência + votos. `approved` nunca é enviado (servidor deriva-o dos votos).
function buildAgendaItemBody(form: Record<string, string | File>): Record<string, unknown> {
  const body: Record<string, unknown> = {};

  // ─── Enunciado anunciado na convocatória (form de rascunho) ───────────────
  if (form.sequence !== undefined) body.sequence = Number(form.sequence);
  if (form.subject !== undefined) body.subject = String(form.subject);
  if (form.itemType !== undefined) body.itemType = String(form.itemType) || null;

  // ─── Registo da deliberação (descrição + referência, form de convocada) ───
  // refType/refId viajam juntos só do form de deliberação; só os pontos
  // "approve_budget" mostram a referência (os restantes submetem vazio = null).
  if (form.description !== undefined) body.description = String(form.description) || null;
  if (form.voteNote !== undefined) body.voteNote = String(form.voteNote) || null;
  if (form.refType !== undefined || form.refId !== undefined) {
    body.refType = parseFormString(form, "refType") || null;
    body.refId = parseFormString(form, "refId") || null;
  }

  // ─── Votos da deliberação (form de convocada) ─────────────────────────────
  // Per-fração: hidden `perm__<unitId>` existe sempre que há presenças (mesmo
  // sem voto) - serve de discriminador. Replace-all: lista vazia volta a pendente.
  const hasPerUnit = Object.keys(form).some((k) => k.startsWith("perm__"));
  if (hasPerUnit) {
    const votes: Array<{ unitId: string; vote: string; permillageApplied: number }> = [];
    for (const [key, value] of Object.entries(form)) {
      const m = key.match(/^vote__(.+)$/);
      if (!m) continue;
      const voteValue = String(value ?? "").trim();
      if (!voteValue) continue; // sem voto desta fração
      const permillage = Number(parseFormString(form, `perm__${m[1]}`).replace(",", "."));
      if (!Number.isFinite(permillage) || permillage <= 0) continue;
      votes.push({ unitId: m[1], vote: voteValue, permillageApplied: permillage });
    }
    body.votes = votes;
  } else if (
    form.votesInFavor !== undefined || form.votesAgainst !== undefined ||
    form.votesAbstain !== undefined
  ) {
    const num = (k: string) => {
      const raw = parseFormString(form, k);
      return raw ? Number(raw.replace(",", ".")) : null;
    };
    body.votesInFavor = num("votesInFavor");
    body.votesAgainst = num("votesAgainst");
    body.votesAbstain = num("votesAbstain");
  }

  return body;
}

// ─── Attendees + Assinatura de Ata ─────────────────────────────────────────

export async function addAttendee(
  assemblyId: string,
  form: Record<string, string | File>,
) {
  const isProxy = String(form.isProxy ?? "") === "1";
  // Portador da procuração: interno (occupant registado) OU externo (fora do
  // sistema). Validação XOR vive no zod API + DB CHECK.
  const holderKind = String(form.proxyHolderKind ?? "internal");
  const proxyHolderOccupantId = isProxy && holderKind === "internal"
    ? parseFormString(form, "proxyHolderOccupantId", { emptyAsNull: true })
    : null;
  const proxyHolderExternalName = isProxy && holderKind === "external"
    ? parseFormString(form, "proxyHolderExternalName", { emptyAsNull: true })
    : null;

  await client.admin.createAssemblyAttendee(assemblyId, {
    unitId: parseFormString(form, "unitId"),
    occupantId: parseFormString(form, "occupantId"),
    permillageAtMeeting: Number(String(form.permillageAtMeeting ?? "").replace(",", ".")),
    isProxy,
    proxyHolderOccupantId,
    proxyHolderExternalName,
    notes: String(form.notes ?? "") || null,
  });
  return { ok: true };
}

export async function deleteAttendee(assemblyId: string, attendeeId: string) {
  await client.admin.deleteAssemblyAttendee(assemblyId, attendeeId);
  return { ok: true };
}

/**
 * Assina a ata (Art. 1434.º CC): presidente + secretário + data, em conjunto
 * (DB CHECK). Data é DATE, input `type="date"` dá YYYY-MM-DD.
 */
export async function signMinutes(
  assemblyId: string,
  form: Record<string, string | File>,
) {
  const signedAt = parseFormString(form, "minutesSignedAt");
  if (!signedAt) {
    throw new Error("Data da assinatura obrigatória.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(signedAt)) {
    throw new Error(`Data da assinatura inválida: "${signedAt}". Formato YYYY-MM-DD.`);
  }
  await client.admin.updateAssembly(assemblyId, {
    presidentOccupantId: parseFormString(form, "presidentOccupantId", { emptyAsNull: true }),
    secretaryOccupantId: parseFormString(form, "secretaryOccupantId", { emptyAsNull: true }),
    minutesSignedAt: signedAt,
  });
  return { ok: true };
}

export async function addAgendaItem(
  assemblyId: string,
  form: Record<string, string | File>,
) {
  await client.admin.createAssemblyAgendaItem(assemblyId, buildAgendaItemBody(form));
  return { ok: true };
}

export async function updateAgendaItem(
  assemblyId: string,
  agendaItemId: string,
  form: Record<string, string | File>,
) {
  await client.admin.updateAssemblyAgendaItem(assemblyId, agendaItemId, buildAgendaItemBody(form));
  return { ok: true };
}

export async function deleteAgendaItem(
  assemblyId: string,
  agendaItemId: string,
) {
  await client.admin.deleteAssemblyAgendaItem(assemblyId, agendaItemId);
  return { ok: true };
}

export async function updateAssemblyStatus(
  assemblyId: string,
  form: Record<string, string | File>,
) {
  const status = String(form.status ?? "held");
  const heldAtRaw = form.heldAt ? String(form.heldAt) : null;
  await client.admin.updateAssembly(assemblyId, {
    status,
    heldAt: heldAtRaw ? toIso(heldAtRaw) : status === "held" ? new Date().toISOString() : null,
  });
  return { ok: true };
}

/**
 * Cancela a assembleia (-> `cancelled`, estado terminal, ver lifecycle.ts).
 * Só em rascunho/convocada; a API bloqueia held/cancelled (409 ASSEMBLY_LOCKED).
 * Ordem do dia, presenças e votos mantêm-se como histórico (ADR 0025 / 0013).
 */
export async function cancelAssembly(assemblyId: string) {
  await client.admin.updateAssembly(assemblyId, { status: "cancelled" });
  return { ok: true };
}

/**
 * Alterna a convocatória (1ª ↔ 2ª) sem tocar nos demais campos. 1ª exige >50%
 * permilagem; sem quórum passa-se à 2ª (qualquer permilagem >0, Art. 1432.º nº 4).
 */
export async function updateAssemblyConvocationRound(
  assemblyId: string,
  round: "first" | "second",
) {
  await client.admin.updateAssembly(assemblyId, { convocationRound: round });
  return { ok: true };
}

/**
 * Envia a convocatória a todos os destinatários elegíveis (bulk).
 * A API bloqueia em `draft` (422 CONVOCATION_DRAFT) e salta cooldown.
 * Devolve contagens para o caller compor o flash.
 */
export async function sendConvocation(
  assemblyId: string,
): Promise<{
  totalRecipients: number;
  sent: number;
  failed: number;
  noEmail: number;
  skippedCooldown: number;
}> {
  const { data } = await client.admin.sendAssemblyConvocation(assemblyId);
  return {
    totalRecipients: data.totalRecipients,
    sent: data.sent,
    failed: data.failed,
    noEmail: data.noEmail,
    skippedCooldown: data.skippedCooldown,
  };
}

/**
 * Reenvia a convocatória a uma pessoa numa fração (ADR 0034). A API impõe
 * cooldown de 24h por (pessoa, fração) (422 COOLDOWN_ACTIVE) e bloqueia em
 * `draft` (422 CONVOCATION_DRAFT).
 */
export async function resendConvocation(
  assemblyId: string,
  occupantId: string,
  unitId: string,
): Promise<{ sent: number; failed: number }> {
  const { data } = await client.admin.resendAssemblyConvocation(assemblyId, occupantId, unitId);
  return { sent: data.sent, failed: data.failed };
}

/**
 * Pré-visualização (read-only) do email da convocatória de um destinatário: assunto
 * + HTML para o `<iframe srcdoc>` do modal (mesmo padrão do billing-reminders).
 */
export async function previewConvocationEmail(
  assemblyId: string,
  occupantId: string,
  unitId: string,
): Promise<{ subject: string; html: string }> {
  const { data } = await client.admin.previewAssemblyConvocation(assemblyId, occupantId, unitId);
  return { subject: data.subject, html: data.html };
}

/**
 * Render parcial do bloco "Destinatários da convocatória" (`#convocation-recipients`),
 * devolvido pelo POST de reenvio quando HX-Request. outerHTML swap + toast OOB
 * (ADR 0026). Markup tem de estar sincronizado com o include no `show.vto`.
 */
export async function renderConvocationRecipients(
  assemblyId: string,
  toast?: { message: string; type?: "success" | "danger" },
): Promise<string> {
  const [{ data: assembly }, recipientsRes] = await Promise.all([
    client.admin.getAssembly(assemblyId),
    client.admin.listAssemblyConvocationRecipients(assemblyId).catch(() => ({ data: [] })),
  ]);
  // canSend = fora de rascunho E antes da data da reunião (depois a API recusa
  // com CONVOCATION_MEETING_PASSED).
  const a = assembly as { status?: string; scheduledAt?: string | null };
  const canSend = canSendConvocation(a.status) && !meetingDateReached(a.scheduledAt);
  return await render("pages/assembly/_convocation_recipients.vto", {
    target: assembly,
    convocationRecipients: recipientsRes.data,
    canSend,
    currentCondominiumId: currentCondominiumId(),
    toast: toast ?? null,
  });
}

/**
 * Edita os dados da convocatória (tipo, datas, local, nº ata, textos, notas).
 * Editáveis só em `draft`: a API trava-os com 409 CONVOCATION_LOCKED depois.
 */
export async function updateAssemblyData(
  assemblyId: string,
  form: Record<string, string | File>,
) {
  const round = parseFormString(form, "convocationRound");
  const secondRaw = parseFormString(form, "secondConvocationAt");
  await client.admin.updateAssembly(assemblyId, {
    type: String(form.type ?? "ordinary"),
    scheduledAt: toIso(String(form.scheduledAt ?? "")),
    secondConvocationAt: secondRaw ? toIso(secondRaw) : null,
    location: String(form.location ?? "") || null,
    minutesNumber: String(form.minutesNumber ?? "") || null,
    convocationIntro: parseFormString(form, "convocationIntro", { emptyAsNull: true }),
    convocationFooter: parseFormString(form, "convocationFooter", { emptyAsNull: true }),
    notes: String(form.notes ?? "") || null,
    ...(round === "first" || round === "second" ? { convocationRound: round } : {}),
  });
  return { ok: true };
}

/**
 * Guarda o texto narrativo de uma seção da ata (intro ou encerramento);
 * `section` distingue a coluna. Devolve `{ section, label }`
 * para o caller decidir o toast.
 */
export async function updateMinuteSection(
  assemblyId: string,
  form: Record<string, string | File>,
): Promise<{ section: "intro" | "conclusion"; label: string }> {
  const section = parseFormString(form, "section");
  if (section !== "intro" && section !== "conclusion") {
    throw new Error(`Seção inválida: "${section}". Aceito "intro" ou "conclusion".`);
  }
  const text = parseFormString(form, "text", { emptyAsNull: true });
  const field = section === "intro" ? "introduction" : "conclusion";
  await client.admin.updateAssembly(assemblyId, { [field]: text });
  return { section, label: section === "intro" ? "Abertura" : "Encerramento" };
}

/**
 * Render parcial do POST /minute-section quando HX-Request: outerHTML swap do
 * `<tbody id="minute-section-tbody">` + toast OOB.
 */
export async function renderMinuteSectionRows(
  assemblyId: string,
  toast?: { message: string },
): Promise<string> {
  const { data: assembly } = await client.admin.getAssembly(assemblyId);
  // Texto da ata: editável convocada E a partir da data da reunião (mesma
  // regra do show.vto).
  const a = assembly as { status?: string; scheduledAt?: string | null };
  const canEdit = canRecordMeeting(a.status) && meetingDateReached(a.scheduledAt);
  return await render("pages/assembly/_minute_section_rows.vto", {
    target: assembly,
    canEdit,
    toast: toast ?? null,
  });
}

/**
 * Render parcial dos POST de pontos da ordem do dia (create/update/delete)
 * quando HX-Request: outerHTML swap do `<tbody id="agenda-tbody">` + toast OOB.
 * Carrega budgets para o template resolver os links "Ver orçamento".
 */
export async function renderAgendaRows(
  assemblyId: string,
  action?: "added" | "updated" | "removed",
): Promise<string> {
  const [{ data: assembly }, { data: budgets }] = await Promise.all([
    client.admin.getAssembly(assemblyId),
    client.admin.listBudgets(),
  ]);
  // Pontos editam-se em rascunho (canEditAgenda); deliberar só convocada E a
  // partir da data da reunião. Mesmos gates do show.vto.
  const a = assembly as { status?: string; scheduledAt?: string | null };
  const status = a.status;
  const canRecord = canRecordMeeting(status) && meetingDateReached(a.scheduledAt);
  return await render("pages/assembly/_agenda_tbody.vto", {
    target: assembly,
    canEdit: canEditAgenda(status) || canRecord,
    canEditAgenda: canEditAgenda(status),
    budgets,
    currentCondominiumId: currentCondominiumId(),
    toast: action ? { message: agendaToastMessage(status, action) } : null,
  });
}

/**
 * Toast das mutações de pontos: rascunho mexe na ordem do dia; convocada
 * regista a deliberação sobre cada ponto.
 */
function agendaToastMessage(
  status: string | undefined,
  action: "added" | "updated" | "removed",
): string {
  if (action === "added") return "Ponto adicionado à ordem do dia";
  if (action === "removed") return "Ponto removido da ordem do dia";
  return status === "scheduled" ? "Deliberação registada" : "Ponto atualizado";
}

/**
 * Render parcial do bloco "Assinatura da Ata" (card + modal de edição com
 * `hx-swap-oob` no `<dialog>`). Devolvido pelo POST /sign-minutes em HX-Request.
 */
export async function renderSignatureBlock(
  assemblyId: string,
  toast?: { message: string },
): Promise<string> {
  const [{ data: assembly }, { data: occupants }] = await Promise.all([
    client.admin.getAssembly(assemblyId),
    client.admin.listOccupants(),
  ]);
  // Assinatura da ata: editável convocada E a partir da data da reunião.
  const a = assembly as { status?: string; scheduledAt?: string | null };
  const canEdit = canRecordMeeting(a.status) && meetingDateReached(a.scheduledAt);
  return await render("pages/assembly/_signature_block.vto", {
    target: assembly,
    canEdit,
    occupants,
    currentCondominiumId: currentCondominiumId(),
    toast: toast ?? null,
  });
}

/**
 * Proxy do PDF da ata: faz fetch ao endpoint API (gera on-the-fly) e devolve
 * os bytes. Não é arquivado em S3 - cada chamada re-gera para refletir
 * deliberações/presenças/texto recentes.
 */
export async function proxyAssemblyMinutesPdf(assemblyId: string): Promise<Response> {
  const upstream = await client.admin.downloadStream(`/assemblies/${assemblyId}/minutes.pdf`);
  return proxyDownload(upstream, {
    errorPrefix: "Erro ao gerar PDF da ata",
    contentType: "application/pdf",
    fallbackDisposition: "attachment",
    cacheControl: "no-store",
  });
}

/**
 * Proxy genérico de um PDF da assembleia gerado on-the-fly (read-only). Usado
 * pelas pré-visualizações de convocatória e procuração; cada chamada re-gera.
 */
async function proxyAssemblyPdf(
  assemblyId: string,
  pdfPath: "convocation.pdf" | "proxy.pdf" | "attendance-sheet.pdf",
  errLabel: string,
): Promise<Response> {
  const upstream = await client.admin.downloadStream(`/assemblies/${assemblyId}/${pdfPath}`);
  return proxyDownload(upstream, {
    errorPrefix: `Erro ao gerar PDF d${errLabel}`,
    contentType: "application/pdf",
    cacheControl: "no-store",
  });
}

/** Pré-visualização (read-only) do PDF da convocatória. */
export function proxyAssemblyConvocationPdf(assemblyId: string): Promise<Response> {
  return proxyAssemblyPdf(assemblyId, "convocation.pdf", "a convocatória");
}

/** Pré-visualização (read-only) do modelo de procuração (dados de amostra). */
export function proxyAssemblyProxyPdf(assemblyId: string): Promise<Response> {
  return proxyAssemblyPdf(assemblyId, "proxy.pdf", "o modelo de procuração");
}

/** Pré-visualização (read-only) da folha de presenças em branco (1 linha por fração). */
export function proxyAssemblyAttendanceSheetPdf(assemblyId: string): Promise<Response> {
  return proxyAssemblyPdf(assemblyId, "attendance-sheet.pdf", "a folha de presenças");
}
