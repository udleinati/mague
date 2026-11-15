import { assertEquals, assertRejects } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { ApiError, Client, type Condominium, type Unit } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";
import { type ScenarioFixture, seedScenario } from "./_helpers/fixtures.ts";

const BASE_URL = "http://localhost:3000";
const client = new Client({ baseUrl: BASE_URL });

const MASTER_HEADERS = await loginAsSuper();

describe("admin units", () => {
  let fx: ScenarioFixture;
  let createdCondo: Condominium;
  let createdUnit: Unit;

  it("setup - create condominium and unit", async () => {
    fx = await seedScenario(client, MASTER_HEADERS)
      .withCondo("Admin Unit Test Condo")
      .withUnit({
        designation: "Admin Unit A",
        permillage: 100,
        description: "Initial description",
      })
      .build();
    createdCondo = fx.condominium;
    createdUnit = fx.units[0];
  });

  it("listMeUnits - with x-condominium-id returns units", async () => {
    const { data, status } = await client.admin.listUnits({
      headers: { ...MASTER_HEADERS, "x-condominium-id": createdCondo.id },
    });
    assertEquals(status, 200);
    assertEquals(data.length, 1);
    assertEquals(data[0].designation, "Admin Unit A");
  });

  // createUnitForMe vs super.createUnit: o admin endpoint POST
  // /admin/c/:cid/units cria a unit no condo ativo, sem precisar de
  // privilégios super. Usado pelo painel quando o admin do condo adiciona
  // uma fração nova.
  it("createUnitForMe - admin cria unit no proprio condo", async () => {
    const { data, status } = await client.admin.createUnitForMe(
      {
        designation: "Admin Unit B (via /admin)",
        permillage: 50,
        description: "Created via createUnitForMe",
      },
      { headers: { ...MASTER_HEADERS, "x-condominium-id": createdCondo.id } },
    );
    assertEquals(status, 201);
    assertEquals(data.designation, "Admin Unit B (via /admin)");
    // permillage vem como decimal serializado ("50.000").
    assertEquals(parseFloat(String(data.permillage)), 50);

    // Confirma que apareceu na listagem.
    const { data: list } = await client.admin.listUnits({
      headers: { ...MASTER_HEADERS, "x-condominium-id": createdCondo.id },
    });
    assertEquals(list.length, 2);
  });

  // Balance embebido na resposta (via view v_unit_balance). Sem charges,
  // tudo a zero. Não requer chamada separada a /bank-accounts/balances.
  it("listMeUnits - payload inclui balance por fração", async () => {
    const { data } = await client.admin.listUnits({
      headers: { ...MASTER_HEADERS, "x-condominium-id": createdCondo.id },
    });
    const u = data[0] as {
      balance?: {
        openDebtCents: number;
        openCreditCents: number;
        overdueDebtCents: number;
        netCents: number;
      };
    };
    assertEquals(typeof u.balance, "object");
    assertEquals(u.balance!.openDebtCents, 0);
    assertEquals(u.balance!.openCreditCents, 0);
    assertEquals(u.balance!.overdueDebtCents, 0);
    assertEquals(u.balance!.netCents, 0);
  });

  // Balance também aparece no getUnit individual.
  it("getMeUnit - payload inclui balance", async () => {
    const { data } = await client.admin.getUnit(createdUnit.id, {
      headers: { ...MASTER_HEADERS, "x-condominium-id": createdCondo.id },
    });
    const u = data as { balance?: { openDebtCents: number; netCents: number } };
    assertEquals(typeof u.balance, "object");
    assertEquals(u.balance!.openDebtCents, 0);
    assertEquals(u.balance!.netCents, 0);
  });

  it("listMeUnits - non-existent condominium returns empty array", async () => {
    const { data, status } = await client.admin.listUnits({
      headers: { ...MASTER_HEADERS, "x-condominium-id": "00000000000000000000000" },
    });
    assertEquals(status, 200);
    assertEquals(data, []);
  });

  it("getMeUnit - with x-condominium-id returns unit", async () => {
    const { data, status } = await client.admin.getUnit(createdUnit.id, {
      headers: { ...MASTER_HEADERS, "x-condominium-id": createdCondo.id },
    });
    assertEquals(status, 200);
    assertEquals(data.id, createdUnit.id);
    assertEquals(data.designation, "Admin Unit A");
  });

  it("getMeUnit - non-existent unit returns 404", async () => {
    const error = await assertRejects(
      () =>
        client.admin.getUnit("00000000000000000000000", {
          headers: { ...MASTER_HEADERS, "x-condominium-id": createdCondo.id },
        }),
      ApiError,
    );
    assertEquals(error.statusCode, 404);
  });

  it("getMeUnit - unit from different condominium returns 404", async () => {
    const { data: otherCondo } = await client.super.createCondominium(
      { name: "Other Condo" },
      { headers: MASTER_HEADERS },
    );

    const error = await assertRejects(
      () =>
        client.admin.getUnit(createdUnit.id, {
          headers: { ...MASTER_HEADERS, "x-condominium-id": otherCondo.id },
        }),
      ApiError,
    );
    assertEquals(error.statusCode, 404);

    await client.super.deleteCondominium(otherCondo.id, { headers: MASTER_HEADERS });
  });

  it("updateMeUnit - update description returns 200", async () => {
    const { data, status } = await client.admin.updateUnitDescription(
      createdUnit.id,
      { description: "Updated description" },
      { headers: { ...MASTER_HEADERS, "x-condominium-id": createdCondo.id } },
    );
    assertEquals(status, 200);
    assertEquals(data.description, "Updated description");
  });

  it("updateMeUnit - clear description with null returns 200", async () => {
    const { data, status } = await client.admin.updateUnitDescription(
      createdUnit.id,
      { description: null },
      { headers: { ...MASTER_HEADERS, "x-condominium-id": createdCondo.id } },
    );
    assertEquals(status, 200);
    assertEquals(data.description, null);
  });

  it("updateMeUnit - update with designation/floor/door/block is applied", async () => {
    const { data, status } = await client.admin.updateUnitDescription(
      createdUnit.id,
      { designation: "Renamed A", floor: "99", door: "E", block: "B1" },
      { headers: { ...MASTER_HEADERS, "x-condominium-id": createdCondo.id } },
    );
    assertEquals(status, 200);
    assertEquals(data.designation, "Renamed A");
    assertEquals(data.floor, "99");
    assertEquals(data.door, "E");
    assertEquals(data.block, "B1");
  });

  it("updateMeUnit - non-existent unit returns 404", async () => {
    const error = await assertRejects(
      () =>
        client.admin.updateUnitDescription(
          "00000000000000000000000",
          { description: "Test" },
          { headers: { ...MASTER_HEADERS, "x-condominium-id": createdCondo.id } },
        ),
      ApiError,
    );
    assertEquals(error.statusCode, 404);
  });

  // ── match_keywords: pre-seleção na reconciliação ─────────────────────
  it("updateMeUnit - matchKeywords defaults to [] on created unit", async () => {
    const { data } = await client.admin.getUnit(createdUnit.id, {
      headers: { ...MASTER_HEADERS, "x-condominium-id": createdCondo.id },
    });
    assertEquals(
      Array.isArray((data as unknown as { matchKeywords: unknown }).matchKeywords),
      true,
    );
    assertEquals((data as unknown as { matchKeywords: string[] }).matchKeywords.length, 0);
  });

  it("updateMeUnit - set matchKeywords persists the array", async () => {
    const { data, status } = await client.admin.updateUnitDescription(
      createdUnit.id,
      { matchKeywords: ["BEATRIZ LEITAO", "LEITAO GALVAO"] },
      { headers: { ...MASTER_HEADERS, "x-condominium-id": createdCondo.id } },
    );
    assertEquals(status, 200);
    assertEquals(
      (data as unknown as { matchKeywords: string[] }).matchKeywords,
      ["BEATRIZ LEITAO", "LEITAO GALVAO"],
    );
  });

  it("updateMeUnit - matchKeywords trims + dedup entries", async () => {
    // Nota: string "" é rejeitada pelo Zod (z.string().min(1)) **antes**
    // do handler. Aqui testamos trim (whitespace) + dedup case-sensitive.
    const { data } = await client.admin.updateUnitDescription(
      createdUnit.id,
      { matchKeywords: ["  foo  ", "foo", "BAR", "bar"] },
      { headers: { ...MASTER_HEADERS, "x-condominium-id": createdCondo.id } },
    );
    // Esperado após trim + dedup:
    //   "  foo  " → "foo"; "foo" (já existe, remove); "BAR" fica; "bar" fica.
    assertEquals(
      (data as unknown as { matchKeywords: string[] }).matchKeywords,
      ["foo", "BAR", "bar"],
    );
  });

  it("updateMeUnit - matchKeywords com entry vazia rebenta 400", async () => {
    const e = await assertRejects(
      () =>
        client.admin.updateUnitDescription(
          createdUnit.id,
          { matchKeywords: ["valid", ""] },
          { headers: { ...MASTER_HEADERS, "x-condominium-id": createdCondo.id } },
        ),
      ApiError,
    );
    assertEquals(e.statusCode, 400);
  });

  it("updateMeUnit - empty matchKeywords array clears previous values", async () => {
    const { data } = await client.admin.updateUnitDescription(
      createdUnit.id,
      { matchKeywords: [] },
      { headers: { ...MASTER_HEADERS, "x-condominium-id": createdCondo.id } },
    );
    assertEquals((data as unknown as { matchKeywords: string[] }).matchKeywords, []);
  });

  it("updateMeUnit - matchKeywords with > 30 entries returns 400", async () => {
    const overLimit = Array.from({ length: 31 }, (_, i) => `kw_${i}`);
    const e = await assertRejects(
      () =>
        client.admin.updateUnitDescription(
          createdUnit.id,
          { matchKeywords: overLimit },
          { headers: { ...MASTER_HEADERS, "x-condominium-id": createdCondo.id } },
        ),
      ApiError,
    );
    assertEquals(e.statusCode, 400);
  });

  it("updateMeUnit - matchKeywords entry > 100 chars returns 400", async () => {
    const longKw = "a".repeat(101);
    const e = await assertRejects(
      () =>
        client.admin.updateUnitDescription(
          createdUnit.id,
          { matchKeywords: [longKw] },
          { headers: { ...MASTER_HEADERS, "x-condominium-id": createdCondo.id } },
        ),
      ApiError,
    );
    assertEquals(e.statusCode, 400);
  });

  it("updateMeUnit - unit from different condominium returns 404", async () => {
    const { data: otherCondo } = await client.super.createCondominium(
      { name: "Other Condo For Update" },
      { headers: MASTER_HEADERS },
    );

    const error = await assertRejects(
      () =>
        client.admin.updateUnitDescription(
          createdUnit.id,
          { description: "Test" },
          { headers: { ...MASTER_HEADERS, "x-condominium-id": otherCondo.id } },
        ),
      ApiError,
    );
    assertEquals(error.statusCode, 404);

    await client.super.deleteCondominium(otherCondo.id, { headers: MASTER_HEADERS });
  });

  // Regressão: API ordena frações em ordem natural (length asc + alfabético).
  // Antes a API devolvia ASC lexicográfico ("A, AA, AB, B") e cada controller
  // do panel re-ordenava em JS via `compareDesignations`. O helper
  // `unitNaturalOrder` no servidor centraliza essa regra.
  it("listMeUnits - retorna frações em ordem natural (A, B, ..., AA, AB)", async () => {
    // Cria mais 4 unidades para ter mistura de comprimentos.
    for (const designation of ["B", "AA", "AB", "C"]) {
      await client.super.createUnit(
        createdCondo.id,
        { designation, permillage: 100 },
        { headers: MASTER_HEADERS },
      );
    }
    const { data } = await client.admin.listUnits({
      headers: { ...MASTER_HEADERS, "x-condominium-id": createdCondo.id },
    });
    const designations = data.map((u) => u.designation);
    // A unit pré-existente "Admin Unit A" tem comprimento 12 - vai ao fim.
    // Importante: 1-char (B, C) antes de 2-char (AA, AB) antes do nome longo.
    assertEquals(designations[0], "B");
    assertEquals(designations[1], "C");
    assertEquals(designations[2], "AA");
    assertEquals(designations[3], "AB");
    // E garantir que NÃO sai em ordem lexicográfica pura (que daria
    // "AA, AB, Admin Unit A, B, C").
    const idxAA = designations.indexOf("AA");
    const idxB = designations.indexOf("B");
    assertEquals(idxB < idxAA, true);
  });

  it("teardown - delete unit and condominium", async () => {
    // Apaga todas as unidades do condomínio (não só a primeira) para evitar
    // FK errors na exclusão do condomínio.
    const { data: allUnits } = await client.admin.listUnits({
      headers: { ...MASTER_HEADERS, "x-condominium-id": createdCondo.id },
    });
    for (const u of allUnits) {
      await client.super.deleteUnit(createdCondo.id, u.id, {
        headers: MASTER_HEADERS,
      });
    }
    await client.super.deleteCondominium(createdCondo.id, {
      headers: MASTER_HEADERS,
    });
  });
});
