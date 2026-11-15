// Controllers dos relatórios (menu "Relatórios"). Wrappers finos sobre
// /v1/admin/condominiums/:cid/reports/* - a agregação toda vive na API.
//
//   GET reports/movements            → extrato anual das bolsas (121 + 122)
//   GET reports/cashflow             → previsão de entradas/saídas
//   GET reports/assemblies           → execução orçamental por Ata
//   GET reports/assemblies/:id       → detalhe de uma Ata

import { render } from "$panel/render.ts";
import { client } from "$panel/client.ts";

const MONTH_LABELS = [
  "Janeiro",
  "Fevereiro",
  "Março",
  "Abril",
  "Maio",
  "Junho",
  "Julho",
  "Agosto",
  "Setembro",
  "Outubro",
  "Novembro",
  "Dezembro",
];

/** "2026-03" → "Março 2026". Vazio se o input não for um mês ISO. */
function monthLabel(month: string | null): string {
  if (!month) return "";
  const [y, m] = month.split("-");
  const idx = Number(m) - 1;
  return idx >= 0 && idx < 12 ? `${MONTH_LABELS[idx]} ${y}` : month;
}

export async function movementsReport(query: {
  year?: string;
  bolsa?: string;
  month?: string;
}) {
  const { data } = await client.admin.cashMovementsReport(
    query.year ? { year: query.year } : undefined,
  );

  const bolsa = query.bolsa === "ordinary" || query.bolsa === "fcr" ? query.bolsa : "all";
  const month = query.month && /^\d{4}-\d{2}$/.test(query.month) ? query.month : null;

  // Filtros aplicados aqui e não na API: o payload do ano já veio inteiro,
  // filtrar de novo pela rede seria uma segunda volta pelo mesmo dado.
  const events = data.events.filter((e) => {
    if (month && e.month !== month) return false;
    if (bolsa === "ordinary" && e.ordinaryCents === 0) return false;
    if (bolsa === "fcr" && e.fcrCents === 0) return false;
    return true;
  });

  // Com filtro de bolsa, os totais são dessa bolsa - senão uma transferência
  // (que soma zero no total) aparecia como movimento nulo na coluna filtrada.
  const amountOf = (e: typeof events[number]) =>
    bolsa === "ordinary" ? e.ordinaryCents : bolsa === "fcr" ? e.fcrCents : e.totalCents;
  const filtered = {
    inCents: events.reduce((a, e) => a + Math.max(amountOf(e), 0), 0),
    outCents: events.reduce((a, e) => a + Math.max(-amountOf(e), 0), 0),
  };

  return await render("pages/reports/movements.vto", {
    title: "Movimentos do ano",
    section: "report_movements",
    report: data,
    months: data.months.map((m) => ({ ...m, label: monthLabel(m.month) })),
    events,
    filterBolsa: bolsa,
    filterMonth: month,
    filterMonthLabel: monthLabel(month),
    filtered,
    isFiltered: bolsa !== "all" || month !== null,
  });
}

export async function cashflowReport(query: { months?: string }) {
  const months = query.months && /^\d+$/.test(query.months) ? query.months : "12";
  const { data } = await client.admin.cashflowReport({ months });

  const rows = data.rows.map((r) => ({
    ...r,
    label: r.kind === "overdue"
      ? "Em atraso"
      : r.kind === "later"
      ? "Depois do horizonte"
      : monthLabel(r.month),
  }));

  // Escala das barras: o maior movimento de qualquer linha. 0 = nada previsto,
  // e todas as barras ficam a zero (evita divisão por zero).
  const peak = rows.reduce((max, r) => Math.max(max, r.inCents, r.outCents), 0);
  const scaled = rows.map((r) => ({
    ...r,
    inPct: peak > 0 ? Math.round((r.inCents / peak) * 100) : 0,
    outPct: peak > 0 ? Math.round((r.outCents / peak) * 100) : 0,
  }));
  const worst = rows.reduce(
    (min: typeof rows[number] | null, r) =>
      min === null || r.closingCents < min.closingCents ? r : min,
    null,
  );

  return await render("pages/reports/cashflow.vto", {
    title: "Previsão de tesouraria",
    section: "report_cashflow",
    report: data,
    rows: scaled,
    horizonMonths: Number(months),
    worst,
    hasNegative: worst !== null && worst.closingCents < 0,
  });
}

export async function assembliesReport() {
  const { data } = await client.admin.assemblyExecutionReport();
  return await render("pages/reports/assemblies.vto", {
    title: "Execução por Ata",
    section: "report_assemblies",
    assemblies: data.assemblies,
  });
}

export async function assemblyReportShow(assemblyId: string) {
  const { data } = await client.admin.assemblyExecutionDetail(assemblyId);
  return await render("pages/reports/assembly_show.vto", {
    title: data.minutesNumber ? `Ata ${data.minutesNumber}` : "Ata",
    section: "report_assemblies",
    assembly: data,
  });
}
