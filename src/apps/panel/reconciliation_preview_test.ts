// Contrato de `_allocation_preview.vto` (preview dry-run da imputação por fração):
// renderiza o partial e asserta o mapeamento visual verde=total / amarelo=parcial /
// sem-marca=não tocada, o total quitado, o excedente e o caso sem elegíveis. Sem BD/API.

import { assert, assertStringIncludes } from "@std/assert";
import { render } from "./render.ts";

const PARTIAL = "pages/reconciliation/_allocation_preview.vto";

function charge(over: Record<string, unknown>) {
  return {
    chargeId: "c",
    description: "Quota",
    chargeType: "quota",
    competencePeriod: "2026-01-01",
    status: "open",
    openAmount: 150_00,
    amountToSettle: 0,
    fill: "none",
    ...over,
  };
}

Deno.test("preview: total=verde, parcial=amarelo, não tocada=sem marca", async () => {
  const html = await render(PARTIAL, {
    preview: {
      charges: [
        charge({
          chargeId: "a",
          description: "Quota Janeiro",
          amountToSettle: 150_00,
          fill: "full",
        }),
        charge({
          chargeId: "b",
          description: "Quota Fevereiro",
          competencePeriod: "2026-02-01",
          amountToSettle: 97_74,
          fill: "partial",
        }),
        charge({
          chargeId: "d",
          description: "Quota Março",
          competencePeriod: "2026-03-01",
          amountToSettle: 0,
          fill: "none",
        }),
      ],
      surplus: 0,
      txAmount: 247_74,
      alreadyAllocated: 0,
      remaining: 247_74,
    },
  });
  // Linha total → tinta verde; parcial → tinta amarela; não tocada → chevron transparente.
  assertStringIncludes(html, "bg-success/15");
  assertStringIncludes(html, "bg-warning/15");
  assertStringIncludes(html, "text-transparent");
  // Resumo: quita 2 cobranças (a full + b partial), total 150,00 + 97,74 = 247,74.
  assertStringIncludes(html, "Vai quitar 2 cobrança(s)");
  assertStringIncludes(html, "247,74");
  assertStringIncludes(html, "150,00");
  assertStringIncludes(html, "97,74");
  assertStringIncludes(html, "Ordinária");
});

Deno.test("preview: sem cobranças elegíveis mostra crédito à fração", async () => {
  const html = await render(PARTIAL, {
    preview: {
      charges: [],
      surplus: 50_00,
      txAmount: 50_00,
      alreadyAllocated: 0,
      remaining: 50_00,
    },
  });
  assertStringIncludes(html, "Sem cobranças elegíveis");
  assertStringIncludes(html, "crédito à fração");
  assertStringIncludes(html, "50,00");
  assert(!html.includes("bg-success/15"), "sem elegíveis não deve ter linha verde");
});

Deno.test("preview: excedente com cobranças mostra linha de excedente", async () => {
  const html = await render(PARTIAL, {
    preview: {
      charges: [
        charge({
          chargeId: "e",
          chargeType: "extraordinary_quota",
          description: "Fundo de reserva",
          amountToSettle: 50_00,
          openAmount: 50_00,
          fill: "full",
        }),
      ],
      surplus: 50_00,
      txAmount: 100_00,
      alreadyAllocated: 0,
      remaining: 100_00,
    },
  });
  assertStringIncludes(html, "Excedente");
  assertStringIncludes(html, "Extraordinária");
});
