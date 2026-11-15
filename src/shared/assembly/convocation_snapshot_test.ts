// WHY (Rule 9): o snapshot tem de capturar EXACTAMENTE o que é anunciado num
// envio - ordem do dia (pela ordem dada), textos e datas das 1ª/2ª convocações,
// com datas normalizadas a ISO strings (estáveis em JSONB e em comparações).

import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import {
  agendaChangedSinceSend,
  buildConvocationSnapshot,
  type ConvocationSnapshot,
} from "./convocation_snapshot.ts";

describe("buildConvocationSnapshot", () => {
  it("captura ordem do dia (preservando a ordem), textos e datas", () => {
    const snap = buildConvocationSnapshot(
      {
        convocationIntro: "Caros condóminos",
        convocationFooter: "Procurações até à hora da reunião",
        scheduledAt: "2026-07-10T19:00:00.000Z",
        secondConvocationAt: "2026-07-10T19:30:00.000Z",
      },
      [
        { sequence: 1, subject: "Orçamento 2026", description: "Discussão e votação." },
        { sequence: 2, subject: "Outros assuntos", description: null },
      ],
    );
    assertEquals(snap.convocationIntro, "Caros condóminos");
    assertEquals(snap.convocationFooter, "Procurações até à hora da reunião");
    assertEquals(snap.scheduledAt, "2026-07-10T19:00:00.000Z");
    assertEquals(snap.secondConvocationAt, "2026-07-10T19:30:00.000Z");
    assertEquals(snap.agenda, [
      { sequence: 1, subject: "Orçamento 2026", description: "Discussão e votação." },
      { sequence: 2, subject: "Outros assuntos", description: null },
    ]);
  });

  it("normaliza datas Date -> ISO string", () => {
    const snap = buildConvocationSnapshot(
      { scheduledAt: new Date("2026-07-10T19:00:00.000Z"), secondConvocationAt: null },
      [],
    );
    assertEquals(snap.scheduledAt, "2026-07-10T19:00:00.000Z");
    assertEquals(snap.secondConvocationAt, null);
    assertEquals(snap.agenda, []);
  });

  it("campos ausentes/nulos viram null (intro/footer/2ª convocação)", () => {
    const snap = buildConvocationSnapshot(
      { scheduledAt: "2026-07-10T19:00:00.000Z" },
      [{ subject: "Ponto único" }],
    );
    assertEquals(snap.convocationIntro, null);
    assertEquals(snap.convocationFooter, null);
    assertEquals(snap.secondConvocationAt, null);
    // sequence ausente -> null; description ausente -> null; subject preservado.
    assertEquals(snap.agenda, [{ sequence: null, subject: "Ponto único", description: null }]);
  });
});

// WHY (Rule 9): o badge "há alterações por enviar" impede realizar a assembleia
// sob ordem do dia/datas/textos diferentes do que foi convocado. Tem de disparar
// em QUALQUER divergência material e ficar calada quando coincide.
describe("agendaChangedSinceSend", () => {
  const base: ConvocationSnapshot = {
    agenda: [
      { sequence: 1, subject: "Orçamento 2026", description: "Discussão e votação." },
      { sequence: 2, subject: "Outros assuntos", description: null },
    ],
    convocationIntro: "Caros condóminos",
    convocationFooter: "Procurações até à hora da reunião",
    scheduledAt: "2026-07-10T19:00:00.000Z",
    secondConvocationAt: "2026-07-10T19:30:00.000Z",
  };
  // Deep clone para cada caso não contaminar os outros.
  const clone = (): ConvocationSnapshot => structuredClone(base);

  it("snapshots idênticos -> sem alterações", () => {
    assertEquals(agendaChangedSinceSend(clone(), clone()), false);
  });

  it("nunca enviada (lastSent null) -> false (sinal de propósito único)", () => {
    // O estado "ainda não enviada" é sinalizado em separado (0 runs); esta
    // função só responde "difere do último anunciado", que exige um anúncio.
    assertEquals(agendaChangedSinceSend(clone(), null), false);
  });

  it("assunto de um ponto alterado -> alteração", () => {
    const current = clone();
    current.agenda[0].subject = "Orçamento 2026 (revisto)";
    assertEquals(agendaChangedSinceSend(current, clone()), true);
  });

  it("descrição de um ponto alterada -> alteração", () => {
    const current = clone();
    current.agenda[1].description = "Inclui ponto sobre obras na fachada.";
    assertEquals(agendaChangedSinceSend(current, clone()), true);
  });

  it("ponto acrescentado -> alteração", () => {
    const current = clone();
    current.agenda.push({ sequence: 3, subject: "Eleição da administração", description: null });
    assertEquals(agendaChangedSinceSend(current, clone()), true);
  });

  it("pontos reordenados (mesmo conteúdo) -> alteração", () => {
    // Reordenar a ordem do dia muda o que foi convocado: a função é
    // ordem-sensível de propósito.
    const current = clone();
    current.agenda = [base.agenda[1], base.agenda[0]];
    assertEquals(agendaChangedSinceSend(current, clone()), true);
  });

  it("texto de abertura alterado -> alteração", () => {
    const current = clone();
    current.convocationIntro = "Exmos. Senhores Condóminos";
    assertEquals(agendaChangedSinceSend(current, clone()), true);
  });

  it("rodapé alterado (texto vs null) -> alteração", () => {
    const current = clone();
    current.convocationFooter = null;
    assertEquals(agendaChangedSinceSend(current, clone()), true);
  });

  it("data da 1ª convocação alterada -> alteração", () => {
    const current = clone();
    current.scheduledAt = "2026-07-17T19:00:00.000Z";
    assertEquals(agendaChangedSinceSend(current, clone()), true);
  });

  it("data da 2ª convocação removida -> alteração", () => {
    const current = clone();
    current.secondConvocationAt = null;
    assertEquals(agendaChangedSinceSend(current, clone()), true);
  });
});
