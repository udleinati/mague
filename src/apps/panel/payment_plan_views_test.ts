// Smoke tests de render (ADR 0039): garantem que os templates novos compilam
// em Vento e mostram as colunas/filtros/badges certos. Sem BD/API - render
// puro com dados mock (mesmo harness do page_header_test).

import { assert, assertStringIncludes } from "@std/assert";
import { render } from "./render.ts";

const overdueUnit = (over: Partial<Record<string, unknown>> = {}) => ({
  unitId: "u1",
  unitLabel: "1ºE",
  totalOwedCents: 60000,
  overdueBeyondThresholdCents: 45000,
  creditCents: 0,
  oldestOverdueDueDate: "2026-02-10",
  lastReminderAt: null,
  inCooldown: false,
  cooldownUntil: null,
  hasActivePlan: false,
  paymentPlan: null,
  ...over,
});

Deno.test("billing-reminders: duas colunas (Vencido + Total vencido)", async () => {
  const html = await render("pages/billing_reminders/list.vto", {
    currentCondominiumId: "c1",
    reconciledThroughDate: "2026-05-20",
    guard: { ok: true },
    filters: { overdue: 30, plan: "all" },
    units: [overdueUnit()],
  });
  // Coluna "Vencido +Nd" acompanha o bloco de antiguidade ativo (30/60/90);
  // "Total vencido" mantém-se como coluna distinta.
  assertStringIncludes(html, "Vencido +30d");
  assertStringIncludes(html, "Total vencido");
  // O valor do bloco (45000) e o total (60000) ambos presentes e distintos.
  assertStringIncludes(html, "450,00");
  assertStringIncludes(html, "600,00");
});

Deno.test("billing-reminders: tfoot soma 'Vencido +Nd' e 'Total vencido' das frações listadas", async () => {
  // Intenção (Rule 9): o rodapé totaliza as duas colunas de valor. Valores
  // escolhidos para que nenhuma somatória coincida com uma célula individual -
  // se a reduce somar o campo errado (ou não somar), as asserções falham.
  const html = await render("pages/billing_reminders/list.vto", {
    currentCondominiumId: "c1",
    reconciledThroughDate: "2026-05-20",
    guard: { ok: true },
    filters: { overdue: 30, plan: "all" },
    units: [
      overdueUnit({ overdueBeyondThresholdCents: 45000, totalOwedCents: 60000 }),
      overdueUnit({
        unitId: "u2",
        unitLabel: "2ºD",
        overdueBeyondThresholdCents: 30000,
        totalOwedCents: 25000,
      }),
    ],
  });
  // Vencido: 45000 + 30000 = 75000 -> "750,00"; total: 60000 + 25000 = 85000 -> "850,00".
  assertStringIncludes(html, "750,00");
  assertStringIncludes(html, "850,00");
});

Deno.test("billing-reminders: barra de filtros bloco + plano com estado ativo", async () => {
  const html = await render("pages/billing_reminders/list.vto", {
    currentCondominiumId: "c1",
    reconciledThroughDate: "2026-05-20",
    guard: { ok: true },
    filters: { overdue: 60, plan: "without" },
    units: [overdueUnit()],
  });
  assertStringIncludes(html, "+60d");
  assertStringIncludes(html, "+90d");
  assertStringIncludes(html, "Só sem plano");
  assertStringIncludes(html, "Só com plano");
  // Filtro corrente propaga-se nos hx-get e no envio (query string).
  assertStringIncludes(html, "overdue=90&plan=without");
  assertStringIncludes(html, "?overdue=60&plan=without");
});

Deno.test("billing-reminders: bloco +1d existe e a coluna Vencido acompanha", async () => {
  // ADR 0028/0039: o bloco +1 baixa o gatilho para "vencida há >= 1
  // dia"; a coluna "Vencido +1d" tem de refletir o filtro ativo.
  const html = await render("pages/billing_reminders/list.vto", {
    currentCondominiumId: "c1",
    reconciledThroughDate: "2026-05-20",
    guard: { ok: true },
    filters: { overdue: 1, plan: "all" },
    units: [overdueUnit()],
  });
  assertStringIncludes(html, "+1d");
  assertStringIncludes(html, "Vencido +1d");
  // hx-get dos outros blocos preserva o plano corrente.
  assertStringIncludes(html, "?overdue=1&plan=all");
});

