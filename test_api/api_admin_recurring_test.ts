import { assertEquals, assertRejects } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { ApiError, Client } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";

// Recurring templates: cria template (payable, mensal), executa o
// generate batch e verifica que criou pelo menos uma charge.
// Usa o seed mínimo e um supplier ad-hoc para isolar o cenário.

const BASE_URL = "http://localhost:3000";
const client = new Client({ baseUrl: BASE_URL });
const MASTER = { ...(await loginAsSuper()), "x-condominium-id": "MgX001" };

describe("admin recurring_templates + generate", () => {
  let supplierId = "";
  let templateId = "";

  it("setup - supplier for recurring", async () => {
    const { data } = await client.admin.createSupplier(
      { name: "E2E Recurring Supplier" },
      { headers: MASTER },
    );
    supplierId = data.id as string;
  });

  it("listRecurringTemplates - returns array", async () => {
    const { data, status } = await client.admin.listRecurringTemplates({ headers: MASTER });
    assertEquals(status, 200);
    assertEquals(Array.isArray(data), true);
  });

  it("createRecurringTemplate - payable monthly returns 201", async () => {
    const { data, status } = await client.admin.createRecurringTemplate(
      {
        kind: "payable",
        description: "E2E Electricidade mensal",
        amount: 5000,
        supplierId: supplierId,
        intervalType: "monthly",
        dayOfMonth: 1,
        startDate: "2026-01-01",
        nextRunDate: "2026-01-01",
      },
      { headers: MASTER },
    );
    assertEquals(status, 201);
    assertEquals(data.kind, "payable");
    assertEquals(Number(data.amount), 5000);
    templateId = data.id as string;
  });

  it("createRecurringTemplate - missing amount returns 400", async () => {
    const e = await assertRejects(
      () =>
        client.admin.createRecurringTemplate(
          {
            kind: "payable",
            description: "broken",
            intervalType: "monthly",
            startDate: "2026-01-01",
            nextRunDate: "2026-01-01",
          },
          { headers: MASTER },
        ),
      ApiError,
    );
    assertEquals(e.statusCode, 400);
  });

  it("triggerRecurringRun - due templates create charges", async () => {
    // Sem unique em recurring_generation_run,
    // podemos re-executar no mesmo dia sem conflito - o trigger a nível
    // de charges ainda previne duplicados.
    const { data, status } = await client.admin.triggerRecurringRun(
      { throughDate: "2027-06-15" },
      { headers: MASTER },
    );
    assertEquals(status, 201);
    assertEquals(typeof data.chargesCreated, "number");
    assertEquals(Number(data.chargesCreated) >= 1, true);
  });

  // Idempotência: 2ª chamada com o mesmo throughDate não deve falhar por
  // unique - nem criar novas charges (o trigger interno a nível de competence
  // skips duplicados).
  it("triggerRecurringRun - re-run no mesmo dia é idempotente", async () => {
    const { data, status } = await client.admin.triggerRecurringRun(
      { throughDate: "2027-06-15" },
      { headers: MASTER },
    );
    assertEquals(status, 201);
    // Não cria charges novas (templates já avançaram next_run_date).
    assertEquals(Number(data.chargesCreated), 0);
  });

  it("triggerRecurringRun - missing throughDate returns 400", async () => {
    const e = await assertRejects(
      () => client.admin.triggerRecurringRun({}, { headers: MASTER }),
      ApiError,
    );
    assertEquals(e.statusCode, 400);
  });

  // Update + Delete do template - novos endpoints.
  it("updateRecurringTemplate - altera amount e descrição", async () => {
    const { data, status } = await client.admin.updateRecurringTemplate(
      templateId,
      {
        amount: 7500,
        description: "E2E Eletricidade (atualizado)",
      },
      { headers: MASTER },
    );
    assertEquals(status, 200);
    assertEquals(Number(data.amount), 7500);
    assertEquals(data.description, "E2E Eletricidade (atualizado)");
  });

  it("updateRecurringTemplate - pausar via isActive=false", async () => {
    const { data, status } = await client.admin.updateRecurringTemplate(
      templateId,
      { isActive: false },
      { headers: MASTER },
    );
    assertEquals(status, 200);
    assertEquals(data.isActive, false);
  });

  it("deleteRecurringTemplate - soft-delete retorna 204", async () => {
    const { status } = await client.admin.deleteRecurringTemplate(templateId, { headers: MASTER });
    assertEquals(status, 204);
  });

  it("deleteRecurringTemplate - já apagado retorna 404", async () => {
    const e = await assertRejects(
      () => client.admin.deleteRecurringTemplate(templateId, { headers: MASTER }),
      ApiError,
    );
    assertEquals(e.statusCode, 404);
  });

  it("teardown - cleanup supplier", async () => {
    // O template fica ligado ao supplier; deletar supplier primeiro
    // pode falhar por FK. Na verdade, supplier tem soft-delete - OK.
    await client.admin.deleteSupplier(supplierId, { headers: MASTER }).catch(() => {});
  });
});
