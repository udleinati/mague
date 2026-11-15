import { assertEquals, assertRejects } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { ApiError, Client } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";
import { type ScenarioFixture, seedScenario } from "./_helpers/fixtures.ts";

const BASE_URL = "http://localhost:3000";
const client = new Client({ baseUrl: BASE_URL });
const MASTER = await loginAsSuper();

describe("admin suppliers", () => {
  let fx: ScenarioFixture;
  let supplierId = "";

  it("setup - create condominium", async () => {
    fx = await seedScenario(client, MASTER)
      .withCondo("Supplier Test Condo")
      .build();
  });

  const hdr = () => fx.hdr();

  it("list - empty returns []", async () => {
    const { data, status } = await client.admin.listSuppliers({ headers: hdr() });
    assertEquals(status, 200);
    assertEquals(data, []);
  });

  it("create - missing name returns 400", async () => {
    const e = await assertRejects(
      () => client.admin.createSupplier({}, { headers: hdr() }),
      ApiError,
    );
    assertEquals(e.statusCode, 400);
  });

  it("create - valid payload returns 201", async () => {
    const { data, status } = await client.admin.createSupplier(
      { name: "Limpezas XPTO", nif: "500123456", contactEmail: "xpto@example.pt" },
      { headers: hdr() },
    );
    assertEquals(status, 201);
    assertEquals(data.name, "Limpezas XPTO");
    assertEquals(data.nif, "500123456");
    supplierId = data.id as string;
  });

  it("list - returns created supplier", async () => {
    const { data } = await client.admin.listSuppliers({ headers: hdr() });
    assertEquals(data.length, 1);
    assertEquals(data[0].id, supplierId);
  });

  it("get - returns supplier", async () => {
    const { data, status } = await client.admin.getSupplier(supplierId, { headers: hdr() });
    assertEquals(status, 200);
    assertEquals(data.id, supplierId);
  });

  it("get - non-existent returns 404", async () => {
    const e = await assertRejects(
      () => client.admin.getSupplier("00000000000000000000000", { headers: hdr() }),
      ApiError,
    );
    assertEquals(e.statusCode, 404);
  });

  it("update - partial update returns 200", async () => {
    const { data, status } = await client.admin.updateSupplier(
      supplierId,
      { contactPhone: "+351 912345678", notes: "Contrato 2026" },
      { headers: hdr() },
    );
    assertEquals(status, 200);
    assertEquals(data.contactPhone, "+351 912345678");
    assertEquals(data.notes, "Contrato 2026");
  });

  it("update - toggle isActive false", async () => {
    const { data } = await client.admin.updateSupplier(
      supplierId,
      { isActive: false },
      { headers: hdr() },
    );
    assertEquals(data.isActive, false);
  });

  // ── match_keywords: pre-seleção na reconciliação ─────────────────────
  it("create - supplier with matchKeywords persists the array", async () => {
    const { data, status } = await client.admin.createSupplier(
      { name: "EDP Comercial", matchKeywords: ["EDP", "ELECTRICIDADE"] },
      { headers: hdr() },
    );
    assertEquals(status, 201);
    assertEquals(
      (data as unknown as { matchKeywords: string[] }).matchKeywords,
      ["EDP", "ELECTRICIDADE"],
    );
    // Clean up inline - não queremos que afecte os testes seguintes.
    await client.admin.deleteSupplier(
      (data as unknown as { id: string }).id,
      { headers: hdr() },
    );
  });

  it("update - set matchKeywords + trim/dedup", async () => {
    // Nota: string "" é rejeitada pelo Zod antes do handler. Testamos trim
    // de whitespace + dedup case-sensitive.
    const { data } = await client.admin.updateSupplier(
      supplierId,
      { matchKeywords: ["  Ascensores ", "Ascensores", "ELEVADOR"] },
      { headers: hdr() },
    );
    assertEquals(
      (data as unknown as { matchKeywords: string[] }).matchKeywords,
      ["Ascensores", "ELEVADOR"],
    );
  });

  it("update - matchKeywords with > 30 entries returns 400", async () => {
    const overLimit = Array.from({ length: 31 }, (_, i) => `kw_${i}`);
    const e = await assertRejects(
      () =>
        client.admin.updateSupplier(
          supplierId,
          { matchKeywords: overLimit },
          { headers: hdr() },
        ),
      ApiError,
    );
    assertEquals(e.statusCode, 400);
  });

  it("update - empty matchKeywords array clears previous values", async () => {
    const { data } = await client.admin.updateSupplier(
      supplierId,
      { matchKeywords: [] },
      { headers: hdr() },
    );
    assertEquals((data as unknown as { matchKeywords: string[] }).matchKeywords, []);
  });

  it("delete - returns 204", async () => {
    const { status } = await client.admin.deleteSupplier(supplierId, { headers: hdr() });
    assertEquals(status, 204);
  });

  it("get - deleted returns 404", async () => {
    const e = await assertRejects(
      () => client.admin.getSupplier(supplierId, { headers: hdr() }),
      ApiError,
    );
    assertEquals(e.statusCode, 404);
  });

  it("teardown - delete condominium", async () => {
    await fx.cleanup();
  });
});