Deno.test("billing-reminders: badge 'Em plano' e bulk exclui plano da contagem", async () => {
  const html = await render("pages/billing_reminders/list.vto", {
    currentCondominiumId: "c1",
    reconciledThroughDate: "2026-05-20",
    guard: { ok: true },
    filters: { overdue: 30, plan: "all" },
    units: [
      overdueUnit({ unitId: "u1" }),
      overdueUnit({
        unitId: "u2",
        unitLabel: "2ºD",
        hasActivePlan: true,
        paymentPlan: { notes: "6x 200", internalNotes: null, endDate: "2026-12-31" },
      }),
    ],
  });
  assertStringIncludes(html, "Em plano");
  // 2 frações listadas mas só 1 elegível para bulk (a outra está em plano).
  assertStringIncludes(html, "Enviar a todas (1)");
  // O envio individual da fração em plano avisa qual email segue (ADR 0039)
  // - o admin sabe que o condómino lê a descrição do plano.
  assertStringIncludes(html, "segue o email de plano, com a descrição do plano");
});

Deno.test("units/show: modais do plano têm nota partilhada e nota interna, com o aviso certo", async () => {
  // A partilhada sai no email de lembrete; a interna nunca. O admin tem de o
  // saber ao escrever, nos dois sítios onde escreve (criar e editar).
  const html = await render("pages/units/_show_modals.vto", {
    currentCondominiumId: "c1",
    unitId: "u1",
    unit: { designation: "1ºE" },
    activePaymentPlan: {
      id: "p1",
      notes: "6x 200",
      internalNotes: "Ligou a dizer que atrasa",
      endDate: null,
    },
  });
  const count = (needle: string) => html.split(needle).length - 1;
  assert(count('name="notes"') === 2, "nota partilhada no criar E no editar");
  assert(count('name="internalNotes"') === 2, "nota interna no criar E no editar");
  assert(count("Visível ao condómino: esta nota e a data final seguem no email") === 2);
  assert(count("Só a administração vê. Não sai nos emails") === 2);
  // Nenhuma é obrigatória sozinha: basta uma das duas.
  assert(!/<textarea[^>]*name="(notes|internalNotes)"[^>]*required/.test(html));
  // O editar vem pré-preenchido com as duas.
  assertStringIncludes(html, ">6x 200</textarea>");
  assertStringIncludes(html, ">Ligou a dizer que atrasa</textarea>");
});

// Só o card do plano: a página inclui os modais, que também têm os rótulos.
const planCardOf = (html: string) =>
  html.slice(html.indexOf("Plano de pagamento"), html.indexOf("Ocupantes ativos"));

Deno.test("units/show: card do plano mostra as duas notas, cada uma com o seu rótulo", async () => {
  const html = await render(
    "pages/units/show.vto",
    showData({
      activePaymentPlan: {
        id: "pp1",
        status: "active",
        notes: "6 prestações de 200 EUR",
        internalNotes: "Pediu para não ligar de manhã",
        endDate: null,
        createdAt: "2026-06-01",
      },
      paymentPlanHistory: [],
      activePaymentPlanExpired: false,
    }),
  );
  const card = planCardOf(html);
  assertStringIncludes(card, "Nota partilhada");
  assertStringIncludes(card, "Nota interna");
  assert(
    card.indexOf("Nota partilhada") < card.indexOf("6 prestações de 200 EUR") &&
      card.indexOf("Nota interna") < card.indexOf("Pediu para não ligar de manhã"),
    "cada nota aparece debaixo do seu rótulo",
  );
});

