import { assertEquals, assertRejects } from "@std/assert";
import { describe, it } from "@std/testing/bdd";

import { ApiError, Client, type Condominium, type Unit } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";

const BASE_URL = "http://localhost:3000";
const client = new Client({ baseUrl: BASE_URL });

const MASTER_HEADERS = await loginAsSuper();

describe("condominiums API", () => {
  it("list - without x-role returns 401", async () => {
    const error = await assertRejects(
      () => client.super.listCondominiums({ headers: {} }),
      ApiError,
    );
    assertEquals(error.statusCode, 401);
  });

  it("list - master role returns condominiums", async () => {
    const { data, status } = await client.super.listCondominiums({
      headers: MASTER_HEADERS,
    });
    assertEquals(status, 200);
    assertEquals(Array.isArray(data), true);
  });

  it("list - without Authorization returns 401", async () => {
    // x-role: admin não é um caminho de auth; sem Bearer token o apiAuth
    // devolve 401 antes de chegar ao super-guard.
    const error = await assertRejects(
      () => client.super.listCondominiums({ headers: { "x-role": "admin" } }),
      ApiError,
    );
    assertEquals(error.statusCode, 401);
  });
});

describe("condominiums CRUD", () => {
  let createdCondo: Condominium;

  it("create - missing name returns 400", async () => {
    const error = await assertRejects(
      () =>
        client.super.createCondominium(
          { fiscalNumber: "123456789" },
          { headers: MASTER_HEADERS },
        ),
      ApiError,
    );
    assertEquals(error.statusCode, 400);
  });

  it("create - valid data returns 201", async () => {
    const { data, status } = await client.super.createCondominium(
      {
        name: "Test Condo API",
        fiscalNumber: "123456789",
        address: "Rua Teste",
        city: "Lisboa",
        postalCode: "1000-100",
        quotaDayOfMonth: 10,
      },
      { headers: MASTER_HEADERS },
    );

    assertEquals(status, 201);
    assertEquals(typeof data.id, "string");
    assertEquals(data.name, "Test Condo API");
    assertEquals(data.fiscalNumber, "123456789");
    assertEquals(data.city, "Lisboa");
    assertEquals(data.isActive, true);
    createdCondo = data;
  });

  it("get - returns created condominium", async () => {
    const { data, status } = await client.super.getCondominium(
      createdCondo.id,
      { headers: MASTER_HEADERS },
    );
    assertEquals(status, 200);
    assertEquals(data.id, createdCondo.id);
    assertEquals(data.name, createdCondo.name);
  });

  it("get - non-existent returns 404", async () => {
    const error = await assertRejects(
      () => client.super.getCondominium("00000000000000000000000", { headers: MASTER_HEADERS }),
      ApiError,
    );
    assertEquals(error.statusCode, 404);
  });

  it("update - partial update returns 200", async () => {
    const { data, status } = await client.super.updateCondominium(
      createdCondo.id,
      { name: "Test Condo Updated", city: "Porto" },
      { headers: MASTER_HEADERS },
    );
    assertEquals(status, 200);
    assertEquals(data.name, "Test Condo Updated");
    assertEquals(data.city, "Porto");
    // fiscalNumber unchanged
    assertEquals(data.fiscalNumber, createdCondo.fiscalNumber);
  });

  it("update - nullable field can be cleared with null", async () => {
    const { data } = await client.super.updateCondominium(
      createdCondo.id,
      { city: null },
      { headers: MASTER_HEADERS },
    );
    assertEquals(data.city, null);
  });

  it("update - non-existent returns 404", async () => {
    const error = await assertRejects(
      () =>
        client.super.updateCondominium(
          "00000000000000000000000",
          { name: "Test" },
          { headers: MASTER_HEADERS },
        ),
      ApiError,
    );
    assertEquals(error.statusCode, 404);
  });

  it("delete - existing returns 204", async () => {
    const { status } = await client.super.deleteCondominium(
      createdCondo.id,
      { headers: MASTER_HEADERS },
    );
    assertEquals(status, 204);
  });

  it("delete - non-existent returns 404", async () => {
    const error = await assertRejects(
      () => client.super.deleteCondominium(createdCondo.id, { headers: MASTER_HEADERS }),
      ApiError,
    );
    assertEquals(error.statusCode, 404);
  });

  it("get - after delete returns 404", async () => {
    const error = await assertRejects(
      () => client.super.getCondominium(createdCondo.id, { headers: MASTER_HEADERS }),
      ApiError,
    );
    assertEquals(error.statusCode, 404);
  });
});

