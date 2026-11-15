// ADR 0011: a projeção é a barreira entre a row da BD (com ActorSnapshots) e a
// resposta da API - este teste falha se alguém voltar a expor um campo *_by.

import { assertEquals } from "@std/assert";
import {
  formatInsurancePolicyForResponse,
  formatInsurancePolicyWithCapabilities,
} from "./_projection.ts";

const FORBIDDEN_KEYS = [
  "uploadedBy",
  "confirmedBy",
  "approvedBy",
  "rejectedBy",
  "createdBy",
  "updatedBy",
  "deletedBy",
];

Deno.test("formatInsurancePolicyForResponse remove todos os ActorSnapshots", () => {
  const actor = {
    user_id: "u1",
    email: "admin@mague.pt",
    ip: "10.0.0.1",
    user_agent: "UA",
    request_id: "req1",
  };
  const row = {
    id: "pol1",
    condominiumId: "c1",
    unitId: "un1",
    validFrom: "2026-01-01",
    validTo: "2027-01-01",
    policyNumber: "POL-1",
    insurer: "Fidelidade",
    status: "active",
    coverageAmountCents: 5_000_000,
    uploadedBy: actor,
    confirmedBy: actor,
    approvedBy: actor,
    rejectedBy: actor,
    createdBy: actor,
    updatedBy: actor,
  };

  const out = formatInsurancePolicyForResponse(row as never) as Record<string, unknown>;

  for (const key of FORBIDDEN_KEYS) {
    assertEquals(key in out, false, `campo ${key} não pode sair na resposta (ADR 0011)`);
  }
  // Whitelist mantém o que a UI precisa.
  assertEquals(out.id, "pol1");
  assertEquals(out.status, "active");
  assertEquals(out.policyNumber, "POL-1");
  assertEquals(out.insurer, "Fidelidade");
  assertEquals(out.coverageAmountCents, 5_000_000);
});

Deno.test("formatInsurancePolicyForResponse normaliza opcionais a null", () => {
  const out = formatInsurancePolicyForResponse({
    id: "pol2",
    condominiumId: "c1",
    unitId: "un1",
    validFrom: "2026-01-01",
    validTo: "2027-01-01",
    status: "pending_review",
  } as never);
  assertEquals(out.policyNumber, null);
  assertEquals(out.rejectedReason, null);
  assertEquals(out.presumedAt, null);
  assertEquals(out.evidenceSource, null);
});

// A whitelist da projeção é o sítio onde a coluna `evidence_source` morre se
// ninguém a acrescentar: a view leva-a até ao read-model e a resposta deixava-a
// cair. `adminDocumented` sai computado para o badge não recompor a regra no .vto.

const TODAY = new Date("2026-07-28T00:00:00Z");

function policyRow(over: Record<string, unknown>) {
  return {
    id: "pol3",
    condominiumId: "c1",
    unitId: "un1",
    validFrom: "2026-01-01",
    validTo: "2027-01-01",
    status: "pending_review",
    ...over,
  } as never;
}

Deno.test("formatInsurancePolicyWithCapabilities: documento da administração sai marcado", () => {
  const out = formatInsurancePolicyWithCapabilities(
    policyRow({ evidenceSource: "admin", attachmentCount: 1 }),
    TODAY,
    { isAdmin: true },
  );
  assertEquals(out.evidenceSource, "admin");
  assertEquals(out.adminDocumented, true);
});

Deno.test("formatInsurancePolicyWithCapabilities: comprovativo da fração não é da administração", () => {
  const out = formatInsurancePolicyWithCapabilities(
    policyRow({ evidenceSource: "unit", attachmentCount: 1 }),
    TODAY,
    { isAdmin: true },
  );
  assertEquals(out.evidenceSource, "unit");
  assertEquals(out.adminDocumented, false);
});
