// E2E security: race condition em /portal/.../save-nif (write-once).
//
// Threat: 2 requests paralelas com NIFs diferentes ambas vêem `nif=NULL`,
// passam o check e ambas escrevem. Sem transação + FOR UPDATE, a 2ª
// sobrescrevia a 1ª - write-once violado.
//
// O NIF vive em core.occupant (per-condo). Endpoint:
// POST /v1/portal/condominiums/:cid/units/:unitId/save-nif. O fix é o mesmo
// (postgres.transaction + SELECT FOR UPDATE no occupant row).

import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import postgresjs from "postgresjs";
import bcrypt from "npm:bcryptjs@2.4.3";
import { Client } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";

const BASE_URL = "http://localhost:3000";
const DATABASE_URL = Deno.env.get("DATABASE_URL") ??
  "postgres://mague:mague@localhost:5432/mague";
const SUPER = await loginAsSuper();
const sql = postgresjs(DATABASE_URL, { max: 4 });

// 5 NIFs PT válidos distintos (check-digit + first-digit allowlist {1,2,3,5,6,8,9}).
const NIFS = ["245678905", "123456789", "234567899", "345678915", "600000001"];

describe("security - NIF write-once race (per-occupant)", () => {
  const stamp = Date.now();
  const userEmail = `nif-race-${stamp}@test.pt`;
  let condoId = "";
  let unitId = "";
  let occupantId = "";
  let userId = "";
  let token = "";

  it("setup - condo + unit + occupant linked to user", async () => {
    // Cleanup defensivo: detach unit_occupants antes do delete.
    await sql`
      DELETE FROM core.unit_occupant
       WHERE occupant_id IN (
         SELECT id FROM core.occupant
          WHERE nif = ANY(${NIFS}) AND name LIKE 'NIF Race%'
       )
    `;
    await sql`
      DELETE FROM core.occupant
       WHERE nif = ANY(${NIFS})
         AND name LIKE 'NIF Race%'
    `;

    const c = new Client({ baseUrl: BASE_URL });
    const { data: condo } = await c.super.createCondominium(
      { name: "NIF Race", fiscalNumber: "501500200" },
      { headers: SUPER },
    );
    condoId = condo.id;
    const headers = { ...SUPER, "x-condominium-id": condoId };

    const { data: unit } = await c.super.createUnit(
      condoId,
      { designation: "X", permillage: 1000 },
      { headers: SUPER },
    );
    unitId = unit.id;

    const hash = await bcrypt.hash("RacePass1234", 10);
    const r = await sql<{ id: string }[]>`
      INSERT INTO core.user (name, email, role, is_active, password_hash)
      VALUES ('NIF Race User', ${userEmail}, NULL, true, ${hash})
      RETURNING id
    `;
    userId = r[0].id;

    const { data: occ } = await c.admin.createOccupant(
      { name: "NIF Race Owner", type: "owner", email: userEmail },
      { headers },
    );
    occupantId = occ.id;
    await sql`UPDATE core.occupant SET user_id = ${userId} WHERE id = ${occupantId}`;
    await c.admin.createUnitOccupant(
      unitId,
      { unitId, occupantId, relationshipType: "owner", startDate: "2025-01-01" },
      { headers },
    );

    token = (await c.auth.login(userEmail, "RacePass1234")).data.token;
  });

  it("5 requests paralelas com NIFs diferentes → 1 success + 4 NIF_LOCKED, DB consistente", async () => {
    const url = `${BASE_URL}/v1/portal/condominiums/${condoId}/units/${unitId}/save-nif`;
    const results = await Promise.allSettled(
      NIFS.map((nif) =>
        fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`,
          },
          body: JSON.stringify({ nif }),
        }).then(async (r) => {
          const body = await r.json();
          return { status: r.status, body };
        })
      ),
    );

    const responses = results.map((r) => (r.status === "fulfilled" ? r.value : null)).filter(
      Boolean,
    ) as Array<{ status: number; body: { data?: { nif?: string }; error?: { code?: string } } }>;

    const ok = responses.filter((r) => r.status === 200);
    const conflicts = responses.filter((r) => r.status === 409);
    const others = responses.filter((r) => r.status !== 200 && r.status !== 409);

    assertEquals(ok.length, 1, `esperava 1× 200, veio ${ok.length}`);
    assertEquals(conflicts.length, 4, `esperava 4× 409, veio ${conflicts.length}`);
    assertEquals(others.length, 0, `respostas inesperadas: ${JSON.stringify(others)}`);

    for (const c of conflicts) {
      assertEquals(c.body.error?.code, "NIF_LOCKED");
    }

    const winnerNif = ok[0].body.data?.nif ?? null;
    const row = await sql<{ nif: string | null }[]>`
      SELECT nif FROM core.occupant WHERE id = ${occupantId}
    `;
    assertEquals(row[0].nif, winnerNif);
    assertEquals(NIFS.includes(row[0].nif!), true);
  });

  it("teardown", async () => {
    try {
      await sql`DELETE FROM core.unit_occupant WHERE unit_id = ${unitId}`;
      await sql`DELETE FROM core.occupant WHERE id = ${occupantId}`;
      await sql`DELETE FROM core.user WHERE id = ${userId}`;
      await sql`DELETE FROM core.unit WHERE id = ${unitId}`;
      await sql`DELETE FROM core.condominium WHERE id = ${condoId}`;
    } finally {
      await sql.end();
    }
  });
});
