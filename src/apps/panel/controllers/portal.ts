// Portal do condómino - vista limitada à fração que o user está a "ver".
// A fração ativa vem do `uid` no path `/portal/c/:cid/u/:uid/...` (fonte única
// de verdade); o middleware injecta-a no ALS via `portalUnitId`. Admin acede
// por impersonate (botão → /u/<uid>); /portal/exit volta ao admin.

import { render } from "$panel/render.ts";
import { type PortalCharge } from "$shared/client/mod.ts";
import {
  currentCondominiumId,
  currentPortalUnitId,
  currentToken,
  currentUser,
} from "$panel/context.ts";
import { proxyDownload } from "$panel/libs/download_proxy.ts";
import {
  filterChargesByWindow,
  filterSettlementsByWindow,
  isInOwnerWindow,
  type NestedOccupantUO,
  type OwnerWindow,
  resolveOwnerWindow as resolveWindowPure,
} from "$panel/portal/owner_window.ts";
import { computeOwnerBalance } from "$panel/portal/owner_balance.ts";
import { groupSettlementsByBankTx } from "$panel/portal/bank_payments.ts";
import { loadPortalUnitContext } from "$panel/portal/portal_context.ts";
import { parseFormBool, parseFormString } from "$panel/libs/form_parsing.ts";
import {
  currentOrMostRecent,
  oldestWith,
  resolveYearFilter,
  yearOf,
} from "$shared/year_filter/mod.ts";
import { client } from "$panel/client.ts";

type Rec = Record<string, unknown>;

// Injecta o currentUser() do ALS no helper puro.
function resolveOwnerWindow(occupants: NestedOccupantUO[]): OwnerWindow | null {
  return resolveWindowPure(occupants, currentUser());
}

// Re-exporta para o resto do panel que ainda importa daqui.
export { isInOwnerWindow, type NestedOccupantUO, type OwnerWindow, resolveOwnerWindow };

// Atira se não houver unitId - handlers rodam depois do auth gate (que já a garante).
function requireUnitId(): string {
  const id = currentPortalUnitId();
  if (!id) throw new Error("portalUnitId não definido - middleware deveria ter bloqueado.");
  return id;
}

