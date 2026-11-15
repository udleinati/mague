// Unit tests da lógica pura do membership (ADR 0001): feed rows in, assert
// facts out, sem DB.

import { assertEquals } from "@std/assert";
import { accountReachableOutside, computeUserMembership } from "./compute.ts";
import type { ManagerSelect } from "$api/libs/postgres/schemas/manager.ts";
import type { OccupantSelect } from "$api/libs/postgres/schemas/occupant.ts";
import type { UnitOccupantSelect } from "$api/libs/postgres/schemas/unit_occupant.ts";
import type { UserSelect } from "$api/libs/postgres/schemas/user.ts";

// ─── Fixtures helpers ────────────────────────────────────────────────────

const NOW = new Date("2026-05-04T12:00:00Z");

function makeUser(overrides: Partial<UserSelect> = {}): UserSelect {
  return {
    id: "u_test",
    email: "test@test.pt",
    name: "Test",
    role: null as unknown as string,
    isActive: true,
    createdAt: NOW,
    updatedAt: NOW,
    nif: null,
    phone: null,
    passwordHash: null,
    passwordChangedAt: null,
    failedLoginAttempts: 0,
    lastFailedLoginAt: null,
    deletedAt: null,
    ...overrides,
  } as UserSelect;
}

function makeManager(overrides: Partial<ManagerSelect> = {}): ManagerSelect {
  return {
    id: "m_test",
    condominiumId: "cid_a",
    userId: "u_test",
    isActive: true,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  } as ManagerSelect;
}

function makeOccupant(overrides: Partial<OccupantSelect> = {}): OccupantSelect {
  return {
    id: "occ_test",
    condominiumId: "cid_a",
    userId: "u_test",
    name: "Test",
    type: "owner",
    nif: null,
    email: null,
    phone: null,
    isActive: true,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  } as OccupantSelect;
}

function makeUnitOccupant(overrides: Partial<UnitOccupantSelect> = {}): UnitOccupantSelect {
  return {
    id: "uo_test",
    unitId: "unit_test",
    occupantId: "occ_test",
    relationshipType: "owner",
    startDate: "2026-01-01",
    endDate: null,
    deletedAt: null,
    createdAt: NOW,
    ...overrides,
  } as UnitOccupantSelect;
}

function unitsMap(entries: Array<[string, string[]]>): Map<string, Set<string>> {
  return new Map(entries.map(([cid, ids]) => [cid, new Set(ids)]));
}

// ─── User-level (across condos) ──────────────────────────────────────────

Deno.test("isSuper: true quando user.role === 'super'", () => {
  const m = computeUserMembership({
    user: makeUser({ role: "super" }),
    managers: [],
    activeOccupants: [],
    activeUnitOccupants: [],
    unitsByCondoId: unitsMap([]),
  });
  assertEquals(m.isSuper, true);
});

Deno.test("isSuper: false para qualquer outro role (incl. legacy 'admin'/'manager'/'owner')", () => {
  for (const role of ["admin", "manager", "owner", null, ""]) {
    const m = computeUserMembership({
      user: makeUser({ role: role as string }),
      managers: [],
      activeOccupants: [],
      activeUnitOccupants: [],
      unitsByCondoId: unitsMap([]),
    });
    assertEquals(m.isSuper, false, `role=${role}`);
  }
});

Deno.test("activeManagerCondoIds: filtra soft-deleted + isActive=false", () => {
  const m = computeUserMembership({
    user: makeUser(),
    managers: [
      makeManager({ id: "m1", condominiumId: "cid_a" }), // active
      makeManager({ id: "m2", condominiumId: "cid_b", deletedAt: NOW }), // soft-deleted
      makeManager({ id: "m3", condominiumId: "cid_c", isActive: false }), // suspended
    ],
    activeOccupants: [],
    activeUnitOccupants: [],
    unitsByCondoId: unitsMap([]),
  });
  assertEquals(m.activeManagerCondoIds, ["cid_a"]);
});

