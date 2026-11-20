// Templates HTML dos emails como inline strings (sem framework).
// Estilos 100% inline porque Gmail strippa `<style>` blocks silenciosamente;
// é a única estratégia robusta cross-client. Constantes `S_*` são as folhas
// partilhadas - editar aqui muda a paleta inteira. Templates recebem os dados
// já formatados (amount como string PT, datas) e devolvem HTML.

import { formatMoney } from "$api/libs/templates/render.ts";

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!),
  );
}

// ─── Estilos inline partilhados ──────────────────────────────────────────
const S_CONTAINER = "font:14px/1.6 Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;" +
  "padding:24px;color:#333";
const S_HEADER =
  "text-align:center;margin:0 0 24px;padding-bottom:16px;border-bottom:2px solid #222";
const S_HEADER_LABEL = "font-size:11px;color:#888;margin-bottom:6px";
const S_HEADER_NAME =
  "font-size:22px;font-weight:bold;color:#111;font-family:Helvetica,Arial,sans-serif";
const S_P = "margin:0 0 16px;font-family:Helvetica,Arial,sans-serif";
const S_INTRO = "margin:0 0 16px;font-size:15px;color:#222;font-family:Helvetica,Arial,sans-serif";
const S_CTA_WRAP = "text-align:center;margin:24px 0";
const S_CTA = "display:inline-block;background:#111;color:#fff;padding:12px 28px;" +
  "text-decoration:none;font-weight:bold;font-family:Helvetica,Arial,sans-serif;" +
  "font-size:14px";
const S_FOOTER = "font-size:12px;color:#999;border-top:1px solid #eee;padding-top:14px;" +
  "margin:24px 0 0;font-family:Helvetica,Arial,sans-serif";
const S_LINK_PLAIN = "color:#888;word-break:break-all";

// Envolve o body no container. `wide` eleva o max-width 560 -> 720 px para
// emails com tabelas largas (5+ colunas) onde 560 px partiria os valores.
function wrapTemplate(body: string, opts: { wide?: boolean } = {}): string {
  const container = opts.wide
    ? S_CONTAINER.replace("max-width:560px", "max-width:720px")
    : S_CONTAINER;
  return `<div style="${container}">${body}</div>`;
}

/** Cabeçalho partilhado dos emails que falam em nome de um condomínio. */
function condominiumHeader(
  designationType: "building" | "condominium",
  condominiumName: string,
): string {
  const label = designationType === "building" ? "EDIFÍCIO" : "CONDOMÍNIO";
  return `<div style="${S_HEADER}">` +
    `<div style="${S_HEADER_LABEL}">${escapeHtml(label)}</div>` +
    `<div style="${S_HEADER_NAME}">${escapeHtml(condominiumName)}</div>` +
    `</div>`;
}

/** Cabeçalho dos emails de sistema (não falam por nenhum condo). */
function systemHeader(label: string, title: string): string {
  return `<div style="${S_HEADER}">` +
    `<div style="${S_HEADER_LABEL}">${escapeHtml(label)}</div>` +
    `<div style="${S_HEADER_NAME}">${escapeHtml(title)}</div>` +
    `</div>`;
}

/** CTA preto principal. */
function primaryButton(href: string, label: string): string {
  return `<div style="${S_CTA_WRAP}">` +
    `<a href="${escapeHtml(href)}" style="${S_CTA}">${escapeHtml(label)}</a>` +
    `</div>`;
}

/** Rodapé com separador + link direto fallback. */
function footerWithLink(
  intro: string,
  href: string,
): string {
  return `<p style="${S_FOOTER}">${intro}<br>` +
    `<span style="${S_LINK_PLAIN}">${escapeHtml(href)}</span></p>`;
}

/**
 * Email de convite para o portal - primeiro acesso do condómino. O link
 * `acceptUrl` aponta para `/accept-invite?token=…`.
 */
