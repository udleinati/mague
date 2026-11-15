// Tests dos templates HTML de email. Duas zonas críticas: escaping de input
// (defesa XSS, emails são HTML em webmail) e branching condicional
// (designationType, unitIdentifier nullable). Testamos presença de strings,
// não a forma exacta do HTML (cores/padding regeneram livremente).

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  assemblyConvocationEmailHtml,
  billingReminderEmailHtml,
  insuranceAdminEvidenceEmailHtml,
  insuranceReminderEmailHtml,
  insuranceRenewalEvidenceEmailHtml,
  inviteEmailHtml,
  receiptIssuedEmailHtml,
  resetPasswordEmailHtml,
  ticketActivityEmailHtml,
  ticketCreatedEmailHtml,
} from "./templates.ts";

// ─── inviteEmailHtml ──────────────────────────────────────────────────────

Deno.test("invite: nome do occupant aparece no body", () => {
  const html = inviteEmailHtml({
    occupantName: "João Silva",
    condominiumName: "Edifício Central",
    designationType: "building",
    acceptUrl: "https://app/accept-invite?token=abc",
    ttl: "24 horas",
  });
  assertStringIncludes(html, "João Silva");
  assertStringIncludes(html, "Edifício Central");
});

Deno.test("invite: designationType=building → label 'EDIFÍCIO'", () => {
  const html = inviteEmailHtml({
    occupantName: "x",
    condominiumName: "y",
    designationType: "building",
    acceptUrl: "https://x",
    ttl: "1h",
  });
  assertStringIncludes(html, "EDIFÍCIO");
});

Deno.test("invite: designationType=condominium → label 'CONDOMÍNIO'", () => {
  const html = inviteEmailHtml({
    occupantName: "x",
    condominiumName: "y",
    designationType: "condominium",
    acceptUrl: "https://x",
    ttl: "1h",
  });
  assertStringIncludes(html, "CONDOMÍNIO");
});

// ─── XSS defense ──────────────────────────────────────────────────────────
// Casos canónicos de injection - verifica escape de cada caracter especial.

Deno.test("invite: occupantName com < e > é escapado (XSS)", () => {
  const html = inviteEmailHtml({
    occupantName: "<script>alert(1)</script>",
    condominiumName: "x",
    designationType: "building",
    acceptUrl: "https://x",
    ttl: "1h",
  });
  assertEquals(html.includes("<script>"), false);
  assertStringIncludes(html, "&lt;script&gt;");
});

Deno.test("invite: condominiumName com & é escapado", () => {
  const html = inviteEmailHtml({
    occupantName: "x",
    condominiumName: "Edifício Sun & Beach",
    designationType: "building",
    acceptUrl: "https://x",
    ttl: "1h",
  });
  assertStringIncludes(html, "Sun &amp; Beach");
  assertEquals(html.includes("Sun & Beach"), false);
});

Deno.test("invite: aspas e apóstrofes são escapadas (atributo HTML safety)", () => {
  const html = inviteEmailHtml({
    occupantName: "a\"b'c",
    condominiumName: "x",
    designationType: "building",
    acceptUrl: "https://x",
    ttl: "1h",
  });
  assertStringIncludes(html, "a&quot;b&#39;c");
});

// ─── resetPasswordEmailHtml ───────────────────────────────────────────────

Deno.test("reset: userName + ttl aparecem; sem branding de condomínio", () => {
  const html = resetPasswordEmailHtml({
    userName: "Ana",
    resetUrl: "https://app/reset?token=xyz",
    ttl: "30 minutos",
  });
  assertStringIncludes(html, "Ana");
  assertStringIncludes(html, "30 minutos");
  assertStringIncludes(html, "Reposição de Password");
  // Reset emails são genéricos - não devem mencionar "Edifício" / condo
  // específico (user pode estar em vários ou ser super).
  assertEquals(html.includes("Edifício"), false);
});

Deno.test("reset: userName escapado", () => {
  const html = resetPasswordEmailHtml({
    userName: "<img onerror=alert>",
    resetUrl: "https://x",
    ttl: "30 minutos",
  });
  assertEquals(html.includes("<img onerror"), false);
  assertStringIncludes(html, "&lt;img onerror=alert&gt;");
});

// ─── receiptIssuedEmailHtml ───────────────────────────────────────────────
// Tem 2 paths: com e sem `unitIdentifier`. Ambos têm que escapar o conteúdo
// e o branching tem que ser correto.

Deno.test("receipt: unitIdentifier=null → só designation no label", () => {
  const html = receiptIssuedEmailHtml({
    recipientName: "Maria",
    condominiumName: "C",
    designationType: "building",
    unitDesignation: "1ºA",
    unitIdentifier: null,
    receiptNumber: "2026/0010",
    amount: "210,00 €",
    paymentDate: "15/05/2026",
    receiptUrl: "https://x",
  });
  assertStringIncludes(html, "1ºA");
  assertEquals(html.includes("·"), false);
});

