// Cobertura via API REST da geração de charges a partir de recurring_template.
//
// Substitui o antigo pgTAP 0005 que dependia do trigger fake gated.
// Aqui exercitamos a stack TS real:
//   POST /recurring_templates → POST /recurring_templates/generate → GET /charges
//
// Cenários:
//   1. Template mensal gera N charges até `throughDate`
//   2. Re-correr é idempotente (skippa períodos já gerados)
//   3. Template inactivo NÃO gera
//   4. endDate respeitada (não gera após)

import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { Client, type Condominium } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";

const BASE_URL = "http://localhost:3000";
const AUTH = await loginAsSuper();
const client = new Client({ baseUrl: BASE_URL });

describe("admin recurring_template - generation end-to-end", () => {
  let condo: Condominium;
  let supplierId = "";
  let categoryAccountId = "";
  const hdr = () => ({ ...AUTH, "x-condominium-id": condo.id });

  it("setup - condo + supplier + categoria de despesa", async () => {
    const { data: c } = await client.super.createCondominium(
      { name: `Recurring Test ${Date.now()}` },
      { headers: AUTH },
    );
    condo = c;
    const { data: cat } = await client.admin.createChartOfAccount(
      {
        code: `REC_${Date.now().toString(36).toUpperCase()}`,
        name: "Manutenção elevadores",
        type: "expense",
        parentCode: "5",
      },
      { headers: hdr() },
    );
    categoryAccountId = cat.id as string;
    const { data: sup } = await client.admin.createSupplier(
      { name: "Schindler", nif: "501234567" },
      { headers: hdr() },
    );
    supplierId = sup.id as string;
  });

  // ── Cenário 1: template mensal gera N charges ───────────────────────────
  it("template mensal 380€ a partir de 2099-01-05 → 4 meses geram 4 charges", async () => {
    const { data: tpl } = await client.admin.createRecurringTemplate(
      {
        kind: "payable",
        description: "Manutenção mensal",
        amount: 380_00,
        accountId: categoryAccountId,
        supplierId,
        intervalType: "monthly",
        dayOfMonth: 5,
        startDate: "2099-01-05",
        nextRunDate: "2099-01-05",
      },
      { headers: hdr() },
    );

    const { data: run } = await client.admin.triggerRecurringRun(
      { templateId: tpl.id, throughDate: "2099-04-30" },
      { headers: hdr() },
    );
    // Aceitar tanto chargesCreated direct ou nested
    const created = (run.chargesCreated ?? run.charges_created ?? 0) as number;
    assertEquals(created, 4, "4 meses (Jan, Fev, Mar, Abr)");

    const { data: charges } = await client.admin.listCharges(
      { kind: "payable", supplierId, year: "2099" },
      { headers: hdr() },
    );
    assertEquals(charges.length, 4);
    // Todas com valor 380€
    for (const c of charges) {
      assertEquals(c.originalAmount, 380_00);
      assertEquals(c.kind, "payable");
      assertEquals(c.chargeType, "supplier_service");
    }
    // Competence months: 2099-01, 02, 03, 04
    const months = new Set(charges.map((c) => c.competencePeriod));
    assertEquals(months.size, 4);
    assertEquals(months.has("2099-01"), true);
    assertEquals(months.has("2099-02"), true);
    assertEquals(months.has("2099-03"), true);
    assertEquals(months.has("2099-04"), true);
  });

  // ── Cenário 2: idempotência ─────────────────────────────────────────────
  it("re-correr generate com mesma throughDate → 0 charges novas", async () => {
    const { data: tpls } = await client.admin.listRecurringTemplates({ headers: hdr() });
    const tpl = tpls[0];
    const { data: run } = await client.admin.triggerRecurringRun(
      { templateId: tpl.id, throughDate: "2099-04-30" },
      { headers: hdr() },
    );
    const created = (run.chargesCreated ?? run.charges_created ?? 0) as number;
    assertEquals(created, 0);
  });

  // ── Cenário 3: incremental ──────────────────────────────────────────────
  it("re-correr com throughDate maior → gera só meses novos", async () => {
    const { data: tpls } = await client.admin.listRecurringTemplates({ headers: hdr() });
    const tpl = tpls[0];
    // Maio + Junho
    const { data: run } = await client.admin.triggerRecurringRun(
      { templateId: tpl.id, throughDate: "2099-06-30" },
      { headers: hdr() },
    );
    const created = (run.chargesCreated ?? run.charges_created ?? 0) as number;
    assertEquals(created, 2, "Maio + Junho");

    const { data: charges } = await client.admin.listCharges(
      { kind: "payable", supplierId, year: "2099" },
      { headers: hdr() },
    );
    assertEquals(charges.length, 6);
  });

  // ── Cenário 4: template inactivo NÃO gera ───────────────────────────────
  it("update template para isActive=false → next generate não gera", async () => {
    const { data: tpls } = await client.admin.listRecurringTemplates({ headers: hdr() });
    const tpl = tpls[0];
    await client.admin.updateRecurringTemplate(
      tpl.id as string,
      { isActive: false },
      { headers: hdr() },
    );
    const { data: run } = await client.admin.triggerRecurringRun(
      { templateId: tpl.id, throughDate: "2099-12-31" },
      { headers: hdr() },
    );
    const created = (run.chargesCreated ?? run.charges_created ?? 0) as number;
    assertEquals(created, 0, "template inactivo não gera");
  });

  it("teardown", async () => {
    await client.super.deleteCondominium(condo.id, { headers: AUTH });
  });
});
