import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import type { Context } from "hono";
import { AppError } from "$api/libs/error/app_error.ts";
import type { Postgres } from "$api/libs/postgres/postgres.ts";
import { loadUnitOwnedEntity, portalScope } from "./scope.ts";

// Stub Context - só os métodos que `requireParam` consulta. Construímos um
// helper para o teste não ficar atulhado de boilerplate.
function ctxWithParams(params: Record<string, string | undefined>): Context {
  return {
    req: {
      param: (name: string) => params[name],
    },
  } as unknown as Context;
}

// Postgres fake nunca chamado: o helper só o repassa ao `fetch`, que aqui
// controlamos. `as unknown as Postgres` para satisfazer TS.
const FAKE_POSTGRES = {} as unknown as Postgres;

// Tracer bullet: `portalScope` extrai cid+unitId do path de uma request
// portal típica (`/v1/portal/c/:cid/units/:unitId/...`).
Deno.test("portalScope: extrai cid e unitId do path", () => {
  const c = ctxWithParams({ cid: "condo_X", unitId: "unit_42" });
  assertEquals(portalScope(c), { cid: "condo_X", unitId: "unit_42" });
});

Deno.test("portalScope: cid em falta → AppError 400", () => {
  const c = ctxWithParams({ unitId: "u1" });
  const err = assertThrows(() => portalScope(c), AppError);
  assertEquals(err.statusCode, 400);
  assertEquals(err.code, "VALIDATION_ERROR");
});

Deno.test("portalScope: unitId em falta → AppError 400", () => {
  const c = ctxWithParams({ cid: "c1" });
  const err = assertThrows(() => portalScope(c), AppError);
  assertEquals(err.statusCode, 400);
});

// ── loadUnitOwnedEntity ───────────────────────────────────────────────────
// Caso happy path: fetch devolve a entity → helper devolve {scope, id, entity}.
Deno.test("loadUnitOwnedEntity: fetch devolve entity → helper devolve {scope, id, entity}", async () => {
  const c = ctxWithParams({ cid: "c1", unitId: "u1", policyId: "pol_X" });
  const entity = { id: "pol_X", insurer: "Fidelidade" };
  const result = await loadUnitOwnedEntity({
    ctx: c,
    paramName: "policyId",
    entityNamePT: "Apólice",
    fetch: () => Promise.resolve(entity),
  }, FAKE_POSTGRES);
  assertEquals(result.scope, { cid: "c1", unitId: "u1" });
  assertEquals(result.id, "pol_X");
  assertEquals(result.entity, entity);
});

// 404 quando fetch devolve null - caso típico: entity não pertence à fração.
// O caller usa esta semântica para defender contra IDOR (não distingue
// "não existe" de "noutra fração").
Deno.test("loadUnitOwnedEntity: fetch devolve null → AppError 404 com entityNamePT", async () => {
  const c = ctxWithParams({ cid: "c1", unitId: "u1", policyId: "pol_OTHER" });
  const err = await assertRejects(
    () =>
      loadUnitOwnedEntity({
        ctx: c,
        paramName: "policyId",
        entityNamePT: "Apólice",
        fetch: () => Promise.resolve(null),
      }, FAKE_POSTGRES),
    AppError,
  );
  assertEquals(err.statusCode, 404);
  assertEquals(err.code, "NOT_FOUND");
  // Mensagem contém o nome PT-PT da entidade - UI usa para mostrar ao user.
  assertEquals(err.message, "Apólice não encontrada");
});

// Mesma semântica para `undefined` (Drizzle `findFirst` devolve undefined,
// não null, em alguns paths - defesa contra ambos).
Deno.test("loadUnitOwnedEntity: fetch devolve undefined → AppError 404", async () => {
  const c = ctxWithParams({ cid: "c1", unitId: "u1", ticketId: "t_X" });
  const err = await assertRejects(
    () =>
      loadUnitOwnedEntity({
        ctx: c,
        paramName: "ticketId",
        entityNamePT: "Ocorrência",
        fetch: () => Promise.resolve(undefined),
      }, FAKE_POSTGRES),
    AppError,
  );
  assertEquals(err.statusCode, 404);
  assertEquals(err.message, "Ocorrência não encontrada");
});

// Contracto central: o fetch recebe cid+unitId+id corretos. Se algum passar
// errado, o caller compõe queries inseguras (entity de outra unit).
Deno.test("loadUnitOwnedEntity: fetch recebe (scope+id, postgres)", async () => {
  const c = ctxWithParams({ cid: "c1", unitId: "u1", chargeId: "ch_X" });
  let received: unknown = null;
  await loadUnitOwnedEntity({
    ctx: c,
    paramName: "chargeId",
    entityNamePT: "Cobrança",
    fetch: (args, pg) => {
      received = { args, pg };
      return Promise.resolve({ id: "ch_X" });
    },
  }, FAKE_POSTGRES);
  assertEquals(received, {
    args: { cid: "c1", unitId: "u1", id: "ch_X" },
    pg: FAKE_POSTGRES,
  });
});

// `paramName` em falta no path → 400 (programmer error: rota mal montada).
Deno.test("loadUnitOwnedEntity: paramName em falta → AppError 400", async () => {
  const c = ctxWithParams({ cid: "c1", unitId: "u1" /* sem policyId */ });
  await assertRejects(
    () =>
      loadUnitOwnedEntity({
        ctx: c,
        paramName: "policyId",
        entityNamePT: "Apólice",
        fetch: () => Promise.resolve({ id: "X" }),
      }, FAKE_POSTGRES),
    AppError,
  );
});
