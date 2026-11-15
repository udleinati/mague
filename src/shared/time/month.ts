// Datas de calendário em ISO (YYYY-MM-DD), sem timezone. Aritmética em UTC:
// as datas do domínio são dias, não instantes.

/**
 * Último dia do mês seguinte ao de `fromIso`. Default de vencimento de uma
 * refaturação: dá à fração o resto do mês corrente mais o mês inteiro a
 * seguir para pagar, e cai sempre num fim de mês (data que toda a gente
 * reconhece como prazo).
 */
export function lastDayOfNextMonth(fromIso: string): string {
  const [y, m] = fromIso.slice(0, 7).split("-").map(Number);
  // Dia 0 do mês N+2 = último dia do mês N+1. `Date.UTC` normaliza o ano.
  const d = new Date(Date.UTC(y, m + 1, 0));
  return d.toISOString().slice(0, 10);
}