Deno.test("historicManagerCondoIds: inclui soft-deleted (para audit)", () => {
  const m = computeUserMembership({
    user: makeUser(),
    managers: [
      makeManager({ id: "m1", condominiumId: "cid_a" }),
      makeManager({ id: "m2", condominiumId: "cid_b", deletedAt: NOW }),
    ],
    activeOccupants: [],
    activeUnitOccupants: [],
    unitsByCondoId: unitsMap([]),
  });
  assertEquals(m.historicManagerCondoIds.sort(), ["cid_a", "cid_b"]);
});

Deno.test("occupantCondoIds: dedup quando user tem 2 occupants no mesmo condo", () => {
  const m = computeUserMembership({
    user: makeUser(),
    managers: [],
    activeOccupants: [
      makeOccupant({ id: "occ1", condominiumId: "cid_a" }),
      makeOccupant({ id: "occ2", condominiumId: "cid_a" }), // duplicado por cid
      makeOccupant({ id: "occ3", condominiumId: "cid_b" }),
    ],
    activeUnitOccupants: [],
    unitsByCondoId: unitsMap([]),
  });
  assertEquals(m.occupantCondoIds.sort(), ["cid_a", "cid_b"]);
});

// ─── inCondo() - slice por condomínio ────────────────────────────────────

Deno.test("inCondo: super tem isCurrentlyRelated=false sem records (super passa por outra via)", () => {
  const m = computeUserMembership({
    user: makeUser({ role: "super" }),
    managers: [],
    activeOccupants: [],
    activeUnitOccupants: [],
    unitsByCondoId: unitsMap([]),
  });
  const c = m.inCondo("cid_a");
  assertEquals(c.isSuper, true);
  assertEquals(c.isManager, false);
  assertEquals(c.isCurrentlyRelated, false);
  // Mantém isRelated=false. O fluxo de auth verifica isSuper *antes* de
  // chamar isRelated; super "passa" por outro caminho, não via membership.
  assertEquals(c.isRelated, false);
});

Deno.test("inCondo: active manager → isManager=true, isRelated=true", () => {
  const m = computeUserMembership({
    user: makeUser(),
    managers: [makeManager({ condominiumId: "cid_a" })],
    activeOccupants: [],
    activeUnitOccupants: [],
    unitsByCondoId: unitsMap([]),
  });
  const c = m.inCondo("cid_a");
  assertEquals(c.isManager, true);
  assertEquals(c.hasManagerHistory, true);
  assertEquals(c.isCurrentlyRelated, true);
  assertEquals(c.isRelated, true);
  assertEquals(c.managerRecord?.id, "m_test");
});

Deno.test("inCondo: soft-deleted manager → isManager=false, hasManagerHistory=true, isRelated=true (audit)", () => {
  const m = computeUserMembership({
    user: makeUser(),
    managers: [makeManager({ condominiumId: "cid_a", deletedAt: NOW })],
    activeOccupants: [],
    activeUnitOccupants: [],
    unitsByCondoId: unitsMap([]),
  });
  const c = m.inCondo("cid_a");
  assertEquals(c.isManager, false);
  assertEquals(c.hasManagerHistory, true);
  assertEquals(c.isCurrentlyRelated, false);
  // Crucial: é o caso do "removi-me como admin, ainda quero ver-me em /users/:id"
  assertEquals(c.isRelated, true);
  // managerRecord ainda visível para a toggle restore logic
  assertEquals(c.managerRecord?.deletedAt, NOW);
});

Deno.test("inCondo: occupant + unit_occupant 'owner' → ownedUnitIds populado, isCurrentlyRelated=true", () => {
  const m = computeUserMembership({
    user: makeUser(),
    managers: [],
    activeOccupants: [makeOccupant({ id: "occ1", condominiumId: "cid_a" })],
    activeUnitOccupants: [
      makeUnitOccupant({ unitId: "u1", occupantId: "occ1", relationshipType: "owner" }),
    ],
    unitsByCondoId: unitsMap([["cid_a", ["u1"]]]),
  });
  const c = m.inCondo("cid_a");
  assertEquals(c.isOccupantOfCondo, true);
  assertEquals(c.ownedUnitIds, ["u1"]);
  assertEquals(c.isCurrentlyRelated, true);
});

