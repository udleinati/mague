// O que estes testes prendem é a razão de o presenter existir: o mesmo `kind`
// tem de se ler de maneiras diferentes conforme quem lê (e concordar em género),
// e nenhum estado pode ficar sem etiqueta. As cinco escadas que ele substituiu
// divergiam em todos estes pontos.

import { assertEquals } from "@std/assert";
import {
  insuranceHero,
  insurancePresumedPending,
  insuranceStatusBadge,
  type InsuranceStatusVoice,
} from "./insurance_status.ts";

const KINDS = [
  "active",
  "expiring_soon",
  "expired",
  "awaiting_approval",
  "awaiting_confirmation",
  "rejected_only",
  "superseded",
  "never_submitted",
];
const VOICES: InsuranceStatusVoice[] = ["unit", "policy", "portal"];

Deno.test("concordância de género: a fração é 'Ativo', a apólice é 'Ativa'", () => {
  assertEquals(insuranceStatusBadge("active", "unit").label, "Ativo");
  assertEquals(insuranceStatusBadge("expired", "unit").label, "Vencido");
  assertEquals(insuranceStatusBadge("rejected_only", "unit").label, "Rejeitado");

  assertEquals(insuranceStatusBadge("active", "policy").label, "Ativa");
  assertEquals(insuranceStatusBadge("expired", "policy").label, "Vencida");
  assertEquals(insuranceStatusBadge("rejected_only", "policy").label, "Rejeitada");
});

Deno.test("o portal fala à fração, não descreve a fila do admin", () => {
  // "Aguarda aprovação"/"Aguarda condómino" descrevem o trabalho da
  // administração; à fração interessa o que se passa com o documento dela.
  assertEquals(insuranceStatusBadge("awaiting_approval", "policy").label, "Aguarda aprovação");
  assertEquals(insuranceStatusBadge("awaiting_approval", "portal").label, "Em revisão");

  assertEquals(insuranceStatusBadge("awaiting_confirmation", "policy").label, "Aguarda condómino");
  assertEquals(insuranceStatusBadge("awaiting_confirmation", "portal").label, "Por confirmar");
});

Deno.test("uma pendência da própria fração é warning no portal, informação passiva no admin", () => {
  assertEquals(insuranceStatusBadge("awaiting_confirmation", "portal").tone, "warning");
  assertEquals(insuranceStatusBadge("awaiting_confirmation", "policy").tone, "muted");
});

Deno.test("ao nível da fração, 'só rejeitada' é falta de cobertura - não um alarme vermelho", () => {
  // O vermelho pertence à apólice concreta que foi recusada; a fração está
  // simplesmente a descoberto, como quem nunca submeteu.
  assertEquals(insuranceStatusBadge("rejected_only", "unit").tone, "muted");
  assertEquals(insuranceStatusBadge("never_submitted", "unit").tone, "neutral");
  assertEquals(insuranceStatusBadge("rejected_only", "policy").tone, "error");
});

Deno.test("todos os kinds têm etiqueta em todas as vozes (nenhuma célula em branco)", () => {
  for (const voice of VOICES) {
    for (const kind of KINDS) {
      const badge = insuranceStatusBadge(kind, voice);
      assertEquals(
        badge.label.length > 0,
        true,
        `${voice}/${kind} ficou sem label`,
      );
    }
  }
});

Deno.test("substituída nunca se lê 'Rejeitada' (era o que o histórico da fração mostrava)", () => {
  for (const voice of VOICES) {
    assertEquals(insuranceStatusBadge("superseded", voice).label.startsWith("Substituíd"), true);
  }
});

Deno.test("kind desconhecido ou ausente degrada para 'Sem submissão', não para vazio", () => {
  assertEquals(insuranceStatusBadge(null, "policy").label, "Sem submissão");
  assertEquals(insuranceStatusBadge(undefined, "unit").label, "Sem submissão");
  assertEquals(
    insuranceStatusBadge("um_kind_que_ainda_nao_existe", "portal").label,
    "Sem submissão",
  );
  assertEquals(insuranceStatusBadge("um_kind_que_ainda_nao_existe", "portal").tone, "neutral");
});

// ─── insuranceHero ───────────────────────────────────────────────────────────
// O hero do portal era uma escada de 8 ramos dentro do `index.vto`, paralela a
// este módulo e já em desacordo com ele. O que estes testes prendem é que as
// duas superfícies (badge e hero) dizem a mesma coisa sobre o mesmo `kind`.

Deno.test("hero: sem estado nenhum lê-se como quem nunca submeteu", () => {
  const h = insuranceHero(null);
  assertEquals(h.kind, "never_submitted");
  assertEquals(h.highlight, "sem apólice");
  assertEquals(h.cta.label, "Submeter apólice");
});

