// E2E: janela do condómino aplicada na API.
//
// O panel filtrava o período do ocupante, mas o cookie do panel é o Bearer da
// API: quem assumia uma fração lia direto na API o email/telefone/NIF dos
// ex-ocupantes e as cobranças deles. Um comprador registado com início futuro
// entrava logo no portal da fração do vendedor.

import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { Client, type Condominium, type Unit } from "$shared/client/mod.ts";
import { loginAs, loginAsSuper } from "./_helpers/auth.ts";
import { seedTestUser, sqlExec } from "./_helpers/db.ts";

const BASE_URL = "http://localhost:3000";
const client = new Client({ baseUrl: BASE_URL });
const MASTER = await loginAsSuper();

async function getJson(path: string, headers: Record<string, string>) {
  const res = await fetch(`${BASE_URL}${path}`, { headers });
  const text = await res.text();
  return { status: res.status, text, body: res.ok ? JSON.parse(text) : null };
}

async function seedOccupant(
  condoId: string,
  unitId: string,
  opts: { name: string; email: string; nif: string; start: string; end?: string; login?: boolean },
): Promise<string> {
  const uid = opts.login ? await seedTestUser({ email: opts.email, password: "test12345" }) : null;
  const occId = (await sqlExec(`
    INSERT INTO core.occupant (user_id,name,email,nif,phone,condominium_id)
    VALUES (${uid ? `'${uid}'` : "NULL"},'${opts.name}','${opts.email}','${opts.nif}',
            '910000000','${condoId}')
    RETURNING id`)).split("\n")[0].trim();
  await sqlExec(`
    INSERT INTO core.unit_occupant (unit_id,occupant_id,relationship_type,start_date,end_date)
    VALUES ('${unitId}','${occId}','owner','${opts.start}',${opts.end ? `'${opts.end}'` : "NULL"});
  `);
  return occId;
}

describe("security - janela do condómino no portal (API)", () => {
  const ts = Date.now();
  let condo: Condominium;
  let unit: Unit;
  let futureUnit: Unit;
  let ownerHeaders: { Authorization: string };
  let buyerHeaders: { Authorization: string };
  const sellerNif = "123456789";

  it("setup: ex-dono (2020-2025), dono atual (2026-), comprador com início futuro", async () => {
    condo = (await client.super.createCondominium(
      { name: `Owner Window ${ts}` },
      { headers: MASTER },
    )).data;
    unit = (await client.super.createUnit(
      condo.id,
      { designation: "A1", permillage: 500 },
      { headers: MASTER },
    )).data;
    futureUnit = (await client.super.createUnit(
      condo.id,
      { designation: "B1", permillage: 500 },
      { headers: MASTER },
    )).data;

    await seedOccupant(condo.id, unit.id, {
      name: "Ex Dono",
      email: `ex-dono-${ts}@example.pt`,
      nif: sellerNif,
      start: "2020-01-01",
      end: "2025-12-31",
    });
    const ownerEmail = `dono-atual-${ts}@example.pt`;
    await seedOccupant(condo.id, unit.id, {
      name: "Dono Atual",
      email: ownerEmail,
      nif: "234567890",
      start: "2026-01-01",
      login: true,
    });
    ownerHeaders = await loginAs(ownerEmail, "test12345");

    const buyerEmail = `comprador-${ts}@example.pt`;
    await seedOccupant(condo.id, futureUnit.id, {
      name: "Comprador",
      email: buyerEmail,
      nif: "345678901",
      start: "2099-01-01",
      login: true,
    });
    buyerHeaders = await loginAs(buyerEmail, "test12345");

    for (const competencePeriod of ["2025-06-01", "2026-03-01"]) {
      await client.admin.createCharge(
        {
          kind: "receivable",
          nature: "debit",
          chargeType: "quota",
          unitId: unit.id,
          amountCents: 10000,
          description: `Quota ${competencePeriod}`,
          competencePeriod,
          issueDate: competencePeriod,
        },
        { headers: { ...MASTER, "x-condominium-id": condo.id } },
      );
    }
  });

  it("fração: o dono atual não recebe dados do ex-dono", async () => {
    const r = await getJson(`/v1/portal/condominiums/${condo.id}/units/${unit.id}`, ownerHeaders);
    assertEquals(r.status, 200);
    const names = (r.body.data.occupants as Array<{ occupant: { name: string } }>)
      .map((o) => o.occupant.name);
    assertEquals(names, ["Dono Atual"]);
    assertEquals(r.text.includes(sellerNif), false, "NIF do ex-dono exposto");
  });

  it("cobranças: só as do período do dono atual", async () => {
    const r = await getJson(
      `/v1/portal/condominiums/${condo.id}/units/${unit.id}/charges`,
      ownerHeaders,
    );
    assertEquals(r.status, 200);
    const periods = (r.body.data as Array<{ competencePeriod: string }>)
      .map((c) => String(c.competencePeriod).slice(0, 7));
    assertEquals(periods, ["2026-03"]);
  });

  it("admin no portal continua a ver a fração toda", async () => {
    const r = await getJson(
      `/v1/portal/condominiums/${condo.id}/units/${unit.id}/charges`,
      MASTER,
    );
    assertEquals(r.status, 200);
    assertEquals((r.body.data as unknown[]).length, 2);
  });

  it("comprador com início futuro ainda não entra no portal", async () => {
    const r = await getJson(
      `/v1/portal/condominiums/${condo.id}/units/${futureUnit.id}`,
      buyerHeaders,
    );
    assertEquals(r.status, 404);
  });
});
