// Tests dos helpers de quórum e majoria (Art. 1432.º CC). Cobrem o WHY:
// estas funções são a "guarda" que protege deliberações inválidas em
// tribunal - mudar o algoritmo afeta diretamente a validade legal das
// atas.

import { assertEquals } from "@std/assert";
import {
  aggregateVotes,
  calculateAssemblyQuorum,
  deriveApprovedFromVotes,
  requiredMajorityForType,
  validateDeliberationMajority,
} from "./quorum_majority.ts";

// ─── Quórum 1ª convocatória ────────────────────────────────────────────────

Deno.test("Quórum 1ª: 501/1000 → tem (maioria estrita)", () => {
  const r = calculateAssemblyQuorum({
    totalAttendeePermillage: 501,
    totalBuildingPermillage: 1000,
    round: "first",
  });
  assertEquals(r.hasQuorum, true);
});

Deno.test("Quórum 1ª: 500/1000 → NÃO tem (maioria é >50%, não ≥)", () => {
  const r = calculateAssemblyQuorum({
    totalAttendeePermillage: 500,
    totalBuildingPermillage: 1000,
    round: "first",
  });
  assertEquals(r.hasQuorum, false);
});

Deno.test("Quórum 1ª: 0/1000 → NÃO tem", () => {
  const r = calculateAssemblyQuorum({
    totalAttendeePermillage: 0,
    totalBuildingPermillage: 1000,
    round: "first",
  });
  assertEquals(r.hasQuorum, false);
});

// ─── Quórum 2ª convocatória ────────────────────────────────────────────────

Deno.test("Quórum 2ª: 1/1000 → tem (qualquer presença chega)", () => {
  const r = calculateAssemblyQuorum({
    totalAttendeePermillage: 1,
    totalBuildingPermillage: 1000,
    round: "second",
  });
  assertEquals(r.hasQuorum, true);
});

Deno.test("Quórum 2ª: 0/1000 → NÃO tem (precisa de pelo menos 1)", () => {
  const r = calculateAssemblyQuorum({
    totalAttendeePermillage: 0,
    totalBuildingPermillage: 1000,
    round: "second",
  });
  assertEquals(r.hasQuorum, false);
});

// ─── Majoria por item_type ─────────────────────────────────────────────────

Deno.test("requiredMajorityForType: approve_budget → simple", () => {
  assertEquals(requiredMajorityForType("approve_budget"), "simple");
});

Deno.test("requiredMajorityForType: approve_fcr_usage → two_thirds", () => {
  assertEquals(requiredMajorityForType("approve_fcr_usage"), "two_thirds");
});

Deno.test("requiredMajorityForType: tipo desconhecido → simple (default)", () => {
  assertEquals(requiredMajorityForType("xpto_random"), "simple");
});

Deno.test("requiredMajorityForType: null/undefined → simple", () => {
  assertEquals(requiredMajorityForType(null), "simple");
  assertEquals(requiredMajorityForType(undefined), "simple");
});

// ─── Validate deliberation majority - simple ────────────────────────────────

Deno.test("Majoria simple: 600 favor vs 400 contra → aprovada", () => {
  const r = validateDeliberationMajority("simple", {
    votesInFavor: 600,
    votesAgainst: 400,
    votesAbstain: 0,
    totalBuildingPermillage: 1000,
  });
  assertEquals(r.approved, true);
});

Deno.test("Majoria simple: 500 favor vs 500 contra → reprovada (empate não conta como aprovação)", () => {
  const r = validateDeliberationMajority("simple", {
    votesInFavor: 500,
    votesAgainst: 500,
    votesAbstain: 0,
    totalBuildingPermillage: 1000,
  });
  assertEquals(r.approved, false);
});

Deno.test("Majoria simple: abstenções não bloqueiam", () => {
  // 200 favor, 100 contra, 700 abstém → aprovada (favor > contra).
  const r = validateDeliberationMajority("simple", {
    votesInFavor: 200,
    votesAgainst: 100,
    votesAbstain: 700,
    totalBuildingPermillage: 1000,
  });
  assertEquals(r.approved, true);
});

// ─── Validate deliberation majority - two_thirds ────────────────────────────

Deno.test("Majoria 2/3: 667 favor / 333 outros presentes → aprovada", () => {
  const r = validateDeliberationMajority("two_thirds", {
    votesInFavor: 667,
    votesAgainst: 200,
    votesAbstain: 133,
    totalBuildingPermillage: 1000,
  });
  assertEquals(r.approved, true);
});