Deno.test("hero: 'por confirmar' é warning, não info", () => {
  // A escada no template pintava-o `text-info`; o mapa de tons deste módulo diz
  // `warning` porque é uma pendência DA FRAÇÃO. As duas não podiam discordar.
  const h = insuranceHero({ kind: "awaiting_confirmation" });
  assertEquals(h.tone, "warning");
  assertEquals(h.tone, insuranceStatusBadge("awaiting_confirmation", "portal").tone);
});

Deno.test("hero: o tom acompanha o badge da voz `portal` em cada estado com apólice", () => {
  // Onde as duas superfícies falam da MESMA apólice não podem discordar - era
  // exatamente aí que a escada do template tinha derivado.
  for (const kind of KINDS.filter((k) => k !== "never_submitted")) {
    assertEquals(
      insuranceHero({ kind }).tone,
      insuranceStatusBadge(kind, "portal").tone,
      `tom divergente em ${kind}`,
    );
  }
});

Deno.test("hero: 'sem apólice' é vermelho, ao contrário do badge", () => {
  // Divergência deliberada e herdada do template: no hero é a chamada à ação da
  // fração descoberta; numa lista o mesmo estado é só informação (neutral).
  assertEquals(insuranceHero({ kind: "never_submitted" }).tone, "error");
  assertEquals(insuranceStatusBadge("never_submitted", "portal").tone, "neutral");
});

Deno.test("hero: kind desconhecido degrada para 'sem apólice'", () => {
  const h = insuranceHero({ kind: "um_kind_que_ainda_nao_existe" });
  assertEquals(h.kind, "never_submitted");
  assertEquals(h.highlight, "sem apólice");
});

Deno.test("hero: com apólice de onde herdar propõe renovar; sem ela, submeter", () => {
  // A renovação herda os dados do predecessor, portanto precisa de um: só o
  // `kind` não chega, é o `policy.id` que faz o URL existir.
  const comApolice = (kind: string, daysOverdue = 0) =>
    insuranceHero({ kind, daysOverdue, policy: { id: "p1" } }).cta;

  assertEquals(comApolice("active").label, "Renovar apólice");
  assertEquals(comApolice("active").target, "renew");
  assertEquals(comApolice("expiring_soon").label, "Renovar apólice");
  // Vencida dentro da janela do `canRenew` continua renovável - senão o hero
  // mandava submeter de raiz uma apólice que o detalhe ainda deixa renovar.
  assertEquals(comApolice("expired", 100).label, "Renovar apólice");
  assertEquals(comApolice("expired", 400).label, "Submeter apólice");
  assertEquals(comApolice("rejected_only").label, "Submeter apólice");
});

Deno.test("hero: sem apólice identificada não promete renovação", () => {
  // Sem `policy.id` não há predecessor de onde herdar nem URL para onde ir.
  const h = insuranceHero({ kind: "active" });
  assertEquals(h.cta.label, "Submeter apólice");
  assertEquals(h.cta.target, "upload");
});

Deno.test("hero: renovação presumida manda para o detalhe, não para nova submissão", () => {
  // Submeter de novo criava uma apólice por cima da presumida; o comprovativo
  // pertence à que já existe.
  const h = insuranceHero({ kind: "active", policy: { id: "p1", presumedAt: "2026-06-01" } });
  assertEquals(h.presumedPending, true);
  assertEquals(h.cta.target, "detail");
  assertEquals(h.cta.label, "Enviar comprovativo");
  assertEquals(h.tone, "warning");
});

Deno.test("hero: os dias vêm do estado, não de uma contagem própria", () => {
  assertEquals(insuranceHero({ kind: "expired", daysOverdue: 42 }).highlight, "vencida há 42 dias");
  assertEquals(
    insuranceHero({ kind: "expiring_soon", daysUntilExpiry: 9 }).highlight,
    "expira em 9 dias",
  );
});

// ─── insurancePresumedPending ────────────────────────────────────────────────

Deno.test("presumida: só a ativa sem anexos aguarda comprovativo", () => {
  assertEquals(insurancePresumedPending({ status: "active", presumedAt: "2026-06-01" }, 0), true);
  // Com o recibo já anexado deixa de aguardar.
  assertEquals(insurancePresumedPending({ status: "active", presumedAt: "2026-06-01" }, 1), false);
  // Sem presunção não há nada a aguardar.
  assertEquals(insurancePresumedPending({ status: "active", presumedAt: null }, 0), false);
});

Deno.test("presumida: uma rejeitada não aguarda comprovativo nenhum", () => {
  // O template testava `kind !== "superseded"`, o que deixava passar a rejeitada
  // e prometia à fração que a cobertura ia ser reconhecida.
  assertEquals(
    insurancePresumedPending({ status: "rejected", presumedAt: "2026-06-01" }, 0),
    false,
  );
  assertEquals(
    insurancePresumedPending({ status: "superseded", presumedAt: "2026-06-01" }, 0),
    false,
  );
});
