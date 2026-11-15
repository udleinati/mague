// Formatação PT-PT partilhada entre o Panel (filtros Vento) e a API (PDFs,
// emails). Timezone: date-only ("YYYY-MM-DD") formata por parse textual, sem
// conversão; timestamps formatam em UTC (comportamento histórico dos PDFs -
// um timestamp 23:xx UTC nunca vira o dia).

// Cêntimos (integer) → "1.234,56 €" (formato PT).
export function formatMoney(cents: unknown): string {
  const n = typeof cents === "number"
    ? cents
    : typeof cents === "string"
    ? Number.parseInt(cents, 10)
    : 0;
  if (!Number.isFinite(n)) return "0,00 €";

  const negative = n < 0;
  const abs = Math.abs(n);
  const euros = Math.trunc(abs / 100);
  const remainder = abs % 100;

  const eurosStr = euros.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const centsStr = remainder.toString().padStart(2, "0");

  return `${negative ? "-" : ""}${eurosStr},${centsStr} €`;
}

// Permilagem (fração de 1000) → 2 decimais fixas, estilo PT. Aceita number
// ou string. Ex: 45.321 → "45,32", 1234.5 → "1.234,50".
export function formatPermillage(value: unknown): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "0,00";
  const fixed = Math.abs(n).toFixed(2);
  const [int, dec] = fixed.split(".");
  const intFormatted = int.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${n < 0 ? "-" : ""}${intFormatted},${dec}`;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

// Data → "dd/mm/yyyy". Devolve "" para null/inválido; o fallback visível é
// política de cada consumidor (ver adapter em $api/libs/templates/render.ts).
export function formatDate(value: unknown): string {
  if (value == null || value === "") return "";
  if (typeof value === "string") {
    const m = value.match(DATE_ONLY);
    if (m) {
      const month = Number(m[2]);
      const day = Number(m[3]);
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        return `${m[3]}/${m[2]}/${m[1]}`;
      }
    }
  }
  const d = value instanceof Date ? value : new Date(value as string | number);
  if (Number.isNaN(d.getTime())) return "";
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  return `${dd}/${mm}/${yyyy}`;
}
