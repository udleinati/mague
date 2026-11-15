// Testa `classifyConvocationRecipients` (parte pura) + `recipientKey`. Intenção (Rule 9):
// 1 destinatário por (occupant × fração), sem dedup (ADR 0034), só owner+resident, NIF +
// natureza jurídica propagados, sem email entra hasEmail=false; recipientKey isola a janela
// de cooldown entre frações da mesma pessoa.

import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import {
  classifyConvocationRecipients,
  type RawConvocationRow,
  recipientKey,
} from "./convocation_recipients.ts";

function row(p: Partial<RawConvocationRow>): RawConvocationRow {
  return {
    occupantId: "o1",
    occupantName: "Pessoa",
    occupantEmail: "p@test.pt",
    occupantNif: null,
    occupantPersonType: "singular",
    occupantDeleted: false,
    relationshipType: "owner",
    unitId: "u1",
    unitDesignation: "A",
    unitIdentifier: null,
    ...p,
  };
}

describe("classifyConvocationRecipients (por fração)", () => {
  it("um destinatário por ligação: dono de várias frações -> várias entradas", () => {
    const out = classifyConvocationRecipients([
      row({ occupantId: "o1", unitId: "u1", unitDesignation: "A" }),
      row({ occupantId: "o1", unitId: "u2", unitDesignation: "B" }),
    ]);
    // WHY: a procuração é por fração (delega-se o voto da permilagem daquela
    // fração) - 2 frações = 2 documentos = 2 emails (ADR 0034), invertendo o
    // dedup por pessoa anterior.
    assertEquals(out.length, 2);
    assertEquals(out.map((r) => r.unitId), ["u1", "u2"]);
    assertEquals(out.every((r) => r.occupantId === "o1"), true);
  });

  it("exclui tenant; mantém owner e resident com o papel desta fração", () => {
    const out = classifyConvocationRecipients([
      row({ occupantId: "owner", relationshipType: "owner" }),
      row({ occupantId: "resid", relationshipType: "resident" }),
      row({ occupantId: "tenant", relationshipType: "tenant" }),
    ]);
    assertEquals(out.map((r) => r.occupantId).sort(), ["owner", "resid"]);
    const byId = Object.fromEntries(out.map((r) => [r.occupantId, r]));
    // O papel é preservado por fração (o envio ramifica owner vs resident).
    assertEquals(byId["owner"].relationshipType, "owner");
    assertEquals(byId["resid"].relationshipType, "resident");
  });

  it("mesma pessoa dona de A e residente de B -> owner em A, resident em B", () => {
    const out = classifyConvocationRecipients([
      row({ occupantId: "o1", unitId: "uA", relationshipType: "owner" }),
      row({ occupantId: "o1", unitId: "uB", relationshipType: "resident" }),
    ]);
    assertEquals(out.length, 2);
    const byUnit = Object.fromEntries(out.map((r) => [r.unitId, r]));
    assertEquals(byUnit["uA"].relationshipType, "owner");
    assertEquals(byUnit["uB"].relationshipType, "resident");
  });

  it("classifica hasEmail: sem email -> hasEmail=false (falha, não saltado)", () => {
    const out = classifyConvocationRecipients([
      row({ occupantId: "comm", occupantEmail: "x@test.pt" }),
      row({ occupantId: "sem", occupantEmail: null }),
      row({ occupantId: "vazio", occupantEmail: "   " }),
    ]);
    const byId = Object.fromEntries(out.map((r) => [r.occupantId, r]));
    assertEquals(byId["comm"].hasEmail, true);
    assertEquals(byId["comm"].email, "x@test.pt");
    assertEquals(byId["sem"].hasEmail, false);
    assertEquals(byId["sem"].email, null);
    assertEquals(byId["vazio"].hasEmail, false);
    assertEquals(byId["vazio"].email, null);
  });

  it("ignora occupant soft-deleted", () => {
    const out = classifyConvocationRecipients([
      row({ occupantId: "vivo" }),
      row({ occupantId: "morto", occupantDeleted: true }),
    ]);
    assertEquals(out.map((r) => r.occupantId), ["vivo"]);
  });

  it("propaga NIF e natureza jurídica (controlam NIF/NIPC + redação)", () => {
    const out = classifyConvocationRecipients([
      row({ occupantId: "singular", occupantNif: "123456789", occupantPersonType: "singular" }),
      row({ occupantId: "empresa", occupantNif: "501234567", occupantPersonType: "collective" }),
      row({ occupantId: "semnif", occupantNif: null, occupantPersonType: "" }),
    ]);
    const byId = Object.fromEntries(out.map((r) => [r.occupantId, r]));
    assertEquals(byId["singular"].nif, "123456789");
    assertEquals(byId["singular"].personType, "singular");
    assertEquals(byId["empresa"].personType, "collective");
    // NIF é opcional (occupant.nif nullable) -> null; person_type desconhecido
    // ou vazio normaliza para singular (default seguro).
    assertEquals(byId["semnif"].nif, null);
    assertEquals(byId["semnif"].personType, "singular");
  });

  it("carrega designation + identifier da fração (alimentam unitLabel)", () => {
    const out = classifyConvocationRecipients([
      row({ unitDesignation: "AT", unitIdentifier: "Bloco 3 5C" }),
    ]);
    assertEquals(out[0].unitDesignation, "AT");
    assertEquals(out[0].unitIdentifier, "Bloco 3 5C");
  });
});

