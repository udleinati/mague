import { assertEquals, assertRejects } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { ApiError, Client, type Condominium } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";

const BASE_URL = "http://localhost:3000";
const client = new Client({ baseUrl: BASE_URL });

const MASTER_HEADERS = await loginAsSuper();

describe("admin condominiums /me", () => {
  let createdCondo: Condominium;

  it("setup - create a condominium", async () => {
    const { data } = await client.super.createCondominium(
      {
        name: "Admin Test Condo",
        fiscalNumber: "123456789",
        address: "Rua Admin",
        city: "Lisboa",
        postalCode: "1000-100",
        quotaDayOfMonth: 15,
      },
      { headers: MASTER_HEADERS },
    );
    createdCondo = data;
  });

  it("getMe - with x-condominium-id returns condominium", async () => {
    const { data, status } = await client.admin.getMe({
      headers: { ...MASTER_HEADERS, "x-condominium-id": createdCondo.id },
    });
    assertEquals(status, 200);
    assertEquals(data.id, createdCondo.id);
    assertEquals(data.name, "Admin Test Condo");
  });

  it("getMe - non-existent condominium returns 404", async () => {
    const error = await assertRejects(
      () =>
        client.admin.getMe({
          headers: { ...MASTER_HEADERS, "x-condominium-id": "00000000000000000000000" },
        }),
      ApiError,
    );
    assertEquals(error.statusCode, 404);
  });

  it("updateMe - partial update returns 200", async () => {
    const { data, status } = await client.admin.updateMe(
      { name: "Admin Test Condo Updated", city: "Porto" },
      { headers: { ...MASTER_HEADERS, "x-condominium-id": createdCondo.id } },
    );
    assertEquals(status, 200);
    assertEquals(data.name, "Admin Test Condo Updated");
    assertEquals(data.city, "Porto");
    // address unchanged
    assertEquals(data.address, createdCondo.address);
  });

  it("updateMe - non-existent condominium returns 404", async () => {
    const error = await assertRejects(
      () =>
        client.admin.updateMe(
          { name: "Test" },
          { headers: { ...MASTER_HEADERS, "x-condominium-id": "00000000000000000000000" } },
        ),
      ApiError,
    );
    assertEquals(error.statusCode, 404);
  });

  it("teardown - delete condominium", async () => {
    await client.super.deleteCondominium(createdCondo.id, {
      headers: MASTER_HEADERS,
    });
  });
});
