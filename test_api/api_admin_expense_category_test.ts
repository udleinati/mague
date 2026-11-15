import { assertEquals, assertRejects } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { ApiError, type ChartOfAccount, Client, type Condominium } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";

const BASE_URL = "http://localhost:3000";
const client = new Client({ baseUrl: BASE_URL });

const MASTER_HEADERS = await loginAsSuper();

describe("admin expense-categories", () => {
  let createdCondo: Condominium;
  let createdCategory: ChartOfAccount;

  it("setup - create a condominium", async () => {
    const { data } = await client.super.createCondominium(
      { name: "Expense Category Test Condo" },
      { headers: MASTER_HEADERS },
    );
    createdCondo = data;
  });

  it("create - valid data returns 201", async () => {
    const { data, status } = await client.admin.createChartOfAccount(
      { code: "9.9.1", name: "Eletricidade", type: "expense" },
      { headers: { ...MASTER_HEADERS, "x-condominium-id": createdCondo.id } },
    );
    assertEquals(status, 201);
    assertEquals(typeof data.id, "string");
    assertEquals(data.name, "Eletricidade");
    createdCategory = data;
  });

  it("create - missing name returns 400", async () => {
    const e = await assertRejects(
      () =>
        client.admin.createChartOfAccount(
          {},
          { headers: { ...MASTER_HEADERS, "x-condominium-id": createdCondo.id } },
        ),
      ApiError,
    );
    assertEquals(e.statusCode, 400);
  });

  it("get - returns created category", async () => {
    const { data, status } = await client.admin.getChartOfAccount(
      createdCategory.id,
      { headers: { ...MASTER_HEADERS, "x-condominium-id": createdCondo.id } },
    );
    assertEquals(status, 200);
    assertEquals(data.id, createdCategory.id);
  });

  it("get - non-existent returns 404", async () => {
    const e = await assertRejects(
      () =>
        client.admin.getChartOfAccount(
          "00000000-0000-0000-0000-000000000000",
          { headers: { ...MASTER_HEADERS, "x-condominium-id": createdCondo.id } },
        ),
      ApiError,
    );
    assertEquals(e.statusCode, 404);
  });

  it("update - partial update returns 200", async () => {
    const { data, status } = await client.admin.updateChartOfAccount(
      createdCategory.id,
      { name: "Eletricidade Atualizada" },
      { headers: { ...MASTER_HEADERS, "x-condominium-id": createdCondo.id } },
    );
    assertEquals(status, 200);
    assertEquals(data.name, "Eletricidade Atualizada");
  });

  it("update - non-existent returns 404", async () => {
    const e = await assertRejects(
      () =>
        client.admin.updateChartOfAccount(
          "00000000-0000-0000-0000-000000000000",
          { name: "Test" },
          { headers: { ...MASTER_HEADERS, "x-condominium-id": createdCondo.id } },
        ),
      ApiError,
    );
    assertEquals(e.statusCode, 404);
  });

  it("delete - existing returns 204", async () => {
    const { status } = await client.admin.deleteChartOfAccount(
      createdCategory.id,
      { headers: { ...MASTER_HEADERS, "x-condominium-id": createdCondo.id } },
    );
    assertEquals(status, 204);
  });

  it("delete - non-existent returns 404", async () => {
    const e = await assertRejects(
      () =>
        client.admin.deleteChartOfAccount(
          "00000000-0000-0000-0000-000000000000",
          { headers: { ...MASTER_HEADERS, "x-condominium-id": createdCondo.id } },
        ),
      ApiError,
    );
    assertEquals(e.statusCode, 404);
  });

  it("teardown - delete condominium", async () => {
    await client.super.deleteCondominium(createdCondo.id, {
      headers: MASTER_HEADERS,
    });
  });
});