Deno.test("receipt: unitIdentifier definido → designation + identifier", () => {
  const html = receiptIssuedEmailHtml({
    recipientName: "Maria",
    condominiumName: "C",
    designationType: "building",
    unitDesignation: "1ºA",
    unitIdentifier: "Bloco A 1º Esq",
    receiptNumber: "2026/0010",
    amount: "210,00 €",
    paymentDate: "15/05/2026",
    receiptUrl: "https://x",
  });
  assertStringIncludes(html, "1ºA");
  assertStringIncludes(html, "Bloco A 1º Esq");
  assertStringIncludes(html, "·");
});

Deno.test("receipt: amount + receiptNumber + paymentDate aparecem", () => {
  const html = receiptIssuedEmailHtml({
    recipientName: "x",
    condominiumName: "y",
    designationType: "building",
    unitDesignation: "1A",
    unitIdentifier: null,
    receiptNumber: "2026/0042",
    amount: "999,99 €",
    paymentDate: "01/01/2026",
    receiptUrl: "https://x",
  });
  assertStringIncludes(html, "2026/0042");
  assertStringIncludes(html, "999,99 €");
  assertStringIncludes(html, "01/01/2026");
});

Deno.test("receipt: amount não quebra mid-string (white-space:nowrap)", () => {
  // Outlook/Gmail mobile partem strings longas no meio. Para valores tipo
  // "1.234,56 €" o nowrap garante que o utilizador vê o montante completo
  // numa única linha. Mesmo para a paymentDate (não quebrar dia da data).
  const html = receiptIssuedEmailHtml({
    recipientName: "x",
    condominiumName: "y",
    designationType: "building",
    unitDesignation: "1A",
    unitIdentifier: null,
    receiptNumber: "1",
    amount: "1.234,56 €",
    paymentDate: "15/05/2026",
    receiptUrl: "https://x",
  });
  // O amount está dentro de um <strong style="white-space:nowrap;">
  assertStringIncludes(html, 'white-space:nowrap;">1.234,56 €</strong>');
  // E a paymentDate está dentro de um <span style="white-space:nowrap;">
  assertStringIncludes(html, 'white-space:nowrap;">15/05/2026</span>');
});

Deno.test("receipt: unitDesignation com HTML é escapado em ambos paths", () => {
  const evilDesig = "<b>1ºA</b>";
  const withId = receiptIssuedEmailHtml({
    recipientName: "x",
    condominiumName: "y",
    designationType: "building",
    unitDesignation: evilDesig,
    unitIdentifier: "Bloco A",
    receiptNumber: "1",
    amount: "1 €",
    paymentDate: "1/1/26",
    receiptUrl: "https://x",
  });
  const withoutId = receiptIssuedEmailHtml({
    recipientName: "x",
    condominiumName: "y",
    designationType: "building",
    unitDesignation: evilDesig,
    unitIdentifier: null,
    receiptNumber: "1",
    amount: "1 €",
    paymentDate: "1/1/26",
    receiptUrl: "https://x",
  });
  // Path com identifier:
  assertEquals(withId.includes("<b>1ºA</b>"), false);
  assertStringIncludes(withId, "&lt;b&gt;1ºA&lt;/b&gt;");
  // Path sem identifier:
  assertEquals(withoutId.includes("<b>1ºA</b>"), false);
  assertStringIncludes(withoutId, "&lt;b&gt;1ºA&lt;/b&gt;");
});

Deno.test("receipt: unitIdentifier com HTML é escapado", () => {
  const html = receiptIssuedEmailHtml({
    recipientName: "x",
    condominiumName: "y",
    designationType: "building",
    unitDesignation: "1A",
    unitIdentifier: "<script>",
    receiptNumber: "1",
    amount: "1 €",
    paymentDate: "1/1/26",
    receiptUrl: "https://x",
  });
  assertEquals(html.includes("<script>"), false);
  assertStringIncludes(html, "&lt;script&gt;");
});

// ─── insuranceReminderEmailHtml ───────────────────────────────────────────

Deno.test("insurance: unitDesignation + portalUrl aparecem", () => {
  const html = insuranceReminderEmailHtml({
    recipientName: "Ana",
    condominiumName: "C",
    designationType: "building",
    unitDesignation: "1ºA - Bloco A",
    portalUrl: "https://app/portal/c/abc/u/xyz/insurances",
  });
  assertStringIncludes(html, "1ºA - Bloco A");
  assertStringIncludes(html, "https://app/portal/c/abc/u/xyz/insurances");
});

Deno.test("insurance: unitDesignation com & escapado (XSS)", () => {
  const html = insuranceReminderEmailHtml({
    recipientName: "x",
    condominiumName: "y",
    designationType: "building",
    unitDesignation: "A & B",
    portalUrl: "https://x",
  });
  assertStringIncludes(html, "A &amp; B");
  // O ampersand cru não pode aparecer fora do contexto escapado.
  // Procuramos especificamente "A & B" sem escape.
  assertEquals(html.includes("A & B"), false);
});