export function inviteEmailHtml(params: {
  occupantName: string;
  condominiumName: string;
  designationType: "building" | "condominium";
  acceptUrl: string;
  /** Validade do token (string human-readable, ex: "24 horas"). */
  ttl: string;
}): string {
  return wrapTemplate(
    condominiumHeader(params.designationType, params.condominiumName) +
      `<p style="${S_INTRO}">Caro(a) <strong>${escapeHtml(params.occupantName)}</strong>,</p>` +
      `<p style="${S_P}">Foi convidado(a) a aceder ao portal do condomínio para consultar a sua conta corrente, recibos, comunicações e demais informação relativa à sua fração.</p>` +
      `<p style="${S_P}">Para ativar o acesso, defina a sua password no botão abaixo.</p>` +
      primaryButton(params.acceptUrl, "Definir password e entrar") +
      `<p style="${S_P}">Os melhores cumprimentos,<br><strong>A Administração</strong></p>` +
      footerWithLink(
        `Este link é válido por ${escapeHtml(params.ttl)}. ` +
          `Caso não tenha pedido este convite, ignore este aviso - o link expira sozinho.`,
        params.acceptUrl,
      ),
  );
}

/**
 * Email de reset de password. Email de sistema - não fala em nome de
 * nenhum condomínio em particular; o user pode ser super ou estar em
 * vários condos.
 */
export function resetPasswordEmailHtml(params: {
  userName: string;
  resetUrl: string;
  ttl: string;
}): string {
  return wrapTemplate(
    systemHeader("Portal do Condomínio", "Reposição de Password") +
      `<p style="${S_INTRO}">Caro(a) <strong>${escapeHtml(params.userName)}</strong>,</p>` +
      `<p style="${S_P}">Recebemos um pedido para alterar a sua password. Carregue no botão abaixo para definir uma nova.</p>` +
      primaryButton(params.resetUrl, "Definir nova password") +
      footerWithLink(
        `Este link é válido por ${escapeHtml(params.ttl)}. ` +
          `Caso não tenha pedido este reset, ignore.`,
        params.resetUrl,
      ),
  );
}

/**
 * Email enviado quando um Recibo é emitido. Inclui PDF anexo + link
 * "Consultar no portal" (que via auto-invite pode ser `/accept-invite?next=…`).
 * Sem `receiptUrl` (destinatário manual, sem acesso ao portal) só segue o PDF.
 */
export function receiptIssuedEmailHtml(params: {
  recipientName: string;
  condominiumName: string;
  designationType: "building" | "condominium";
  /** Designação da fração (ex: "1ºA"). */
  unitDesignation: string;
  /** Identificador secundário (ex: matrícula). Pode ser null. */
  unitIdentifier: string | null;
  receiptNumber: string;
  /** Já formatado, ex: "210,00 €". */
  amount: string;
  /** Já formatado, ex: "15/05/2026". */
  paymentDate: string;
  receiptUrl?: string;
}): string {
  const unitLabel = params.unitIdentifier
    ? `${escapeHtml(params.unitDesignation)} <span style="color:#6b7280;font-weight:normal">· ${
      escapeHtml(params.unitIdentifier)
    }</span>`
    : escapeHtml(params.unitDesignation);
  return wrapTemplate(
    condominiumHeader(params.designationType, params.condominiumName) +
      `<p style="${S_INTRO}">Caro(a) <strong>${escapeHtml(params.recipientName)}</strong>,</p>` +
      `<p style="${S_P}">Confirmamos a receção do seu pagamento de <strong style="white-space:nowrap;">${
        escapeHtml(params.amount)
      }</strong> em <span style="white-space:nowrap;">${
        escapeHtml(params.paymentDate)
      }</span> relativo à fração <strong>${unitLabel}</strong>.</p>` +
      `<p style="${S_P}">O recibo n.º <strong>${
        escapeHtml(params.receiptNumber)
      }</strong> segue em <strong>anexo</strong> a este email.${
        params.receiptUrl ? " Também pode ser consultado em qualquer altura no portal." : ""
      }</p>` +
      (params.receiptUrl ? primaryButton(params.receiptUrl, "Consultar no portal") : "") +
      `<p style="${S_P}">Os melhores cumprimentos,<br><strong>A Administração</strong></p>` +
      (params.receiptUrl
        ? footerWithLink(`Caso o botão não funcione, copie o link direto:`, params.receiptUrl)
        : ""),
  );
}

/**
 * Email de cobrança de Insurance: enviado quando uma fração não tem
 * apólice válida (vencida, expira <30d ou nunca submetida).
 */
