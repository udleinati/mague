// Composição da linha de status por fração. O que estes testes prendem é a
// coerência do par (`aggregate`, `status`): o badge e as datas apresentadas ao
// lado dele têm de vir da MESMA apólice. Derivá-los em separado passava nos
// testes de render (que alimentam os dois com o mesmo objeto) e falhava no ecrã.

import { assertEquals } from "@std/assert";
import { composeUnitStatus, type UnitStatusViewRow } from "./read_model.ts";
import type { InsurancePolicySelect } from "$api/libs/postgres/schemas/mod.ts";

const TODAY = new Date("2026-03-01T00:00:00Z");
const isoDay = (n: number) => new Date(TODAY.getTime() + n * 86_400_000).toISOString().slice(0, 10);

function policy(over: Record<string, unknown>) {
  return {
    id: "p",
    condominiumId: "c1",
    unitId: "u1",
    status: "active",
    validFrom: isoDay(-165),
    validTo: isoDay(200),
    policyNumber: "POL-1",
    insurer: "Fidelidade",
    confirmedAt: isoDay(-165) + "T00:00:00Z",
    approvedAt: isoDay(-165) + "T00:00:00Z",
    presumedAt: null,
    evidenceSource: "unit",
    renewedFromId: null,
    attachmentCount: 1,
    createdAt: isoDay(-165) + "T00:00:00Z",
    ...over,
  } as unknown as UnitStatusViewRow["policies"][number];
}

const row = (policies: InsurancePolicySelect[] | unknown[]): UnitStatusViewRow => ({
  unit_id: "u1",
  designation: "1ºE",
  identifier: null,
  policies: policies as UnitStatusViewRow["policies"],
  last_reminder_at: null,
  last_renewal_evidence_at: null,
  has_occupant_with_email: true,
  occupants: [],
});

Deno.test("renovação em curso: o badge é 'active' e as datas são as DA ativa", () => {
  // O caso real: a fração está coberta e submeteu já a apólice do ano seguinte.
  // `selectPolicyForDisplay` priorizava a pending_review, `computeAggregateStatus`
  // dizia "active" - a célula "Validade" mostrava a vigência da apólice errada.
  const ativa = policy({ id: "p-ativa", validTo: isoDay(200) });
  const pendente = policy({
    id: "p-pendente",
    status: "pending_review",
    validFrom: isoDay(200),
    validTo: isoDay(565),
    confirmedAt: null,
    approvedAt: null,
  });

  const out = composeUnitStatus(row([pendente, ativa]), TODAY);

  assertEquals(out.aggregate, "active");
  assertEquals("policy" in out.status ? out.status.policy.id : null, "p-ativa");
  assertEquals("policy" in out.status ? out.status.policy.validTo : null, isoDay(200));
  // A pendente continua visível na lista por-apólice (não fica escondida).
  assertEquals(out.policies.length, 2);
  assertEquals(out.counts.pending_review, 1);
});

Deno.test("active do proprietário + rejected do inquilino: badge e detalhe na ativa (ADR 0017)", () => {
  const ativa = policy({ id: "p-owner" });
  const rejeitada = policy({
    id: "p-tenant",
    status: "rejected",
    validTo: isoDay(300),
    createdAt: isoDay(-2) + "T00:00:00Z",
    approvedAt: null,
  });

  const out = composeUnitStatus(row([rejeitada, ativa]), TODAY);

  assertEquals(out.aggregate, "active");
  assertEquals("policy" in out.status ? out.status.policy.id : null, "p-owner");
});

Deno.test("só superseded: fração conta como nunca submetida, sem apólice no detalhe", () => {
  const out = composeUnitStatus(
    row([policy({ id: "p-velha", status: "superseded" })]),
    TODAY,
  );

  assertEquals(out.aggregate, "never_submitted");
  assertEquals("policy" in out.status, false);
  // Mas o histórico continua a chegar à UI.
  assertEquals(out.policies.length, 1);
  assertEquals(out.counts.superseded, 1);
});

Deno.test("sem apólices: never_submitted e contadores vazios", () => {
  const out = composeUnitStatus(row([]), TODAY);

  assertEquals(out.aggregate, "never_submitted");
  assertEquals("policy" in out.status, false);
  assertEquals(out.policies.length, 0);
  assertEquals(out.presumedEvidenceDays, null);
});

Deno.test("renovação presumida sem comprovativo: a mais antiga manda no KPI", () => {
  const out = composeUnitStatus(
    row([
      policy({
        id: "p-nova",
        presumedAt: isoDay(-10) + "T00:00:00Z",
        attachmentCount: 0,
        renewedFromId: "p-velha",
      }),
      policy({
        id: "p-outra",
        presumedAt: isoDay(-40) + "T00:00:00Z",
        attachmentCount: 0,
        renewedFromId: "p-antiga",
      }),
    ]),
    TODAY,
  );

  assertEquals(out.presumedEvidenceDays, 40);
});

// O botão "Atualizar" da lista lê `updateAction` (calculada com o mesmo `today`
// dos `can.*`); a renovação leva o id para o template encontrar a apólice.
Deno.test("updateAction: ativa → renovar com o id da apólice", () => {
  const out = composeUnitStatus(row([policy({ id: "p-ativa" })]), TODAY);
  assertEquals(out.updateAction, { kind: "renew", policyId: "p-ativa" });
});

Deno.test("updateAction: só rejeitada → registar de raiz", () => {
  const out = composeUnitStatus(row([policy({ id: "p-rej", status: "rejected" })]), TODAY);
  assertEquals(out.updateAction, { kind: "register" });
});

Deno.test("updateAction: renovação por rever → rever", () => {
  const out = composeUnitStatus(
    row([
      policy({ id: "p-ativa" }),
      policy({ id: "p-pend", status: "pending_review", renewedFromId: "p-ativa" }),
    ]),
    TODAY,
  );
  assertEquals(out.updateAction, { kind: "review" });
});