// adminNote: a caixa "Nota da administração" só aparece com texto, escapa
// HTML do utilizador e converte quebras de linha em <br>. Mesmo contracto que
// billingReminderEmailHtml - se mudar o escape, o utilizador injeta markup.
Deno.test("insurance: adminNote renderiza a caixa com o texto", () => {
  const html = insuranceReminderEmailHtml({
    recipientName: "Ana",
    condominiumName: "C",
    designationType: "building",
    unitDesignation: "1ºA",
    portalUrl: "https://x",
    adminNote: "Submeta a apólice até 30/06.",
  });
  assertStringIncludes(html, "Nota da administração");
  assertStringIncludes(html, "Submeta a apólice até 30/06.");
});

Deno.test("insurance: adminNote escapa HTML e respeita quebras de linha", () => {
  const html = insuranceReminderEmailHtml({
    recipientName: "x",
    condominiumName: "y",
    designationType: "building",
    unitDesignation: "A",
    portalUrl: "https://x",
    adminNote: "<b>perigo</b>\nlinha 2",
  });
  // Markup do utilizador escapado + \n vira <br> (ambos na mesma asserção).
  assertStringIncludes(html, "&lt;b&gt;perigo&lt;/b&gt;<br>linha 2");
  assertEquals(html.includes("<b>perigo</b>"), false);
});

Deno.test("insurance: sem adminNote (ou só whitespace) não mostra a caixa", () => {
  const base = {
    recipientName: "x",
    condominiumName: "y",
    designationType: "building" as const,
    unitDesignation: "A",
    portalUrl: "https://x",
  };
  assertEquals(insuranceReminderEmailHtml(base).includes("Nota da administração"), false);
  assertEquals(
    insuranceReminderEmailHtml({ ...base, adminNote: "   " }).includes("Nota da administração"),
    false,
  );
});

// ─── insuranceRenewalEvidenceEmailHtml ────────────────────────────────────
// Copy distinto do lembrete "seguro em falta": confirma a renovação e pede o
// comprovativo anual. Mesma infra (recipients/cooldown/nota), template próprio.

Deno.test("renovação seguro: confirma renovação + pede comprovativo + portalUrl", () => {
  const html = insuranceRenewalEvidenceEmailHtml({
    recipientName: "Ana",
    condominiumName: "C",
    designationType: "building",
    unitDesignation: "1ºA - Bloco A",
    portalUrl: "https://app/portal/c/abc/u/xyz/insurances",
  });
  assertStringIncludes(html, "1ºA - Bloco A");
  assertStringIncludes(html, "renovada");
  assertStringIncludes(html, "Enviar comprovativo");
  assertStringIncludes(html, "https://app/portal/c/abc/u/xyz/insurances");
  // Não pode reusar o copy do lembrete de falta (intenção oposta).
  assertEquals(html.includes("não tem atualmente apólice de seguro válida"), false);
});

Deno.test("renovação seguro: adminNote renderiza a caixa", () => {
  const html = insuranceRenewalEvidenceEmailHtml({
    recipientName: "Ana",
    condominiumName: "C",
    designationType: "building",
    unitDesignation: "1ºA",
    portalUrl: "https://x",
    adminNote: "Envie o recibo até 30/06.",
  });
  assertStringIncludes(html, "Nota da administração");
  assertStringIncludes(html, "Envie o recibo até 30/06.");
});

Deno.test("renovação seguro: unitDesignation com & escapado (XSS) e sem em-dash", () => {
  const html = insuranceRenewalEvidenceEmailHtml({
    recipientName: "x",
    condominiumName: "y",
    designationType: "building",
    unitDesignation: "A & B",
    portalUrl: "https://x",
  });
  assertStringIncludes(html, "A &amp; B");
  assertEquals(html.includes("A & B"), false);
  assertEquals(html.includes("—"), false);
});

// ─── insuranceAdminEvidenceEmailHtml ──────────────────────────────────────
// Aviso do registo feito pela administração com o documento entregue fora do
// portal. É o único email de seguro que não pede nada, e é o controlo que
// substitui a evidência submetida pela própria fração: se ela não souber do
// registo, não o pode contestar.

const adminEvidenceBase = {
  recipientName: "Ana",
  condominiumName: "Edifício Central",
  designationType: "building" as const,
  unitDesignation: "1ºA - Bloco A",
  validFrom: "01/01/2026",
  validTo: "31/12/2026",
  renewal: false,
  portalUrl: "https://app/portal/c/abc/u/xyz/insurances",
};

Deno.test("aviso de registo: identifica a fração, a vigência e a origem do documento", () => {
  const html = insuranceAdminEvidenceEmailHtml(adminEvidenceBase);
  assertStringIncludes(html, "1ºA - Bloco A");
  assertStringIncludes(html, "documento entregue à administração");
  // As duas datas são o conteúdo verificável do aviso - sem elas a fração não
  // consegue confrontar o registo com o papel que entregou.
  assertStringIncludes(html, "01/01/2026");
  assertStringIncludes(html, "31/12/2026");
  assertStringIncludes(html, "https://app/portal/c/abc/u/xyz/insurances");
});

