// Guard ADR 0011: nenhuma resposta JSON da API pode conter chaves ActorSnapshot
// (created_by/updated_by/deleted_by/uploaded_by/confirmed_by/approved_by/
// rejected_by, em snake_case ou camelCase). Scan recursivo sobre endpoints
// representativos, incluindo insurance e assembly attachments.
//
// Cobre também o gate de visibilidade dos anexos de assembleia no portal
// (ADR 0003): assembleia `draft` nunca lista/serve anexos a um occupant.

import { assertEquals, assertExists } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { Client, type Condominium, type Unit } from "$shared/client/mod.ts";
import { loginAs, loginAsSuper } from "./_helpers/auth.ts";
import { seedTestUser, sqlExec } from "./_helpers/db.ts";

const BASE_URL = "http://localhost:3000";
const client = new Client({ baseUrl: BASE_URL });
const MASTER = await loginAsSuper();

const FORBIDDEN = new Set([
  "created_by",
  "updated_by",
  "deleted_by",
  "uploaded_by",
  "confirmed_by",
  "approved_by",
  "rejected_by",
  "createdBy",
  "updatedBy",
  "deletedBy",
  "uploadedBy",
  "confirmedBy",
  "approvedBy",
  "rejectedBy",
]);

/** Percorre o JSON e devolve os paths onde aparece uma chave proibida. */
function findActorLeaks(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => findActorLeaks(v, `${path}[${i}]`));
  }
  if (value && typeof value === "object") {
    const leaks: string[] = [];
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN.has(k)) leaks.push(`${path}.${k}`);
      leaks.push(...findActorLeaks(v, `${path}.${k}`));
    }
    return leaks;
  }
  return [];
}

async function getJson(path: string, headers: Record<string, string>) {
  const resp = await fetch(`${BASE_URL}${path}`, { headers });
  const text = await resp.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch { /* deixa como texto */ }
  return { status: resp.status, body };
}

function assertNoLeaks(label: string, status: number, body: unknown) {
  assertEquals(status, 200, `${label}: esperado 200, veio ${status}`);
  const leaks = findActorLeaks(body);
  assertEquals(leaks, [], `${label}: ActorSnapshot exposto em ${leaks.join(", ")}`);
}