// Dashboard do portal: KPIs (atraso/futuras/crédito) + listas (próximas
// cobranças, últimos pagamentos, próxima assembleia).
export async function portalDashboard() {
  const unitId = requireUnitId();
  const today = new Date().toISOString().slice(0, 10);

  // loadPortalUnitContext: getUnit+getCondominium+ownerWindow numa chamada,
  // cacheada em ALS - render.ts (banner impersonate) reutiliza o Promise.
  const [ctx, chargesRes, settlementsRes, assembliesRes] = await Promise.all([
    loadPortalUnitContext(),
    client.portal.listCharges(unitId, { limit: "200" }),
    client.portal.listSettlements(unitId),
    client.portal.listAssemblies().catch(() => ({ data: [] as Array<Record<string, unknown>> })),
  ]);

  const { unit, condominium, ownerWindow } = ctx as typeof ctx & {
    unit: typeof ctx.unit & {
      occupants?: NestedOccupantUO[];
      balance?: {
        openDebtCents: number;
        openCreditCents: number;
        overdueDebtCents: number;
        netCents: number;
      };
    };
  };

  const allCharges = chargesRes.data;
  const charges = filterChargesByWindow(allCharges, ownerWindow);
  const allSettlements = settlementsRes.data;

  // Balance recalculado a partir das charges já na janela (a view DB
  // v_unit_balance ignora a janela; ver portal/owner_balance.ts).
  const cutoff = (condominium as { reconciledThroughDate?: string | null }).reconciledThroughDate ??
    null;
  const balance = computeOwnerBalance(charges, cutoff);

  const chargeIds = new Set(charges.map((c) => String(c.id)));
  const unitSettlements = filterSettlementsByWindow(allSettlements, chargeIds, unitId, ownerWindow);

  // Débitos open/partial/overdue, data ASC, top 5.
  const upcomingCharges = charges
    .filter((c) =>
      c.nature === "debit" &&
      (c.status === "open" || c.status === "partial" || c.status === "overdue")
    )
    .sort((a, b) =>
      String(a.competencePeriod ?? a.issueDate ?? "")
        .localeCompare(String(b.competencePeriod ?? b.issueDate ?? ""))
    )
    .slice(0, 5);

  const overdueCharges = upcomingCharges.filter((c) => c.status === "overdue");

  // Top 10 pagamentos por bank tx. Dashboard só ativos (portalExtrato inclui reverted).
  const recentBankPayments = groupSettlementsByBankTx(unitSettlements, { onlyActive: true })
    .slice(0, 10);

  // Próxima assembleia, filtrada pela janela: owner antigo não vê futuras
  // de quando já não é proprietário.
  type AssemblyRec = {
    id: string;
    type: string;
    status: string;
    scheduledAt: string;
    minutesNumber: string | null;
    location?: string | null;
  };
  const assemblies = assembliesRes.data as AssemblyRec[];
  const upcomingAssembly = assemblies
    .filter((a) =>
      a.status !== "held" && a.status !== "cancelled" &&
      a.scheduledAt >= today &&
      isInOwnerWindow(a.scheduledAt, ownerWindow)
    )
    .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))[0] ?? null;

  // Inspeções ativas (admin pode desactivar para esconder do portal).
  const requiredInspectionsRes = await client.portal.listInspections().catch(() => ({ data: [] }));

  // Estado agregado do servidor (ADR 0017), a mesma regra e a mesma antecedência
  // (OCCUPANT_NOTICE_DAYS) da página de seguros do portal.
  const insuranceStatusRes = await client.portal.getInsuranceStatus(unitId)
    .catch(() => ({ data: { status: { kind: "never_submitted" as const } } }));
  const insuranceStatus = insuranceStatusRes.data.status;
  type InspRec = {
    id: string;
    category: string;
    description: string;
    validUntil: string;
    lastDoneDate: string | null;
    status: string | null;
  };
  const requiredInspections = (requiredInspectionsRes.data as unknown as InspRec[])
    .sort((a, b) => a.validUntil.localeCompare(b.validUntil));

  // `me` é sempre não-nulo aqui (middleware exige sessão); fallback defende
  // contra race do logout durante render.
  const me = currentUser();
  const greetingName = me?.name?.split(" ")[0] ?? "Condómino";

  return await render("pages/portal/dashboard.vto", {
    title: "O meu painel",
    section: "dashboard",
    condominium,
    unit,
    greetingName,
    ownerWindow,
    stats: {
      overdueCents: balance.overdueCents,
      futureDebtCents: balance.futureDebtCents,
      creditCents: balance.openCredit,
      netCents: balance.netCents,
      chargesCount: charges.length,
      paidCount: charges.filter((c) => c.status === "paid").length,
    },
    upcomingCharges,
    overdueCharges,
    recentBankPayments,
    upcomingAssembly,
    requiredInspections,
    insuranceStatus,
    today,
  });
}

// Lista todas as cobranças da fração. Filtro por ano: default = ano mais antigo
// com dívida em aberto (foca no que está em atraso); sem dívida, default = "Todos".
export async function portalCharges(filters: { year?: string | null } = {}) {
  const unitId = requireUnitId();
  const [ctx, chargesRes, bankAccountsRes] = await Promise.all([
    loadPortalUnitContext(),
    client.portal.listCharges(unitId, { limit: "5000" }),
    // Banner "Pagar quotas": só contas is_quota_payment com IBAN. Falha → banner escondido.
    client.portal.listBankAccounts().catch(() => ({ data: [] as Rec[] })),
  ]);

  const allChargesRaw = chargesRes.data;
  // Window de ownership: charges fora da janela não contam para o condómino atual.
  const allCharges = filterChargesByWindow(allChargesRaw, ctx.ownerWindow)
    .slice()
    .sort((a, b) =>
      (b.competencePeriod ?? b.issueDate ?? "")
        .localeCompare(a.competencePeriod ?? a.issueDate ?? "")
    );

  // Anos da competência (fallback issueDate).
  const getDate = (c: PortalCharge) => c.competencePeriod ?? c.issueDate ?? null;
  const isOpenDebt = (c: PortalCharge) =>
    c.nature === "debit" &&
    c.openAmount > 0 &&
    (c.status === "open" || c.status === "partial" || c.status === "overdue");
  const { availableYears, filterYear } = resolveYearFilter<PortalCharge>({
    items: allCharges,
    getDate,
    param: filters.year,
    defaultStrategy: oldestWith(isOpenDebt, getDate),
  });

  const charges = filterYear === null
    ? allCharges
    : allCharges.filter((c) => yearOf(getDate(c)) === filterYear);

  const quotaAccounts = (bankAccountsRes.data as Rec[])
    .filter((a) => Boolean(a.isQuotaPayment) && Boolean(a.isActive) && a.iban)
    .map((a) => ({
      id: a.id,
      bankName: a.bankName,
      accountName: a.accountName,
      accountHolder: a.accountHolder,
      iban: a.iban,
    }));

  return await render("pages/portal/charges.vto", {
    title: "Cobranças",
    section: "charges",
    condominium: ctx.condominium,
    unit: ctx.unit,
    ownerWindow: ctx.ownerWindow,
    charges,
    // Nº antes do filtro: distingue "sem dados" de "filtros sem resultados" no template.
    totalCharges: allCharges.length,
    availableYears,
    filterYear,
    quotaAccounts,
  });
}

