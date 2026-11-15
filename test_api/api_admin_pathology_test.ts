// Contrato HTTP do recurso Pathology (admin). Cobre CRUD, atribuição de code,
// filtro por status, e isolamento multi-tenant.
//
// Pré-requisitos: stack de pé + DB com super@mague.pt. Correr:
//   deno test --allow-net --allow-read --allow-env --allow-run test_api/api_admin_pathology_test.ts

import { assertEquals, assertRejects } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { ApiError, Client } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";
import { type ScenarioFixture, seedScenario } from "./_helpers/fixtures.ts";

const BASE_URL = "http://localhost:3000";
const client = new Client({ baseUrl: BASE_URL });
const MASTER = await loginAsSuper();

describe("admin pathologies", () => {
  let fx: ScenarioFixture;
  let pathologyId = "";
  const hdr = () => fx.hdr();

  it("setup - condo + unit", async () => {
    fx = await seedScenario(client, MASTER)
      .withCondo("Pathology E2E")
      .withUnit({ designation: "A", permillage: 1000 })
      .build();
  });

  it("listPathologies - vazio no início", async () => {
    const { data, status } = await client.admin.listPathologies({}, { headers: hdr() });
    assertEquals(status, 200);
    assertEquals(data, []);
  });

  it("createPathology - title vazio → 400", async () => {
    const e = await assertRejects(
      () => client.admin.createPathology({ title: "", category: "crack" }, { headers: hdr() }),
      ApiError,
    );
    assertEquals(e.statusCode, 400);
  });

  it("createPathology - válida → 201, status draft e code P###", async () => {
    const { data, status } = await client.admin.createPathology(
      { title: "Fissura fachada norte", category: "crack", unitIds: [fx.units[0].id] },
      { headers: hdr() },
    );
    assertEquals(status, 201);
    assertEquals(data.category, "crack");
    assertEquals(data.status, "draft"); // default do schema
    assertEquals(/^P[0-9A-Z]{3,}$/.test(data.code), true); // code humano auto-atribuído
    pathologyId = data.id;
  });

  it("getPathology - 200", async () => {
    const { data, status } = await client.admin.getPathology(pathologyId, { headers: hdr() });
    assertEquals(status, 200);
    assertEquals(data.id, pathologyId);
  });

  it("updatePathology - transição de status para identified", async () => {
    const { data } = await client.admin.updatePathology(
      pathologyId,
      { status: "identified" },
      { headers: hdr() },
    );
    assertEquals(data.status, "identified");
  });

  it("listPathologies - filtro por status devolve a patologia", async () => {
    const { data } = await client.admin.listPathologies(
      { status: "identified" },
      { headers: hdr() },
    );
    assertEquals(data.some((p) => p.id === pathologyId), true);
  });

  it("getPathology - id inexistente → 404", async () => {
    const e = await assertRejects(
      () => client.admin.getPathology("nao_existe", { headers: hdr() }),
      ApiError,
    );
    assertEquals(e.statusCode, 404);
  });

  it("cross-tenant - outro condo não vê esta patologia → 404", async () => {
    const fxB = await seedScenario(client, MASTER).withCondo("Pathology E2E B").build();
    const e = await assertRejects(
      () => client.admin.getPathology(pathologyId, { headers: fxB.hdr() }),
      ApiError,
    );
    assertEquals(e.statusCode, 404);
    await fxB.cleanup();
  });

  it("deletePathology - some da listagem", async () => {
    await client.admin.deletePathology(pathologyId, { headers: hdr() });
    const { data } = await client.admin.listPathologies({}, { headers: hdr() });
    assertEquals(data.some((p) => p.id === pathologyId), false);
  });

  it("cleanup", async () => {
    await fx.cleanup();
  });
});
