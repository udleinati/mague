import { assert, assertEquals } from "@std/assert";
import { adminAudience, occupantAudience, unitInsuranceView } from "./unit_view.ts";
import type { InsurancePolicyRowLike } from "./_projection.ts";

const TODAY = new Date("2026-06-20T00:00:00Z");

/** Data ISO a `days` de TODAY (negativo = passado). */
const isoFromToday = (days: number): string =>
  new Date(TODAY.getTime() + days * 86_400_000).toISOString().slice(0, 10);

function pol(
  id: string,
  status: string,
  extra: Partial<InsurancePolicyRowLike> = {},
): InsurancePolicyRowLike {
  return { id, status, validTo: isoFromToday(400), ...extra } as InsurancePolicyRowLike;
}

// ─── A audiência é a única coisa que separa admin de portal ─────────────────
// WHY: a janela de aviso e o gate viviam soltos em cada call site. O portal
// chegou a classificar com os 30 dias do admin (o parity test constrói o
// agregado assim e não vê a diferença). Amarrá-los num objeto é o que impede
// que voltem a divergir.

Deno.test("audiência: a mesma apólice avisa o admin antes de avisar a fração", () => {
  const p = [pol("a", "active", { validTo: isoFromToday(20) })];

  // 20 dias: dentro dos 30 do admin, fora dos 15 do condómino.
  assertEquals(unitInsuranceView(p, TODAY, adminAudience).aggregate, "expiring_soon");
  assertEquals(unitInsuranceView(p, TODAY, occupantAudience("u1")).aggregate, "active");
});

Deno.test("audiência: a janela do condómino traz sempre os gates do condómino", () => {
  const p = [pol("a", "pending_review", { uploadedBy: { user_id: "u1" } })];

  const admin = unitInsuranceView(p, TODAY, adminAudience);
  const dono = unitInsuranceView(p, TODAY, occupantAudience("u1"));
  const outro = unitInsuranceView(p, TODAY, occupantAudience("u2"));

  assert("policy" in admin.status && admin.status.policy.can.delete);
  // Só a própria submissão por confirmar se apaga do portal (ADR 0040).
  assert("policy" in dono.status && dono.status.policy.can.delete);
  assert("policy" in outro.status && !outro.status.policy.can.delete);
});

// ─── O agregado do ADR 0017 vale para os dois lados ─────────────────────────

Deno.test("agregado: uma ativa vence uma rejeitada mais recente", () => {
  // O cenário do ADR 0017: proprietário com apólice ativa, inquilino com uma
  // rejeitada depois. A fração está coberta - o badge não pode dizer o contrário.
  const policies = [
    pol("rejeitada-do-inquilino", "rejected", { createdAt: new Date("2026-06-19") }),
    pol("ativa-do-proprietario", "active", { createdAt: new Date("2026-01-01") }),
  ];

  for (const audience of [adminAudience, occupantAudience("u1")]) {
    const view = unitInsuranceView(policies, TODAY, audience);
    assertEquals(view.aggregate, "active");
    assert("policy" in view.status);
    // O par sai junto: o kind agregado e a apólice que o justifica.
    assertEquals(view.status.policy.id, "ativa-do-proprietario");
  }
});

Deno.test("counts: conta por status cru, incluindo o histórico substituído", () => {
  const view = unitInsuranceView(
    [pol("a", "active"), pol("b", "superseded"), pol("c", "superseded")],
    TODAY,
    adminAudience,
  );
  assertEquals(view.counts, { active: 1, superseded: 2 });
  // Todas classificadas, para a UI poder listar a cadeia.
  assertEquals(view.policies.length, 3);
});

// ─── Perseguir a presunção (ADR 0040) ───────────────────────────────────────

Deno.test("presumida: manda a mais antiga sem comprovativo", () => {
  const view = unitInsuranceView(
    [
      pol("recente", "active", { presumedAt: new Date(isoFromToday(-10)), attachmentCount: 0 }),
      pol("antiga", "active", { presumedAt: new Date(isoFromToday(-40)), attachmentCount: 0 }),
    ],
    TODAY,
    adminAudience,
  );

  assertEquals(view.presumedEvidenceDays, 40);
});

Deno.test("presumida: com comprovativo anexado deixa de contar", () => {
  const view = unitInsuranceView(
    [pol("a", "active", { presumedAt: new Date(isoFromToday(-40)), attachmentCount: 1 })],
    TODAY,
    adminAudience,
  );
  assertEquals(view.presumedEvidenceDays, null);
});

// ─── decorate ──────────────────────────────────────────────────────────────

Deno.test("decorate: acrescenta os extras do admin sem perder a projeção", () => {
  const view = unitInsuranceView(
    [pol("a", "active", { attachmentCount: 2 })],
    TODAY,
    adminAudience,
    (projected, raw) => ({ ...projected, attachmentCount: raw.attachmentCount ?? 0 }),
  );

  assert("policy" in view.status);
  assertEquals(view.status.policy.attachmentCount, 2);
  // A projeção do ADR 0011 continua lá: sem ActorSnapshots, com gates.
  assertEquals(view.status.policy.id, "a");
  assert(view.status.policy.can !== undefined);
  assertEquals(Object.hasOwn(view.status.policy, "uploadedBy"), false);
});

Deno.test("sem apólices: never_submitted e nada a perseguir", () => {
  const view = unitInsuranceView([], TODAY, adminAudience);
  assertEquals(view.aggregate, "never_submitted");
  assertEquals(view.presumedEvidenceDays, null);
  assertEquals(view.counts, {});
});