Deno.test("aviso de registo: NÃO pede nada à fração (é informativo, D5)", () => {
  // A razão de existir deste email é substituir o `renewal_evidence`, que pedia
  // à condómina o documento que o admin já tinha na mão. Se voltar a aparecer
  // copy de pedido aqui, a feature desfez-se.
  const html = insuranceAdminEvidenceEmailHtml(adminEvidenceBase);
  assertStringIncludes(html, "apenas informativo");
  assertStringIncludes(html, "não precisa de submeter nada no portal");
  // Copy dos dois emails de cobrança de evidência - nenhum pode reaparecer.
  assertEquals(html.includes("Submeter apólice"), false);
  assertEquals(html.includes("Enviar comprovativo"), false);
  assertEquals(html.includes("agradecemos que submeta"), false);
  assertEquals(html.includes("Solicitamos"), false);
});

Deno.test("aviso de registo: diz como contestar (é isso que o torna um controlo)", () => {
  // Sem o caminho para reclamar, o aviso é decorativo: a auto-aprovação do
  // admin não é controlo nenhum, este email é.
  const html = insuranceAdminEvidenceEmailHtml(adminEvidenceBase);
  assertStringIncludes(html, "Se não reconhece este registo");
  assertStringIncludes(html, "contacte a administração");
});

Deno.test("aviso de registo: renovação e primeiro registo têm redações distintas", () => {
  // A fração precisa de saber se isto substitui a apólice que já tinha ou se é
  // o primeiro registo - muda o que ela deve conferir.
  const first = insuranceAdminEvidenceEmailHtml(adminEvidenceBase);
  const renewed = insuranceAdminEvidenceEmailHtml({ ...adminEvidenceBase, renewal: true });
  assertStringIncludes(renewed, "a renovação do seguro da fração");
  assertStringIncludes(renewed, "A nova vigência");
  assertEquals(first.includes("a renovação do seguro"), false);
  assertEquals(first.includes("A nova vigência"), false);
  assertStringIncludes(first, "Registámos o seguro da fração");
});

Deno.test("aviso de registo: unitDesignation com & escapado (XSS) e sem em-dash", () => {
  const html = insuranceAdminEvidenceEmailHtml({
    ...adminEvidenceBase,
    unitDesignation: "A & B",
    recipientName: "<script>alert(1)</script>",
  });
  assertStringIncludes(html, "A &amp; B");
  assertEquals(html.includes("A & B"), false);
  assertEquals(html.includes("<script>"), false);
  assertEquals(html.includes("—"), false);
});

// ─── URL não-escapada (atributo href) ─────────────────────────────────────
// As URLs são interpoladas raw em href= (sem escape). Isto é OK porque o
// caller (templates/sendEmail) controla a URL - não vem de utilizador.
// Test pinning este contracto: se alguém adicionar escape automático em
// URL, breaks o teste.

Deno.test("invite: acceptUrl é interpolada raw em href (caller-controlled)", () => {
  // URL com query string complexa (params reais que o sistema gera).
  const url = "https://app/accept-invite?token=abc&next=%2Fhome";
  const html = inviteEmailHtml({
    occupantName: "x",
    condominiumName: "y",
    designationType: "building",
    acceptUrl: url,
    ttl: "1h",
  });
  // O `&` da query string aparece cru no href (não escapado para `&amp;`).
  // Se a interpolação muda para escape, o link fica partido nos webmails.
  assertStringIncludes(html, `href="${url}"`);
});

// ─── billingReminderEmailHtml ─────────────────────────────────────────────

Deno.test("billing reminder: cada célula de valor tem white-space:nowrap", () => {
  // Em clients estreitos (Outlook web mobile, Gmail mobile portrait),
  // valores como "1.234,56 €" partem-se mid-string sem nowrap. Lock-in:
  // se alguém remover o nowrap, esta assertion grita.
  const html = billingReminderEmailHtml({
    recipientName: "x",
    condominiumName: "y",
    designationType: "building",
    unitDesignation: "1A",
    totalOwedCents: 123456,
    creditCents: 0,
    iban: null,
    lines: [{
      label: "Quota Janeiro 2026",
      dueDate: "31/01/2026",
      amountCents: 5000,
      settledCents: 0,
      outstandingCents: 5000,
    }],
  });
  // Cada um dos 4 td numéricos (data, valor, pago, em dívida) tem nowrap.
  const nowrapCount = (html.match(/white-space:nowrap/g) ?? []).length;
  // Mínimo 4 nowraps na row + 4 nas headers = 8.
  if (nowrapCount < 8) {
    throw new Error(
      `esperava >=8 white-space:nowrap (headers + cells), obtido ${nowrapCount}`,
    );
  }
});

Deno.test("billing reminder: container alargado para 720px (5 colunas precisam espaço)", () => {
  // Default `wrapTemplate` usa max-width:560px - aperta uma tabela com
  // 5 colunas e força partir os valores. Para billing reminder usamos
  // o flag `wide` que vai a 720px. Lock-in para evitar regressão.
  const html = billingReminderEmailHtml({
    recipientName: "x",
    condominiumName: "y",
    designationType: "building",
    unitDesignation: "1A",
    totalOwedCents: 100,
    creditCents: 0,
    iban: null,
    lines: [],
  });
  assertStringIncludes(html, "max-width:720px");
});

