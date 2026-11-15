// Render do PDF do orçamento. Verifica a INTENÇÃO (Rule 9): o badge de estado
// reflete os três estados e nunca rotula um `not_approved` como "Aprovado" nem
// "Rascunho". Puro: `renderTemplate`, sem DB/Chromium.

import { assert, assertStringIncludes } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { renderTemplate } from "$api/libs/templates/render.ts";

const CONDO = { name: "Condomínio Alfa", fiscalNumber: "501234567" };
const BASE_BUDGET = {
  year: "2026",
  type: "principal",
  notes: "Proposta A",
  fcrPercentage: "10.00",
  fcrAmount: 12000,
  totalAmount: 120000,
  approvedAt: null,
  installments: null,
  lines: [],
};

function renderBudget(status: string) {
  return renderTemplate("budget.vto", {
    condominium: CONDO,
    budget: { ...BASE_BUDGET, status },
    quotaMap: null,
    grandTotal: 132000,
    installmentValue: null,
    generatedAt: "2026-06-25T10:00:00+00:00",
  });
}

describe("template budget.vto (PDF) - badge de estado", () => {
  it("draft -> Rascunho", async () => {
    const html = await renderBudget("draft");
    assertStringIncludes(html, "Rascunho");
    assert(!html.includes("Não aprovado"), "draft não pode rotular Não aprovado");
  });

  it("approved -> Aprovado", async () => {
    const html = await renderBudget("approved");
    assertStringIncludes(html, "Aprovado");
    assert(!html.includes("Rascunho"), "approved não pode rotular Rascunho");
  });

  it("not_approved -> Não aprovado (nem Aprovado nem Rascunho)", async () => {
    const html = await renderBudget("not_approved");
    assertStringIncludes(html, "Não aprovado");
    assert(!html.includes("Rascunho"), "not_approved não pode cair no ramo Rascunho");
    assert(!/>\s*Aprovado\s*</.test(html), "not_approved não pode rotular Aprovado");
  });
});
