// Prefixos atribuídos pela AT: 1-3 singulares, 5 empresas, 6 admin pública,
// 8 comerciante em nome individual, 9 entidades não residentes.
const VALID_FIRST_DIGITS = new Set(["1", "2", "3", "5", "6", "8", "9"]);

export function isValidPortugueseNif(nif: string): boolean {
  if (nif.length !== 9) return false;
  if (!VALID_FIRST_DIGITS.has(nif[0])) return false;

  // Checksum: Σ(dígito × peso) com pesos [9..2]; check = 0 se resto<=1, senão 11-resto.
  let sum = 0;
  for (let i = 0; i < 8; i++) {
    sum += Number(nif[i]) * (9 - i);
  }
  const remainder = sum % 11;
  const expectedCheck = remainder <= 1 ? 0 : 11 - remainder;

  return Number(nif[8]) === expectedCheck;
}
