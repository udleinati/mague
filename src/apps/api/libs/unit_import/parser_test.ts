// Unit tests para o parser de import de frações + ocupantes.
// Constrói workbooks reais em memória (lib `xlsx`) - sem DB nem HTTP.
// Correr:  deno test --allow-env src/apps/api/libs/unit_import/parser_test.ts

import { assertEquals } from "@std/assert";
import * as XLSX from "xlsx";
import { parseUnitsImport } from "./parser.ts";

function toXlsx(aoa: unknown[][]): Uint8Array {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Dados");
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }));
}

const HEADER = [
  "Fração",
  "Tipo",
  "Permilagem",
  "Bloco",
  "Piso",
  "Porta",
  "Descrição",
  "Nome",
  "Email",
  "Telefone",
  "NIF",
  "Relação",
];

Deno.test("parseUnitsImport: dedup, permilagem PT, enums inválidos e fusão por nome", () => {
  const { units, occupants, links, warnings } = parseUnitsImport(toXlsx([
    HEADER,
    [
      "A",
      "residential",
      "12,5",
      "",
      "1",
      "Esq",
      "",
      "Ana Leitão",
      "ana@x.pt",
      "",
      "123456789",
      "owner",
    ],
    ["A", "residential", "15", "", "1", "Esq", "", "", "", "", "", ""], // dup A, permilagem diverge
    ["B", "commercial", "2,5", "", "-1", "G1", "", "Ana Leitão", "", "", "", "owner"], // Ana sem contactos → funde
    ["C", "bogus", "3", "", "2", "Dt", "", "João", "joao@x.pt", "", "", "tenant"], // tipo inválido
    ["D", "residential", "1", "", "3", "Dt", "", "Maria", "", "", "999", "superdono"], // relação inválida
  ]));

  // ── Frações: dedup por designation (1ª vence), permilagem PT parseada ──
  assertEquals(units.length, 4);
  assertEquals(units.find((u) => u.designation === "A")?.permillage, 12.5);
  assertEquals(units.find((u) => u.designation === "C")?.unitType, "residential"); // "bogus" → fallback

  // ── Ocupantes: dedup por email>nif>nome; Ana "pobre" fundida na "rica" ──
  assertEquals(occupants.length, 3);
  const ana = occupants.find((o) => o.name === "Ana Leitão");
  assertEquals(ana?.email, "ana@x.pt");
  assertEquals(ana?.nif, "123456789");

  // ── Links: a fração B aponta para a Ana canónica (com email) ──
  assertEquals(links.length, 4);
  assertEquals(links.find((l) => l.unitDesignation === "B")?.occupantKey, "e:ana@x.pt");

  // ── Warnings: permilagem divergente + tipo + relação + fusão ──
  assertEquals(warnings.length, 4);
  assertEquals(warnings.some((w) => w.includes("permilagem diferente")), true);
  assertEquals(warnings.some((w) => w.includes("fundidos")), true);
});

Deno.test("parseUnitsImport: duas pessoas com mesmo nome mas NIFs diferentes NÃO se fundem", () => {
  const { occupants } = parseUnitsImport(toXlsx([
    HEADER,
    ["A", "residential", "1", "", "", "", "", "João Costa", "", "", "111111111", "owner"],
    ["B", "residential", "1", "", "", "", "", "João Costa", "", "", "222222222", "owner"],
  ]));
  // Ambos "ricos" (NIF) → registos distintos, sem fusão.
  assertEquals(occupants.length, 2);
});

const CSV_ROWS = [
  HEADER,
  [
    "C",
    "residential",
    "100",
    "",
    "1",
    "Dto.",
    "",
    "Ana Simão",
    "",
    "",
    "123456789",
    "owner",
  ],
];
const BOM = String.fromCharCode(0xFEFF);
const toCsv = (aoa: string[][]) => aoa.map((r) => r.join(",")).join("\r\n") + "\r\n";

// Google Sheets, Numbers e LibreOffice gravam UTF-8 sem BOM; o import não pode
// criar uma fração com o cabeçalho nem estragar os acentos dos nomes.
Deno.test("parseUnitsImport: CSV UTF-8 lê igual com e sem BOM", () => {
  for (const prefix of [BOM, ""]) {
    const { units, occupants, warnings } = parseUnitsImport(
      new TextEncoder().encode(prefix + toCsv(CSV_ROWS)),
    );
    assertEquals(units.map((u) => u.designation), ["C"]);
    assertEquals(occupants[0].name, "Ana Simão");
    assertEquals(warnings, []);
  }
});

// O Excel em Windows grava "CSV (separado por vírgulas)" em Windows-1252; a
// correção do UTF-8 não pode partir estes ficheiros.
Deno.test("parseUnitsImport: CSV Windows-1252 continua a ler acentos", () => {
  const latin1 = Uint8Array.from(toCsv(CSV_ROWS), (ch) => ch.charCodeAt(0));
  const { units, occupants } = parseUnitsImport(latin1);
  assertEquals(units.map((u) => u.designation), ["C"]);
  assertEquals(occupants[0].name, "Ana Simão");
});

Deno.test("parseUnitsImport: linha sem designação é ignorada", () => {
  const { units } = parseUnitsImport(toXlsx([
    HEADER,
    ["A", "residential", "1", "", "", "", "", "", "", "", "", ""],
    ["", "residential", "9", "", "", "", "", "", "", "", "", ""], // sem fração → ignorada
  ]));
  assertEquals(units.length, 1);
});
