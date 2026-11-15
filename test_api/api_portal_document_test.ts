// E2E: portal documents - só is_public=true visível.

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
const sql = postgresjs(DATABASE_URL, { max: 2 });

describe("portal documents - public-only filter", () => {
  const stamp = Date.now();
  const ownerEmail = `portal-doc-${stamp}@test.pt`;
  const password = "TestPass1234";
  let condoId = "";
  let unitId = "";
  let occupantId = "";
  let userId = "";
  let publicDocId = "";
  let privateDocId = "";
  let token = "";

  it("setup - condo + unit + occupant + 2 docs (1 public, 1 private)", async () => {
    const adm = new Client({ baseUrl: BASE_URL });
    const { data: condo } = await adm.super.createCondominium(
      { name: "Portal Doc Test", fiscalNumber: "501700100" },
      { headers: SUPER },
    );
    condoId = condo.id;
    const headers = { ...SUPER, "x-condominium-id": condoId };

    const { data: unit } = await adm.super.createUnit(
      condoId,
      { designation: "X", permillage: 1000 },
      { headers: SUPER },
    );
    unitId = unit.id;

    const hash = await bcrypt.hash(password, 10);
    const u = await sql<{ id: string }[]>`
      INSERT INTO core.user (name, email, role, is_active, password_hash)
      VALUES ('Portal Doc User', ${ownerEmail}, NULL, true, ${hash}) RETURNING id
    `;
    userId = u[0].id;

    const { data: occ } = await adm.admin.createOccupant(
      { name: "Owner Doc", type: "owner", email: ownerEmail },
      { headers },
    );
    occupantId = occ.id;
    await sql`UPDATE core.occupant SET user_id = ${userId} WHERE id = ${occupantId}`;
    await adm.admin.createUnitOccupant(
      unitId,
      { unitId, occupantId, relationshipType: "owner", startDate: "2025-01-01" },
      { headers },
    );

    const pub = await adm.admin.createDocument(
      { title: "Acta Pública", category: "minutes", isPublic: true },
      { headers },
    );
    publicDocId = pub.data.id;

    const priv = await adm.admin.createDocument(
      { title: "Contrato Privado", category: "contract", isPublic: false },
      { headers },
    );
    privateDocId = priv.data.id;

    token = (await adm.auth.login(ownerEmail, password)).data.token;
  });

  function portal() {
    return new Client({
      baseUrl: BASE_URL,
      condominiumId: condoId,
      defaultHeaders: { Authorization: `Bearer ${token}` },
    });
  }

  it("listDocuments - portal vê só o público", async () => {
    const { data } = await portal().portal.listDocuments();
    assertEquals(data.length, 1);
    assertEquals(data[0].id, publicDocId);
    assertEquals(data[0].isPublic, true);
  });

  it("admin pode tornar privado público + portal passa a ver", async () => {
    const adm = new Client({
      baseUrl: BASE_URL,
      condominiumId: condoId,
      defaultHeaders: SUPER,
    });
    await adm.admin.updateDocument(privateDocId, { isPublic: true });
    const { data } = await portal().portal.listDocuments();
    assertEquals(data.length, 2);
  });

  it("teardown", async () => {
    try {
      await sql`DELETE FROM core.unit_occupant WHERE unit_id = ${unitId}`;
      await sql`DELETE FROM core.occupant WHERE id = ${occupantId}`;
      await sql`DELETE FROM core.user WHERE id = ${userId}`;
      await sql`DELETE FROM core.document WHERE condominium_id = ${condoId}`;
      await sql`DELETE FROM core.unit WHERE id = ${unitId}`;
      await sql`DELETE FROM core.condominium WHERE id = ${condoId}`;
    } finally {
      await sql.end();
    }
  });
});