// Extrato bancário: pagamentos que tocaram esta fração + detalhe de quotas
// liquidadas. `params.year` filtra por ano da transactionDate (anos derivados do dataset).
export async function portalExtrato(params: { year?: string } = {}) {
  const unitId = requireUnitId();
  const [ctx, chargesRes, settlementsRes, receiptsRes] = await Promise.all([
    loadPortalUnitContext(),
    client.portal.listCharges(unitId, { limit: "5000" }),
    // Endpoint filtra por unit (settlement.unit_id OR charge.unit_id); auth gate
    // via requirePortalAccessToUnit, unitId no path - não pode ser overrided.
    client.portal.listSettlements(unitId),
    // Recibos ativos desta fração (badge "Recibo X" inline em cada bank tx).
    client.portal.listReceipts(unitId, { voided: "false" }).catch(() => ({
      data: [] as Array<Record<string, unknown>>,
    })),
  ]);
  const { ownerWindow } = ctx;

  const charges = chargesRes.data;
  const chargeIds = new Set(charges.map((c) => c.id));
  const allSettlements = settlementsRes.data;
  const mySettlements = filterSettlementsByWindow(allSettlements, chargeIds, unitId, ownerWindow);

  // Recibos por bankTransactionId para enriquecer cada linha do breakdown.
  const receipts = receiptsRes.data;
  const receiptByBankTx = new Map(receipts.map((r) => [r.bankTransactionId, r]));

  // Extrato inclui settlements reverted (com `reversed=true` e risca no template).
  const allBankBreakdown = groupSettlementsByBankTx(mySettlements)
    .map((bk) => ({
      ...bk,
      receipt: receiptByBankTx.get(bk.bankTxId) ?? null,
    }));

  // Filtro por ano (transactionDate): default = ano corrente ou mais recente;
  // `""` força "Todos". Mecânica partilhada (year_filter/mod.ts).
  const txYear = (bk: typeof allBankBreakdown[number]) => bk.transactionDate;
  const { availableYears, filterYear } = resolveYearFilter({
    items: allBankBreakdown,
    getDate: txYear,
    param: params.year,
    defaultStrategy: currentOrMostRecent(),
  });
  const bankBreakdown = filterYear === null
    ? allBankBreakdown
    : allBankBreakdown.filter((bk) => yearOf(txYear(bk)) === filterYear);

  return await render("pages/portal/statement.vto", {
    title: "Extrato",
    section: "statement",
    condominium: ctx.condominium,
    unit: ctx.unit,
    ownerWindow,
    bankBreakdown,
    availableYears,
    filterYear,
  });
}

