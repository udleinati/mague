// Smoke tests de render dos seguros: nota da administração (index.vto) e o
// botão "ver" de pré-visualização (_rows.vto). Sem BD/API - render puro com
// dados mock (mesmo harness do payment_plan_views_test).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { render } from "./render.ts";
import {
  type AggregateKind,
  classifyPolicy,
  isAdminDocumented,
  policyCapabilities,
  PRESUMED_EVIDENCE_GRACE_DAYS,
  presumedEvidenceGap,
  reminderTriggerFor,
  unitUpdateAction,
} from "$shared/insurance/policy_status.ts";
import { matchesInsuranceFilters, withRenewalDates } from "./controllers/insurance_list_state.ts";

const TODAY = new Date("2026-03-01T00:00:00Z");
/** Data ISO a `n` dias de TODAY (negativo = passado). */
const isoDay = (n: number) => new Date(TODAY.getTime() + n * 86_400_000).toISOString().slice(0, 10);

const emptySummary = {
  active: 0,
  expiring_soon: 0,
  expired: 0,
  awaiting_approval: 0,
  awaiting_confirmation: 0,
  rejected_only: 0,
  never_submitted: 0,
};

const indexCtx = (over: Record<string, unknown> = {}) => ({
  currentCondominiumId: "c1",
  units: [],
  totalUnits: 1, // > 0 -> ramo com a nota (não o empty-state global)
  summary: emptySummary,
  availableYears: [],
  filterYear: null,
  filterStatus: null,
  cooldownCount: 0,
  cooldownDays: 7,
  noticeDays: 30,
  remindableCount: 0,
  presumedPendingCount: 0,
  presumedPendingFilter: "presumed_pending",
  adminDocumentedFilter: "admin_documented",
  ...over,
});

/** Row da fração com o `reminderTrigger` derivado do predicado real - é o que o
 *  controller faz, e é o que decide se há botão de envio e com que legenda. */
const unitRow = (over: Record<string, unknown> = {}) => {
  const base = {
    unit: { id: "u1", designation: "1ºE", identifier: null },
    occupants: [{ name: "Ana" }],
    aggregate: "expired",
    counts: {},
    policies: [],
    status: { kind: "expired", policy: null },
    lastReminderAt: null,
    lastRenewalEvidenceAt: null,
    presumedEvidenceDays: null,
    inCooldown: false,
    cooldownUntil: null,
    hasOccupantWithEmail: true,
    ...over,
  };
  // `updateAction` pelo predicado real, com o shape do read-model (id da apólice).
  const entries = base.policies as Array<{ policy?: { id: string; status: string } }>;
  const action = unitUpdateAction(
    entries.flatMap((e) => (e.policy ? [e.policy] : [])),
    TODAY,
  );
  return {
    ...base,
    reminderTrigger: reminderTriggerFor({
      aggregate: base.aggregate as AggregateKind,
      presumedEvidenceDays: base.presumedEvidenceDays as number | null,
    }),
    updateAction: action.kind === "renew" ? { kind: "renew", policyId: action.policy.id } : action,
  };
};

Deno.test("seguros: nota da administração gravada pré-preenche o textarea", async () => {
  // A nota é persistente no condomínio e editada nesta página:
  // ao abrir, o textarea tem de mostrar o valor guardado, senão o admin pensa
  // que o perdeu e reescreve.
  const html = await render(
    "pages/insurance/index.vto",
    indexCtx({
      condominium: { insuranceReminderNote: "Submeta a apólice até 30/06." },
    }),
  );
  assertStringIncludes(html, "Nota da administração");
  assertStringIncludes(html, "Guardar nota");
  assertStringIncludes(html, "/insurances/note");
  assertStringIncludes(html, "Submeta a apólice até 30/06.");
  // Modal + função de pré-visualização presentes (fora das linhas).
  assertStringIncludes(html, "insurance_preview_modal");
  assertStringIncludes(html, "openInsurancePreview");
  // O modal mostra o assunto do email, lido do JSON da rota de preview.
  assertStringIncludes(html, 'id="insurance_preview_subject"');
  assertStringIncludes(html, "subject.textContent = data.subject");
});