export function insuranceReminderEmailHtml(params: {
  recipientName: string;
  condominiumName: string;
  designationType: "building" | "condominium";
  unitDesignation: string;
  portalUrl: string;
  /** Nota livre da administração mostrada no topo. Vazio/ausente = sem caixa. */
  adminNote?: string;
}): string {
  // Mesma caixa destacada do lembrete de cobrança (billingReminderEmailHtml).
  const noteText = params.adminNote?.trim();
  const adminNoteBlock = noteText
    ? `<div style="margin:20px 0;padding:14px 16px;background:#eff6ff;border-left:4px solid #2563eb;border-radius:6px;">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#1e40af;font-weight:700;">Nota da administração</div>
        <div style="margin-top:6px;font-size:14px;color:#1f2937;line-height:1.5;">${
      escapeHtml(noteText).replace(/\n/g, "<br>")
    }</div>
      </div>`
    : "";
  return wrapTemplate(
    condominiumHeader(params.designationType, params.condominiumName) +
      `<p style="${S_INTRO}">Caro(a) <strong>${escapeHtml(params.recipientName)}</strong>,</p>` +
      adminNoteBlock +
      `<p style="${S_P}">Verificámos que a fração <strong>${
        escapeHtml(params.unitDesignation)
      }</strong> não tem atualmente apólice de seguro válida registada nos nossos serviços.</p>` +
      `<p style="${S_P}">Solicitamos que submeta o PDF da apólice no portal do condomínio. Basta carregar o ficheiro - o sistema extrai os dados automaticamente.</p>` +
      primaryButton(params.portalUrl, "Submeter apólice") +
      `<p style="${S_P}">Os melhores cumprimentos,<br><strong>A Administração</strong></p>` +
      footerWithLink(`Caso já tenha submetido recentemente, ignore este aviso.`, params.portalUrl),
  );
}

/**
 * Email de renovação de seguro: enviado quando o admin renova uma apólice
 * (nova vigência presumida, sem evidência). Pede ao condómino o recibo/
 * comprovativo da renovação anual. Reusa a infra de lembretes (recipients,
 * cooldown e nota da administração) com copy próprio.
 */
export function insuranceRenewalEvidenceEmailHtml(params: {
  recipientName: string;
  condominiumName: string;
  designationType: "building" | "condominium";
  unitDesignation: string;
  portalUrl: string;
  /** Nota livre da administração mostrada no topo. Vazio/ausente = sem caixa. */
  adminNote?: string;
}): string {
  const noteText = params.adminNote?.trim();
  const adminNoteBlock = noteText
    ? `<div style="margin:20px 0;padding:14px 16px;background:#eff6ff;border-left:4px solid #2563eb;border-radius:6px;">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#1e40af;font-weight:700;">Nota da administração</div>
        <div style="margin-top:6px;font-size:14px;color:#1f2937;line-height:1.5;">${
      escapeHtml(noteText).replace(/\n/g, "<br>")
    }</div>
      </div>`
    : "";
  return wrapTemplate(
    condominiumHeader(params.designationType, params.condominiumName) +
      `<p style="${S_INTRO}">Caro(a) <strong>${escapeHtml(params.recipientName)}</strong>,</p>` +
      adminNoteBlock +
      `<p style="${S_P}">A apólice de seguro da fração <strong>${
        escapeHtml(params.unitDesignation)
      }</strong> foi renovada para um novo período de vigência.</p>` +
      `<p style="${S_P}">Para mantermos o registo atualizado, agradecemos que submeta no portal o recibo ou comprovativo da renovação anual.</p>` +
      primaryButton(params.portalUrl, "Enviar comprovativo") +
      `<p style="${S_P}">Os melhores cumprimentos,<br><strong>A Administração</strong></p>` +
      footerWithLink(`Caso já tenha enviado o comprovativo, ignore este aviso.`, params.portalUrl),
  );
}

/**
 * Aviso à fração de que a administração registou a apólice a partir do
 * documento que lhe foi entregue fora do portal (ADR 0016).
 * Único dos emails de seguro que não pede nada: a fração não submeteu nem
 * confirmou este registo, e saber dele é o que a deixa contestá-lo.
 */