const billingBase = {
  recipientName: "x",
  condominiumName: "y",
  designationType: "building" as const,
  unitDesignation: "1A",
  totalOwedCents: 100,
  creditCents: 0,
  iban: null,
  lines: [],
};

Deno.test("billing reminder: adminNote vazio/ausente → sem caixa 'Nota da administração'", () => {
  // Estado por defeito (condomínios que não configuram nota): a caixa não
  // aparece de todo. Se aparecesse vazia, sujava o email de toda a gente.
  assertEquals(billingReminderEmailHtml(billingBase).includes("Nota da administração"), false);
  assertEquals(
    billingReminderEmailHtml({ ...billingBase, adminNote: "   " }).includes(
      "Nota da administração",
    ),
    false,
  );
});

Deno.test("billing reminder: adminNote preenchida aparece no corpo, antes do total em dívida", () => {
  // A nota é editorial e deve enquadrar a leitura: tem de vir ANTES da caixa
  // vermelha do total (decisão de posicionamento), senão é só um apêndice.
  const html = billingReminderEmailHtml({
    ...billingBase,
    adminNote: "Pagar até 30/06/2026 conforme assembleia.",
  });
  assertStringIncludes(html, "Nota da administração");
  assertStringIncludes(html, "Pagar até 30/06/2026 conforme assembleia.");
  const notePos = html.indexOf("Nota da administração");
  const totalPos = html.indexOf("Total em dívida");
  if (!(notePos < totalPos)) {
    throw new Error("a nota da administração deve aparecer antes do total em dívida");
  }
});

Deno.test("billing reminder: adminNote com HTML é escapada (XSS)", () => {
  // Texto livre controlado pelo admin, mas renderizado em webmail: escapar
  // sempre. Se entrar markup cru, é injeção.
  const html = billingReminderEmailHtml({
    ...billingBase,
    adminNote: "<script>alert(1)</script>",
  });
  assertEquals(html.includes("<script>alert(1)</script>"), false);
  assertStringIncludes(html, "&lt;script&gt;");
});

Deno.test("billing reminder: quebras de linha da adminNote viram <br>", () => {
  // O admin escreve parágrafos no textarea; preservar as quebras é o que
  // torna o resultado previsível (decisão: sem markdown, só nl→br).
  const html = billingReminderEmailHtml({
    ...billingBase,
    adminNote: "linha 1\nlinha 2",
  });
  assertStringIncludes(html, "linha 1<br>linha 2");
});

// Fração em plano de pagamento (ADR 0039): o condómino
// com acordo não pode receber o email de "valores em atraso" - tem de ler que
// está em plano, os termos e o que continua pendente.
Deno.test("billing reminder em plano: diz que está em plano, mostra termos, data final e pendentes", () => {
  const html = billingReminderEmailHtml({
    ...billingBase,
    totalOwedCents: 45_000,
    paymentPlan: { notes: "100 € por mês até dezembro", endDate: "31/12/2026" },
  });
  assertStringIncludes(html, "tem um plano de pagamento em curso");
  assertStringIncludes(html, "100 € por mês até dezembro");
  assertStringIncludes(html, "Data final prevista: <strong>31/12/2026</strong>");
  assertStringIncludes(html, "Valores pendentes");
  assertStringIncludes(html, "450,00");
  // Nada da redação de cobrança do email normal.
  assertEquals(html.includes("tem valores em atraso"), false);
  assertEquals(html.includes("Total em dívida"), false);
  assertEquals(html.includes("Solicitamos a regularização"), false);
});

Deno.test("billing reminder em plano: sem data final não mostra a linha da data", () => {
  const html = billingReminderEmailHtml({
    ...billingBase,
    paymentPlan: { notes: "Acordo verbal", endDate: null },
  });
  assertStringIncludes(html, "Acordo verbal");
  assertEquals(html.includes("Data final prevista"), false);
});

Deno.test("billing reminder em plano: termos do plano escapados e com quebras de linha", () => {
  // Texto livre do admin que agora sai para o condómino: escapar sempre.
  const html = billingReminderEmailHtml({
    ...billingBase,
    paymentPlan: { notes: "1ª prestação\n<script>alert(1)</script>", endDate: null },
  });
  assertEquals(html.includes("<script>alert(1)</script>"), false);
  assertStringIncludes(html, "1ª prestação<br>&lt;script&gt;");
});

Deno.test("billing reminder em plano: sem nota partilhada, a caixa só mostra a data final", () => {
  // Planos só com nota interna (a interna nunca chega ao template).
  const html = billingReminderEmailHtml({
    ...billingBase,
    paymentPlan: { notes: null, endDate: "31/12/2026" },
  });
  assertStringIncludes(html, "tem um plano de pagamento em curso");
  assertStringIncludes(html, "Plano de pagamento");
  assertStringIncludes(html, "Data final prevista: <strong>31/12/2026</strong>");
});

