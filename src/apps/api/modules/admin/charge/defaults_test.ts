import { assertEquals, assertThrows } from "@std/assert";
import {
  deriveCompetenceFromIssueDate,
  inferChargeType,
  normalizeChargeInput,
} from "./defaults.ts";
import { AppError } from "$api/libs/error/app_error.ts";

Deno.test("deriveCompetenceFromIssueDate - data válida → primeiro dia do mês", () => {
  assertEquals(deriveCompetenceFromIssueDate("2026-05-15"), "2026-05-01");
  assertEquals(deriveCompetenceFromIssueDate("2026-01-31"), "2026-01-01");
  assertEquals(deriveCompetenceFromIssueDate("2026-12-01"), "2026-12-01");
});

Deno.test("deriveCompetenceFromIssueDate - formato inválido → null", () => {
  assertEquals(deriveCompetenceFromIssueDate(""), null);
  assertEquals(deriveCompetenceFromIssueDate("2026-05"), null);
  assertEquals(deriveCompetenceFromIssueDate("15/05/2026"), null);
  assertEquals(deriveCompetenceFromIssueDate("not-a-date"), null);
});

Deno.test("inferChargeType - payable + supplier → supplier_service", () => {
  assertEquals(inferChargeType({ kind: "payable", supplierId: "sup_x" }), "supplier_service");
});

Deno.test("inferChargeType - payable sem supplier → expense", () => {
  assertEquals(inferChargeType({ kind: "payable", supplierId: null }), "expense");
  assertEquals(inferChargeType({ kind: "payable", supplierId: undefined }), "expense");
  assertEquals(inferChargeType({ kind: "payable", supplierId: "" }), "expense");
});

Deno.test("inferChargeType - receivable → quota", () => {
  assertEquals(inferChargeType({ kind: "receivable", supplierId: null }), "quota");
  assertEquals(inferChargeType({ kind: "receivable", supplierId: "sup_x" }), "quota");
});

Deno.test("normalizeChargeInput - aplica todos os defaults", () => {
  const result = normalizeChargeInput({
    kind: "payable",
    issueDate: "2026-05-15",
    supplierId: "sup_1",
  });
  assertEquals(result.nature, "debit");
  assertEquals(result.chargeType, "supplier_service");
  assertEquals(result.competencePeriod, "2026-05-01");
});

Deno.test("normalizeChargeInput - respeita overrides explícitos", () => {
  const result = normalizeChargeInput({
    kind: "receivable",
    issueDate: "2026-05-15",
    nature: "credit",
    chargeType: "extraordinary_quota",
    competencePeriod: "2025-01-01",
  });
  assertEquals(result.nature, "credit");
  assertEquals(result.chargeType, "extraordinary_quota");
  assertEquals(result.competencePeriod, "2025-01-01");
});

Deno.test("normalizeChargeInput - issueDate inválido + sem competence → AppError", () => {
  const err = assertThrows(
    () =>
      normalizeChargeInput({
        kind: "payable",
        issueDate: "invalid-date",
      }),
    AppError,
  );
  assertEquals(err.statusCode, 400);
  assertEquals(err.code, "VALIDATION_ERROR");
});

Deno.test("normalizeChargeInput - issueDate inválido mas competence presente → ok", () => {
  const result = normalizeChargeInput({
    kind: "payable",
    issueDate: "invalid",
    competencePeriod: "2026-03-01",
  });
  assertEquals(result.competencePeriod, "2026-03-01");
});
