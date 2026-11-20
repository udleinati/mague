// Contrato da tab Manual de `_tx_modal.vto`: seleção múltipla por checkbox
// (`chargeIds[]`) + resumo "falta conciliar" alimentado por
// `data-tx-unallocated`. Sem BD/API - render puro com dados mock (mesmo
// harness do reconciliation_preview_test).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { render } from "./render.ts";

const MODAL = "pages/reconciliation/_tx_modal.vto";

function charge(over: Record<string, unknown>) {
  return {
    id: "c1",
    unitId: null,
    supplierId: null,
    kind: "receivable",
    nature: "debit",
    chargeType: "quota",
    description: "Quota Janeiro",
    openAmount: 50_00,
    unit_label: null,
    ...over,
  };
}

function baseData(over: Record<string, unknown> = {}) {
  return {
    currentCondominiumId: "cid1",
    t: {
      id: "tx1",
      transactionDate: "2026-07-01",
      description: "TRF Condómino A",
      amount: 100_00,
    },
    txUnallocated: 100_00,
    units: [],
    suppliers: [],
    openCharges: [],
    recentPayablesBySupplier: {},
    suggestedUnitId: null,
    suggestedSupplierId: null,
    ...over,
  };
}

function countOccurrences(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

Deno.test("modal manual: entrada lista receivables como checkboxes e omite payables", async () => {
  const html = await render(
    MODAL,
    baseData({
      openCharges: [
        charge({ id: "c1", description: "Quota Janeiro", unitId: "u1", unit_label: "A" }),
        charge({ id: "c2", description: "Quota Fevereiro", unitId: "u1", unit_label: "A" }),
        charge({
          id: "c3",
          kind: "payable",
          description: "Fatura limpeza",
          supplierId: "s1",
          openAmount: 80_00,
        }),
      ],
    }),
  );
  assertEquals(countOccurrences(html, 'name="chargeIds[]"'), 2);
  assertStringIncludes(html, "Quota Janeiro");
  assertStringIncludes(html, "Quota Fevereiro");
  assert(!html.includes("Fatura limpeza"), "entrada não deve listar payables");
  // O antigo select único desapareceu (o name="chargeId" que resta é o hidden do ajuste).
  assert(!html.includes('<select name="chargeId"'), "select único devia ter saído");
});

Deno.test("modal manual: resumo parte do por-alocar e checkbox carrega openAmount", async () => {
  const html = await render(
    MODAL,
    baseData({
      txUnallocated: 75_50,
      openCharges: [charge({ id: "c1", openAmount: 50_00, unitId: "u1" })],
    }),
  );
  assertStringIncludes(html, 'data-tx-unallocated="7550"');
  assertStringIncludes(html, "Falta conciliar");
  assertStringIncludes(html, "75,50");
  assertStringIncludes(html, 'data-open-amount="5000"');
  // Submit começa desativado (0 selecionadas) e o atalho de ajuste tem os hidden.
  assertStringIncludes(html, "data-manual-submit");
  assertStringIncludes(html, "data-manual-adjust-charge");
  assertStringIncludes(html, "data-manual-adjust-amount");
});

Deno.test("modal manual: saída lista payables e mostra vazio quando não há charges", async () => {
  const html = await render(
    MODAL,
    baseData({
      t: {
        id: "tx2",
        transactionDate: "2026-07-02",
        description: "PAG Fornecedor",
        amount: -80_00,
      },
      txUnallocated: 80_00,
      openCharges: [
        charge({ id: "c1", description: "Quota Janeiro", unitId: "u1" }),
        charge({
          id: "c3",
          kind: "payable",
          description: "Fatura limpeza",
          supplierId: "s1",
          openAmount: 80_00,
        }),
      ],
    }),
  );
  assertEquals(countOccurrences(html, 'name="chargeIds[]"'), 1);
  assertStringIncludes(html, "Fatura limpeza");
  assert(!html.includes("Quota Janeiro"), "saída não deve listar receivables");

  const emptyHtml = await render(
    MODAL,
    baseData({
      t: { id: "tx3", transactionDate: "2026-07-03", description: "PAG X", amount: -10_00 },
      txUnallocated: 10_00,
    }),
  );
  assertStringIncludes(emptyHtml, "Sem charges em aberto");
  assertEquals(countOccurrences(emptyHtml, 'name="chargeIds[]"'), 0);
});

Deno.test("modal parcial: mostra o já conciliado e o disponível, e a devolução parte do disponível", async () => {
  const html = await render(
    MODAL,
    baseData({
      t: {
        id: "tx1",
        transactionDate: "2099-03-10",
        description: "TRF ENTRADA TESTE",
        amount: 500_00,
      },
      txUnallocated: 200_00,
      txAllocated: 300_00,
    }),
  );
  assertStringIncludes(html, "data-tx-available");
  assertStringIncludes(html, "300,00 €");
  assertStringIncludes(html, "Disponível para conciliar");
  assertStringIncludes(html, "200,00 €");
  // Propor o valor do movimento na devolução excederia o que falta conciliar.
  assertStringIncludes(html, 'value="200.00"');
  assert(!html.includes('value="500.00"'));
});

Deno.test("modal sem conciliações: não mostra o quadro do disponível", async () => {
  const html = await render(MODAL, baseData({ txAllocated: 0 }));
  assert(!html.includes("data-tx-available"));
});