export function insuranceAdminEvidenceEmailHtml(params: {
  recipientName: string;
  condominiumName: string;
  designationType: "building" | "condominium";
  unitDesignation: string;
  /** Datas de vigência já formatadas dd/mm/yyyy pelo caller. */
  validFrom: string;
  validTo: string;
  /** Renovação de uma apólice anterior vs primeiro registo desta fração. */
  renewal: boolean;
  portalUrl: string;
}): string {
  const what = params.renewal ? "a renovação do seguro" : "o seguro";
  const coverage = params.renewal ? "A nova vigência" : "A vigência";
  const nowrap = (value: string) =>
    `<strong style="white-space:nowrap;">${escapeHtml(value)}</strong>`;
  return wrapTemplate(
    condominiumHeader(params.designationType, params.condominiumName) +
      `<p style="${S_INTRO}">Caro(a) <strong>${escapeHtml(params.recipientName)}</strong>,</p>` +
      `<p style="${S_P}">Registámos ${what} da fração <strong>${
        escapeHtml(params.unitDesignation)
      }</strong> a partir do documento entregue à administração.</p>` +
      `<p style="${S_P}">${coverage} vai de ${nowrap(params.validFrom)} a ${
        nowrap(params.validTo)
      }.</p>` +
      `<p style="${S_P}">Este email é apenas informativo: não precisa de submeter nada no portal. O registo e o documento ficam disponíveis para consulta.</p>` +
      primaryButton(params.portalUrl, "Consultar no portal") +
      `<p style="${S_P}">Se não reconhece este registo, ou se algum dado não corresponde à apólice que contratou, contacte a administração para o corrigirmos.</p>` +
      `<p style="${S_P}">Os melhores cumprimentos,<br><strong>A Administração</strong></p>` +
      footerWithLink(`Caso o botão não funcione, copie o link direto:`, params.portalUrl),
  );
}

