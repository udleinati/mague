// Unit tests para as heurísticas puras de extração de apólices (sem binários OCR).
// A função pública extractInsuranceFields chama pdftotext/tesseract; estes testes
// cobrem só a lógica determinística que decide datas/seguradora/nº de apólice.
// Correr:  deno test --allow-env src/apps/api/libs/ocr/extract_pdf_test.ts

import { assertEquals } from "@std/assert";
import {
  findDateCandidates,
  findInsurer,
  findPolicyNumber,
  normalizeDate,
  stripAccents,
  validUntilHints,
} from "./extract_pdf.ts";

// ── normalizeDate ────────────────────────────────────────────────────────────

Deno.test("normalizeDate: assume ordem PT dia/mês/ano, não mês/dia", () => {
  // "03/04/2025" tem de ser 3 de Abril, não 4 de Março - apólices PT são DD/MM.
  assertEquals(normalizeDate("03/04/2025"), "2025-04-03");
});

Deno.test("normalizeDate: aceita separadores / . e -", () => {
  assertEquals(normalizeDate("31/12/2027"), "2027-12-31");
  assertEquals(normalizeDate("31.12.2027"), "2027-12-31");
  assertEquals(normalizeDate("31-12-2027"), "2027-12-31");
});

Deno.test("normalizeDate: ano de 2 dígitos assume 20XX", () => {
  assertEquals(normalizeDate("1.2.27"), "2027-02-01");
});

Deno.test("normalizeDate: mês>12 ou dia>31 → null (não é data)", () => {
  assertEquals(normalizeDate("31/13/2027"), null);
  assertEquals(normalizeDate("32/12/2027"), null);
});

Deno.test("normalizeDate: zero em dia ou mês → null", () => {
  assertEquals(normalizeDate("00/12/2027"), null);
  assertEquals(normalizeDate("12/00/2027"), null);
});

Deno.test("normalizeDate: ano com 3 dígitos ou partes a menos → null", () => {
  assertEquals(normalizeDate("12/12/202"), null);
  assertEquals(normalizeDate("12/2027"), null);
});

Deno.test("normalizeDate: NÃO valida calendário (31 de Fevereiro passa)", () => {
  // Só valida intervalos, não dias-por-mês; o user confirma a data no form.
  assertEquals(normalizeDate("31/02/2027"), "2027-02-31");
});

// ── stripAccents ─────────────────────────────────────────────────────────────

Deno.test("stripAccents: remove diacríticos mas preserva caixa", () => {
  assertEquals(stripAccents("Vigência até Março"), "Vigencia ate Marco");
});

// ── findInsurer ──────────────────────────────────────────────────────────────

Deno.test("findInsurer: devolve a seguradora canónica mesmo em minúsculas", () => {
  assertEquals(findInsurer("apolice da fidelidade nº 123"), "Fidelidade");
});

Deno.test("findInsurer: exige fronteira de palavra (não casa substring)", () => {
  // "fidelidadetotal" não é a Fidelidade; sem \b daria falso positivo.
  assertEquals(findInsurer("seguro fidelidadetotal lda"), undefined);
});

Deno.test("findInsurer: texto sem seguradora conhecida → undefined", () => {
  assertEquals(findInsurer("seguradora local desconhecida"), undefined);
});

// ── findPolicyNumber ─────────────────────────────────────────────────────────

Deno.test("findPolicyNumber: extrai o nº após 'policy:'", () => {
  assertEquals(findPolicyNumber("policy: ABC-12345 emitida hoje"), "ABC-12345");
});

Deno.test("findPolicyNumber: referência curta (<6 chars) é ignorada", () => {
  assertEquals(findPolicyNumber("policy: AB12"), undefined);
});

Deno.test("findPolicyNumber: sem palavra-gatilho → undefined", () => {
  assertEquals(findPolicyNumber("documento sem qualquer referencia util"), undefined);
});

// ── findDateCandidates (com os hints reais) ──────────────────────────────────

Deno.test("findDateCandidates: extrai a data após 'vigencia ate'", () => {
  const text = stripAccents("Vigência até 31/12/2027");
  assertEquals(findDateCandidates(text, validUntilHints), ["2027-12-31"]);
});

Deno.test("findDateCandidates: deduplica a mesma data repetida", () => {
  const text = stripAccents("validade 01/01/2026 e cobertura 01/01/2026");
  assertEquals(findDateCandidates(text, validUntilHints), ["2026-01-01"]);
});

Deno.test("findDateCandidates: texto sem datas → lista vazia", () => {
  assertEquals(findDateCandidates("texto sem qualquer data util", validUntilHints), []);
});
