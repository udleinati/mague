// Paridade admin/portal do estado do seguro (ADR 0017). O cenário que separava
// os dois lados: o proprietário tem uma apólice ativa e o inquilino submeteu
// depois uma que foi rejeitada. O admin agregava (∃ active → "Ativo") e o portal
// olhava só para a mais recente ("Última apólice rejeitada" + CTA a pedir nova).
// Agora ambos renderizam a partir do MESMO `aggregateUnitStatus`.

import { assert, assertStringIncludes } from "@std/assert";
import { render } from "./render.ts";
import {
  aggregateUnitStatus,
  classifyPolicy,
  policyCapabilities,
  reminderTriggerFor,
} from "$shared/insurance/policy_status.ts";
import { groupByRenewalChain } from "./controllers/portal_insurance.ts";

const TODAY = new Date("2026-03-01T00:00:00Z");
const isoDay = (n: number) => new Date(TODAY.getTime() + n * 86_400_000).toISOString().slice(0, 10);

function policy(over: Record<string, unknown>) {
  const base = {
    id: "p",
    status: "active",
    validFrom: isoDay(-165),
    validTo: isoDay(200),
    policyNumber: "POL-1",
    insurer: "Fidelidade",
    coverageAmountCents: null,
    createdAt: isoDay(-165) + "T00:00:00Z",
    confirmedAt: isoDay(-165) + "T00:00:00Z",
    approvedAt: isoDay(-165) + "T00:00:00Z",
    rejectedAt: null,
    rejectedReason: null,
    presumedAt: null,
    supersededAt: null,
    attachmentCount: 1,
    attachments: [],
    ...over,
  };
  return {
    ...base,
    kind: classifyPolicy(base, TODAY).kind,
    can: policyCapabilities(base, TODAY, { isAdmin: true }),
  };
}

// Ativa do proprietário (mais antiga) + rejeitada do inquilino (mais recente).
const ativaDoProprietario = policy({ id: "p-owner" });
const rejeitadaDoInquilino = policy({
  id: "p-tenant",
  status: "rejected",
  validTo: isoDay(300),
  createdAt: isoDay(-2) + "T00:00:00Z",
  rejectedAt: isoDay(-1) + "T00:00:00Z",
  rejectedReason: "PDF ilegível",
  approvedAt: null,
});

const classified = [rejeitadaDoInquilino, ativaDoProprietario].map((p) => {
  const s = classifyPolicy(p, TODAY);
  return "policy" in s ? { ...s, policy: p } : s;
});
const aggregate = aggregateUnitStatus(classified);

Deno.test("paridade: admin mostra 'Ativo' para fração com active do proprietário + rejected do inquilino", async () => {
  const html = await render("pages/insurance/_rows.vto", {
    u: {
      unit: { id: "u1", designation: "1ºE", identifier: null },
      occupants: [{ name: "Ana" }, { name: "Rui" }],
      aggregate: aggregate.kind,
      reminderTrigger: reminderTriggerFor({
        aggregate: aggregate.kind,
        presumedEvidenceDays: null,
      }),
      counts: { active: 1, rejected: 1 },
      policies: classified,
      status: aggregate,
      lastReminderAt: null,
      inCooldown: false,
      cooldownUntil: null,
      hasOccupantWithEmail: true,
    },
    currentCondominiumId: "c1",
    oob: false,
  });
  assertStringIncludes(html, "Ativo");
  // O badge agregado não pode ser "Rejeitado" só porque a última submissão falhou.
  assert(!/>\s*Rejeitado\s*</.test(html));
});

Deno.test("paridade: portal mostra o mesmo estado (apólice válida, sem CTA a pedir nova)", async () => {
  const html = await render("pages/portal/insurance/index.vto", {
    currentCondominiumId: "c1",
    currentPortalUnitId: "u1",
    condominium: { name: "Cond X", designationType: "condominium" },
    unit: { designation: "1ºE" },
    currentUser: { name: "Ana", role: "occupant" },
    status: { unit: { id: "u1" }, status: aggregate },
    chains: groupByRenewalChain(
      [rejeitadaDoInquilino, ativaDoProprietario] as unknown as Parameters<
        typeof groupByRenewalChain
      >[0],
    ),
  });
  assertStringIncludes(html, "Apólice válida");
  // O hero não anuncia a rejeição como se fosse o estado da fração.
  assert(!html.includes('Última apólice <span class="text-error">rejeitada</span>'));
  // Coberto: o CTA é "Renovar apólice", não "Submeter apólice" (nunca teve).
  assertStringIncludes(html, "Renovar apólice");
});
