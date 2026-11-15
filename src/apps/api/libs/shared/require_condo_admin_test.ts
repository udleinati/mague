// Unit tests para o gate de autorização "admin deste condomínio" (ADR 0002 + 0009).
// É segurança: se a regra super-OU-managed afrouxar, vaza acesso cross-tenant.
// Correr:  deno test --allow-env src/apps/api/libs/shared/require_condo_admin_test.ts

import { assertEquals, assertThrows } from "@std/assert";
import { isCondoAdmin, requireCondoAdmin } from "./require_condo_admin.ts";
import { AppError } from "$api/libs/error/app_error.ts";

type CtxVals = {
  condominiumId?: string;
  role?: string;
  managedCondominiumIds?: string[];
};

function fakeCtx(vals: CtxVals) {
  return {
    get: (k: keyof CtxVals) => vals[k],
    // deno-lint-ignore no-explicit-any
  } as any;
}

// ── isCondoAdmin ─────────────────────────────────────────────────────────────

Deno.test("isCondoAdmin: super passa para qualquer condomínio", () => {
  // super não tem managedCondominiumIds; o privilégio não pode depender da lista.
  assertEquals(isCondoAdmin(fakeCtx({ condominiumId: "c1", role: "super" })), true);
});

Deno.test("isCondoAdmin: manager com o cid na lista passa", () => {
  const ctx = fakeCtx({
    condominiumId: "c1",
    role: "manager",
    managedCondominiumIds: ["c1", "c2"],
  });
  assertEquals(isCondoAdmin(ctx), true);
});

Deno.test("isCondoAdmin: manager SEM o cid na lista é negado (cross-tenant)", () => {
  // O coração do isolamento multi-tenant: gerir c2 não dá acesso a c1.
  const ctx = fakeCtx({ condominiumId: "c1", role: "manager", managedCondominiumIds: ["c2"] });
  assertEquals(isCondoAdmin(ctx), false);
});

Deno.test("isCondoAdmin: cid ausente é negado mesmo com lista preenchida", () => {
  const ctx = fakeCtx({ role: "manager", managedCondominiumIds: ["c1"] });
  assertEquals(isCondoAdmin(ctx), false);
});

Deno.test("isCondoAdmin: managedCondominiumIds ausente trata como lista vazia", () => {
  const ctx = fakeCtx({ condominiumId: "c1", role: "manager" });
  assertEquals(isCondoAdmin(ctx), false);
});

// ── requireCondoAdmin ────────────────────────────────────────────────────────

Deno.test("requireCondoAdmin: admin válido não atira", () => {
  requireCondoAdmin(fakeCtx({ condominiumId: "c1", role: "super" }));
});

Deno.test("requireCondoAdmin: não-admin atira 403 FORBIDDEN", () => {
  const ctx = fakeCtx({ condominiumId: "c1", role: "manager", managedCondominiumIds: ["c2"] });
  const err = assertThrows(() => requireCondoAdmin(ctx), AppError);
  assertEquals(err.statusCode, 403);
  assertEquals(err.code, "FORBIDDEN");
});

Deno.test("requireCondoAdmin: opts.action entra na mensagem de erro", () => {
  const ctx = fakeCtx({ condominiumId: "c1", role: "manager", managedCondominiumIds: [] });
  const err = assertThrows(() => requireCondoAdmin(ctx, { action: "apagar fração" }), AppError);
  assertEquals(err.message, "Apenas admin pode apagar fração");
});