Deno.test("seguros: sem condomínio no contexto, o textarea da nota fica vazio (não rebenta)", async () => {
  // No harness de render puro `condominium` é null; o optional chaining evita
  // o TypeError. Em produção o condomínio existe sempre.
  const html = await render("pages/insurance/index.vto", indexCtx());
  assertStringIncludes(html, "Nota da administração");
});

Deno.test("seguros (_rows): fração com email tem 'ver' que abre a pré-visualização", async () => {
  // Intenção: o botão "ver" só serve para algo se chamar o preview da fração
  // certa; o URL tem de conter o unitId e o sufixo /preview.
  const html = await render("pages/insurance/_rows.vto", {
    u: unitRow({ hasOccupantWithEmail: true }),
    currentCondominiumId: "c1",
    oob: false,
  });
  assertStringIncludes(html, "openInsurancePreview");
  assertStringIncludes(html, "/insurances/reminders/u1/preview");
  // Com email, o "ver" não está desativado.
  assert(!/openInsurancePreview[^>]*disabled/.test(html));
});

Deno.test("seguros (_rows): fração sem email tem 'ver' desativado (igual ao 'lembrar')", async () => {
  // Decisão: sem occupant com email não há destinatário, logo "ver" desativa-se
  // tal como o "lembrar" (o preview precisa de um destinatário real).
  const html = await render("pages/insurance/_rows.vto", {
    u: unitRow({ hasOccupantWithEmail: false }),
    currentCondominiumId: "c1",
    oob: false,
  });
  // O botão "ver" (onclick openInsurancePreview) sai com `disabled`.
  assert(/openInsurancePreview[\s\S]*?disabled/.test(html));
});

// ─── Gates dos botões de ação (ADR 0040) ─────────────────────────────────────

/**
 * Policy "mínima viável" para o corpo do _rows.vto não rebentar, com o `can.*`
 * calculado pelo MESMO predicado que o read-model usa. Os testes de gate abaixo
 * exercem então a cadeia real (domínio → can → template), não uma cópia da regra.
 */
const detailPolicy = (over: Record<string, unknown> = {}) => {
  const base = {
    id: "p1",
    status: "active",
    validFrom: isoDay(-365),
    validTo: isoDay(0),
    policyNumber: "POL-1",
    insurer: "Fidelidade",
    coverageAmountCents: null,
    createdAt: isoDay(-365) + "T00:00:00Z",
    confirmedAt: null,
    approvedAt: null,
    rejectedAt: null,
    presumedAt: null,
    rejectedReason: null,
    attachmentCount: 0,
    attachments: [],
    evidenceSource: null,
    ...over,
  };
  return {
    ...base,
    kind: classifyPolicy(base, TODAY).kind,
    can: policyCapabilities(base, TODAY, { isAdmin: true }),
    presumedEvidence: presumedEvidenceGap(base, TODAY),
    adminDocumented: isAdminDocumented(base),
  };
};

/** `withRenewalDates` é o mesmo enriquecimento que o controller aplica antes de
 *  renderizar - as datas do modal saem daqui, não de uma cópia no teste. */
