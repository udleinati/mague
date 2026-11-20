// E2E security: teto de períodos na geração recorrente.
//
// Threat model: o gestor controla next_run_date (create/update do template) e
// throughDate (POST /recurring_templates/generate). Com next_run_date em 1900 e
// throughDate em 9999, um só pedido gerava ~100k charges numa transação (DoS da
// BD partilhada). Acima de 240 períodos por template, o run falha com 422 antes
// de inserir - não trunca em silêncio.

import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { Client } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";
import { type ScenarioFixture, seedScenario } from "./_helpers/fixtures.ts";

const BASE_URL = "http://localhost:3000";
const AUTH = await loginAsSuper();
const client = new Client({ baseUrl: BASE_URL });

describe("security - teto de períodos na geração recorrente", () => {
  let fx: ScenarioFixture;
  let templateId = "";

  const generate = (throughDate: string) =>
    fetch(
      `${BASE_URL}/v1/admin/condominiums/${fx.condominium.id}/recurring_templates/generate`,
      {
        method: "POST",
        headers: { ...fx.hdr(), "Content-Type": "application/json" },
        body: JSON.stringify({ throughDate }),
      },
    );

  it("setup - condo + template mensal com 360 meses por gerar até 2099-12", async () => {
    fx = await seedScenario(client, AUTH)
      .withCondo(`Recurring Limit ${Date.now()}`)
      .build();
    const { data: tpl } = await client.admin.createRecurringTemplate(
      {
        kind: "payable",
        description: "Limpeza mensal",
        amount: 50_00,
        intervalType: "monthly",
        dayOfMonth: 5,
        startDate: "2070-01-05",
        nextRunDate: "2070-01-05",
      },
      { headers: fx.hdr() },
    );
    templateId = tpl.id as string;
  });

  it("throughDate que pede mais de 240 períodos → 422 e nada é gerado", async () => {
    const res = await generate("2099-12-31");
    assertEquals(res.status, 422);
    const body = await res.json();
    assertEquals(body.error.code, "RECURRING_TOO_MANY_PERIODS");

    const { data: charges } = await client.admin.listCharges(
      { kind: "payable" },
      { headers: fx.hdr() },
    );
    assertEquals(charges.length, 0, "o run falhado não deixa charges");

    const { data: tpls } = await client.admin.listRecurringTemplates({ headers: fx.hdr() });
    const tpl = tpls.find((t) => t.id === templateId);
    assertEquals(tpl?.nextRunDate, "2070-01-05", "next_run_date não avança");
  });

  it("dentro do teto o mesmo template gera normalmente", async () => {
    const res = await generate("2070-12-31");
    assertEquals(res.status, 201);
    const body = await res.json();
    assertEquals(body.data.chargesCreated, 12);
  });

  it("teardown", async () => {
    await fx.cleanup();
  });
});
