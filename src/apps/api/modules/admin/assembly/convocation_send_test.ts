// `renderConvocationEmailHtml` é o ponto único do corpo do email - envio e pré-visualização
// usam-no, garantindo que o "Ver" mostra exatamente o que o destinatário recebe. O teste fixa
// o wiring (recipient → corpo; ramo owner vs residente) sem BD/Chromium/rede.

import { assertStringIncludes } from "@std/assert";
import { renderConvocationEmailHtml } from "./convocation_send.ts";
import { planConvocationDispatch } from "./convocation_dispatch.ts";
import type { ConvocationRecipient } from "./convocation_recipients.ts";

const META = {
  condominiumName: "Condomínio Alfa",
  designationType: "condominium" as const,
  assemblyType: "ordinary" as const,
  firstConvocation: "10/07/2026 19:00",
  secondConvocation: null,
  location: "Sala de reuniões",
  correctionEmail: "gestor@alfa.pt",
};

const PLAN_CTX = {
  unitLabel: "AT - Bloco 2 5C",
  condominiumName: META.condominiumName,
  correctionEmail: META.correctionEmail,
  assemblyType: META.assemblyType,
  firstConvocation: META.firstConvocation,
};

const PORTAL_URL = "https://painel.test/portal/c/cid/u/u1/assemblies";

function recipient(p: Partial<ConvocationRecipient>): ConvocationRecipient {
  return {
    occupantId: "o1",
    unitId: "u1",
    name: "Maria Silva",
    nif: "123456789",
    personType: "singular",
    email: "maria@test.pt",
    hasEmail: true,
    relationshipType: "owner",
    unitDesignation: "AT",
    unitIdentifier: "Bloco 2 5C",
    ownerNamesOfUnit: [],
    ...p,
  };
}

const render = (r: ConvocationRecipient) =>
  renderConvocationEmailHtml({
    recipient: r,
    plan: planConvocationDispatch(r, PLAN_CTX),
    emailMeta: META,
    portalUrl: PORTAL_URL,
  });

Deno.test("renderConvocationEmailHtml: owner traz saudação personalizada + data + portal", () => {
  const html = render(recipient({ relationshipType: "owner", name: "Maria Silva" }));
  assertStringIncludes(html, "Maria Silva");
  assertStringIncludes(html, "10/07/2026 19:00");
  assertStringIncludes(html, PORTAL_URL);
});

Deno.test("renderConvocationEmailHtml: residente identifica os donos e nega voto próprio", () => {
  const html = render(
    recipient({
      relationshipType: "resident",
      name: "João Inquilino",
      ownerNamesOfUnit: ["Maria Silva", "Rui Dono"],
    }),
  );
  assertStringIncludes(html, "não dispõe de voto próprio");
  assertStringIncludes(html, "Maria Silva");
  assertStringIncludes(html, "Rui Dono");
});