// Convocatória de assembleia, enviada POR FRAÇÃO (ADR 0034). Nota de cobertura
// que aponta os 2 anexos (convocatória com a ordem do dia + procuração); a ordem
// do dia não se repete no corpo. Ramifica por papel + natureza jurídica:
// owner singular (dados pessoais), owner coletiva ("Exmos. Senhores", dados da
// sociedade), resident (não vota; identifica os donos + procuração em branco).
export function assemblyConvocationEmailHtml(params: {
  recipientName: string;
  condominiumName: string;
  designationType: "building" | "condominium";
  assemblyType: "ordinary" | "extraordinary";
  /** 1ª convocatória já formatada, ex: "10/07/2026 19:00". */
  firstConvocation: string;
  /** 2ª convocatória já formatada, ou null. */
  secondConvocation: string | null;
  location: string | null;
  portalUrl: string;
  /** Papel na fração + natureza jurídica (owner); o ramo resident traz os donos. */
  recipient:
    | { role: "owner"; personType: "singular" | "collective" }
    | { role: "resident"; ownerNames: string[] };
  /** Email da administração para reportar problemas, ou null (sem endereço). */
  correctionEmail: string | null;
}): string {
  const tipo = params.assemblyType === "ordinary" ? "ordinária" : "extraordinária";
  const isCollectiveOwner = params.recipient.role === "owner" &&
    params.recipient.personType === "collective";

  const infoRow = (label: string, value: string) =>
    `<tr>
      <td style="padding:4px 12px 4px 0;color:#6b7280;font-size:13px;white-space:nowrap;vertical-align:top;">${
      escapeHtml(label)
    }</td>
      <td style="padding:4px 0;font-size:13px;font-weight:600;color:#111;">${escapeHtml(value)}</td>
    </tr>`;
  const sessionInfo = `<table style="width:100%;border-collapse:collapse;margin:8px 0 20px;">` +
    infoRow("1.ª convocatória", params.firstConvocation) +
    (params.secondConvocation ? infoRow("2.ª convocatória", params.secondConvocation) : "") +
    (params.location ? infoRow("Local", params.location) : "") +
    `</table>`;

  // Saudação: a empresa é tratada por "Exmos. Senhores," (sem nome pessoal).
  const greeting = isCollectiveOwner
    ? `<p style="${S_INTRO}">Exmos. Senhores,</p>`
    : `<p style="${S_INTRO}">Caro(a) <strong>${escapeHtml(params.recipientName)}</strong>,</p>`;

  // Bloco dos anexos: ramo dono (singular/coletiva) vs residente (ADR 0034).
  let attachmentBlock: string;
  if (params.recipient.role === "resident") {
    const names = params.recipient.ownerNames;
    const ownersPhrase = names.length > 0
      ? `<strong>${names.map(escapeHtml).join(", ")}</strong>`
      : "o(s) proprietário(s) da fração";
    attachmentBlock =
      `<p style="${S_P}">Enquanto residente da fração, não dispõe de voto próprio em assembleia - o direito de voto pertence ao(s) proprietário(s): ${ownersPhrase}. Pode, contudo, ser nomeado(a) representante de um proprietário mediante procuração escrita.</p>` +
      `<p style="${S_P}">Seguem em <strong>anexo</strong> a este email a <strong>convocatória</strong> (com a ordem do dia) e um <strong>modelo de procuração em branco</strong>, a preencher e assinar por um proprietário da fração que o(a) queira nomear seu representante.</p>`;
  } else if (isCollectiveOwner) {
    attachmentBlock =
      `<p style="${S_P}">Seguem em <strong>anexo</strong> a este email a <strong>convocatória</strong> (com a ordem do dia) e o <strong>modelo de procuração</strong>, caso a sociedade pretenda fazer-se representar por procurador na assembleia.</p>`;
  } else {
    attachmentBlock =
      `<p style="${S_P}">Seguem em <strong>anexo</strong> a este email a <strong>convocatória</strong> (com a ordem do dia) e o <strong>modelo de procuração</strong> (caso não possa comparecer e queira fazer-se representar).</p>`;
  }

  // Contacto da administração para a nota (ou vazio se o condomínio não tem email).
  const adminContact = params.correctionEmail
    ? `à administração (<a href="mailto:${
      escapeHtml(params.correctionEmail)
    }" style="color:#6b7280;text-decoration:underline;">${escapeHtml(params.correctionEmail)}</a>)`
    : "à administração";

  // Nota final por ramo: residente avisa sobre estatuto; owner sobre dados.
  let correctionNote: string;
  if (params.recipient.role === "resident") {
    correctionNote =
      `<p style="${S_P}font-size:12px;color:#6b7280;">Recebeu este email por constar como residente (sem direito de voto próprio) desta fração. Se é o(a) proprietário(a) desta fração e não consta como tal, comunique ${adminContact} para corrigirmos o registo.</p>`;
  } else if (isCollectiveOwner) {
    correctionNote =
      `<p style="${S_P}font-size:12px;color:#6b7280;">Se algum dado da sociedade (denominação, NIPC, fração ou titularidade) estiver incorreto, comunique ${adminContact}.</p>`;
  } else {
    correctionNote =
      `<p style="${S_P}font-size:12px;color:#6b7280;">Se algum dado (nome, NIF, fração ou titularidade) estiver incorreto, comunique ${adminContact}.</p>`;
  }

  return wrapTemplate(
    condominiumHeader(params.designationType, params.condominiumName) +
      greeting +
      `<p style="${S_P}">Convocamos a assembleia <strong>${tipo}</strong> de condóminos, a realizar:</p>` +
      sessionInfo +
      attachmentBlock +
      primaryButton(params.portalUrl, "Ver no portal") +
      correctionNote +
      `<p style="${S_P}">Os melhores cumprimentos,<br><strong>A Administração</strong></p>` +
      footerWithLink("Caso o botão não funcione, copie o link direto:", params.portalUrl),
  );
}

/**
 * Email de Lembrete de cobrança (ADR 0028): enviado quando uma fração tem
 * pelo menos 1 dívida em atraso > 30 dias. O bloco destacado mostra o total
 * em dívida + IBAN para pagamento; a tabela lista todas as receivable em
 * aberto (quotas, refaturações, saldo inicial). Crédito existente é mencionado como informação.
 */
export interface BillingReminderEmailLine {
  /** Etiqueta legível PT-PT (ex: "Quota Janeiro 2026", "Multa", "Despesa imputada"). */
  label: string;
  /** dd/mm/yyyy formatado pelo caller. */
  dueDate: string;
  amountCents: number;
  settledCents: number;
  outstandingCents: number;
}

/** Plano de pagamento ativo da fração (ADR 0039). */
export interface BillingReminderEmailPlan {
  /** Nota partilhada do plano (a interna nunca chega aqui). null = sem nota. */
  notes: string | null;
  /** Data final prevista, dd/mm/yyyy formatado pelo caller. null = sem data. */
  endDate: string | null;
}