describe("units API", () => {
  it("list - without x-role returns 401", async () => {
    const error = await assertRejects(
      () => client.super.listUnits("any-id", { headers: {} }),
      ApiError,
    );
    assertEquals(error.statusCode, 401);
  });

  it("list - master role works without x-condominium-id", async () => {
    const { data, status } = await client.super.listUnits("any-id", {
      headers: MASTER_HEADERS,
    });
    assertEquals(status, 200);
    assertEquals(Array.isArray(data), true);
  });
});

describe("units CRUD", () => {
  let createdCondo: Condominium;
  let createdUnit: Unit;

  it("setup - create a condominium first", async () => {
    const { data } = await client.super.createCondominium(
      { name: "Unit Test Condo" },
      { headers: MASTER_HEADERS },
    );
    createdCondo = data;
  });

  it("create - missing designation returns 400", async () => {
    const error = await assertRejects(
      () =>
        client.super.createUnit(
          createdCondo.id,
          { permillage: 100 },
          { headers: MASTER_HEADERS },
        ),
      ApiError,
    );
    assertEquals(error.statusCode, 400);
  });

  it("create - missing permillage returns 400", async () => {
    const error = await assertRejects(
      () =>
        client.super.createUnit(
          createdCondo.id,
          { designation: "Fracao A" },
          { headers: MASTER_HEADERS },
        ),
      ApiError,
    );
    assertEquals(error.statusCode, 400);
  });

  it("create - valid data returns 201", async () => {
    const { data, status } = await client.super.createUnit(
      createdCondo.id,
      {
        designation: "Fracao A",
        unitType: "residential",
        permillage: 100,
        floor: "1",
        door: "A",
        block: "B",
        description: "Test unit",
      },
      { headers: MASTER_HEADERS },
    );

    assertEquals(status, 201);
    assertEquals(typeof data.id, "string");
    assertEquals(data.designation, "Fracao A");
    assertEquals(data.unitType, "residential");
    assertEquals(data.condominiumId, createdCondo.id);
    assertEquals(data.floor, "1");
    assertEquals(data.door, "A");
    assertEquals(data.block, "B");
    assertEquals(data.isActive, true);
    createdUnit = data;
  });

  it("get - returns created unit", async () => {
    const { data, status } = await client.super.getUnit(
      createdCondo.id,
      createdUnit.id,
      { headers: MASTER_HEADERS },
    );
    assertEquals(status, 200);
    assertEquals(data.id, createdUnit.id);
    assertEquals(data.designation, createdUnit.designation);
  });

  it("get - non-existent returns 404", async () => {
    const error = await assertRejects(
      () =>
        client.super.getUnit(createdCondo.id, "00000000000000000000000", {
          headers: MASTER_HEADERS,
        }),
      ApiError,
    );
    assertEquals(error.statusCode, 404);
  });

  it("update - partial update returns 200", async () => {
    const { data, status } = await client.super.updateUnit(
      createdCondo.id,
      createdUnit.id,
      { designation: "Fracao A Updated", floor: "2" },
      { headers: MASTER_HEADERS },
    );
    assertEquals(status, 200);
    assertEquals(data.designation, "Fracao A Updated");
    assertEquals(data.floor, "2");
    // door unchanged
    assertEquals(data.door, createdUnit.door);
  });

  it("update - nullable field can be cleared with null", async () => {
    const { data } = await client.super.updateUnit(
      createdCondo.id,
      createdUnit.id,
      { description: null },
      { headers: MASTER_HEADERS },
    );
    assertEquals(data.description, null);
  });

  it("update - non-existent returns 404", async () => {
    const error = await assertRejects(
      () =>
        client.super.updateUnit(
          createdCondo.id,
          "00000000000000000000000",
          { designation: "Test" },
          { headers: MASTER_HEADERS },
        ),
      ApiError,
    );
    assertEquals(error.statusCode, 404);
  });

  it("delete - existing returns 204", async () => {
    const { status } = await client.super.deleteUnit(
      createdCondo.id,
      createdUnit.id,
      { headers: MASTER_HEADERS },
    );
    assertEquals(status, 204);
  });

  it("delete - non-existent returns 404", async () => {
    const error = await assertRejects(
      () =>
        client.super.deleteUnit(createdCondo.id, createdUnit.id, {
          headers: MASTER_HEADERS,
        }),
      ApiError,
    );
    assertEquals(error.statusCode, 404);
  });

  it("get - after delete returns 404", async () => {
    const error = await assertRejects(
      () =>
        client.super.getUnit(createdCondo.id, createdUnit.id, {
          headers: MASTER_HEADERS,
        }),
      ApiError,
    );
    assertEquals(error.statusCode, 404);
  });

  it("teardown - delete the condominium", async () => {
    await client.super.deleteCondominium(createdCondo.id, {
      headers: MASTER_HEADERS,
    });
  });
});