Deno.test("billing reminder em plano: sem nota partilhada nem data, sem caixa do plano", () => {
  const html = billingReminderEmailHtml({
    ...billingBase,
    paymentPlan: { notes: null, endDate: null },
  });
  // Continua a ser o email de plano (intro + valores pendentes), sem caixa vazia.
  assertStringIncludes(html, "tem um plano de pagamento em curso");
  assertStringIncludes(html, "Valores pendentes");
  assertEquals(html.includes(">Plano de pagamento</div>"), false);
});

Deno.test("billing reminder sem plano: mantém a redação de cobrança e não fala de plano", () => {
  const html = billingReminderEmailHtml({ ...billingBase, paymentPlan: null });
  assertStringIncludes(html, "tem valores em atraso");
  assertStringIncludes(html, "Total em dívida");
  assertEquals(html.includes("Plano de pagamento"), false);
});

// ─── assemblyConvocationEmailHtml ─────────────────────────────────────────

Deno.test("convocação (owner singular): nota objetiva, ordem do dia só no anexo, link ao portal e nota de correção", () => {
  const html = assemblyConvocationEmailHtml({
    recipientName: "Maria <b>Silva</b>",
    condominiumName: "Edifício Central",
    designationType: "building",
    assemblyType: "ordinary",
    firstConvocation: "10/07/2026 19:00",
    secondConvocation: "10/07/2026 19:30",
    location: "Sala do condomínio",
    portalUrl: "https://app/portal/c/cd1/u/u1/assemblies",
    recipient: { role: "owner", personType: "singular" },
    correctionEmail: "gestor@central.pt",
  });
  // Pessoa singular: saudação pessoal com o nome escapado (defesa XSS).
  assertStringIncludes(html, "Caro(a) <strong>Maria &lt;b&gt;Silva&lt;/b&gt;</strong>");
  assertStringIncludes(html, "Edifício Central");
  assertStringIncludes(html, "ordinária");
  // Dia e hora (1ª/2ª convocatória + local) ficam no corpo - resumo objetivo.
  assertStringIncludes(html, "10/07/2026 19:00");
  assertStringIncludes(html, "10/07/2026 19:30");
  assertStringIncludes(html, "Sala do condomínio");
  // WHY: o corpo do email é uma nota de cobertura; a ordem do dia completa vive
  // na convocatória anexa (PDF), não se repete inline (pedido do user).
  assertStringIncludes(html, "convocatória</strong> (com a ordem do dia)");
  // Link ao portal + menção dos 2 anexos. Owner: procuração para SE representar.
  assertStringIncludes(html, "https://app/portal/c/cd1/u/u1/assemblies");
  assertStringIncludes(html, "modelo de procuração</strong> (caso não possa comparecer");
  // Nota de correção (dados pessoais) com o email da administração.
  assertStringIncludes(html, "Se algum dado (nome, NIF, fração ou titularidade) estiver incorreto");
  assertStringIncludes(html, "gestor@central.pt");
  // Sem travessões em-dash (convenção do projeto).
  assertEquals(html.includes("—"), false);
});

Deno.test("convocação: a ordem do dia NÃO se repete no corpo do email (vive no anexo)", () => {
  // WHY: o user pediu um email objetivo; os assuntos da ordem do dia não devem
  // aparecer no corpo - quem precisa do detalhe abre a convocatória anexa.
  const html = assemblyConvocationEmailHtml({
    recipientName: "Maria",
    condominiumName: "Edifício Central",
    designationType: "building",
    assemblyType: "ordinary",
    firstConvocation: "10/07/2026 19:00",
    secondConvocation: null,
    location: null,
    portalUrl: "https://app/portal",
    recipient: { role: "owner", personType: "singular" },
    correctionEmail: null,
  });
  assertEquals(html.includes("Aprovação do orçamento 2026"), false);
  assertEquals(html.includes("Outros assuntos"), false);
});

Deno.test("convocação (owner coletiva): trata por 'Exmos. Senhores' + nota da sociedade", () => {
  // WHY: uma empresa não "comparece" pessoalmente nem se trata por "Caro(a)";
  // representa-se por procurador e a nota é sobre dados da sociedade.
  const html = assemblyConvocationEmailHtml({
    recipientName: "Imobiliária X, Lda",
    condominiumName: "Cond A",
    designationType: "condominium",
    assemblyType: "ordinary",
    firstConvocation: "10/07/2026 19:00",
    secondConvocation: null,
    location: null,
    portalUrl: "https://app/portal",
    recipient: { role: "owner", personType: "collective" },
    correctionEmail: "gestor@a.pt",
  });
  assertStringIncludes(html, "Exmos. Senhores,");
  // Não usa a saudação pessoal nem a redação de "comparecer".
  assertEquals(html.includes("Caro(a)"), false);
  assertStringIncludes(html, "caso a sociedade pretenda fazer-se representar por procurador");
  assertStringIncludes(
    html,
    "Se algum dado da sociedade (denominação, NIPC, fração ou titularidade)",
  );
  assertStringIncludes(html, "gestor@a.pt");
  assertEquals(html.includes("—"), false);
});