Deno.test("inCondo: tenant unit_occupant NÃO conta como ownedUnit, MAS conta como linkedUnit", () => {
  const m = computeUserMembership({
    user: makeUser(),
    managers: [],
    activeOccupants: [makeOccupant({ id: "occ1", condominiumId: "cid_a" })],
    activeUnitOccupants: [
      makeUnitOccupant({ unitId: "u1", occupantId: "occ1", relationshipType: "tenant" }),
    ],
    unitsByCondoId: unitsMap([["cid_a", ["u1"]]]),
  });
  const c = m.inCondo("cid_a");
  assertEquals(c.isOccupantOfCondo, true, "ainda é occupant");
  assertEquals(c.ownedUnitIds, [], "tenant não 'owns'");
  assertEquals(c.linkedUnitIds, ["u1"], "mas tenant está linked à unit (acesso ao portal)");
  // isCurrentlyRelated é falsy: tenant ainda não dá acesso de admin/portal-owner
  // (cada caller decide se tenant conta ou não)
  assertEquals(c.isCurrentlyRelated, false);
});

Deno.test("inCondo: linkedUnitIds = ownedUnitIds para owners únicos", () => {
  const m = computeUserMembership({
    user: makeUser(),
    managers: [],
    activeOccupants: [makeOccupant({ id: "occ1", condominiumId: "cid_a" })],
    activeUnitOccupants: [
      makeUnitOccupant({ unitId: "u1", occupantId: "occ1", relationshipType: "owner" }),
    ],
    unitsByCondoId: unitsMap([["cid_a", ["u1"]]]),
  });
  const c = m.inCondo("cid_a");
  assertEquals(c.ownedUnitIds, ["u1"]);
  assertEquals(c.linkedUnitIds, ["u1"]);
});

Deno.test("inCondo: mistura owner+tenant - linkedUnitIds inclui ambos, ownedUnitIds só owner", () => {
  const m = computeUserMembership({
    user: makeUser(),
    managers: [],
    activeOccupants: [
      makeOccupant({ id: "occ1", condominiumId: "cid_a" }),
      makeOccupant({ id: "occ2", condominiumId: "cid_a" }),
    ],
    activeUnitOccupants: [
      makeUnitOccupant({ id: "uo1", unitId: "u1", occupantId: "occ1", relationshipType: "owner" }),
      makeUnitOccupant({ id: "uo2", unitId: "u2", occupantId: "occ2", relationshipType: "tenant" }),
    ],
    unitsByCondoId: unitsMap([["cid_a", ["u1", "u2"]]]),
  });
  const c = m.inCondo("cid_a");
  assertEquals(c.ownedUnitIds.sort(), ["u1"]);
  assertEquals(c.linkedUnitIds.sort(), ["u1", "u2"]);
});

Deno.test("inCondo: cross-tenant guard - unit_occupant aponta para unit fora do condo do occupant", () => {
  // Occupant pertence a cid_a, mas unit_occupant aponta para unit que (no
  // unitsByCondoId) está em cid_b. ownedUnitIds para cid_a não conta este.
  const m = computeUserMembership({
    user: makeUser(),
    managers: [],
    activeOccupants: [makeOccupant({ id: "occ1", condominiumId: "cid_a" })],
    activeUnitOccupants: [
      makeUnitOccupant({ unitId: "u_in_b", occupantId: "occ1", relationshipType: "owner" }),
    ],
    unitsByCondoId: unitsMap([["cid_b", ["u_in_b"]]]),
  });
  const c = m.inCondo("cid_a");
  assertEquals(c.ownedUnitIds, [], "unit fora do condo não conta");
});

