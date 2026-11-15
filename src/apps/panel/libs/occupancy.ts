// Vigência de uma associação fração<->ocupante para display. Uma associação
// está ativa enquanto não tem data de fim, ou enquanto essa data ainda não
// passou; o dia do fim ainda conta. Fonte única do Panel: o filtro binário
// `!endDate` escondia também as que só terminam no futuro e, sem vista de
// histórico, deixava a associação inacessível pelo UI.

export interface OccupancyPeriod {
  endDate?: string | null;
}

/** Datas ISO (YYYY-MM-DD) comparam lexicograficamente. */
export function isOccupancyActive(uo: OccupancyPeriod, today: string): boolean {
  return !uo.endDate || uo.endDate >= today;
}

export function splitOccupancies<T extends OccupancyPeriod>(
  rows: T[],
  today: string,
): { active: T[]; past: T[] } {
  const active: T[] = [];
  const past: T[] = [];
  for (const row of rows) {
    (isOccupancyActive(row, today) ? active : past).push(row);
  }
  return { active, past };
}