export function billingReminderEmailHtml(params: {
  recipientName: string;
  condominiumName: string;
  designationType: "building" | "condominium";
  unitDesignation: string;
  totalOwedCents: number;
  creditCents: number;
  /** IBAN do condomínio (já mascarado pelo caller se aplicável). null se cond. não tem conta bank. */
  iban: string | null;
  /** Nota livre da administração mostrada no topo. Vazio/ausente = sem caixa. */
  adminNote?: string;
  lines: BillingReminderEmailLine[];
  /** Presente = fração em plano: o email fala dos valores pendentes do acordo. */
  paymentPlan?: BillingReminderEmailPlan | null;
}): string {
  const plan = params.paymentPlan ?? null;
  // Em plano o tom é de acompanhamento (âmbar), não de cobrança (vermelho).
  const tone = plan
    ? { bg: "#fffbeb", border: "#d97706", text: "#92400e" }
    : { bg: "#fef2f2", border: "#b91c1c", text: "#7f1d1d" };

  // Linhas das charges: etiqueta | venc | valor | pago | em dívida.
  const tableRows = params.lines.map((l) =>
    `<tr>
      <td style="padding:6px 4px;border-bottom:1px solid #e5e7eb;">${escapeHtml(l.label)}</td>
      <td style="padding:6px 4px;border-bottom:1px solid #e5e7eb;text-align:center;font-variant-numeric:tabular-nums;white-space:nowrap;">${
      escapeHtml(l.dueDate)
    }</td>
      <td style="padding:6px 4px;border-bottom:1px solid #e5e7eb;text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;">${
      formatMoney(l.amountCents)
    }</td>
      <td style="padding:6px 4px;border-bottom:1px solid #e5e7eb;text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;color:#6b7280;">${
      formatMoney(l.settledCents)
    }</td>
      <td style="padding:6px 4px;border-bottom:1px solid #e5e7eb;text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;font-weight:600;color:${tone.border};">${
      formatMoney(l.outstandingCents)
    }</td>
    </tr>`
  ).join("");

  const creditNote = params.creditCents > 0
    ? `<p style="${S_P}font-size:12px;color:#4b5563;">Tem também ${
      formatMoney(params.creditCents)
    } de pagamentos adiantados não imputados. Contacte a administração para reconciliar.</p>`
    : "";

  const noteText = params.adminNote?.trim();
  const adminNoteBlock = noteText
    ? `<div style="margin:20px 0;padding:14px 16px;background:#eff6ff;border-left:4px solid #2563eb;border-radius:6px;">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#1e40af;font-weight:700;">Nota da administração</div>
        <div style="margin-top:6px;font-size:14px;color:#1f2937;line-height:1.5;">${
      escapeHtml(noteText).replace(/\n/g, "<br>")
    }</div>
      </div>`
    : "";

  const ibanBlock = params.iban
    ? `<div style="margin-top:10px;background:#fff;padding:10px 12px;border:1px solid #e5e7eb;border-radius:6px;">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:${tone.text};font-weight:700;">IBAN para pagamento</div>
        <div style="font-family:monospace;font-size:14px;margin-top:4px;letter-spacing:0.02em;color:#1f2937;"><strong>${
      escapeHtml(params.iban)
    }</strong></div>
      </div>`
    : "";

  const planNote = plan?.notes?.trim();
  const planBlock = plan && (planNote || plan.endDate)
    ? `<div style="margin:20px 0;padding:14px 16px;background:#f9fafb;border-left:4px solid #4b5563;border-radius:6px;">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#374151;font-weight:700;">Plano de pagamento</div>${
      planNote
        ? `<div style="margin-top:6px;font-size:14px;color:#1f2937;line-height:1.5;">${
          escapeHtml(planNote).replace(/\n/g, "<br>")
        }</div>`
        : ""
    }${
      plan.endDate
        ? `<div style="margin-top:8px;font-size:12px;color:#4b5563;">Data final prevista: <strong>${
          escapeHtml(plan.endDate)
        }</strong></div>`
        : ""
    }
      </div>`
    : "";

  const unitDesignation = `<strong>${escapeHtml(params.unitDesignation)}</strong>`;
  const intro = plan
    ? `A fração ${unitDesignation} tem um plano de pagamento em curso. Em baixo, os valores que se mantêm pendentes.`
    : `A fração ${unitDesignation} tem valores em atraso. Em baixo o detalhe.`;
  const closing = plan
    ? "Agradecemos o cumprimento do plano acordado. Caso já tenha procedido ao pagamento, ignore este aviso e contacte-nos se possível."
    : "Solicitamos a regularização da situação. Caso já tenha procedido ao pagamento, ignore este aviso e contacte-nos se possível.";

  return wrapTemplate(
    condominiumHeader(params.designationType, params.condominiumName) +
      `<p style="${S_INTRO}">Caro(a) <strong>${escapeHtml(params.recipientName)}</strong>,</p>` +
      `<p style="${S_P}">${intro}</p>` +
      adminNoteBlock +
      planBlock +
      `<div style="margin:20px 0;padding:16px 20px;background:${tone.bg};border-left:4px solid ${tone.border};border-radius:6px;">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:${tone.text};font-weight:700;">${
        plan ? "Valores pendentes" : "Total em dívida"
      }</div>
      <div style="font-size:28px;font-weight:700;color:${tone.text};margin-top:4px;font-variant-numeric:tabular-nums;">${
        formatMoney(params.totalOwedCents)
      }</div>
      ${ibanBlock}
    </div>` +
      creditNote +
      // Padding compacto + nowrap nas colunas numéricas para os valores não partirem.
      `<table style="width:100%;border-collapse:collapse;margin-top:16px;font-size:12px;table-layout:auto;">
      <thead>
        <tr style="background:#f9fafb;">
          <th style="padding:6px 4px;text-align:left;border-bottom:1px solid #d1d5db;font-size:10px;text-transform:uppercase;letter-spacing:0.04em;color:#4b5563;">Descrição</th>
          <th style="padding:6px 4px;text-align:center;border-bottom:1px solid #d1d5db;font-size:10px;text-transform:uppercase;letter-spacing:0.04em;color:#4b5563;white-space:nowrap;">Vencimento</th>
          <th style="padding:6px 4px;text-align:right;border-bottom:1px solid #d1d5db;font-size:10px;text-transform:uppercase;letter-spacing:0.04em;color:#4b5563;white-space:nowrap;">Valor</th>
          <th style="padding:6px 4px;text-align:right;border-bottom:1px solid #d1d5db;font-size:10px;text-transform:uppercase;letter-spacing:0.04em;color:#4b5563;white-space:nowrap;">Pago</th>
          <th style="padding:6px 4px;text-align:right;border-bottom:1px solid #d1d5db;font-size:10px;text-transform:uppercase;letter-spacing:0.04em;color:#4b5563;white-space:nowrap;">${
        plan ? "Pendente" : "Em dívida"
      }</th>
        </tr>
      </thead>
      <tbody>${tableRows}</tbody>
    </table>` +
      `<p style="margin:28px 0 16px;font-family:Helvetica,Arial,sans-serif;">${closing}</p>` +
      `<p style="${S_P}">Os melhores cumprimentos,<br><strong>A Administração</strong></p>` +
      `<p style="font-size:11px;color:#9ca3af;margin-top:24px;border-top:1px solid #e5e7eb;padding-top:12px;">Este email foi gerado automaticamente a partir do estado da conciliação. Se considera ter sido enviado por engano, contacte a administração.</p>`,
    { wide: true },
  );
}

