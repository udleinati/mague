// Testa `planConvocationDispatch` - ponto único de decisão dono vs residente (ADR 0034).
// Intenção (Rule 9): o RESIDENTE nunca recebe procuração em seu nome (não vota), sai em
// branco; o OWNER recebe-a personalizada com NIF/NIPC conforme a natureza jurídica.

import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { planConvocationDispatch } from "./convocation_dispatch.ts";
import type { ConvocationRecipient } from "./convocation_recipients.ts";

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
    unitIdentifier: "Bloco 3 5C",
    ownerNamesOfUnit: [],
    ...p,
  };
}

const CTX = {
  unitLabel: "AT - Bloco 3 5C",
  condominiumName: "Condomínio Alfa",
  correctionEmail: "gestor@alfa.pt",
  assemblyType: "ordinary" as const,
  firstConvocation: "10/07/2026 19:00",
};

describe("planConvocationDispatch (owner)", () => {
  it("singular -> procuração personalizada com NIF + nome + fração", () => {
    const plan = planConvocationDispatch(
      recipient({ relationshipType: "owner", personType: "singular", nif: "123456789" }),
      CTX,
    );
    assertEquals(plan.email.role, "owner");
    // O email do owner leva a natureza jurídica (singular vs sociedade).
    if (plan.email.role === "owner") assertEquals(plan.email.personType, "singular");
    assertEquals(plan.proxy.mode, "personalized");
    if (plan.proxy.mode === "personalized") {
      assertEquals(plan.proxy.nifLabel, "NIF");
      assertEquals(plan.proxy.nif, "123456789");
      assertEquals(plan.proxy.name, "Maria Silva");
      assertEquals(plan.proxy.unitLabel, "AT - Bloco 3 5C");
      assertEquals(plan.proxy.personType, "singular");
    }
  });

  it("coletiva -> rótulo fiscal NIPC (a empresa não é 'NIF') + email da sociedade", () => {
    const plan = planConvocationDispatch(
      recipient({ relationshipType: "owner", personType: "collective", nif: "501234567" }),
      CTX,
    );
    // WHY: o email de uma sociedade é redigido para a empresa (não "Caro(a)").
    if (plan.email.role === "owner") assertEquals(plan.email.personType, "collective");
    assertEquals(plan.proxy.mode, "personalized");
    if (plan.proxy.mode === "personalized") {
      assertEquals(plan.proxy.nifLabel, "NIPC");
      assertEquals(plan.proxy.personType, "collective");
    }
  });

  it("sem NIF no registo -> nif null (procuração imprime linha em branco)", () => {
    const plan = planConvocationDispatch(
      recipient({ relationshipType: "owner", nif: null }),
      CTX,
    );
    if (plan.proxy.mode === "personalized") assertEquals(plan.proxy.nif, null);
  });
});

describe("planConvocationDispatch (resident)", () => {
  it("procuração EM BRANCO - o residente nunca é mandante (não vota)", () => {
    // WHY: um residente não-proprietário não tem voto, logo não pode ser
    // representado nem dar procuração em seu nome (seria juridicamente inválida).
    // A procuração sai em branco para um PROPRIETÁRIO a preencher (ADR 0034).
    const plan = planConvocationDispatch(
      recipient({ relationshipType: "resident", ownerNamesOfUnit: ["João Dono"] }),
      CTX,
    );
    assertEquals(plan.proxy.mode, "blank");
    assertEquals(plan.email.role, "resident");
    if (plan.email.role === "resident") {
      assertEquals(plan.email.ownerNames, ["João Dono"]);
    }
  });

  it("compropriedade -> lista TODOS os donos da fração no email", () => {
    const plan = planConvocationDispatch(
      recipient({ relationshipType: "resident", ownerNamesOfUnit: ["João Dono", "Ana Dona"] }),
      CTX,
    );
    if (plan.email.role === "resident") {
      assertEquals(plan.email.ownerNames, ["João Dono", "Ana Dona"]);
    }
  });
});

describe("planConvocationDispatch (assunto + nota de correção)", () => {
  it("o assunto leva tipo + data da assembleia, a fração (unitLabel) e o condomínio", () => {
    const plan = planConvocationDispatch(recipient({}), CTX);
    assertEquals(
      plan.subject,
      "Convocatória - Assembleia ordinária de condóminos - 10/07/2026 19:00 - Fração AT - Bloco 3 5C - Condomínio Alfa",
    );
  });

  it("extraordinária -> o tipo reflete-se no assunto", () => {
    const plan = planConvocationDispatch(recipient({}), { ...CTX, assemblyType: "extraordinary" });
    assertEquals(
      plan.subject,
      "Convocatória - Assembleia extraordinária de condóminos - 10/07/2026 19:00 - Fração AT - Bloco 3 5C - Condomínio Alfa",
    );
  });

  it("propaga o correctionEmail em ambos os ramos", () => {
    const owner = planConvocationDispatch(recipient({ relationshipType: "owner" }), CTX);
    const resid = planConvocationDispatch(recipient({ relationshipType: "resident" }), CTX);
    assertEquals(owner.correctionEmail, "gestor@alfa.pt");
    assertEquals(resid.correctionEmail, "gestor@alfa.pt");
  });

  it("correctionEmail null quando o condomínio não tem email -> nota sai sem endereço", () => {
    // WHY: o envio não pode abortar por falta de email de contacto; a nota
    // simplesmente sai sem endereço (o caller/template trata o null).
    const plan = planConvocationDispatch(recipient({}), { ...CTX, correctionEmail: null });
    assertEquals(plan.correctionEmail, null);
  });
});
