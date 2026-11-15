// Parser do extrato em XLSX do NovoBanco.
//
// Formato observado (2026):
//   Linha 1: vazia
//   Linha 2: cabeçalhos - "Data Operação", "Data Valor", "Tipo",
//            "Descrição", "Débito", "Crédito", "Saldo Controlo"
//   Linha 3..N: movimentos; data em serial Excel; débito/crédito separados,
//               ausência marcada com "-".
//
// Tipos observados: CRD, TRF, SDD, DEB. Amount convencional: crédito
// positivo, débito negativo. Importa em cêntimos (integer).

import * as XLSX from "xlsx";

export interface ParsedRow {
  transactionDate: string; // YYYY-MM-DD
  valueDate: string | null;
  kind: string; // CRD | TRF | SDD | DEB
  description: string;
  amountCents: number; // positivo=crédito, negativo=débito
  balanceAfterCents: number | null;
  rowNumber: number; // linha original no xlsx, p/ debug
}

export interface ParseResult {
  rows: ParsedRow[];
  warnings: string[];
}

/** Converte serial Excel (1900 date system) para YYYY-MM-DD. */
function excelSerialToIsoDate(serial: number): string {
  // Excel: 1 = 1900-01-01, mas há o bug do ano bissexto 1900 → offset 25569 para 1970-01-01.
  const utcMs = (serial - 25569) * 86400 * 1000;
  const d = new Date(utcMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function toCents(value: number): number {
  // Evita artefactos de floating point (e.g. 40.520000000000003 → 4052).
  return Math.round(value * 100);
}

export function parseNovoBancoXlsx(bytes: Uint8Array): ParseResult {
  const wb = XLSX.read(bytes, { type: "array" });
  const sheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  if (!sheet) return { rows: [], warnings: ["Folha vazia"] };

  // header:1 devolve arrays por linha; defval para normalizar células vazias.
  const raw = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: null,
    raw: true,
  });

  const rows: ParsedRow[] = [];
  const warnings: string[] = [];

  // Procura linha do cabeçalho "Data Operação".
  let headerRow = -1;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i]?.[0] === "Data Operação") {
      headerRow = i;
      break;
    }
  }
  if (headerRow < 0) {
    return { rows: [], warnings: ["Cabeçalho 'Data Operação' não encontrado"] };
  }

  for (let i = headerRow + 1; i < raw.length; i++) {
    const r = raw[i];
    if (!r || r.length === 0) continue;
    const [aOp, aValor, aTipo, aDesc, aDebito, aCredito, aSaldo] = r as [
      unknown,
      unknown,
      unknown,
      unknown,
      unknown,
      unknown,
      unknown,
    ];

    // Linha final com "-" ou resumo: skip se não for numérica em A.
    if (typeof aOp !== "number") continue;

    const transactionDate = excelSerialToIsoDate(aOp);
    const valueDate = typeof aValor === "number" ? excelSerialToIsoDate(aValor) : null;
    const kind = typeof aTipo === "string" ? aTipo : "";
    const description = typeof aDesc === "string" ? aDesc.trim() : "";

    const debito = typeof aDebito === "number" ? aDebito : null;
    const credito = typeof aCredito === "number" ? aCredito : null;
    const saldo = typeof aSaldo === "number" ? aSaldo : null;

    if (debito === null && credito === null) {
      warnings.push(`Linha ${i + 1}: sem débito nem crédito, ignorada`);
      continue;
    }
    if (debito !== null && credito !== null) {
      warnings.push(`Linha ${i + 1}: tem débito E crédito, ignorada`);
      continue;
    }

    const amountCents = credito !== null ? toCents(credito) : -toCents(debito!);

    rows.push({
      transactionDate,
      valueDate,
      kind,
      description,
      amountCents,
      balanceAfterCents: saldo !== null ? toCents(saldo) : null,
      rowNumber: i + 1,
    });
  }

  return { rows, warnings };
}