const rowsWith = (entry: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  render("pages/insurance/_rows.vto", {
    u: withRenewalDates(
      unitRow({ policies: [entry], status: { kind: entry.kind, policy: entry.policy }, ...over }),
    ),
    currentCondominiumId: "c1",
    oob: false,
  });

Deno.test("seguros (_rows): vencida há 100 dias mostra 'renovar' (PRD #7: tratar as em falha)", async () => {
  const html = await rowsWith({
    kind: "expired",
    daysOverdue: 100,
    policy: detailPolicy({ validTo: isoDay(-100) }),
  });
  assertStringIncludes(html, "/insurances/p1/renew");
});

Deno.test("seguros (_rows): vencida há 400 dias esconde 'renovar' (> 1 ano: submeter nova)", async () => {
  const html = await rowsWith({
    kind: "expired",
    daysOverdue: 400,
    policy: detailPolicy({ validTo: isoDay(-400) }),
  });
  assert(!/insurances\/p1\/renew/.test(html));
  // Mas continua eliminável pelo admin (sem cobertura viva).
  assertStringIncludes(html, "/insurances/p1/delete");
});

Deno.test("seguros (_rows): ativa saudável esconde 'eliminar' (rejeitar primeiro)", async () => {
  // Cobertura viva: nem eliminar (rejeitar primeiro) - mas renovar já aparece,
  // porque `canRenew` não tem janela de dias (era só o template que a tinha).
  const html = await rowsWith({
    kind: "active",
    daysUntilExpiry: 306,
    policy: detailPolicy({ validTo: isoDay(306) }),
  });
  assert(!/insurances\/p1\/delete/.test(html));
});

// ─── O que a renovação leva para a nova vigência ────────────────────────────
// WHY: nº, seguradora e capital eram copiados do predecessor no servidor, sem
// aparecerem em lado nenhum. O modal precisa deles para o admin os transcrever
// do documento; sem documento, precisa ao menos de mostrar o que vai assumir.

Deno.test("seguros (_rows): o botão renovar leva os dados que a nova vai herdar", async () => {
  const html = await rowsWith({
    kind: "expiring_soon",
    daysUntilExpiry: 20,
    policy: detailPolicy({ validTo: isoDay(20), coverageAmountCents: 5_000_000 }),
  });
  assertStringIncludes(html, 'data-policy-number="POL-1"');
  assertStringIncludes(html, 'data-insurer="Fidelidade"');
  assertStringIncludes(html, 'data-coverage-cents="5000000"');
});

Deno.test("seguros: o modal de renovação tem onde transcrever o documento", async () => {
  const html = await render("pages/insurance/index.vto", indexCtx());
  assertStringIncludes(html, 'name="policyNumber"');
  assertStringIncludes(html, 'name="insurer"');
  assertStringIncludes(html, "data-renew-details");
  // Escondidos à partida: de raiz não há anterior de onde herdar, e é o JS que
  // os revela no modo renovar.
  assertStringIncludes(html, 'class="hidden space-y-4" data-renew-details');
  // E o caminho presumido diz o que copia, em vez de o fazer às escondidas.
  assertStringIncludes(html, "data-renew-inherits");
});

Deno.test("seguros (_rows): ativa a 20 dias de expirar mostra 'renovar' (B2: KPI e ação alinhados)", async () => {
  // O KPI conta "a expirar ≤ 30 dias"; antes o botão só aparecia a ≤ 15, logo o
  // admin via o problema sem ter a ação. Agora ambos derivam do domínio.
  const html = await rowsWith({
    kind: "expiring_soon",
    daysUntilExpiry: 20,
    policy: detailPolicy({ validTo: isoDay(20) }),
  });
  assertStringIncludes(html, "/insurances/p1/renew");
});

// ─── Renovação presumida: badge, undo e perseguição do comprovativo ─────────
// WHY: o `renew` manual cria sempre cobertura presumida sem evidência. Sem um
// contador visível e sem caminho de volta, essas frações ficavam marcadas como
// cobertas para sempre e a renovação por engano era irreversível.

/** Renovação presumida com `n` dias de idade e `attachmentCount` ficheiros. */
const presumida = (n: number, attachmentCount = 0) =>
  detailPolicy({
    id: "p1",
    validTo: isoDay(300),
    presumedAt: new Date(TODAY.getTime() - n * 86_400_000).toISOString(),
    renewedFromId: "p0",
    attachmentCount,
  });

/** Markup do badge (as classes vêm antes do texto). */
const badgeClassesOf = (html: string, label: string) =>
  html.slice(Math.max(0, html.indexOf(label) - 250), html.indexOf(label));

Deno.test("seguros (_rows): presumida sem comprovativo mostra há quantos dias", async () => {
  const p = presumida(5);
  const html = await rowsWith({ kind: p.kind, daysUntilExpiry: 300, policy: p });
  assertStringIncludes(html, "presumida há 5d");
  // Dentro da tolerância: âmbar, é só um seguimento normal.
  assert(5 < PRESUMED_EVIDENCE_GRACE_DAYS);
  assertStringIncludes(badgeClassesOf(html, "presumida há 5d"), "bg-amber-100");
});

Deno.test("seguros (_rows): passada a tolerância, o badge da presumida agrava", async () => {
  // A presunção envelhece: aos 45 dias sem documento deixa de ser normal.
  const p = presumida(45);
  const html = await rowsWith({ kind: p.kind, daysUntilExpiry: 300, policy: p });
  assert(PRESUMED_EVIDENCE_GRACE_DAYS < 45);
  assertStringIncludes(badgeClassesOf(html, "presumida há 45d"), "text-error");
});

Deno.test("seguros (_rows): presumida com comprovativo anexado deixa de ter badge", async () => {
  // Chegou o documento: a fração deixa de estar na lista dos que é preciso
  // perseguir, mesmo continuando a ter `presumed_at` gravado.
  const p = presumida(45, 1);
  const html = await rowsWith({ kind: p.kind, daysUntilExpiry: 300, policy: p });
  assert(!html.includes("presumida há"));
});

Deno.test("seguros (_rows): renovação presumida oferece 'desfazer renovação'", async () => {
  const p = presumida(2);
  const html = await rowsWith({ kind: p.kind, daysUntilExpiry: 300, policy: p });
  assertStringIncludes(html, "/insurances/p1/undo-renewal");
  assertStringIncludes(html, "desfazer renovação");
});

Deno.test("seguros (_rows): com comprovativo já anexado, o undo desaparece", async () => {
  // Desfazer apagaria a apólice - e com ela a evidência que acabou de chegar.
  const p = presumida(2, 1);
  const html = await rowsWith({ kind: p.kind, daysUntilExpiry: 300, policy: p });
  assert(!/insurances\/p1\/undo-renewal/.test(html));
});

Deno.test("seguros (_rows): apólice submetida de raiz nunca oferece o undo", async () => {
  const html = await rowsWith({
    kind: "active",
    daysUntilExpiry: 306,
    policy: detailPolicy({ validTo: isoDay(306) }),
  });
  assert(!/undo-renewal/.test(html));
});

Deno.test("seguros (_rows): pedido de comprovativo aparece à parte do último lembrete", async () => {
  // As duas famílias de trigger têm cooldowns distintos; renovar não cega o
  // botão "Lembrar", logo as datas não podem partilhar a mesma linha.
  const html = await render("pages/insurance/_rows.vto", {
    u: unitRow({ lastReminderAt: null, lastRenewalEvidenceAt: isoDay(-3) + "T09:00:00Z" }),
    currentCondominiumId: "c1",
    oob: false,
  });
  assertStringIncludes(html, "comprovativo pedido");
});

Deno.test("seguros (_rows): fração coberta com renovação por documentar pede o comprovativo", async () => {
  // A fração está "Ativa" - o lembrete de seguro em falta seria copy errada.
  const html = await render("pages/insurance/_rows.vto", {
    u: unitRow({ aggregate: "active", presumedEvidenceDays: 20 }),
    currentCondominiumId: "c1",
    oob: false,
  });
  assertStringIncludes(html, "Pedir comprovativo");
  assert(!html.includes("Lembrar"));
});

Deno.test("seguros (_rows): fração coberta e documentada não tem botão de envio", async () => {
  const html = await render("pages/insurance/_rows.vto", {
    u: unitRow({ aggregate: "active", presumedEvidenceDays: null }),
    currentCondominiumId: "c1",
    oob: false,
  });
  assert(!html.includes("Pedir comprovativo"));
  assert(!/insurances\/reminders\/u1/.test(html));
});

Deno.test("seguros: KPI e filtro de presumidas sem comprovativo", async () => {
  const html = await render("pages/insurance/index.vto", indexCtx({ presumedPendingCount: 3 }));
  assertStringIncludes(html, "Presumidas");
  assertStringIncludes(html, "renovadas sem comprovativo");
  assertStringIncludes(html, "status=presumed_pending");
});

// ─── Linhagem visível (B5) ──────────────────────────────────────────────────
// WHY: `renewed_from_id` era gravado, projetado e viajava na view desde o ADR
// 0040 - e nunca aparecia em lado nenhum. A cadeia de renovações era dado morto.

Deno.test("seguros (_rows): renovação mostra de que apólice veio, com link para o cartão", async () => {
  const p = detailPolicy({
    id: "p2",
    renewedFromId: "p1",
    renewedFrom: {
      id: "p1",
      policyNumber: "POL-2024",
      validFrom: isoDay(-730),
      validTo: isoDay(-365),
    },
  });
  const html = await rowsWith({ kind: p.kind, daysUntilExpiry: 300, policy: p });
  assertStringIncludes(html, "Renovação de");
  assertStringIncludes(html, "POL-2024");
  // O destino do link tem de existir na mesma linha expandida.
  assertStringIncludes(html, 'href="#policy-p1"');
  assertStringIncludes(html, 'id="policy-p2"');
});

Deno.test("seguros (_rows): apólice de raiz não inventa linhagem", async () => {
  const html = await rowsWith({
    kind: "active",
    daysUntilExpiry: 306,
    policy: detailPolicy({ validTo: isoDay(306) }),
  });
  assert(!html.includes("Renovação de"));
});

// ─── Nada aqui é automático (B1) ────────────────────────────────────────────
// WHY: a renovação do registo é sempre um clique do admin. A etiqueta que
// prometia o contrário saiu (ADR 0040); a guarda fica,
// porque o copy pode reintroduzir a promessa sem trazer a coluna de volta.

Deno.test("seguros: a UI não afirma que o sistema renova sozinho", async () => {
  const html = (await render("pages/insurance/index.vto", indexCtx())).toLowerCase();
  for (const promessa of ["renova automaticamente", "renovação automática", "auto-renova"]) {
    assert(!html.includes(promessa), `A página promete "${promessa}"`);
  }
});

// ─── Botão do bulk reminder ─────────────────────────────────────────────────
// A regra "que frações precisam de lembrete" vive em `needsReminder`; o template
// recebe a contagem já resolvida em vez de somar campos do summary à mão.

Deno.test("seguros: sem frações a lembrar, o botão do bulk não aparece", async () => {
  const html = await render("pages/insurance/index.vto", indexCtx({ remindableCount: 0 }));
  assert(!html.includes("Lembrar todos os pendentes"));
});

Deno.test("seguros: com frações a lembrar, o botão do bulk aparece", async () => {
  const html = await render("pages/insurance/index.vto", indexCtx({ remindableCount: 3 }));
  assertStringIncludes(html, "Lembrar todos os pendentes");
  assertStringIncludes(html, "/insurances/reminders");
});

// ─── Documento entregue à administração (ADR 0016) ──────────────────────────
// WHY: o administrador recebe a apólice por email ou em mão e o sistema não
// tinha onde a pôr - o único caminho de upload era o portal. O terceiro estado
// só existe na UI se for visível (badge), acionável (modal) e listável (filtro).

/** Apólice em revisão com o documento que o admin registou (D1). */
const documentoDoAdmin = (over: Record<string, unknown> = {}) =>
  detailPolicy({
    status: "pending_review",
    evidenceSource: "admin",
    attachmentCount: 1,
    attachments: [{ id: "a1", mimeType: "application/pdf", filename: "apolice.pdf" }],
    validTo: isoDay(300),
    ...over,
  });

Deno.test("seguros (_rows): documento registado pela administração é marcado como tal", async () => {
  const p = documentoDoAdmin();
  const html = await rowsWith({ kind: p.kind, policy: p });
  assertStringIncludes(html, "documento da administração");
});

Deno.test("seguros (_rows): comprovativo submetido pela fração não leva o badge", async () => {
  // A distinção inteira da D1: o mesmo anexo, origem diferente. Com o badge aqui,
  // o admin lia "fui eu que registei isto" numa prova que a condómina submeteu.
  const p = documentoDoAdmin({ evidenceSource: "unit" });
  const html = await rowsWith({ kind: p.kind, policy: p });
  assert(!html.includes("documento da administração"));
});

Deno.test("seguros (_rows): documento da administração oferece aprovar, não espera a fração", async () => {
  // D3: a fração não confirma nada, o documento chegou ao admin por email. Com o
  // `kind` a dizer "aguarda condómino" o cartão não tinha botão nenhum para
  // fechar o registo que o próprio admin acabara de criar.
  const p = documentoDoAdmin();
  const html = await rowsWith({ kind: p.kind, policy: p });
  assertStringIncludes(html, "/insurances/p1/approve");
  assert(!html.includes("Aguarda condómino"));
});

Deno.test("seguros (_rows): renovar abre o modal com a vigência seguinte pré-preenchida", async () => {
  // D8: as datas decidem-se antes de submeter, com o documento à frente. O botão
  // leva a proposta (+1 ano) e o modal deixa corrigi-la - gravar a aritmética sem
  // ninguém a conferir contra o papel era o que se queria deixar de fazer.
  const p = detailPolicy({ validTo: "2026-05-03" });
  const html = await rowsWith({ kind: p.kind, daysUntilExpiry: 63, policy: p });
  assertStringIncludes(html, "data-renew-policy");
  assertStringIncludes(html, "/insurances/p1/renew");
  assertStringIncludes(html, 'data-valid-from="2026-05-03"');
  assertStringIncludes(html, 'data-valid-to="2027-05-03"');
});

Deno.test("seguros (_rows): fração sem apólice oferece registar o documento entregue", async () => {
  const html = await render("pages/insurance/_rows.vto", {
    u: unitRow({ aggregate: "never_submitted", status: { kind: "never_submitted" } }),
    currentCondominiumId: "c1",
    oob: false,
  });
  assertStringIncludes(html, "data-create-policy");
  assertStringIncludes(html, "/insurances/units/u1");
});

Deno.test("seguros (_rows): fração com cobertura não oferece registar de raiz", async () => {
  // Havendo predecessor o caminho é renovar, que preserva a linhagem (ADR 0040).
  const p = detailPolicy({ validTo: isoDay(306) });
  const html = await rowsWith({ kind: p.kind, daysUntilExpiry: 306, policy: p });
  assert(!html.includes("data-create-policy"));
});

// ─── "Atualizar" na linha-resumo (sem expandir, sem entrar na fração) ─────────

/** Só a linha-resumo: o botão tem de estar visível sem abrir o detalhe. */
const summaryOf = (html: string) => html.split('id="unit-detail-')[0];

Deno.test("seguros (_rows): apólice renovável tem 'Atualizar' na linha-resumo que renova ESSA apólice", async () => {
  const p = detailPolicy({ validTo: "2026-05-03" });
  const summary = summaryOf(await rowsWith({ kind: p.kind, daysUntilExpiry: 63, policy: p }));
  assertStringIncludes(summary, ">Atualizar</button>");
  assertStringIncludes(summary, "data-renew-policy");
  assertStringIncludes(summary, '/insurances/p1/renew"');
  assertStringIncludes(summary, 'data-valid-from="2026-05-03"');
  assertStringIncludes(summary, 'data-valid-to="2027-05-03"');
  assert(!summary.includes("data-create-policy"), "havendo renovável, não se regista de raiz");
});

Deno.test("seguros (_rows): só rejeitada - 'Atualizar' regista de raiz (antes só pelo portal)", async () => {
  const p = detailPolicy({ status: "rejected", rejectedAt: isoDay(-5) + "T00:00:00Z" });
  const html = await rowsWith({ kind: p.kind, policy: p }, { aggregate: "rejected_only" });
  const summary = summaryOf(html);
  assertStringIncludes(summary, ">Atualizar</button>");
  assertStringIncludes(summary, "data-create-policy");
  assertStringIncludes(summary, '/insurances/units/u1"');
  // O detalhe oferece o mesmo caminho.
  assertStringIncludes(html.split('id="unit-detail-')[1], "registar apólice");
});

Deno.test("seguros (_rows): vencida há mais de 1 ano - 'Atualizar' regista de raiz", async () => {
  const p = detailPolicy({ validTo: isoDay(-400) });
  const summary = summaryOf(await rowsWith({ kind: "expired", daysOverdue: 400, policy: p }));
  assertStringIncludes(summary, "data-create-policy");
  assert(!summary.includes("data-renew-policy"));
});

Deno.test("seguros (_rows): apólice por rever - 'Rever' abre o detalhe, sem 'Atualizar'", async () => {
  // Renovar por cima dá 409 e registar duplicava a submissão: primeiro rever.
  const p = detailPolicy({ status: "pending_review", evidenceSource: "admin", attachmentCount: 1 });
  const summary = summaryOf(await rowsWith({ kind: p.kind, policy: p }, { aggregate: p.kind }));
  assertStringIncludes(summary, "data-policy-expand");
  assertStringIncludes(summary, ">Rever</button>");
  assert(!summary.includes(">Atualizar</button>"));
});

Deno.test("seguros: o JS da página abre o detalhe a partir do 'Rever'", async () => {
  const html = await render("pages/insurance/index.vto", indexCtx());
  assertStringIncludes(html, "closest('[data-policy-expand]')");
});

Deno.test("seguros: o modal leva o ficheiro e a vigência no mesmo envio", async () => {
  // O API exige as datas junto do multipart (422 sem elas): um form que só
  // mandasse o ficheiro deixava o admin com um toast de erro e nada registado.
  const html = await render("pages/insurance/index.vto", indexCtx());
  assertStringIncludes(html, 'id="modal_policy_document"');
  assertStringIncludes(html, 'hx-encoding="multipart/form-data"');
  assertStringIncludes(html, 'name="file"');
  assertStringIncludes(html, 'name="validFrom"');
  assertStringIncludes(html, 'name="validTo"');
  // O caminho de hoje (renovação presumida, sem documento) continua a existir.
  assertStringIncludes(html, "Renovar sem documento");
});

Deno.test("seguros: o dropzone do admin aceita HEIC (a exclusão é só do portal)", async () => {
  // No portal o HEIC está fora de propósito - o formulário pré-visualiza o
  // ficheiro e browsers não-Safari não o renderizam. Aqui não há pré-visualização,
  // logo vale a allowlist global, a mesma que o servidor valida.
  const html = await render("pages/insurance/index.vto", indexCtx());
  assertStringIncludes(html, "image/heic");
});

Deno.test("seguros: filtro de estado tem entrada para o documento da administração", async () => {
  // D7: sem entrada no filtro o terceiro estado é decorativo - o admin via o
  // badge numa fração e não tinha como listar as outras.
  const html = await render("pages/insurance/index.vto", indexCtx());
  assertStringIncludes(html, "status=admin_documented");
  assertStringIncludes(html, "Documento da administração");
});

// ─── Filtro `admin_documented` (predicado do controller) ───────────────────

const filterRow = (aggregate: string, adminDocumented: boolean) => ({
  aggregate,
  status: { kind: aggregate },
  presumedEvidenceDays: null,
  policies: [{ policy: { adminDocumented, validFrom: "2026-01-01", validTo: "2026-12-31" } }],
});

Deno.test("seguros (filtro): admin_documented atravessa os agregados", () => {
  // A fração documentada pelo admin está "Ativa" - se o filtro comparasse com o
  // agregado, como as abas de estado fazem, não devolvia nada.
  assertEquals(
    matchesInsuranceFilters(filterRow("active", true), { year: null, status: "admin_documented" }),
    true,
  );
});

Deno.test("seguros (filtro): admin_documented ignora o comprovativo do portal", () => {
  assertEquals(
    matchesInsuranceFilters(filterRow("active", false), { year: null, status: "admin_documented" }),
    false,
  );
});

Deno.test("seguros (filtro): as abas de estado continuam a comparar com o agregado", () => {
  // A entrada nova não pode passar a apanhar tudo: `expired` continua a ser um kind.
  assertEquals(
    matchesInsuranceFilters(filterRow("active", true), { year: null, status: "expired" }),
    false,
  );
});
