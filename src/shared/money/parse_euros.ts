// Conversão canónica de euros (string) para cêntimos (integer). Regra do
// projeto (CLAUDE.md): cêntimos integer, nunca float. Aceita vírgula PT-PT OU
// ponto e arredonda à 2.ª casa. Fixa a regra única que 8+ controllers do panel
// replicavam com edge-cases divergentes (trim, isNaN, negativos).

export interface ParseEurosOpts {
  /**
   * Default `false` - input negativo → `null`.
   * Útil para charges (não há montantes negativos) vs. balanços (podem ser negativos).
   */
  allowNegative?: boolean;
}

/**
 * "1.234,56", "1234.56", "10" -> cêntimos integer; vazio/inválido/NaN -> `null`.
 * Negativos -> `null` salvo `allowNegative`. `Math.round` à unidade de cêntimo.
 *
 * @example
 *   parseEurosToCents("1.234,56")        // 123456
 *   parseEurosToCents("")                // null
 *   parseEurosToCents("-5,00")           // null
 *   parseEurosToCents("-5,00", { allowNegative: true })  // -500
 *   parseEurosToCents(undefined)         // null
 */
export function parseEurosToCents(
  input: unknown,
  opts: ParseEurosOpts = {},
): number | null {
  if (input === null || input === undefined) return null;
  const trimmed = String(input).trim();
  if (!trimmed) return null;

  // Com vírgula = PT-PT (ponto é milhares, descartado; vírgula vira decimal);
  // sem vírgula = intl (ponto é decimal). "1.234" sem vírgula assume-se intl.
  let normalized: string;
  if (trimmed.includes(",")) {
    if (trimmed.indexOf(",") !== trimmed.lastIndexOf(",")) return null; // múltiplas vírgulas
    normalized = trimmed.replace(/\./g, "").replace(",", ".");
  } else {
    normalized = trimmed;
  }

  // parseFloat é tolerante demais ("1.2.3" -> 1.2, "5abc" -> 5); valida tudo via regex.
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) return null;

  const n = parseFloat(normalized);
  if (!Number.isFinite(n)) return null;
  if (n < 0 && !opts.allowNegative) return null;

  return Math.round(n * 100);
}