// Histórico read-only de assembleias realizadas + orçamentos aprovados.
// Fetch: listBudgets já traz totalAmount/fcrAmount; held assemblies fazem
// getAssembly em paralelo (1-3/ano, overhead trivial); falhas caem em "lite".
export async function portalAssembleias(params: { year?: string } = {}) {
  requireUnitId();

  const [ctx, budgetsRes, assembliesRes] = await Promise.all([
    loadPortalUnitContext(),
    client.portal.listBudgets(),
    client.portal.listAssemblies(),
  ]);

  type BudgetRec = Rec & {
    id: string;
    year: string;
    type: string;
    status: string;
    fcrPercentage: string | number;
    notes: string | null;
    approvedAt: string | null;
    quotasGeneratedAt: string | null;
    totalAmount: number;
    fcrAmount: number;
  };
  type AssemblyRec = Rec & {
    id: string;
    type: string;
    status: string;
    scheduledAt: string;
    secondConvocationAt: string | null;
    heldAt: string | null;
    location: string | null;
    minutesNumber: string | null;
    convocationSentAt: string | null;
    notes: string | null;
  };
  type AgendaItemRec = Rec & {
    id: string;
    sequence: number;
    subject: string;
    description: string | null;
    itemType: string | null;
    refType: string | null;
    refId: string | null;
    approved: boolean | null;
    votesInFavor: number | string | null;
    votesAgainst: number | string | null;
    votesAbstain: number | string | null;
  };

  const ownerWindow = ctx.ownerWindow;

  // Para budgets, a janela é por ANO sobreposto: budget de 2024 conta se
  // o owner foi proprietário em qualquer mês de 2024.
  const windowYearStart = ownerWindow ? Number(ownerWindow.startDate.slice(0, 4)) : 0;
  const windowYearEnd = ownerWindow?.endDate ? Number(ownerWindow.endDate.slice(0, 4)) : 9999;
  const budgets = budgetsRes.data as unknown as BudgetRec[];
  const approvedBudgetsAll = budgets
    .filter((b) => b.status === "approved")
    .filter((b) => {
      if (!ownerWindow) return true;
      const y = Number(b.year);
      return y >= windowYearStart && y <= windowYearEnd;
    })
    .sort((a, b) => String(b.year).localeCompare(String(a.year)));

  const assemblies = assembliesRes.data as unknown as AssemblyRec[];
  const heldAssembliesAll = assemblies
    .filter((a) => a.status === "held")
    .filter((a) => isInOwnerWindow(a.scheduledAt, ownerWindow))
    .sort((a, b) => String(b.scheduledAt).localeCompare(String(a.scheduledAt)));

  // Convocatórias por consultar (scheduled + convocationSentAt). Sempre no topo,
  // não filtradas por ano (negócio em curso), próximas primeiro.
  const convokedAssemblies = assemblies
    .filter((a) => a.status === "scheduled" && !!a.convocationSentAt)
    .filter((a) => isInOwnerWindow(a.scheduledAt, ownerWindow))
    .sort((a, b) => String(a.scheduledAt).localeCompare(String(b.scheduledAt)));

  // Filtro por ano: anos = união de budgets aprovados + assembleias realizadas.
  // Default = ano corrente ou mais recente; `""` força "Todos". Mecânica
  // partilhada (year_filter/mod.ts).
  const yearItems: string[] = [
    ...approvedBudgetsAll.map((b) => String(b.year)),
    ...heldAssembliesAll.map((a) => String(a.scheduledAt)),
  ];
  const { availableYears, filterYear } = resolveYearFilter({
    items: yearItems,
    getDate: (s) => s,
    param: params.year,
    defaultStrategy: currentOrMostRecent(),
  });
  const approvedBudgets = filterYear === null
    ? approvedBudgetsAll
    : approvedBudgetsAll.filter((b) => Number(b.year) === filterYear);
  const heldAssemblies = filterYear === null
    ? heldAssembliesAll
    : heldAssembliesAll.filter((a) => yearOf(a.scheduledAt) === filterYear);

  // Pontos da ordem do dia + anexos de cada held, em paralelo. Falha → "lite".
  type AttachmentRec = {
    id: string;
    filename: string;
    mimeType?: string | null;
    fileSize?: number | null;
  };
  const heldWithAgenda = await Promise.all(
    heldAssemblies.map(async (a) => {
      const [decRes, attRes] = await Promise.all([
        client.portal.getAssembly(a.id).catch(() => null),
        client.portal.listAssemblyAttachments(a.id).catch(() => null),
      ]);
      // Envelope rico do retrieve (já validado para o portal): aqui só extraímos.
      type AssemblyEnvelope = {
        agendaItems?: AgendaItemRec[];
        introduction?: string | null;
        conclusion?: string | null;
        minutesSignedAt?: string | null;
        presidentOccupant?: { id: string; name: string } | null;
        secretaryOccupant?: { id: string; name: string } | null;
        attendeeSummary?: {
          count: number;
          totalPermillage: number;
          totalBuildingPermillage: number;
          convocationRound: string;
        } | null;
      };
      const env = (decRes?.data ?? {}) as unknown as AssemblyEnvelope;
      const attachments = (attRes?.data ?? []) as unknown as AttachmentRec[];
      return {
        ...a,
        agendaItems: env.agendaItems ?? [],
        attachments,
        introduction: env.introduction ?? null,
        conclusion: env.conclusion ?? null,
        minutesSignedAt: env.minutesSignedAt ?? null,
        presidentOccupant: env.presidentOccupant ?? null,
        secretaryOccupant: env.secretaryOccupant ?? null,
        attendeeSummary: env.attendeeSummary ?? null,
      };
    }),
  );

  return await render("pages/portal/assemblies.vto", {
    title: "Assembleias",
    section: "assemblies",
    condominium: ctx.condominium,
    unit: ctx.unit,
    ownerWindow,
    convokedAssemblies,
    approvedBudgets,
    heldAssemblies: heldWithAgenda,
    availableYears,
    filterYear,
  });
}