Deno.test("units/show: plano só com nota interna não mostra rótulo de partilhada", async () => {
  // Os planos migrados ficaram só com nota interna.
  const html = await render(
    "pages/units/show.vto",
    showData({
      activePaymentPlan: {
        id: "pp1",
        status: "active",
        notes: null,
        internalNotes: "Combinado pagar em três prestações.",
        endDate: null,
        createdAt: "2026-06-01",
      },
      paymentPlanHistory: [],
      activePaymentPlanExpired: false,
    }),
  );
  const card = planCardOf(html);
  assertStringIncludes(card, "Combinado pagar em três prestações.");
  assert(!card.includes("Nota partilhada"), "sem nota partilhada, sem rótulo vazio");
});

Deno.test("billing-reminders: tooltip do plano mostra as duas notas ao admin", async () => {
  const html = await render("pages/billing_reminders/list.vto", {
    currentCondominiumId: "c1",
    reconciledThroughDate: "2026-05-20",
    guard: { ok: true },
    filters: { overdue: 30, plan: "all" },
    units: [
      overdueUnit({
        hasActivePlan: true,
        paymentPlan: { notes: "6x 200", internalNotes: "Atrasa sempre", endDate: null },
      }),
    ],
  });
  assertStringIncludes(html, 'data-tip="Partilhada: 6x 200 · Interna: Atrasa sempre"');
});

Deno.test("billing-reminders: nota da administração gravada pré-preenche o textarea", async () => {
  // A nota é persistente no condomínio (ADR 0028) e editada nesta página: ao
  // abrir, o textarea tem de mostrar o valor guardado, senão o admin pensa que
  // o perdeu e reescreve.
  const html = await render("pages/billing_reminders/list.vto", {
    currentCondominiumId: "c1",
    reconciledThroughDate: "2026-05-20",
    guard: { ok: true },
    filters: { overdue: 30, plan: "all" },
    units: [],
    condominium: { billingReminderNote: "Pagar até 30/06 conforme assembleia." },
  });
  assertStringIncludes(html, "Nota da administração");
  assertStringIncludes(html, "Guardar nota");
  assertStringIncludes(html, "/billing-reminders/note");
  assertStringIncludes(html, "Pagar até 30/06 conforme assembleia.");
});

Deno.test("billing-reminders: sem condomínio no contexto, o textarea da nota fica vazio (não rebenta)", async () => {
  // No harness de render puro `condominium` é null; o optional chaining evita
  // o TypeError. Em produção o condomínio existe sempre, mas o template tem de
  // ser robusto.
  const html = await render("pages/billing_reminders/list.vto", {
    currentCondominiumId: "c1",
    reconciledThroughDate: "2026-05-20",
    guard: { ok: true },
    filters: { overdue: 30, plan: "all" },
    units: [],
  });
  assertStringIncludes(html, "Nota da administração");
});

Deno.test("billing-reminders: ícone 'Ver' (ADR 0022) abre o email num modal de pré-visualização", async () => {
  // Segue o padrão dos demais: olho + label "Ver" (não "Visualizar"), e o
  // email mostra-se num modal+iframe (mesmo padrão do histórico de emails).
  const html = await render("pages/billing_reminders/list.vto", {
    currentCondominiumId: "c1",
    reconciledThroughDate: "2026-05-20",
    guard: { ok: true },
    filters: { overdue: 30, plan: "all" },
    units: [overdueUnit({ unitId: "u1" })],
  });
  // Ícone do olho (kind:"view" do action_link.vto) + chamada ao modal por fração.
  assertStringIncludes(html, "M15 12a3 3 0 11-6 0");
  assertStringIncludes(
    html,
    "openBillingPreview('/admin/c/c1/billing-reminders/units/u1/preview')",
  );
  // Modal + iframe sandbox partilhados (uma só vez, fora do swap HTMX).
  assertStringIncludes(html, 'id="billing_preview_modal"');
  assertStringIncludes(html, "<iframe");
  // O modal mostra o assunto do email, lido do JSON da rota de preview.
  assertStringIncludes(html, 'id="billing_preview_subject"');
  assertStringIncludes(html, "subject.textContent = data.subject");
});

// ─── Badge na listagem de frações ─────────────────────────────────────

