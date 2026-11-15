import { assertEquals, assertRejects } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { ApiError, Client, type Condominium } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";
import { deleteTestUser, seedTestUser, sqlExec } from "./_helpers/db.ts";

const BASE_URL = "http://localhost:3000";
const client = new Client({ baseUrl: BASE_URL });

const MASTER_HEADERS = await loginAsSuper();

describe("admin users", () => {
  let createdCondo: Condominium;
  let managerUserId = "";
  const hdr = () => ({ ...MASTER_HEADERS, "x-condominium-id": createdCondo.id });

  it("setup - create a condominium", async () => {
    const { data } = await client.super.createCondominium(
      { name: "User Test Condo" },
      { headers: MASTER_HEADERS },
    );
    createdCondo = data;
  });

  it("listUsers - with x-condominium-id returns users", async () => {
    const { data, status } = await client.admin.listUsers({ headers: hdr() });
    assertEquals(status, 200);
    assertEquals(Array.isArray(data), true);
  });

  // Para exercitar getUser/updateUser/deleteUser temos de criar 1 user
  // ligado ao condo. Após ADR 0002 a ligação faz-se via INSERT directo em
  // core.manager (não há mais POST /managers; só PATCH /users/:id { isManager }
  // - mas isso já requer o user estar related ao condo, que aqui não está).
  it("setup user (seed) + liga ao condo via core.manager", async () => {
    managerUserId = `usr_user_test_${crypto.randomUUID().substring(0, 6)}`;
    await deleteTestUser(managerUserId).catch(() => {});
    await seedTestUser({
      id: managerUserId,
      email: `${managerUserId}@example.pt`,
      name: "Manager Para Teste User",
      nif: "999888777",
    });
    await sqlExec(
      `INSERT INTO core.manager (condominium_id, user_id, is_active)
       VALUES ('${createdCondo.id}', '${managerUserId}', true)`,
    );
  });

  it("getUser - devolve o user criado", async () => {
    const { data, status } = await client.admin.getUser(managerUserId, { headers: hdr() });
    assertEquals(status, 200);
    assertEquals(data.id, managerUserId);
    assertEquals(data.email, `${managerUserId}@example.pt`);
  });

  it("getUser - id inexistente devolve 404", async () => {
    const e = await assertRejects(
      () => client.admin.getUser("id_que_nao_existe_xxx", { headers: hdr() }),
      ApiError,
    );
    assertEquals(e.statusCode, 404);
  });

  it("updateUser - patch name funciona", async () => {
    const { data, status } = await client.admin.updateUser(
      managerUserId,
      { name: "Manager Renomeado" },
      { headers: hdr() },
    );
    assertEquals(status, 200);
    assertEquals(data.name, "Manager Renomeado");
  });

  it("updateUser - body invalido (name vazia) devolve 400", async () => {
    const e = await assertRejects(
      () =>
        client.admin.updateUser(
          managerUserId,
          { name: "" },
          { headers: hdr() },
        ),
      ApiError,
    );
    assertEquals(e.statusCode, 400);
  });

  it("deleteUser - desliga user do condo (soft delete da relação)", async () => {
    // O endpoint NÃO apaga core.user (utilizador continua global). Apaga
    // apenas a manager/occupant relations. Após delete, listUsers deste
    // condo já não deve trazer o user.
    const { status } = await client.admin.deleteUser(managerUserId, { headers: hdr() });
    assertEquals(status, 204);

    const { data } = await client.admin.listUsers({ headers: hdr() });
    const found = data.find((u) => u.id === managerUserId);
    assertEquals(
      found,
      undefined,
      "Após deleteUser, user já não deve aparecer em listUsers do condo",
    );
  });

  it("listUsers inclui residents/tenants, não apenas owners", async () => {
    // Regressão: o filtro `unit_occupant.relationship_type = 'owner'`
    // deixava residents/tenants invisíveis em /users mesmo já tendo user
    // activo + first_login. Agora todas as relations contam.
    const unitRes = await client.super.createUnit(
      createdCondo.id,
      { designation: "A1", permillage: 1000 } as Record<string, unknown>,
      { headers: MASTER_HEADERS },
    );
    const unitId = unitRes.data.id;

    const residentUserId = `usr_resident_${crypto.randomUUID().substring(0, 6)}`;
    const residentOccupantId = `occ_resident_${crypto.randomUUID().substring(0, 6)}`;
    await seedTestUser({
      id: residentUserId,
      email: `${residentUserId}@example.pt`,
      name: "Resident para teste",
      nif: "111222333",
    });
    await sqlExec(`
      INSERT INTO core.occupant (id, condominium_id, name, email, user_id)
      VALUES ('${residentOccupantId}', '${createdCondo.id}', 'Resident', '${residentUserId}@example.pt', '${residentUserId}');
      INSERT INTO core.unit_occupant (id, unit_id, occupant_id, relationship_type, start_date)
      VALUES ('uo_resident_${
      crypto.randomUUID().substring(0, 6)
    }', '${unitId}', '${residentOccupantId}', 'resident', '2025-01-01');
    `);

    const { data } = await client.admin.listUsers({ headers: hdr() });
    const found = data.find((u) => u.id === residentUserId);
    if (!found) {
      throw new Error(
        "Resident user devia aparecer em listUsers (não só 'owner')",
      );
    }
    assertEquals(found.occupantId, residentOccupantId);

    // Cleanup
    await sqlExec(`
      DELETE FROM core.unit_occupant WHERE occupant_id = '${residentOccupantId}';
      DELETE FROM core.occupant WHERE id = '${residentOccupantId}';
    `);
    await deleteTestUser(residentUserId).catch(() => {});
  });

  it("teardown - delete condominium + user", async () => {
    await client.super.deleteCondominium(createdCondo.id, {
      headers: MASTER_HEADERS,
    });
    await deleteTestUser(managerUserId).catch(() => {});
  });
});