// Detalhe read-only da convocatória: mostra o ÚLTIMO snapshot enviado
// (lastConvocation.snapshot), NÃO render ao vivo - o condómino vê o que foi
// de facto convocado. Snapshot null → template mostra estado vazio.
export async function portalAssemblyDetail(assemblyId: string) {
  requireUnitId();

  const [ctx, assemblyRes] = await Promise.all([
    loadPortalUnitContext(),
    client.portal.getAssembly(assemblyId),
  ]);

  type SnapshotAgendaItem = {
    sequence: number | null;
    subject: string;
    description: string | null;
  };
  type AssemblyRec = Rec & {
    id: string;
    type: string;
    status: string;
    scheduledAt: string;
    location: string | null;
    minutesNumber: string | null;
    lastConvocation: {
      snapshot: {
        agenda: SnapshotAgendaItem[];
        convocationIntro: string | null;
        convocationFooter: string | null;
        scheduledAt: string | null;
        secondConvocationAt: string | null;
      } | null;
      sentAt: string;
      trigger: string;
    } | null;
  };
  const assembly = assemblyRes.data as unknown as AssemblyRec;

  // Guard de janela (API só escopa por condominiumId): convocatória de período
  // em que não eras owner. Espelha os detalhes irmãos e o filtro da lista.
  if (!isInOwnerWindow(assembly.scheduledAt, ctx.ownerWindow)) {
    return await render("pages/errors/not_found.vto", {
      title: "Assembleia fora do período",
      heading: "Convocatória fora do seu período",
      subtitle:
        "Esta assembleia é de um período em que ainda não eras (ou já não és) proprietário.",
      attemptedPath: `/portal/c/.../u/.../assemblies/${assemblyId}`,
      showDashboard: false,
      showChoose: false,
    });
  }

  const snapshot = assembly.lastConvocation?.snapshot ?? null;

  return await render("pages/portal/assembly_convocation.vto", {
    title: "Convocatória",
    section: "assemblies",
    condominium: ctx.condominium,
    unit: ctx.unit,
    ownerWindow: ctx.ownerWindow,
    assembly,
    snapshot,
    sentAt: assembly.lastConvocation?.sentAt ?? null,
  });
}

// Detalhe read-only de orçamento aprovado: metadados, KPIs, quota desta fração
// e rubricas. Rejeita rascunhos (status !== "approved") com erro claro.
export async function portalBudgetDetail(budgetId: string) {
  const unitId = requireUnitId();

  const [ctx, budgetRes, quotaMapRes] = await Promise.all([
    loadPortalUnitContext(),
    client.portal.getBudget(budgetId),
    client.portal.getBudgetQuotaMap(budgetId).catch(() => ({ data: null })),
  ]);

  type BudgetLine = {
    id: string;
    accountId: string;
    annualAmount: number;
    notes: string | null;
    categoryName?: string;
  };
  type Budget = Rec & {
    id: string;
    year: string;
    type: string;
    status: string;
    fcrPercentage: string | number;
    notes: string | null;
    approvedAt: string | null;
    quotasGeneratedAt: string | null;
    totalAmount: number;
    fcrAmount: number;
    lines: BudgetLine[];
  };
  const budget = budgetRes.data as unknown as Budget;

  // Portal só mostra aprovados.
  if (budget.status !== "approved") {
    return await render("pages/errors/not_found.vto", {
      title: "Orçamento não acessível",
      heading: "Orçamento não disponível",
      subtitle: "Este orçamento ainda não foi aprovado em assembleia.",
      attemptedPath: `/portal/c/.../orcamentos/${budgetId}`,
      showDashboard: false,
      showChoose: false,
    });
  }

  // Defesa de janela: owner antigo não vê orçamentos de anos em que
  // não foi proprietário.
  const ownerWindow = ctx.ownerWindow;
  if (ownerWindow) {
    const y = Number(budget.year);
    const yStart = Number(ownerWindow.startDate.slice(0, 4));
    const yEnd = ownerWindow.endDate ? Number(ownerWindow.endDate.slice(0, 4)) : 9999;
    if (y < yStart || y > yEnd) {
      return await render("pages/errors/not_found.vto", {
        title: "Orçamento fora do período",
        heading: "Orçamento fora do seu período",
        subtitle: "Este orçamento é de um ano em que ainda não eras (ou já não és) proprietário.",
        attemptedPath: `/portal/c/.../orcamentos/${budgetId}`,
        showDashboard: false,
        showChoose: false,
      });
    }
  }

  // Quota desta fração: pode não existir (fração adicionada após geração do
  // quota_map, ou orçamento sem linhas) - template lida com myQuota=null.
  type QuotaUnit = {
    unitId: string;
    unitDesignation: string;
    unitPermillage: number;
    monthlyBaseCents: number;
    monthlyFcrCents: number;
    monthlyTotalCents: number;
    annualTotalCents: number;
  };
  const quotaMap = quotaMapRes.data as unknown as null | {
    units: QuotaUnit[];
    totals: { annualTotalCents: number; monthlyTotalCents: number };
  };
  const myQuota = quotaMap?.units.find((u) => u.unitId === unitId) ?? null;

  // Rubricas ordenadas por valor anual desc para destacar onde mais se gasta.
  const lines = (budget.lines ?? []).slice().sort((a, b) =>
    Number(b.annualAmount ?? 0) - Number(a.annualAmount ?? 0)
  );
  const grandTotal = Number(budget.totalAmount ?? 0) + Number(budget.fcrAmount ?? 0);

  return await render("pages/portal/budget.vto", {
    title: `Orçamento ${budget.year}`,
    section: "assemblies",
    condominium: ctx.condominium,
    unit: ctx.unit,
    ownerWindow,
    budget,
    lines,
    grandTotal,
    myQuota,
    quotaMapTotals: quotaMap?.totals ?? null,
  });
}