// ─── Ocorrências (tickets) ───────────────────────────────────────────────
// Linha "label: valor" das fichas de ocorrência (partilhada pelos 2 templates).
function ticketInfoRow(label: string, value: string): string {
  return `<tr>
      <td style="padding:4px 12px 4px 0;color:#6b7280;font-size:13px;white-space:nowrap;vertical-align:top;">${
    escapeHtml(label)
  }</td>
      <td style="padding:4px 0;font-size:13px;font-weight:600;color:#111;">${escapeHtml(value)}</td>
    </tr>`;
}

// Bloco de texto livre (descrição, comentário) com quebras de linha preservadas.
function ticketTextBlock(title: string, text: string): string {
  return `<div style="margin:20px 0;padding:14px 16px;background:#f9fafb;border-left:4px solid #111;border-radius:6px;">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#4b5563;font-weight:700;">${
    escapeHtml(title)
  }</div>
      <div style="margin-top:6px;font-size:14px;color:#1f2937;line-height:1.5;">${
    escapeHtml(text).replace(/\n/g, "<br>")
  }</div>
    </div>`;
}

// Cabeçalho comum: código + título da ocorrência.
function ticketTitleLine(code: string, title: string): string {
  return `<p style="${S_P}"><span style="font-family:monospace;color:#6b7280;">${
    escapeHtml(code)
  }</span> <strong>${escapeHtml(title)}</strong></p>`;
}

