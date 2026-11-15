// Match de keywords contra descrição de movimentos bancários.
// Normaliza (lowercase + strip de diacríticos via NFD) para que o match
// ignore acentos do input bancário. Ex: "Beatriz Leitão" bate "beatriz leitao".

export function normalize(s: string | null | undefined): string {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

// Itens cuja `matchKeywords` tem pelo menos uma keyword que é substring da
// descrição (ambos normalizados). Keywords vazias ou ausentes nunca batem.
export function findKeywordMatches<
  T extends { id: string; matchKeywords?: readonly string[] | null },
>(
  description: string | null | undefined,
  items: ReadonlyArray<T>,
): T[] {
  const desc = normalize(description);
  if (!desc) return [];
  return items.filter((item) => {
    const kws = item.matchKeywords ?? [];
    for (const k of kws) {
      const nk = normalize(k);
      if (nk.length > 0 && desc.includes(nk)) return true;
    }
    return false;
  });
}