// Detalhe read-only de recibo. Anti-IDOR: confirma que o recibo pertence à
// fração do user (sem isto, owner de A veria recibos de B só sabendo o ID).
export async function portalReceiptDetail(receiptId: string) {
  const unitId = requireUnitId();
  const [receiptRes, ctx] = await Promise.all([
    client.portal.getReceipt(unitId, receiptId),
    loadPortalUnitContext(),
  ]);

  const receipt = receiptRes.data;
  if (receipt.unitId !== unitId) {
    return await render("pages/errors/not_found.vto", {
      title: "Recibo não acessível",
      heading: "Recibo não acessível",
      subtitle: "Este recibo não pertence à sua fração.",
      attemptedPath: `/portal/c/.../u/.../receipts/${receiptId}`,
      showDashboard: false,
      showChoose: false,
    });
  }

  // Defesa de janela: recibo de período em que não eras owner.
  const ownerWindow = ctx.ownerWindow;
  const txDate = receipt.bankTxSnapshot?.transactionDate ?? null;
  if (!isInOwnerWindow(txDate, ownerWindow)) {
    return await render("pages/errors/not_found.vto", {
      title: "Recibo fora do período",
      heading: "Recibo fora do seu período",
      subtitle:
        "Este recibo refere-se a um pagamento de um período em que ainda não eras (ou já não és) proprietário.",
      attemptedPath: `/portal/c/.../u/.../receipts/${receiptId}`,
      showDashboard: false,
      showChoose: false,
    });
  }

  return await render("pages/portal/receipt.vto", {
    title: `Recibo ${receipt.number ?? "-"}`,
    section: "statement",
    condominium: ctx.condominium,
    unit: ctx.unit,
    ownerWindow,
    receipt,
  });
}

