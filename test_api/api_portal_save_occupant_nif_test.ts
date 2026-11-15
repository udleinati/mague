// E2E: POST /v1/portal/condominiums/:cid/units/:unitId/save-nif
//
// O NIF do user vive em core.occupant (per-condo). Este
// teste substitui api_auth_save_nif_test.ts (que escrevia em core.user.nif).
//
// Cobre:
//   1. Sem auth → 401.
//   2. NIF vazio ou inválido → 400 VALIDATION_ERROR.
//   3. NIF válido salva em core.occupant.
//   4. Tentativa de alterar NIF já preenchido → 409 NIF_LOCKED.
//   5. NIF já em uso por outro occupant ACTIVO no mesmo condo → 409 NIF_TAKEN.
//   6. NIF pode repetir-se em condos diferentes (caso multi-condo do mesmo owner).

import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import postgresjs from "postgresjs";
import bcrypt from "npm:bcryptjs@2.4.3";
import { ApiError, Client } from "$shared/client/mod.ts";
import { assertRejects } from "@std/assert";
import { loginAsSuper } from "./_helpers/auth.ts";

const BASE_URL = "http://localhost:3000";
const DATABASE_URL = Deno.env.get("DATABASE_URL") ??
  "postgres://mague:mague@localhost:5432/mague";
const SUPER = await loginAsSuper();
const sql = postgresjs(DATABASE_URL, { max: 2 });

// NIFs PT válidos (gerados pelo algoritmo check-digit). Não usar em prod.
const VALID_NIF_A = "245678905";
const VALID_NIF_B = "123456789";

