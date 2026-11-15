// Formatters puros do domínio de recibos. Sem I/O, sem deps em runtime -
// determinísticos e fáceis de testar isoladamente (ver _helpers_test.ts).

// Mascara o IBAN: PT50 0033 ... 4321.
export function maskIban(iban: string | null): string | null {
  if (!iban) return null;
  const clean = iban.replace(/\s+/g, "");
  if (clean.length < 8) return iban;
  const head = clean.substring(0, 8);
  const tail = clean.substring(clean.length - 4);
  const masked = "*".repeat(Math.max(0, clean.length - 12));
  return `${head} ${masked.match(/.{1,4}/g)?.join(" ") ?? masked} ${tail}`.replace(/\s+/g, " ")
    .trim();
}

// Descrição amigável de uma linha do recibo (ex.: "Quota Março/2026").
export function humanizeChargeLine(
  description: string,
  chargeType: string,
  competencePeriod: string | null,
): string {
  if (chargeType === "quota" && competencePeriod) {
    const d = new Date(String(competencePeriod));
    const meses = [
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
    if (!Number.isNaN(d.getTime())) {
      return `Quota ${meses[d.getUTCMonth()]}/${d.getUTCFullYear()}`;
    }
  }
  if (chargeType === "credit_balance") return "Adiantamento à conta";
  if (chargeType === "extraordinary_quota") return description || "Quota extraordinária";
  return description || chargeType;
}

// Número por extenso PT-PT (dezasseis, não dezesseis). Suporta até 999 999 999.
const UNIDADES = [
  "zero",
  "um",
  "dois",
  "três",
  "quatro",
  "cinco",
  "seis",
  "sete",
  "oito",
  "nove",
  "dez",
  "onze",
  "doze",
  "treze",
  "catorze",
  "quinze",
  "dezasseis",
  "dezassete",
  "dezoito",
  "dezanove",
];
const DEZENAS = [
  "",
  "",
  "vinte",
  "trinta",
  "quarenta",
  "cinquenta",
  "sessenta",
  "setenta",
  "oitenta",
  "noventa",
];
const CENTENAS = [
  "",
  "cento",
  "duzentos",
  "trezentos",
  "quatrocentos",
  "quinhentos",
  "seiscentos",
  "setecentos",
  "oitocentos",
  "novecentos",
];

function under1000(n: number): string {
  if (n === 100) return "cem";
  const c = Math.trunc(n / 100);
  const r = n % 100;
  let rest = "";
  if (r > 0) {
    rest = r < 20
      ? UNIDADES[r]
      : DEZENAS[Math.trunc(r / 10)] + (r % 10 > 0 ? ` e ${UNIDADES[r % 10]}` : "");
  }
  if (c === 0) return rest;
  return rest ? `${CENTENAS[c]} e ${rest}` : CENTENAS[c];
}

// "e" liga o grupo final quando é < 100 ou uma centena redonda ("mil e duzentos",
// mas "mil duzentos e trinta e quatro").
function numberInWords(n: number): string {
  if (n === 0) return "zero";
  const millions = Math.trunc(n / 1_000_000);
  const thousands = Math.trunc((n % 1_000_000) / 1000);
  const rest = n % 1000;
  const parts: string[] = [];
  if (millions > 0) {
    parts.push(millions === 1 ? "um milhão" : `${under1000(millions)} milhões`);
  }
  if (thousands > 0) parts.push(thousands === 1 ? "mil" : `${under1000(thousands)} mil`);
  const head = parts.join(" ");
  if (rest === 0) return head || "zero";
  const restWords = under1000(rest);
  if (!head) return restWords;
  const connector = rest < 100 || rest % 100 === 0 ? " e " : " ";
  return head + connector + restWords;
}

// Cêntimos para quantia por extenso PT-PT: "Quinhentos e cinco euros e
// trinta e cinco cêntimos". Negativos (void/refund) tratados como módulo.
export function amountInWords(cents: number): string {
  const euros = Math.trunc(Math.abs(cents) / 100);
  const c = Math.abs(cents) % 100;
  let text: string;
  if (euros === 0 && c === 0) {
    text = "zero euros";
  } else if (euros === 0) {
    text = `${numberInWords(c)} cêntimo${c === 1 ? "" : "s"}`;
  } else {
    text = `${numberInWords(euros)} euro${euros === 1 ? "" : "s"}${
      c > 0 ? ` e ${numberInWords(c)} cêntimo${c === 1 ? "" : "s"}` : ""
    }`;
  }
  return text.charAt(0).toUpperCase() + text.slice(1);
}