// Proxy do PDF do recibo, anti-IDOR (só serve se o recibo for da unit do user).
export async function portalReceiptPdf(receiptId: string): Promise<Response> {
  const unitId = requireUnitId();
  // Verificação dupla: ownership + janela do owner.
  const [receiptRes, ctx] = await Promise.all([
    client.portal.getReceipt(unitId, receiptId),
    loadPortalUnitContext(),
  ]);
  const receipt = receiptRes.data;
  if (receipt.unitId !== unitId) {
    return new Response("Recibo não acessível", { status: 403 });
  }
  const ownerWindow = ctx.ownerWindow;
  const txDate = receipt.bankTxSnapshot?.transactionDate ?? null;
  if (!isInOwnerWindow(txDate, ownerWindow)) {
    return new Response("Recibo fora do seu período como proprietário", { status: 403 });
  }

  // Track primeiro download (idempotente, write-once): occupant cujo userId é
  // o do user E que está nos recipients. Falha silenciosa - serve o PDF na mesma.
  const user = currentUser();
  if (user?.role === "occupant") {
    const occupants = (ctx.unit.occupants ?? []) as NestedOccupantUO[];
    const myOccupantId = occupants.find((uo) => uo.occupant.userId === user.id)?.occupant.id ??
      null;
    const isRecipient = myOccupantId &&
      (receipt.recipientsSnapshot ?? []).some((r) => r.occupantId === myOccupantId);
    if (myOccupantId && isRecipient) {
      try {
        // occupantId é derivado do user no servidor (não vai no body); só passamos ids do path.
        await client.portal.trackReceiptAccess(unitId, receiptId);
      } catch (e) {
        console.warn(`[portalReceiptPdf:${receiptId}] track access failed:`, (e as Error).message);
      }
    }
  }

  // Endpoint /pdf do portal (scope cid+unitId), NUNCA o admin: token do condómino → 403.
  const upstream = await client.portal.downloadStream(
    `/units/${unitId}/receipts/${receiptId}/pdf`,
  );
  return proxyDownload(upstream, {
    errorPrefix: "Erro ao obter PDF",
    contentType: "application/pdf",
    cacheControl: "private, max-age=3600",
  });
}

// Perfil read-only: dados da fração e ocupantes.
export async function portalPerfil() {
  requireUnitId();
  const ctx = await loadPortalUnitContext();
  const occupants = (ctx.unit.occupants ?? []) as NestedOccupantUO[];
  const activeOccupants = occupants.filter((o) => !o.endDate);
  return await render("pages/portal/profile.vto", {
    title: "Perfil",
    section: "profile",
    condominium: ctx.condominium,
    unit: ctx.unit,
    activeOccupants,
    ownerWindow: ctx.ownerWindow,
  });
}

// Edição do próprio perfil (nome, email, telefone, preferência de recibos).
// NIF tem fluxo write-once dedicado no modal global do portal.
export async function portalPerfilEdit() {
  requireUnitId();
  const ctx = await loadPortalUnitContext();
  const user = currentUser();
  const occupants = (ctx.unit.occupants ?? []) as Array<
    NestedOccupantUO & {
      occupant: {
        id: string;
        name: string;
        userId: string | null;
        email?: string | null;
        phone?: string | null;
        nif?: string | null;
        receiveReceiptEmails?: boolean;
      };
    }
  >;
  const myEntry = occupants.find((o) => o.occupant.userId === user?.id && !o.endDate);
  if (!myEntry) {
    // Defesa: super/manager a impersonar não tem occupant nesta unit.
    return await render("pages/errors/not_found.vto", {
      title: "Perfil não editável",
      heading: "Sem ocupação ativa",
      subtitle:
        "Esta vista só está disponível para o condómino dono dos dados - admins não editam aqui.",
      attemptedPath: `/portal/c/.../profile/edit`,
      showDashboard: false,
      showChoose: false,
    });
  }
  return await render("pages/portal/profile_edit.vto", {
    title: "Editar perfil",
    section: "profile",
    condominium: ctx.condominium,
    unit: ctx.unit,
    me: myEntry.occupant,
    relationshipType: myEntry.relationshipType,
  });
}

export async function saveEditPortalProfile(form: Record<string, string | File>): Promise<void> {
  const unitId = requireUnitId();
  await client.portal.saveOccupantProfile(unitId, {
    name: parseFormString(form, "name"),
    email: parseFormString(form, "email", { emptyAsNull: true }),
    phone: parseFormString(form, "phone", { emptyAsNull: true }),
    receiveReceiptEmails: parseFormBool(form, "receiveReceiptEmails"),
  });
}

// Toggle inline da preferência de recibos por email; devolve o estado final
// para o caller compor a flash message.
export async function toggleReceiveReceipts(
  form: Record<string, string | File>,
): Promise<boolean> {
  const unitId = requireUnitId();
  const enabled = form.receiveReceiptEmails === "1" ||
    form.receiveReceiptEmails === "on" || form.receiveReceiptEmails === "true";
  await client.portal.saveReceiveReceipts(unitId, { receiveReceiptEmails: enabled });
  return enabled;
}

const DOCUMENT_CATEGORY_LABELS: Record<string, string> = {
  minutes: "Ata",
  regulation: "Regulamento",
  contract: "Contrato",
  budget: "Orçamento",
  insurance: "Seguro",
  plant: "Planta",
  other: "Outro",
};