Deno.test("convocação: extraordinária + sem 2ª convocatória + sem local", () => {
  const html = assemblyConvocationEmailHtml({
    recipientName: "Ana",
    condominiumName: "Cond A",
    designationType: "condominium",
    assemblyType: "extraordinary",
    firstConvocation: "01/09/2026 18:00",
    secondConvocation: null,
    location: null,
    portalUrl: "https://app/portal",
    recipient: { role: "owner", personType: "singular" },
    correctionEmail: "gestor@a.pt",
  });
  assertStringIncludes(html, "extraordinária");
  assertStringIncludes(html, "01/09/2026 18:00");
  assertEquals(html.includes("2.ª convocatória"), false);
});

Deno.test("convocação (resident): donos da fração + procuração em branco + nota de estatuto", () => {
  // WHY (ADR 0034): o residente não vota; o email diz-lhe quem o pode nomear e
  // que a procuração anexa sai EM BRANCO (não em nome dele - seria inválida). A
  // nota final é sobre o ESTATUTO (avisar se afinal é proprietário), não dados.
  const html = assemblyConvocationEmailHtml({
    recipientName: "Maria Reside",
    condominiumName: "Cond A",
    designationType: "condominium",
    assemblyType: "ordinary",
    firstConvocation: "10/07/2026 19:00",
    secondConvocation: null,
    location: null,
    portalUrl: "https://app/portal",
    recipient: { role: "resident", ownerNames: ["João Dono", "Ana Dona"] },
    correctionEmail: "gestor@a.pt",
  });
  // Não vota; lista TODOS os donos (compropriedade).
  assertStringIncludes(html, "não dispõe de voto próprio");
  assertStringIncludes(html, "João Dono, Ana Dona");
  // Procuração em branco (não a redação do owner).
  assertStringIncludes(html, "procuração em branco");
  assertEquals(html.includes("caso não possa comparecer e queira fazer-se representar"), false);
  // Nota de estatuto: avisar se afinal é proprietário (não "nome, NIF, ...").
  assertStringIncludes(html, "Se é o(a) proprietário(a) desta fração e não consta como tal");
  assertEquals(html.includes("Se algum dado (nome, NIF"), false);
  assertEquals(html.includes("—"), false);
});

Deno.test("convocação: sem correctionEmail -> nota sai sem endereço (não rebenta)", () => {
  const html = assemblyConvocationEmailHtml({
    recipientName: "Ana",
    condominiumName: "Cond A",
    designationType: "condominium",
    assemblyType: "ordinary",
    firstConvocation: "10/07/2026 19:00",
    secondConvocation: null,
    location: null,
    portalUrl: "https://app/portal",
    recipient: { role: "owner", personType: "singular" },
    correctionEmail: null,
  });
  assertStringIncludes(html, "estiver incorreto");
  // Sem endereço -> sem o link mailto.
  assertEquals(html.includes("mailto:"), false);
});

Deno.test("convocação (resident): sem donos conhecidos -> frase genérica, não aborta", () => {
  const html = assemblyConvocationEmailHtml({
    recipientName: "Reside",
    condominiumName: "Cond A",
    designationType: "condominium",
    assemblyType: "ordinary",
    firstConvocation: "10/07/2026 19:00",
    secondConvocation: null,
    location: null,
    portalUrl: "https://app/portal",
    recipient: { role: "resident", ownerNames: [] },
    correctionEmail: "gestor@a.pt",
  });
  assertStringIncludes(html, "o(s) proprietário(s) da fração");
  assertStringIncludes(html, "procuração em branco");
});

// ─── ticketCreatedEmailHtml ───────────────────────────────────────────────
// Email para a caixa do condomínio quando o portal regista uma ocorrência.
// A ficha (fração, reporter, categoria) é o que permite triagem sem abrir o
// painel - por isso testa-se a presença, não o layout.

Deno.test("ticket criado: ficha de triagem completa + link para o painel", () => {
  const html = ticketCreatedEmailHtml({
    condominiumName: "Edifício Central",
    designationType: "building",
    ticketCode: "T001",
    ticketTitle: "Elevador parado",
    unitDesignation: "1ºA",
    reporterName: "Maria Silva",
    categoryLabel: "Elevador",
    priorityLabel: "Urgente",
    location: "Hall do 2º piso",
    description: "Parou entre pisos.",
    ticketUrl: "https://app/admin/c/abc/tickets/t1",
  });
  assertStringIncludes(html, "T001");
  assertStringIncludes(html, "Elevador parado");
  assertStringIncludes(html, "1ºA");
  assertStringIncludes(html, "Maria Silva");
  assertStringIncludes(html, "Urgente");
  assertStringIncludes(html, "Hall do 2º piso");
  assertStringIncludes(html, "Parou entre pisos.");
  assertStringIncludes(html, "https://app/admin/c/abc/tickets/t1");
});

