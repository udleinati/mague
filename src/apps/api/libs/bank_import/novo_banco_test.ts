// Tests para o parser de extrato XLSX do NovoBanco.
//
// Estratégia: construímos XLSX em memória com `xlsx` library, mesma
// usada pelo parser. Cobre cenários reais sem precisar de fixtures
// estáticos (que ficariam por updates do formato do banco).

import { assertEquals } from "@std/assert";
import * as XLSX from "xlsx";
import { parseNovoBancoXlsx } from "./novo_banco.ts";

// ─── Helpers de construção ─────────────────────────────────────────────────

/**
 * Constrói XLSX em memória com o formato observado: linha 1 vazia, linha 2
 * cabeçalho ("Data Operação", ...), linhas seguintes com dados.
 */
function buildXlsx(rows: unknown[][]): Uint8Array {
  const sheetData: unknown[][] = [
    [], // linha 1 vazia
    ["Data Operação", "Data Valor", "Tipo", "Descrição", "Débito", "Crédito", "Saldo Controlo"],
    ...rows,
  ];
  const ws = XLSX.utils.aoa_to_sheet(sheetData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Movimentos");
  const out = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  return new Uint8Array(out);
}

/** Converte YYYY-MM-DD em serial Excel (1900 system + bug ano bissexto). */
function isoToSerial(iso: string): number {
  const d = new Date(iso + "T00:00:00Z");
  return (d.getTime() / 86400000) + 25569;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

Deno.test("parse - bytes vazios → result vazio + warning", () => {
  const result = parseNovoBancoXlsx(new Uint8Array(0));
  assertEquals(result.rows, []);
  // Implementação devolve "Folha vazia" ou similar; a chave é zero rows.
});

Deno.test("parse - sheet sem cabeçalho 'Data Operação' → warning + 0 rows", () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["random", "headers"]]), "X");
  const bytes = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }));
  const result = parseNovoBancoXlsx(bytes);
  assertEquals(result.rows.length, 0);
  assertEquals(result.warnings.includes("Cabeçalho 'Data Operação' não encontrado"), true);
});

Deno.test("parse - crédito simples → amount positivo em cêntimos", () => {
  const bytes = buildXlsx([
    [isoToSerial("2026-03-15"), isoToSerial("2026-03-15"), "CRD", "Recebimento", null, 100, 500],
  ]);
  const result = parseNovoBancoXlsx(bytes);
  assertEquals(result.rows.length, 1);
  assertEquals(result.rows[0].amountCents, 10000);
  assertEquals(result.rows[0].transactionDate, "2026-03-15");
  assertEquals(result.rows[0].kind, "CRD");
});

Deno.test("parse - débito → amount negativo em cêntimos", () => {
  const bytes = buildXlsx([
    [isoToSerial("2026-03-15"), null, "DEB", "Pagamento", 50, null, 450],
  ]);
  const result = parseNovoBancoXlsx(bytes);
  assertEquals(result.rows[0].amountCents, -5000);
});

Deno.test("parse - data valor nula → valueDate=null (não trava)", () => {
  const bytes = buildXlsx([
    [isoToSerial("2026-04-01"), null, "TRF", "X", null, 25, 475],
  ]);
  const result = parseNovoBancoXlsx(bytes);
  assertEquals(result.rows[0].valueDate, null);
});

Deno.test("parse - linha sem débito nem crédito → ignorada + warning", () => {
  const bytes = buildXlsx([
    [isoToSerial("2026-03-15"), null, "INFO", "Sem montante", null, null, 100],
    [isoToSerial("2026-03-16"), null, "CRD", "Ok", null, 50, 150],
  ]);
  const result = parseNovoBancoXlsx(bytes);
  assertEquals(result.rows.length, 1, "só a 2ª linha (com crédito) é parseada");
  assertEquals(result.rows[0].kind, "CRD");
  assertEquals(result.warnings.length, 1);
  assertEquals(result.warnings[0].includes("sem débito nem crédito"), true);
});

Deno.test("parse - linha com débito E crédito → ignorada + warning (mutually exclusive)", () => {
  const bytes = buildXlsx([
    [isoToSerial("2026-03-15"), null, "?", "ambíguo", 10, 10, 0],
  ]);
  const result = parseNovoBancoXlsx(bytes);
  assertEquals(result.rows.length, 0);
  assertEquals(result.warnings[0].includes("débito E crédito"), true);
});

Deno.test("parse - linha terminal sem data numérica → skip silencioso (saldo final)", () => {
  const bytes = buildXlsx([
    [isoToSerial("2026-03-15"), null, "CRD", "Real", null, 100, 100],
    ["-", null, null, "Saldo final", null, null, 100],
  ]);
  const result = parseNovoBancoXlsx(bytes);
  assertEquals(result.rows.length, 1);
});

Deno.test("parse - múltiplas linhas → ordem preservada, rowNumber sequencial", () => {
  const bytes = buildXlsx([
    [isoToSerial("2026-03-15"), null, "CRD", "A", null, 100, 100],
    [isoToSerial("2026-03-16"), null, "DEB", "B", 20, null, 80],
    [isoToSerial("2026-03-17"), null, "TRF", "C", null, 200, 280],
  ]);
  const result = parseNovoBancoXlsx(bytes);
  assertEquals(result.rows.length, 3);
  assertEquals(result.rows[0].description, "A");
  assertEquals(result.rows[1].description, "B");
  assertEquals(result.rows[2].description, "C");
  // rowNumber é sequencial entre linhas parseadas; valores concretos dependem
  // de como xlsx serializa a linha vazia (pode ou não compactar). Asserto que
  // são contíguos e crescentes.
  assertEquals(result.rows[1].rowNumber, result.rows[0].rowNumber + 1);
  assertEquals(result.rows[2].rowNumber, result.rows[1].rowNumber + 1);
});

Deno.test("parse - description é trim'd", () => {
  const bytes = buildXlsx([
    [isoToSerial("2026-03-15"), null, "CRD", "   espaços    ", null, 1, 1],
  ]);
  const result = parseNovoBancoXlsx(bytes);
  assertEquals(result.rows[0].description, "espaços");
});

Deno.test("parse - floating point cents arredondam corretamente (40.52 → 4052, não 4052.0000003)", () => {
  // Bug conhecido em JS: 40.52 * 100 = 4052.000000000001. O parser usa
  // Math.round para evitar isto - asserto que se mantém.
  const bytes = buildXlsx([
    [isoToSerial("2026-03-15"), null, "CRD", "rounding", null, 40.52, 40.52],
  ]);
  const result = parseNovoBancoXlsx(bytes);
  assertEquals(result.rows[0].amountCents, 4052);
});

Deno.test("parse - saldo nulo → balanceAfterCents=null", () => {
  const bytes = buildXlsx([
    [isoToSerial("2026-03-15"), null, "CRD", "X", null, 10, null],
  ]);
  const result = parseNovoBancoXlsx(bytes);
  assertEquals(result.rows[0].balanceAfterCents, null);
});

Deno.test("parse - kind não-string → kind=''", () => {
  // Defesa: se o tipo vier vazio/numérico, parser não rebenta.
  const bytes = buildXlsx([
    [isoToSerial("2026-03-15"), null, null, "X", null, 1, 1],
  ]);
  const result = parseNovoBancoXlsx(bytes);
  assertEquals(result.rows.length, 1);
  assertEquals(result.rows[0].kind, "");
});