describe("classifyConvocationRecipients (donos da fração para a nota do residente)", () => {
  it("residente carrega os nomes dos PROPRIETÁRIOS da sua fração", () => {
    // WHY: o residente não vota; o email diz-lhe quem o pode nomear (ADR 0034).
    const out = classifyConvocationRecipients([
      row({
        occupantId: "dono",
        occupantName: "João Dono",
        unitId: "u1",
        relationshipType: "owner",
      }),
      row({
        occupantId: "res",
        occupantName: "Maria Reside",
        unitId: "u1",
        relationshipType: "resident",
      }),
    ]);
    const resid = out.find((r) => r.occupantId === "res")!;
    assertEquals(resid.ownerNamesOfUnit, ["João Dono"]);
  });

  it("compropriedade -> o residente vê TODOS os donos daquela fração", () => {
    const out = classifyConvocationRecipients([
      row({ occupantId: "d1", occupantName: "João", unitId: "u1", relationshipType: "owner" }),
      row({ occupantId: "d2", occupantName: "Ana", unitId: "u1", relationshipType: "owner" }),
      row({
        occupantId: "res",
        occupantName: "Reside",
        unitId: "u1",
        relationshipType: "resident",
      }),
    ]);
    const resid = out.find((r) => r.occupantId === "res")!;
    assertEquals(resid.ownerNamesOfUnit, ["João", "Ana"]);
  });

  it("nomes são só da PRÓPRIA fração (não vazam donos de outra fração)", () => {
    const out = classifyConvocationRecipients([
      row({ occupantId: "dA", occupantName: "Dono A", unitId: "uA", relationshipType: "owner" }),
      row({ occupantId: "dB", occupantName: "Dono B", unitId: "uB", relationshipType: "owner" }),
      row({
        occupantId: "res",
        occupantName: "Reside",
        unitId: "uA",
        relationshipType: "resident",
      }),
    ]);
    const resid = out.find((r) => r.occupantId === "res")!;
    assertEquals(resid.ownerNamesOfUnit, ["Dono A"]);
  });

  it("residente sem dono na fração -> lista vazia (envio não aborta)", () => {
    const out = classifyConvocationRecipients([
      row({ occupantId: "res", unitId: "u1", relationshipType: "resident" }),
    ]);
    assertEquals(out[0].ownerNamesOfUnit, []);
  });

  it("owner não acumula a lista (ele é o mandante, não precisa)", () => {
    const out = classifyConvocationRecipients([
      row({ occupantId: "dono", unitId: "u1", relationshipType: "owner" }),
    ]);
    assertEquals(out[0].ownerNamesOfUnit, []);
  });

  it("dono soft-deleted não entra na lista do residente", () => {
    const out = classifyConvocationRecipients([
      row({ occupantId: "vivo", occupantName: "Vivo", unitId: "u1", relationshipType: "owner" }),
      row({
        occupantId: "morto",
        occupantName: "Morto",
        unitId: "u1",
        relationshipType: "owner",
        occupantDeleted: true,
      }),
      row({ occupantId: "res", unitId: "u1", relationshipType: "resident" }),
    ]);
    const resid = out.find((r) => r.occupantId === "res")!;
    assertEquals(resid.ownerNamesOfUnit, ["Vivo"]);
  });
});

describe("recipientKey (cooldown por pessoa × fração)", () => {
  it("isola a janela entre frações da mesma pessoa", () => {
    // WHY: reenviar a fração A não pode mexer no cooldown da fração B - a chave
    // distingue (o1, uA) de (o1, uB) (ADR 0034). Sem isto, o display e o guard
    // do reenvio divergiriam entre frações.
    assertEquals(recipientKey("o1", "uA") === recipientKey("o1", "uB"), false);
    assertEquals(recipientKey("o1", "uA"), recipientKey("o1", "uA"));
    // Pessoas diferentes na mesma fração também são chaves distintas.
    assertEquals(recipientKey("o1", "uA") === recipientKey("o2", "uA"), false);
  });
});