Deno.test("ticket criado: sem localização nem descrição não deixa linhas vazias", () => {
  const html = ticketCreatedEmailHtml({
    condominiumName: "C",
    designationType: "condominium",
    ticketCode: "T002",
    ticketTitle: "Ruído",
    unitDesignation: "2ºB",
    reporterName: "João",
    categoryLabel: "Outros",
    priorityLabel: "Normal",
    location: null,
    description: null,
    ticketUrl: "https://x",
  });
  assertEquals(html.includes("Localização"), false);
  assertEquals(html.includes("Descrição"), false);
});

Deno.test("ticket criado: input do condómino é escapado (XSS via título)", () => {
  const html = ticketCreatedEmailHtml({
    condominiumName: "C",
    designationType: "condominium",
    ticketCode: "T003",
    ticketTitle: "<script>alert(1)</script>",
    unitDesignation: "1ºA",
    reporterName: "X",
    categoryLabel: "Outros",
    priorityLabel: "Normal",
    location: null,
    description: null,
    ticketUrl: "https://x",
  });
  assertEquals(html.includes("<script>"), false);
  assertStringIncludes(html, "&lt;script&gt;");
});

// ─── ticketActivityEmailHtml ──────────────────────────────────────────────
// Serve os dois sentidos. O que muda por sentido: saudação (nome vs
// institucional), destino do botão e a existência de transição de estado.

Deno.test("interação: comentário do admin trata o reporter pelo nome", () => {
  const html = ticketActivityEmailHtml({
    recipientName: "Maria Silva",
    condominiumName: "Edifício Central",
    designationType: "building",
    ticketCode: "T001",
    ticketTitle: "Elevador parado",
    unitDesignation: "1ºA",
    authorLabel: "A administração",
    statusChange: null,
    statusLabel: "Em progresso",
    comment: "Técnico marcado para amanhã.",
    ticketUrl: "https://app/portal/c/abc/u/u1/tickets/t1",
    buttonLabel: "Ver no portal",
  });
  assertStringIncludes(html, "Maria Silva");
  assertStringIncludes(html, "Técnico marcado para amanhã.");
  assertStringIncludes(html, "Ver no portal");
  assertStringIncludes(html, "https://app/portal/c/abc/u/u1/tickets/t1");
  // Sem transição -> não anuncia mudança de estado.
  assertEquals(html.includes("passou de"), false);
});

Deno.test("interação: sem nome (caixa do condomínio) usa saudação institucional", () => {
  const html = ticketActivityEmailHtml({
    recipientName: null,
    condominiumName: "C",
    designationType: "condominium",
    ticketCode: "T001",
    ticketTitle: "Infiltração",
    unitDesignation: "1ºA",
    authorLabel: "Maria Silva",
    statusChange: null,
    statusLabel: "Aberto",
    comment: "Continua a pingar.",
    ticketUrl: "https://app/admin/c/abc/tickets/t1",
    buttonLabel: "Abrir no painel",
  });
  assertStringIncludes(html, "Exmos. Senhores");
  assertStringIncludes(html, "Maria Silva");
  assertStringIncludes(html, "Abrir no painel");
});

Deno.test("interação: mudança de estado anuncia origem e destino", () => {
  const html = ticketActivityEmailHtml({
    recipientName: "Maria",
    condominiumName: "C",
    designationType: "condominium",
    ticketCode: "T001",
    ticketTitle: "Elevador parado",
    unitDesignation: "1ºA",
    authorLabel: "A administração",
    statusChange: { from: "Aberto", to: "Resolvido" },
    statusLabel: "Resolvido",
    comment: 'Estado alterado de "Aberto" para "Resolvido".',
    ticketUrl: "https://x",
    buttonLabel: "Ver no portal",
  });
  assertStringIncludes(html, "passou de");
  assertStringIncludes(html, "Aberto");
  assertStringIncludes(html, "Resolvido");
});

Deno.test("interação: ocorrência sem fração não imprime linha de fração", () => {
  const html = ticketActivityEmailHtml({
    recipientName: null,
    condominiumName: "C",
    designationType: "condominium",
    ticketCode: "T009",
    ticketTitle: "Zona comum",
    unitDesignation: null,
    authorLabel: "A administração",
    statusChange: null,
    statusLabel: "Aberto",
    comment: "Nota.",
    ticketUrl: "https://x",
    buttonLabel: "Abrir no painel",
  });
  assertEquals(html.includes("Fração"), false);
});

Deno.test("interação: comentário é escapado e mantém quebras de linha", () => {
  const html = ticketActivityEmailHtml({
    recipientName: "M",
    condominiumName: "C",
    designationType: "condominium",
    ticketCode: "T001",
    ticketTitle: "T",
    unitDesignation: "1ºA",
    authorLabel: "A administração",
    statusChange: null,
    statusLabel: "Aberto",
    comment: "linha1\n<img onerror=alert>",
    ticketUrl: "https://x",
    buttonLabel: "Ver no portal",
  });
  assertEquals(html.includes("<img onerror"), false);
  assertStringIncludes(html, "&lt;img onerror=alert&gt;");
  assertStringIncludes(html, "linha1<br>");
});
