// Helpers puros do quota_generator (testáveis sem DB).
// Algoritmo (ADR 0010):
//   monthly_with_fcr = total_annual * (100 + fcr%) / 100 / 12  (numeric)
//   contribuição/unit = ROUND(monthly_with_fcr * permillage / total_pm)
//   O diff (Σ contribuições vs ROUND(monthly_with_fcr)) é absorvido pela big
//   unit (maior permillage) para garantir Σ exato.

export interface MonthlyTotals {
  /** Valor exato antes de arredondar (numeric). */
  value: number;
  /** Valor arredondado em cêntimos (target da soma das contribuições). */
  rounded: number;
}

// totalAnnual em cêntimos; fcrPercentage como número (10 = 10%).
export function computeMonthlyWithFcr(
  totalAnnual: number,
  fcrPercentage: number,
): MonthlyTotals {
  const value = totalAnnual * (100 + fcrPercentage) / 100 / 12;
  return { value, rounded: Math.round(value) };
}

// Último mês a gerar: < Jan do ano -> 0; dentro do ano -> mês; > Dez -> 12.
export function computeMaxMonth(throughDate: string, budgetYear: number): number {
  const throughYear = Number(throughDate.slice(0, 4));
  const throughMonth = Number(throughDate.slice(5, 7));
  if (throughYear < budgetYear) return 0;
  if (throughYear > budgetYear) return 12;
  return throughMonth;
}

export interface UnitForDistribution {
  id: string;
  permillage: number;
}

// Distribui por permillage; a big unit absorve o diff de arredondamento para
// garantir Σ contribuições = monthlyWithFcrInt. Devolve Map id -> cêntimos/mês.
export function distributeByPermillage(
  monthlyWithFcr: number,
  monthlyWithFcrInt: number,
  units: ReadonlyArray<UnitForDistribution>,
  totalPm: number,
  bigUnitId: string | null,
): Map<string, number> {
  if (totalPm <= 0) throw new Error("totalPm tem de ser > 0");
  const monthlyByUnit = new Map<string, number>();
  let sumDistributed = 0;
  for (const u of units) {
    const monthly = Math.round(monthlyWithFcr * u.permillage / totalPm);
    monthlyByUnit.set(u.id, monthly);
    sumDistributed += monthly;
  }
  const diff = monthlyWithFcrInt - sumDistributed;
  if (diff !== 0 && bigUnitId !== null) {
    monthlyByUnit.set(bigUnitId, (monthlyByUnit.get(bigUnitId) ?? 0) + diff);
  }
  return monthlyByUnit;
}

// ── Suplementar: obra paga em N prestações ───────────────────────────────
// O total da obra (Σ budget_lines) é dividido pelo nº de prestações - NÃO por
// 12. A componente FCR aplica-se ao total (default 0% nos suplementares).

export interface CompetenceMonth {
  year: number;
  month: number; // 1-12
}

// total em cêntimos; fcrPercentage como número (0 = sem FCR). Devolve N
// inteiros (cêntimos/prestação) cuja soma = ROUND(total*(100+fcr)/100). As
// primeiras N-1 são iguais; a última absorve o resto de arredondamento.
export function computeInstallmentAmounts(
  total: number,
  fcrPercentage: number,
  n: number,
): number[] {
  if (n < 1) throw new Error("installments tem de ser >= 1");
  const totalWithFcrInt = Math.round(total * (100 + fcrPercentage) / 100);
  const base = Math.round(totalWithFcrInt / n);
  const amounts = new Array<number>(n).fill(base);
  amounts[n - 1] = totalWithFcrInt - base * (n - 1);
  return amounts;
}

// N meses consecutivos a partir de (firstYear, firstMonth), com rollover de
// Dezembro para Janeiro do ano seguinte (a obra pode cruzar o ano fiscal).
export function computeInstallmentPeriods(
  firstYear: number,
  firstMonth: number,
  n: number,
): CompetenceMonth[] {
  if (n < 1) throw new Error("installments tem de ser >= 1");
  if (firstMonth < 1 || firstMonth > 12) throw new Error(`mês inválido: ${firstMonth}`);
  const periods: CompetenceMonth[] = [];
  for (let i = 0; i < n; i++) {
    const zeroBased = (firstMonth - 1) + i;
    periods.push({
      year: firstYear + Math.floor(zeroBased / 12),
      month: (zeroBased % 12) + 1,
    });
  }
  return periods;
}

// Parse "YYYY-MM" ou "YYYY-MM-DD" -> {year, month}.
export function parseYearMonth(s: string): CompetenceMonth {
  const year = Number(s.slice(0, 4));
  const month = Number(s.slice(5, 7));
  if (!Number.isInteger(year) || month < 1 || month > 12) {
    throw new Error(`mês inválido: ${s}`);
  }
  return { year, month };
}