Deno.test("inCondo: cid sem qualquer relação → tudo false", () => {
  const m = computeUserMembership({
    user: makeUser(),
    managers: [makeManager({ condominiumId: "cid_a" })],
    activeOccupants: [makeOccupant({ condominiumId: "cid_a" })],
    activeUnitOccupants: [],
    unitsByCondoId: unitsMap([["cid_a", ["u1"]]]),
  });
  const c = m.inCondo("cid_other");
  assertEquals(c.isManager, false);
  assertEquals(c.hasManagerHistory, false);
  assertEquals(c.isOccupantOfCondo, false);
  assertEquals(c.ownedUnitIds, []);
  assertEquals(c.isCurrentlyRelated, false);
  assertEquals(c.isRelated, false);
  assertEquals(c.managerRecord, null);
});

Deno.test("inCondo: combinação admin + owner - ambos populados, isRelated=true via 2 caminhos", () => {
  const m = computeUserMembership({
    user: makeUser(),
    managers: [makeManager({ condominiumId: "cid_a" })],
    activeOccupants: [makeOccupant({ id: "occ1", condominiumId: "cid_a" })],
    activeUnitOccupants: [
      makeUnitOccupant({ unitId: "u1", occupantId: "occ1", relationshipType: "owner" }),
    ],
    unitsByCondoId: unitsMap([["cid_a", ["u1"]]]),
  });
  const c = m.inCondo("cid_a");
  assertEquals(c.isManager, true);
  assertEquals(c.ownedUnitIds, ["u1"]);
  assertEquals(c.isRelated, true);
});

// ─── Defensive guards ────────────────────────────────────────────────────

Deno.test("activeManagerCondoIds: dedupe em casos degenerados (mesmo cid 2 records)", () => {
  // Schema tem UNIQUE(cid, user_id) mas se algures alguém quebrar o invariante…
  const m = computeUserMembership({
    user: makeUser(),
    managers: [
      makeManager({ id: "m1", condominiumId: "cid_a" }),
      makeManager({ id: "m2", condominiumId: "cid_a" }),
    ],
    activeOccupants: [],
    activeUnitOccupants: [],
    unitsByCondoId: unitsMap([]),
  });
  assertEquals(m.activeManagerCondoIds, ["cid_a"]);
});

// ─── accountReachableOutside (reset assistido de password) ───────────────

// A password é da conta: repô-la dá a quem pede todos os condomínios que a conta abre.
Deno.test("accountReachableOutside: conta só dos condomínios geridos → false", () => {
  const m = computeUserMembership({
    user: makeUser(),
    managers: [makeManager({ condominiumId: "cid_a" })],
    activeOccupants: [makeOccupant({ condominiumId: "cid_a" })],
    activeUnitOccupants: [],
    unitsByCondoId: unitsMap([]),
  });
  assertEquals(accountReachableOutside(m, ["cid_a"]), false);
});

Deno.test("accountReachableOutside: gere ou é ocupante noutro condomínio → true", () => {
  const managesB = computeUserMembership({
    user: makeUser(),
    managers: [makeManager({ condominiumId: "cid_a" }), makeManager({ condominiumId: "cid_b" })],
    activeOccupants: [],
    activeUnitOccupants: [],
    unitsByCondoId: unitsMap([]),
  });
  const occupantInB = computeUserMembership({
    user: makeUser(),
    managers: [makeManager({ condominiumId: "cid_a" })],
    activeOccupants: [makeOccupant({ condominiumId: "cid_b" })],
    activeUnitOccupants: [],
    unitsByCondoId: unitsMap([]),
  });
  assertEquals(accountReachableOutside(managesB, ["cid_a"]), true);
  assertEquals(accountReachableOutside(occupantInB, ["cid_a"]), true);
});

Deno.test("accountReachableOutside: gestão removida noutro condomínio não conta", () => {
  // Já não abre B: bloquear o reset por histórico deixava a conta sem quem a desbloqueie.
  const m = computeUserMembership({
    user: makeUser(),
    managers: [
      makeManager({ condominiumId: "cid_a" }),
      makeManager({ id: "m2", condominiumId: "cid_b", deletedAt: NOW }),
    ],
    activeOccupants: [],
    activeUnitOccupants: [],
    unitsByCondoId: unitsMap([]),
  });
  assertEquals(accountReachableOutside(m, ["cid_a"]), false);
});