/**
 * Email para a caixa do condomínio quando um ocupante regista uma ocorrência
 * no portal. Ocorrências criadas no painel não notificam ninguém.
 */
export function ticketCreatedEmailHtml(params: {
  condominiumName: string;
  designationType: "building" | "condominium";
  ticketCode: string;
  ticketTitle: string;
  unitDesignation: string;
  reporterName: string;
  categoryLabel: string;
  priorityLabel: string;
  location: string | null;
  description: string | null;
  ticketUrl: string;
}): string {
  const info = `<table style="width:100%;border-collapse:collapse;margin:8px 0 20px;">` +
    ticketInfoRow("Fração", params.unitDesignation) +
    ticketInfoRow("Reportado por", params.reporterName) +
    ticketInfoRow("Categoria", params.categoryLabel) +
    ticketInfoRow("Prioridade", params.priorityLabel) +
    (params.location ? ticketInfoRow("Localização", params.location) : "") +
    `</table>`;

  return wrapTemplate(
    condominiumHeader(params.designationType, params.condominiumName) +
      `<p style="${S_INTRO}">Foi registada uma <strong>nova ocorrência</strong> no portal do condómino.</p>` +
      ticketTitleLine(params.ticketCode, params.ticketTitle) +
      info +
      (params.description ? ticketTextBlock("Descrição", params.description) : "") +
      primaryButton(params.ticketUrl, "Abrir ocorrência") +
      footerWithLink("Caso o botão não funcione, copie o link direto:", params.ticketUrl),
  );
}

/**
 * Email de interação numa ocorrência: comentário público ou mudança de estado.
 * Serve os dois sentidos - administração → reporter e reporter → administração;
 * o caller escolhe destinatário, saudação, link e rótulo do botão.
 */
export function ticketActivityEmailHtml(params: {
  /** Nome do destinatário; null usa a saudação institucional (caixa do condomínio). */
  recipientName: string | null;
  condominiumName: string;
  designationType: "building" | "condominium";
  ticketCode: string;
  ticketTitle: string;
  /** Designação da fração, ou null em ocorrências sem fração associada. */
  unitDesignation: string | null;
  /** Quem escreveu, já legível ("A administração", "Maria Silva"). */
  authorLabel: string;
  /** Preenchido quando a interação foi uma mudança de estado (labels PT-PT). */
  statusChange?: { from: string; to: string } | null;
  /** Estado atual da ocorrência, label PT-PT. */
  statusLabel: string;
  comment: string;
  ticketUrl: string;
  buttonLabel: string;
}): string {
  const greeting = params.recipientName
    ? `<p style="${S_INTRO}">Caro(a) <strong>${escapeHtml(params.recipientName)}</strong>,</p>`
    : `<p style="${S_INTRO}">Exmos. Senhores,</p>`;

  const lead = params.statusChange
    ? `<p style="${S_P}">O estado da ocorrência passou de <strong>${
      escapeHtml(params.statusChange.from)
    }</strong> para <strong>${escapeHtml(params.statusChange.to)}</strong>.</p>`
    : `<p style="${S_P}">Há uma nova mensagem na ocorrência abaixo.</p>`;

  const info = `<table style="width:100%;border-collapse:collapse;margin:8px 0 20px;">` +
    (params.unitDesignation ? ticketInfoRow("Fração", params.unitDesignation) : "") +
    ticketInfoRow("Estado", params.statusLabel) +
    ticketInfoRow("Autor", params.authorLabel) +
    `</table>`;

  return wrapTemplate(
    condominiumHeader(params.designationType, params.condominiumName) +
      greeting +
      lead +
      ticketTitleLine(params.ticketCode, params.ticketTitle) +
      info +
      ticketTextBlock("Mensagem", params.comment) +
      primaryButton(params.ticketUrl, params.buttonLabel) +
      footerWithLink("Caso o botão não funcione, copie o link direto:", params.ticketUrl),
  );
}