Deno.test("Majoria 2/3: 666 favor / 334 outros → reprovada (falta 1‰)", () => {
  const r = validateDeliberationMajority("two_thirds", {
    votesInFavor: 666,
    votesAgainst: 100,
    votesAbstain: 234,
    totalBuildingPermillage: 1000,
  });
  // 666 < (2/3) * 1000 = 666.66...
  assertEquals(r.approved, false);
});

Deno.test("Majoria 2/3: 0 presentes → reprovada (defesa contra divisão por zero)", () => {
  const r = validateDeliberationMajority("two_thirds", {
    votesInFavor: 0,
    votesAgainst: 0,
    votesAbstain: 0,
    totalBuildingPermillage: 1000,
  });
  assertEquals(r.approved, false);
});

// ─── Validate deliberation majority - unanimous ─────────────────────────────

Deno.test("Unanimidade: todos os 1000 favor → aprovada", () => {
  const r = validateDeliberationMajority("unanimous", {
    votesInFavor: 1000,
    votesAgainst: 0,
    votesAbstain: 0,
    totalBuildingPermillage: 1000,
  });
  assertEquals(r.approved, true);
});

Deno.test("Unanimidade: 999 favor, 1 ausente → reprovada (não há unanimidade)", () => {
  const r = validateDeliberationMajority("unanimous", {
    votesInFavor: 999,
    votesAgainst: 0,
    votesAbstain: 0,
    totalBuildingPermillage: 1000,
  });
  assertEquals(r.approved, false);
});

Deno.test("Unanimidade: 999 favor, 1 abstém → reprovada", () => {
  const r = validateDeliberationMajority("unanimous", {
    votesInFavor: 999,
    votesAgainst: 0,
    votesAbstain: 1,
    totalBuildingPermillage: 1000,
  });
  assertEquals(r.approved, false);
});

// ─── aggregateVotes ─────────────────────────────────────────────────────────

Deno.test("aggregateVotes: soma corretamente por categoria", () => {
  const r = aggregateVotes([
    { vote: "favor", permillageApplied: 250 },
    { vote: "favor", permillageApplied: 100 },
    { vote: "against", permillageApplied: 150 },
    { vote: "abstain", permillageApplied: 50 },
  ]);
  assertEquals(r, { votesInFavor: 350, votesAgainst: 150, votesAbstain: 50 });
});

Deno.test("aggregateVotes: lista vazia → zeros", () => {
  assertEquals(aggregateVotes([]), { votesInFavor: 0, votesAgainst: 0, votesAbstain: 0 });
});

// ─── deriveApprovedFromVotes ─────────────────────────────────────────────────
// O resultado é SEMPRE derivado dos votos (Regra 5): garante que o algoritmo
// de maioria por tipo é o único decisor de Aprovada/Rejeitada/Pendente.

Deno.test("deriveApproved: sem votos (0/0/0) → null (pendente, ainda não votado)", () => {
  const r = deriveApprovedFromVotes("approve_budget", {
    votesInFavor: 0,
    votesAgainst: 0,
    votesAbstain: 0,
  }, 1000);
  assertEquals(r, null);
});

Deno.test("deriveApproved: item_type 'info' → null (sem deliberação), mesmo com votos", () => {
  const r = deriveApprovedFromVotes("info", {
    votesInFavor: 900,
    votesAgainst: 0,
    votesAbstain: 0,
  }, 1000);
  assertEquals(r, null);
});

Deno.test("deriveApproved: simple 600>400 → true (sem o admin escolher)", () => {
  const r = deriveApprovedFromVotes("approve_budget", {
    votesInFavor: 600,
    votesAgainst: 400,
    votesAbstain: 0,
  }, 1000);
  assertEquals(r, true);
});

Deno.test("deriveApproved: simple 400<600 → false", () => {
  const r = deriveApprovedFromVotes("accounts_approval", {
    votesInFavor: 400,
    votesAgainst: 600,
    votesAbstain: 0,
  }, 1000);
  assertEquals(r, false);
});

Deno.test("deriveApproved: FCR exige 2/3 - 700/1000 presentes → true", () => {
  const r = deriveApprovedFromVotes("approve_fcr_usage", {
    votesInFavor: 700,
    votesAgainst: 200,
    votesAbstain: 100,
  }, 1000);
  assertEquals(r, true);
});

Deno.test("deriveApproved: FCR 2/3 - 600/1000 presentes → false (maioria simples não chega)", () => {
  const r = deriveApprovedFromVotes("approve_fcr_usage", {
    votesInFavor: 600,
    votesAgainst: 100,
    votesAbstain: 300,
  }, 1000);
  // 600 < (2/3)*1000 = 666.7; com regra simples seria true - prova que o tipo decide.
  assertEquals(r, false);
});
