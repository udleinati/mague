/** "2026-04-15" → "2026-04-01". Trunca uma data ISO ao 1º dia do mês. */
export function monthStart(dateIso: string): string {
  return `${dateIso.slice(0, 7)}-01`;
}

/**
 * Avança uma data ISO conforme intervalType (monthly/bimonthly/quarterly/semiannual/annual).
 * Mantém o day original e NÃO normaliza dias inválidos (31 + 1 mês → 31, não 30/Fev),
 * espelhando o trigger SQL antigo (date + INTERVAL '1 month').
 */
export function advanceByInterval(dateIso: string, intervalType: string): string {
  const [y, m, d] = dateIso.split("-").map(Number);
  let newY = y;
  let newM = m;
  switch (intervalType) {
    case "monthly":
      newM += 1;
      break;
    case "bimonthly":
      newM += 2;
      break;
    case "quarterly":
      newM += 3;
      break;
    case "semiannual":
      newM += 6;
      break;
    case "annual":
      newY += 1;
      break;
    default:
      throw new Error(`interval_type desconhecido: ${intervalType}`);
  }
  while (newM > 12) {
    newM -= 12;
    newY += 1;
  }
  return `${newY}-${String(newM).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