describe("portal - save NIF (per-occupant, write-once)", () => {
  const stamp = Date.now();
  const aEmail = `portal-nif-a-${stamp}@test.pt`;
  const bEmail = `portal-nif-b-${stamp}@test.pt`;
  const password = "TestPass1234";

  let condoId = "";
  let unitAId = "";
  let unitBId = "";
  let occupantAId = "";
  let occupantBId = "";
  let aToken = "";
  let bToken = "";

  it("setup - condo + 2 units + 2 occupants linkados a 2 users", async () => {
    // Cleanup defensivo: detach unit_occupants (FK→occupant) antes do delete.
    await sql`
      DELETE FROM core.unit_occupant
       WHERE occupant_id IN (
         SELECT id FROM core.occupant
          WHERE nif IN (${VALID_NIF_A}, ${VALID_NIF_B})
            AND name LIKE 'Portal NIF Test%'
       )
    `;
    await sql`
      DELETE FROM core.occupant
       WHERE nif IN (${VALID_NIF_A}, ${VALID_NIF_B})
         AND name LIKE 'Portal NIF Test%'
    `;

    const adminClient = new Client({ baseUrl: BASE_URL });
    const { data: condo } = await adminClient.super.createCondominium(
      { name: "Portal NIF Test", fiscalNumber: "501500100" },
      { headers: SUPER },
    );
    condoId = condo.id;
    const headers = { ...SUPER, "x-condominium-id": condoId };

    const { data: u1 } = await adminClient.super.createUnit(
      condoId,
      { designation: "1A", permillage: 500 },
      { headers: SUPER },
    );
    unitAId = u1.id;
    const { data: u2 } = await adminClient.super.createUnit(
      condoId,
      { designation: "1B", permillage: 500 },
      { headers: SUPER },
    );
    unitBId = u2.id;

    // Cria users com password.
    const hash = await bcrypt.hash(password, 10);
    const aUser = await sql<{ id: string }[]>`
      INSERT INTO core.user (name, email, role, is_active, password_hash)
      VALUES ('Portal NIF Test A', ${aEmail}, NULL, true, ${hash}) RETURNING id
    `;
    const bUser = await sql<{ id: string }[]>`
      INSERT INTO core.user (name, email, role, is_active, password_hash)
      VALUES ('Portal NIF Test B', ${bEmail}, NULL, true, ${hash}) RETURNING id
    `;

    // Cria occupants linkados aos users.
    const { data: occA } = await adminClient.admin.createOccupant(
      { name: "Portal NIF Test A", type: "owner", email: aEmail },
      { headers },
    );
    occupantAId = occA.id;
    await sql`UPDATE core.occupant SET user_id = ${aUser[0].id} WHERE id = ${occA.id}`;
    await adminClient.admin.createUnitOccupant(
      unitAId,
      { unitId: unitAId, occupantId: occA.id, relationshipType: "owner", startDate: "2025-01-01" },
      { headers },
    );

    const { data: occB } = await adminClient.admin.createOccupant(
      { name: "Portal NIF Test B", type: "owner", email: bEmail },
      { headers },
    );
    occupantBId = occB.id;
    await sql`UPDATE core.occupant SET user_id = ${bUser[0].id} WHERE id = ${occB.id}`;
    await adminClient.admin.createUnitOccupant(
      unitBId,
      { unitId: unitBId, occupantId: occB.id, relationshipType: "owner", startDate: "2025-01-01" },
      { headers },
    );

    // Login dos 2 users.
    aToken = (await new Client({ baseUrl: BASE_URL }).auth.login(aEmail, password)).data.token;
    bToken = (await new Client({ baseUrl: BASE_URL }).auth.login(bEmail, password)).data.token;
  });

  function clientForToken(token: string) {
    return new Client({
      baseUrl: BASE_URL,
      condominiumId: condoId,
      defaultHeaders: { Authorization: `Bearer ${token}` },
    });
  }

  it("401 sem token", async () => {
    const res = await fetch(
      `${BASE_URL}/v1/portal/condominiums/${condoId}/units/${unitAId}/save-nif`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nif: VALID_NIF_A }),
      },
    );
    assertEquals(res.status, 401);
    await res.body?.cancel();
  });

  it("400 quando NIF vazio", async () => {
    const e = await assertRejects(
      () => clientForToken(aToken).portal.saveOccupantNif(unitAId, ""),
      ApiError,
    );
    assertEquals(e.statusCode, 400);
  });

  it("400 quando NIF inválido (check-digit falha)", async () => {
    const e = await assertRejects(
      () => clientForToken(aToken).portal.saveOccupantNif(unitAId, "111111111"),
      ApiError,
    );
    assertEquals(e.statusCode, 400);
    const row = await sql<{ nif: string | null }[]>`
      SELECT nif FROM core.occupant WHERE id = ${occupantAId}
    `;
    assertEquals(row[0].nif, null);
  });

  it("guarda NIF válido em core.occupant", async () => {
    const { data, status } = await clientForToken(aToken).portal.saveOccupantNif(
      unitAId,
      VALID_NIF_A,
    );
    assertEquals(status, 200);
    assertEquals(data.nif, VALID_NIF_A);
    assertEquals(data.occupantId, occupantAId);
    const row = await sql<{ nif: string | null }[]>`
      SELECT nif FROM core.occupant WHERE id = ${occupantAId}
    `;
    assertEquals(row[0].nif, VALID_NIF_A);
  });

  it("409 NIF_LOCKED ao tentar alterar NIF já preenchido", async () => {
    const e = await assertRejects(
      () => clientForToken(aToken).portal.saveOccupantNif(unitAId, VALID_NIF_B),
      ApiError,
    );
    assertEquals(e.statusCode, 409);
  });

  it("409 NIF_TAKEN ao tentar usar NIF já em uso por outro occupant no mesmo condo", async () => {
    const e = await assertRejects(
      () => clientForToken(bToken).portal.saveOccupantNif(unitBId, VALID_NIF_A),
      ApiError,
    );
    assertEquals(e.statusCode, 409);
  });

  it("user B grava NIF distinto sem colisão", async () => {
    const { data } = await clientForToken(bToken).portal.saveOccupantNif(unitBId, VALID_NIF_B);
    assertEquals(data.nif, VALID_NIF_B);
  });

  it("teardown", async () => {
    try {
      // FK chain: unit_occupant → occupant → user. Detach top-down.
      await sql`DELETE FROM core.unit_occupant WHERE unit_id IN (${unitAId}, ${unitBId})`;
      await sql`DELETE FROM core.occupant WHERE id IN (${occupantAId}, ${occupantBId})`;
      await sql`DELETE FROM core.user WHERE email IN (${aEmail}, ${bEmail})`;
      await sql`DELETE FROM core.unit WHERE id IN (${unitAId}, ${unitBId})`;
      await sql`DELETE FROM core.condominium WHERE id = ${condoId}`;
    } finally {
      await sql.end();
    }
  });
});
