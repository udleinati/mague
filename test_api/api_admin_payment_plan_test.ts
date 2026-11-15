// Contrato HTTP do recurso Payment Plan (admin, ADR 0039). Cobre criação,
// listagem, update, a regra "1 plano active por fração" (422) e o anti-IDOR
// multi-tenant (404 quando a fração é de outro condo).
//
// Pré-requisitos: stack de pé + DB com super@mague.pt. Correr:
//   deno test --allow-net --allow-read --allow-env --allow-run test_api/api_admin_payment_plan_test.ts

import { assertEquals, assertRejects } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { ApiError, Client } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";
import { type ScenarioFixture, seedScenario } from "./_helpers/fixtures.ts";

const BASE_URL = "http://localhost:3000";
const client = new Client({ baseUrl: BASE_URL });
const MASTER = await loginAsSuper();

describe("admin payment plans", () => {
  let fx: ScenarioFixture;
  let unitId = "";
  let planId = "";
  const hdr = () => fx.hdr();

  it("setup - condo + unit", async () => {
    fx = await seedScenario(client, MASTER)
      .withCondo("PaymentPlan E2E")
      .withUnit({ designation: "A", permillage: 1000 })
      .build();
    unitId = fx.units[0].id;
  });

  it("listPaymentPlans - vazio no início", async () => {
    const { data, status } = await client.admin.listPaymentPlans(unitId, { headers: hdr() });
    assertEquals(status, 200);
    assertEquals(data, []);
  });

  it("createPaymentPlan - notes vazias → 400", async () => {
    const e = await assertRejects(
      () => client.admin.createPaymentPlan(unitId, { notes: "" }, { headers: hdr() }),
      ApiError,
    );
    assertEquals(e.statusCode, 400);
  });

  it("createPaymentPlan - válido → 201, status active", async () => {
    const { data, status } = await client.admin.createPaymentPlan(
      unitId,
      { notes: "Acordo 6 prestações", endDate: "2026-12-31" },
      { headers: hdr() },
    );
    assertEquals(status, 201);
    assertEquals(data.status, "active");
    assertEquals(data.notes, "Acordo 6 prestações");
    planId = data.id;
  });

  it("createPaymentPlan - 2º plano active na mesma fração → 422", async () => {
    const e = await assertRejects(
      () => client.admin.createPaymentPlan(unitId, { notes: "Outro acordo" }, { headers: hdr() }),
      ApiError,
    );
    assertEquals(e.statusCode, 422); // PAYMENT_PLAN_ALREADY_ACTIVE
  });

  it("listPaymentPlans - devolve o plano criado", async () => {
    const { data } = await client.admin.listPaymentPlans(unitId, { headers: hdr() });
    assertEquals(data.some((p) => p.id === planId), true);
  });

  it("updatePaymentPlan - edita notes", async () => {
    const { data } = await client.admin.updatePaymentPlan(
      unitId,
      planId,
      { notes: "Acordo revisto" },
      { headers: hdr() },
    );
    assertEquals(data.notes, "Acordo revisto");
  });

  // Duas notas: partilhada (`notes`) e interna. Basta uma.
  it("updatePaymentPlan - acrescenta a nota interna sem mexer na partilhada", async () => {
    const { data } = await client.admin.updatePaymentPlan(
      unitId,
      planId,
      { internalNotes: "Ligou a pedir mais prazo" },
      { headers: hdr() },
    );
    assertEquals(data.notes, "Acordo revisto");
    assertEquals(data.internalNotes, "Ligou a pedir mais prazo");
  });

  it("updatePaymentPlan - apagar a partilhada deixa só a interna", async () => {
    const { data } = await client.admin.updatePaymentPlan(
      unitId,
      planId,
      { notes: "" },
      { headers: hdr() },
    );
    assertEquals(data.notes, null);
    assertEquals(data.internalNotes, "Ligou a pedir mais prazo");
  });

  it("updatePaymentPlan - apagar a última nota → 400 (o plano fica sem nada)", async () => {
    const e = await assertRejects(
      () =>
        client.admin.updatePaymentPlan(unitId, planId, { internalNotes: "" }, { headers: hdr() }),
      ApiError,
    );
    assertEquals(e.statusCode, 400);
  });

  it("createPaymentPlan - só com nota interna → 201", async () => {
    const fxC = await seedScenario(client, MASTER)
      .withCondo("PaymentPlan E2E C")
      .withUnit({ designation: "A", permillage: 1000 })
      .build();
    const { data, status } = await client.admin.createPaymentPlan(
      fxC.units[0].id,
      { internalNotes: "Só para a administração" },
      { headers: fxC.hdr() },
    );
    assertEquals(status, 201);
    assertEquals(data.notes, null);
    assertEquals(data.internalNotes, "Só para a administração");
    await fxC.cleanup();
  });

  it("createPaymentPlan - fração inexistente → 404", async () => {
    const e = await assertRejects(
      () => client.admin.createPaymentPlan("nao_existe", { notes: "x" }, { headers: hdr() }),
      ApiError,
    );
    assertEquals(e.statusCode, 404);
  });

  it("anti-IDOR - fração de outro condo → 404", async () => {
    const fxB = await seedScenario(client, MASTER).withCondo("PaymentPlan E2E B").build();
    // Headers do condo B, mas o unitId pertence ao condo A.
    const e = await assertRejects(
      () => client.admin.createPaymentPlan(unitId, { notes: "x" }, { headers: fxB.hdr() }),
      ApiError,
    );
    assertEquals(e.statusCode, 404);
    await fxB.cleanup();
  });

  it("cleanup", async () => {
    await fx.cleanup();
  });
});