Deno.test("units/list: badge 'Em plano' só na fração com plano ativo", async () => {
  const baseUnit = (over: Record<string, unknown>) => ({
    id: "u1",
    designation: "1ºE",
    identifier: "1-Esq",
    unitType: "residential",
    permillage: "100",
    block: null,
    floor: "1",
    door: "E",
    occupants: [],
    overdueDebtCents: 0,
    futureDebtCents: 0,
    isActive: true,
    hasActivePlan: false,
    ...over,
  });
  const html = await render("pages/units/list.vto", {
    currentCondominiumId: "c1",
    units: [
      baseUnit({ id: "u1", designation: "1ºE", hasActivePlan: true }),
      baseUnit({ id: "u2", designation: "2ºD", hasActivePlan: false }),
    ],
    stats: {
      total: 2,
      occupantsTotal: 0,
      unitsOverdue: 0,
      totalOverdueCents: 0,
      totalFutureDebtCents: 0,
    },
    totalPm: 1000,
    remaining: 0,
  });
  // Exatamente 1 badge "Em plano" (a fração u1), não 2.
  assertStringIncludes(html, "Em plano");
  assert(
    html.split("Em plano").length - 1 === 1,
    "deve haver exatamente 1 badge 'Em plano' na listagem",
  );
});

// ─── Card de plano na página da fração ────────────────────────────────

const showData = (over: Record<string, unknown>) => ({
  currentCondominiumId: "c1",
  condominium: { reconciledThroughDate: "2026-05-20" },
  unit: {
    designation: "1ºE",
    isActive: true,
    identifier: "1-Esq",
    unitType: "residential",
    permillage: 100,
    block: null,
    floor: "1",
    door: "E",
    description: null,
    occupants: [],
  },
  unitId: "u1",
  activeOccupants: [],
  pastOccupants: [],
  charges: [],
  bankBreakdown: [],
  insuranceStatus: null,
  insurancePolicies: [],
  unitEmails: [],
  stats: {
    overdueCents: 0,
    futureDebtCents: 0,
    creditBalanceCents: 0,
    chargesCount: 0,
    settlementsCount: 0,
    bankBreakdownCount: 0,
  },
  currentUser: { role: "super" },
  ...over,
});

Deno.test("units/show: card de plano ativo mostra descrição + transições", async () => {
  const html = await render(
    "pages/units/show.vto",
    showData({
      activePaymentPlan: {
        id: "pp1",
        status: "active",
        notes: "6 prestações de 200 EUR",
        endDate: "2026-12-31",
        createdAt: "2026-06-01",
      },
      paymentPlanHistory: [],
      activePaymentPlanExpired: false,
    }),
  );
  assertStringIncludes(html, "Plano de pagamento");
  assertStringIncludes(html, "6 prestações de 200 EUR");
  assertStringIncludes(html, "Marcar cumprido");
  // PT-PT: um plano falhado está "em incumprimento", nunca "quebrado".
  assertStringIncludes(html, "Marcar incumprimento");
  // O confirm anuncia o ESTADO, não repete o rótulo do botão.
  assertStringIncludes(html, "como «em incumprimento»");
});

Deno.test("units/show: sem plano mostra CTA de criar", async () => {
  const html = await render(
    "pages/units/show.vto",
    showData({
      activePaymentPlan: null,
      paymentPlanHistory: [],
      activePaymentPlanExpired: false,
    }),
  );
  assertStringIncludes(html, "não está em plano de pagamento");
  assertStringIncludes(html, "Criar plano");
  assert(!html.includes("Marcar cumprido"), "sem plano não mostra transições");
});

Deno.test("units/show: histórico de planos terminais com rótulo de estado", async () => {
  const html = await render(
    "pages/units/show.vto",
    showData({
      activePaymentPlan: null,
      paymentPlanHistory: [
        {
          id: "pp0",
          status: "broken",
          notes: "plano antigo",
          endDate: "2026-03-01",
          endedAt: "2026-03-15",
        },
      ],
      activePaymentPlanExpired: false,
    }),
  );
  assertStringIncludes(html, "Histórico");
  assertStringIncludes(html, "Em incumprimento");
  assertStringIncludes(html, "plano antigo");
});
