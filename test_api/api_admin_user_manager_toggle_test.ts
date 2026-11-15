// Tests para o novo fluxo de toggle de administrador (ADR 0002).
//
// Cobertura:
//   • PATCH user com isManager=true cria registo em core.manager
//   • PATCH user com isManager=false soft-deleta o registo
//   • Idempotência: re-toggle on restaura o mesmo registo soft-deleted
//   • Retrieve após toggle off: user ainda visível, isManager=false
//   • Último admin: 409 LAST_MANAGER ao tentar remover o último ativo
//
// Pré-requisito da relatedness check (`update.ts`/`retrieve.ts`):
// o user tem de já estar relacionado com o condo via:
//   - `core.manager` (qualquer estado, incluindo soft-deleted) OU
//   - `core.occupant` + `core.unit_occupant` (relationshipType='owner') na unit do condo.
// O setup deste teste cria a chain occupant+unit+unit_occupant para
// satisfazer a regra antes de fazer o primeiro toggle on.
//
// Login: super (loginAsSuper).

import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { ApiError, Client } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";
import { deleteTestUser, seedTestUser, sqlExec } from "./_helpers/db.ts";

const BASE_URL = "http://localhost:3000";
const client = new Client({ baseUrl: BASE_URL });

describe("admin user - isManager toggle (ADR 0002)", () => {
  let condoId = "";
  // Dois admins: managerA é o admin permanente (evita lockout do último admin);
  // managerB é o que vamos toggle on/off durante os testes.
  const managerAId = "usr_toggle_a";
  const managerBId = "usr_toggle_b";
  const occupantBId = "occ_toggle_b";
  const unitOccupantBId = "uo_toggle_b";
  const unitId = "unit_toggle";
  let auth: { Authorization: string };

  it("setup", async () => {
    auth = await loginAsSuper();
    const { data: c } = await client.super.createCondominium(
      { name: "Toggle Test Condo" },
      { headers: auth },
    );
    condoId = c.id;

    // Limpar runs anteriores que possam ter ficado.
    await deleteTestUser(managerAId).catch(() => {});
    await deleteTestUser(managerBId).catch(() => {});

    await seedTestUser({ id: managerAId, email: "toggle_a@test.pt" });
    await seedTestUser({ id: managerBId, email: "toggle_b@test.pt" });

    // Adicionar managerA como admin via INSERT directo (a forma "moderna"
    // - PATCH user { isManager: true } - é o que estamos a testar, e
    // requer o user já estar relacionado, criando galinha e ovo).
    await sqlExec(
      `INSERT INTO core.manager (condominium_id, user_id, is_active)
       VALUES ('${condoId}', '${managerAId}', true)`,
    );

    // Setup da relatedness chain para managerB: cria 1 unit no condo, 1
    // occupant ligado ao user, e 1 unit_occupant a ligar os dois com tipo
    // "owner". Isto satisfaz o `isRelated` check em update.ts/retrieve.ts.
    // IDs fixos para evitar parsing do output do RETURNING (que pode
    // incluir o tag "INSERT 0 1" e quebrar o trim).
    await sqlExec(
      `INSERT INTO core.unit (id, condominium_id, designation, permillage)
       VALUES ('${unitId}', '${condoId}', '1ºA', 100)`,
    );
    await sqlExec(
      `INSERT INTO core.occupant (id, condominium_id, user_id, name)
       VALUES ('${occupantBId}', '${condoId}', '${managerBId}', 'Manager B')`,
    );
    await sqlExec(
      `INSERT INTO core.unit_occupant (id, unit_id, occupant_id, relationship_type, start_date)
       VALUES ('${unitOccupantBId}', '${unitId}', '${occupantBId}', 'owner', CURRENT_DATE)`,
    );
  });

  it("PATCH user { isManager: true } cria registo em core.manager", async () => {
    const headers = { ...auth, "x-condominium-id": condoId };
    const { data, status } = await client.admin.updateUser(
      managerBId,
      { isManager: true },
      { headers },
    );
    assertEquals(status, 200);
    assertEquals(data.isManager, true);

    const dbResult = await sqlExec(
      `SELECT COUNT(*) FROM core.manager
       WHERE user_id = '${managerBId}' AND condominium_id = '${condoId}'
         AND is_active = true AND deleted_at IS NULL`,
    );
    assertEquals(dbResult, "1", "manager record ativo deve existir");
  });

  it("PATCH user { isManager: false } soft-deleta o registo", async () => {
    const headers = { ...auth, "x-condominium-id": condoId };
    const { data, status } = await client.admin.updateUser(
      managerBId,
      { isManager: false },
      { headers },
    );
    assertEquals(status, 200);
    assertEquals(data.isManager, false);

    const dbResult = await sqlExec(
      `SELECT deleted_at IS NOT NULL FROM core.manager
       WHERE user_id = '${managerBId}' AND condominium_id = '${condoId}'`,
    );
    assertEquals(dbResult, "t", "manager record deve estar soft-deleted");
  });

  it("retrieve user após toggle off ainda devolve o user (relação histórica)", async () => {
    const headers = { ...auth, "x-condominium-id": condoId };
    const { data, status } = await client.admin.getUser(managerBId, { headers });
    assertEquals(status, 200);
    assertExists(data);
    assertEquals(data.isManager, false, "isManager deve ser false no retrieve");
  });

  it("PATCH user { isManager: true } restaura o registo soft-deleted (idempotente)", async () => {
    const headers = { ...auth, "x-condominium-id": condoId };
    const { data, status } = await client.admin.updateUser(
      managerBId,
      { isManager: true },
      { headers },
    );
    assertEquals(status, 200);
    assertEquals(data.isManager, true);

    // Não deve haver duplicação - mesmo registo restaurado.
    const count = await sqlExec(
      `SELECT COUNT(*) FROM core.manager
       WHERE user_id = '${managerBId}' AND condominium_id = '${condoId}'`,
    );
    assertEquals(count, "1", "deve continuar com 1 registo (não duplicar)");

    const active = await sqlExec(
      `SELECT COUNT(*) FROM core.manager
       WHERE user_id = '${managerBId}' AND condominium_id = '${condoId}'
         AND deleted_at IS NULL`,
    );
    assertEquals(active, "1", "registo deve estar ativo (deletedAt NULL)");
  });

  it("último admin → PATCH { isManager: false } retorna 409 LAST_MANAGER", async () => {
    const headers = { ...auth, "x-condominium-id": condoId };
    // Remove managerB primeiro (deixa só managerA).
    await client.admin.updateUser(managerBId, { isManager: false }, { headers });

    // Agora tenta remover managerA (o último admin ativo).
    await assertRejects(
      async () => {
        await client.admin.updateUser(managerAId, { isManager: false }, { headers });
      },
      ApiError,
      "último administrador",
    );

    const stillActive = await sqlExec(
      `SELECT COUNT(*) FROM core.manager
       WHERE user_id = '${managerAId}' AND condominium_id = '${condoId}'
         AND deleted_at IS NULL`,
    );
    assertEquals(stillActive, "1", "último admin deve permanecer ativo");
  });

  it("auth API: user com manager soft-deleted é bloqueado em /admin/* (mas tem occupant access)", async () => {
    // managerB foi soft-deleted. Login como managerB.
    const { data: loginRes } = await client.auth.login("toggle_b@test.pt", "test12345");
    const userAuth = { Authorization: `Bearer ${loginRes.token}` };

    // managerB tem occupant + unit_occupant no condo, portanto api_auth
    // deixa entrar (o middleware aceita occupant access). Mas o
    // requireAdminRole bloqueia /admin/* - o user não é admin nem super.
    await assertRejects(
      async () => {
        await client.admin.listUsers({
          headers: { ...userAuth, "x-condominium-id": condoId },
        });
      },
      ApiError,
      "Acesso reservado a administradores",
    );
  });

  it("teardown", async () => {
    await sqlExec(
      `DELETE FROM core.unit_occupant WHERE id = '${unitOccupantBId}'`,
    ).catch(() => {});
    await sqlExec(`DELETE FROM core.occupant WHERE id = '${occupantBId}'`).catch(() => {});
    await sqlExec(`DELETE FROM core.unit WHERE id = '${unitId}'`).catch(() => {});
    await client.super.deleteCondominium(condoId, { headers: auth });
    await deleteTestUser(managerAId);
    await deleteTestUser(managerBId);
  });
});