/** Lista documentos públicos do condomínio (read-only). */
export async function portalDocuments(params: { category?: string } = {}) {
  requireUnitId();
  const [docsRes, ctx] = await Promise.all([
    client.portal.listDocuments(),
    loadPortalUnitContext(),
  ]);
  type DocRec = Rec & {
    id: string;
    title: string;
    category: string;
    publishedAt: string | null;
    description: string | null;
    attachments: Array<Rec & { id: string; filename: string; mimeType: string; fileSize: number }>;
  };
  const allDocs = docsRes.data as unknown as DocRec[];
  const VALID_CATEGORIES = new Set([
    "minutes",
    "regulation",
    "contract",
    "budget",
    "insurance",
    "plant",
    "other",
  ]);
  const filterCategory = params.category && VALID_CATEGORIES.has(params.category)
    ? params.category
    : null;
  const visible = filterCategory ? allDocs.filter((d) => d.category === filterCategory) : allDocs;

  // Contadores por categoria para os tabs (inclui "all" = total antes do filtro).
  const categoryCounts: Record<string, number> = {
    all: allDocs.length,
    minutes: 0,
    regulation: 0,
    contract: 0,
    budget: 0,
    insurance: 0,
    plant: 0,
    other: 0,
  };
  for (const d of allDocs) {
    if (categoryCounts[d.category] !== undefined) categoryCounts[d.category]++;
  }

  // Agrupa por ano (de publishedAt); docs sem data caem no grupo `null`.
  const byYear = new Map<string | null, DocRec[]>();
  for (const d of visible) {
    const year = d.publishedAt ? d.publishedAt.slice(0, 4) : null;
    const list = byYear.get(year) ?? [];
    list.push(d);
    byYear.set(year, list);
  }
  const yearGroups: Array<{ year: string | null; docs: DocRec[] }> = [];
  // "Sem data" vai PRIMEIRO: regulamento/plantas são os mais consultados,
  // não os mais recentes - melhora descoberta (pedido do user).
  if (byYear.has(null)) yearGroups.push({ year: null, docs: byYear.get(null) ?? [] });
  const years = Array.from(byYear.keys()).filter((y): y is string => y !== null)
    .sort((a, b) => b.localeCompare(a)); // DESC: 2026 antes de 2025
  for (const y of years) yearGroups.push({ year: y, docs: byYear.get(y) ?? [] });

  return await render("pages/portal/documents.vto", {
    title: "Documentos",
    section: "documents",
    condominium: ctx.condominium,
    unit: ctx.unit,
    documents: visible,
    yearGroups,
    categoryCounts,
    filterCategory,
    categoryLabels: DOCUMENT_CATEGORY_LABELS,
  });
}

/** Proxy do anexo de documento público (filtro is_public no API). */
export async function portalDocumentAttachment(
  documentId: string,
  attachmentId: string,
): Promise<Response> {
  const upstream = await client.portal.downloadStream(
    `/documents/${documentId}/attachments/${attachmentId}`,
  );
  return proxyDownload(upstream, {
    errorPrefix: "Erro a obter anexo",
    fallbackDisposition: `inline; filename="anexo-${attachmentId}"`,
  });
}

// ─── Aviso de privacidade (gate no primeiro acesso) ─────────────────────
// Página standalone (sem layout do portal). Após OK, redirige ao dashboard.

export async function portalPrivacyNotice(): Promise<string> {
  const ctx = await loadPortalUnitContext();
  return await render("pages/portal/privacy_notice.vto", {
    title: "Aviso de privacidade",
    section: "privacy-notice",
    condominium: ctx.condominium,
    unit: ctx.unit,
    currentCondominiumId: currentCondominiumId(),
    currentPortalUnitId: currentPortalUnitId(),
  });
}

// Consulta read-only da Política de Privacidade (footer do portal): "fácil
// acessibilidade" do Art. 12º RGPD. Mesmo conteúdo do privacy_notice.vto, com nav.
export async function portalPrivacy(): Promise<string> {
  const ctx = await loadPortalUnitContext();
  return await render("pages/portal/privacy.vto", {
    title: "Aviso de privacidade",
    section: "privacy",
    condominium: ctx.condominium,
    unit: ctx.unit,
    currentCondominiumId: currentCondominiumId(),
    currentPortalUnitId: currentPortalUnitId(),
  });
}

export async function acceptPrivacyNotice(): Promise<void> {
  // Write-once via COALESCE na API (idempotente). Coluna mantém nome histórico
  // `terms_acknowledged_at` (rename só em rotas/templates/funções, ver CLAUDE.md).
  await client.auth.saveTermsAcknowledged(currentToken());
}