describe("guard ADR 0011 - respostas sem ActorSnapshots + draft assembly IDOR", () => {
  let condo: Condominium;
  let unit: Unit;
  let policyId = "";
  let heldAssemblyId = "";
  let draftAssemblyId = "";
  let draftAttachmentId = "";
  let aliceHeaders: { Authorization: string };
  const RICH_ACTOR =
    `'{"user_id":"adm","email":"admin@leak.pt","ip":"10.9.9.9","user_agent":"UA"}'::jsonb`;

  it("setup: condo + unit + occupant + policy + assemblies com anexos", async () => {
    const ts = Date.now();
    condo = (await client.super.createCondominium(
      { name: `Actor Leak Guard ${ts}` },
      { headers: MASTER },
    )).data;
    unit = (await client.super.createUnit(
      condo.id,
      { designation: "A1", permillage: 1000 },
      { headers: MASTER },
    )).data;

    // Occupant autenticável (portal).
    const aliceEmail = `alice-leak-${ts}@example.pt`;
    const aliceUid = await seedTestUser({
      email: aliceEmail,
      password: "test12345",
      name: "Alice Leak",
      active: true,
    });
    const aliceOcc = (await sqlExec(`
      INSERT INTO core.occupant (user_id,name,email,condominium_id)
      VALUES ('${aliceUid}','Alice Leak','${aliceEmail}','${condo.id}')
      RETURNING id`)).split("\n")[0].trim();
    await sqlExec(`
      INSERT INTO core.unit_occupant (unit_id,occupant_id,relationship_type,start_date)
      VALUES ('${unit.id}','${aliceOcc}','owner',CURRENT_DATE);
    `);
    aliceHeaders = await loginAs(aliceEmail, "test12345");

    // Policy com TODOS os actor snapshots preenchidos com PII rica.
    policyId = (await sqlExec(`
      INSERT INTO core.insurance_policy (
        condominium_id, unit_id, valid_from, valid_to, status,
        uploaded_by, confirmed_by, confirmed_at, approved_by, approved_at,
        created_by, updated_by
      ) VALUES (
        '${condo.id}', '${unit.id}', '2026-01-01', '2027-01-01', 'active',
        ${RICH_ACTOR}, ${RICH_ACTOR}, now(), ${RICH_ACTOR}, now(),
        ${RICH_ACTOR}, ${RICH_ACTOR}
      ) RETURNING id`)).split("\n")[0].trim();
    assertExists(policyId);

    // Assembleia pública (held) + draft, cada uma com um anexo (metadata SQL;
    // bytes S3 não são precisos para list).
    heldAssemblyId = (await sqlExec(`
      INSERT INTO core.assembly (condominium_id, type, scheduled_at, status, created_by)
      VALUES ('${condo.id}', 'ordinary', now(), 'held', ${RICH_ACTOR})
      RETURNING id`)).split("\n")[0].trim();
    draftAssemblyId = (await sqlExec(`
      INSERT INTO core.assembly (condominium_id, type, scheduled_at, status, created_by)
      VALUES ('${condo.id}', 'ordinary', now(), 'draft', ${RICH_ACTOR})
      RETURNING id`)).split("\n")[0].trim();
    await sqlExec(`
      INSERT INTO core.attachment (condominium_id, entity_type, entity_id, filename,
        mime_type, storage_key, file_size, created_by)
      VALUES ('${condo.id}', 'assembly', '${heldAssemblyId}', 'ata.pdf',
        'application/pdf', 'test/leak-held-${ts}.pdf', 100, ${RICH_ACTOR});
    `);
    draftAttachmentId = (await sqlExec(`
      INSERT INTO core.attachment (condominium_id, entity_type, entity_id, filename,
        mime_type, storage_key, file_size, created_by)
      VALUES ('${condo.id}', 'assembly', '${draftAssemblyId}', 'rascunho.pdf',
        'application/pdf', 'test/leak-draft-${ts}.pdf', 100, ${RICH_ACTOR})
      RETURNING id`)).split("\n")[0].trim();
  });

  it("admin: insurance list/retrieve/units-status sem actor keys", async () => {
    const admin = `/v1/admin/condominiums/${condo.id}`;
    for (
      const path of [
        `${admin}/insurance`,
        `${admin}/insurance/${policyId}`,
        `${admin}/insurance/units-status`,
      ]
    ) {
      const { status, body } = await getJson(path, MASTER);
      assertNoLeaks(path, status, body);
    }
  });

  it("admin: sweep de listagens representativas sem actor keys", async () => {
    const admin = `/v1/admin/condominiums/${condo.id}`;
    for (
      const path of [
        `${admin}/units`,
        `${admin}/charges`,
        `${admin}/assemblies`,
        `${admin}/assemblies/${heldAssemblyId}/attachments`,
      ]
    ) {
      const { status, body } = await getJson(path, MASTER);
      assertNoLeaks(path, status, body);
    }
  });

  it("portal: insurance list/retrieve sem actor keys (occupant)", async () => {
    const portal = `/v1/portal/condominiums/${condo.id}/units/${unit.id}`;
    for (
      const path of [
        `${portal}/insurance`,
        `${portal}/insurance/${policyId}`,
      ]
    ) {
      const { status, body } = await getJson(path, aliceHeaders);
      assertNoLeaks(path, status, body);
    }
  });

  it("portal: anexos de assembleia pública listam sem actor keys", async () => {
    const path = `/v1/portal/condominiums/${condo.id}/assemblies/${heldAssemblyId}/attachments`;
    const { status, body } = await getJson(path, aliceHeaders);
    assertNoLeaks(path, status, body);
  });

  it("portal: assembleia draft não lista nem serve anexos (404, ADR 0003)", async () => {
    const base = `/v1/portal/condominiums/${condo.id}/assemblies/${draftAssemblyId}`;
    const list = await getJson(`${base}/attachments`, aliceHeaders);
    assertEquals(list.status, 404, "list de anexos de draft devia ser 404");
    const serve = await getJson(`${base}/attachments/${draftAttachmentId}`, aliceHeaders);
    assertEquals(serve.status, 404, "serve de anexo de draft devia ser 404");
  });

  it("admin continua a ver anexos da draft (só o portal é gated)", async () => {
    const path = `/v1/admin/condominiums/${condo.id}/assemblies/${draftAssemblyId}/attachments`;
    const { status, body } = await getJson(path, MASTER);
    assertNoLeaks(path, status, body);
  });
});
