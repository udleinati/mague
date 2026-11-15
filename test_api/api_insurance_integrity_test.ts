// Integridade do módulo de seguros:
//   • portal confirm fora de pending_review → 422 e datas intactas;
//   • upload de um ocupante não apaga o draft de outro (ADR 0017: proprietário e
//     inquilino coexistem);
//   • delete de apólice com sucessora → 409 de domínio (não o 23503 cru).
//
// Nota operacional: exigem a BD seeded + servidor (não correm contra a BD de
// trabalho - `test:up` recria a BD de desenvolvimento).

import { assertEquals, assertRejects } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { ApiError, Client, type Condominium, type Unit } from "$shared/client/mod.ts";
import { loginAs, loginAsSuper } from "./_helpers/auth.ts";
import { seedTestUser, sqlExec } from "./_helpers/db.ts";

const BASE_URL = "http://localhost:3000";
const client = new Client({ baseUrl: BASE_URL });

/** Data ISO (YYYY-MM-DD) a `n` dias de hoje (negativo = passado). */
function isoDay(n: number): string {
  return new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
}

/** PDF mínimo: passa os magic bytes; o OCR falha e é best-effort. */
function fakePdf(name: string): File {
  return new File([new TextEncoder().encode("%PDF-1.4\ntrailer\n<<>>\n%%EOF\n")], name, {
    type: "application/pdf",
  });
}

describe("seguros - integridade (confirm gate, coexistência, linhagem)", () => {
  const ts = Date.now();
  let auth: { Authorization: string };
  let condo: Condominium;
  let unit: Unit;
  let adminHdr: Record<string, string>;
  let aliceUid = "";
  let bobUid = "";
  let alicePortalHdr: Record<string, string>;
  let bobPortalHdr: Record<string, string>;

  /** Liga um user novo à fração como ocupante e devolve os headers do portal. */
  async function seedOccupant(
    label: string,
    relationship: "owner" | "tenant",
  ): Promise<{ userId: string; headers: Record<string, string> }> {
    const email = `${label}-integ-${ts}@example.pt`;
    const userId = await seedTestUser({ email, password: "test12345", name: label, active: true });
    const occupantId = (await sqlExec(`
      INSERT INTO core.occupant (user_id, name, email, condominium_id)
      VALUES ('${userId}', '${label}', '${email}', '${condo.id}')
      RETURNING id`)).split("\n")[0].trim();
    await sqlExec(`
      INSERT INTO core.unit_occupant (unit_id, occupant_id, relationship_type, start_date)
      VALUES ('${unit.id}', '${occupantId}', '${relationship}', CURRENT_DATE);
    `);
    const headers = await loginAs(email, "test12345");
    return { userId, headers: { ...headers, "x-condominium-id": condo.id } };
  }

  /** Cria uma apólice via SQL (o admin não tem caminho de upload - ADR 0016). */
  async function makePolicy(args: {
    id: string;
    status: string;
    validFrom: string;
    validTo: string;
    uploaderUserId: string;
    renewedFromId?: string;
  }): Promise<string> {
    const uploader = JSON.stringify({ user_id: args.uploaderUserId });
    const renewedFrom = args.renewedFromId ? `'${args.renewedFromId}'` : "NULL";
    return (await sqlExec(`
      INSERT INTO core.insurance_policy
        (id, condominium_id, unit_id, status, valid_from, valid_to, uploaded_by, renewed_from_id)
      VALUES ('${args.id}', '${condo.id}', '${unit.id}', '${args.status}',
              '${args.validFrom}', '${args.validTo}', '${uploader}'::jsonb, ${renewedFrom})
      RETURNING id`)).split("\n")[0].trim();
  }

  it("setup: condo + fração com proprietário (alice) e inquilino (bob)", async () => {
    auth = await loginAsSuper();
    condo = (await client.super.createCondominium(
      { name: `Seguros Integridade ${ts}` },
      { headers: auth },
    )).data;
    unit = (await client.super.createUnit(
      condo.id,
      { designation: "A1", permillage: 1000 } as Record<string, unknown>,
      { headers: auth },
    )).data;
    adminHdr = { ...auth, "x-condominium-id": condo.id };

    const alice = await seedOccupant("alice", "owner");
    aliceUid = alice.userId;
    alicePortalHdr = alice.headers;
    const bob = await seedOccupant("bob", "tenant");
    bobUid = bob.userId;
    bobPortalHdr = bob.headers;
  });

  // ── A1: o confirm do portal não reescreve uma apólice já aprovada ──────

  it("portal confirm numa apólice active → 422 e as datas não mudam", async () => {
    // WHY: sem gate de estado, o condómino estende `validTo` de uma apólice já
    // aprovada e mantém a fração "coberta" indefinidamente sem nova revisão.
    const id = await makePolicy({
      id: `pol_conf_act_${ts}`,
      status: "active",
      validFrom: isoDay(-30),
      validTo: isoDay(30),
      uploaderUserId: aliceUid,
    });

    const e = await assertRejects(
      () =>
        client.portal.confirmInsurancePolicy(unit.id, id, {
          validFrom: isoDay(-30),
          validTo: isoDay(3650),
          policyNumber: "POL-ESTICADA",
          insurer: "Seguradora Falsa",
        }, { headers: alicePortalHdr }),
      ApiError,
    );
    assertEquals(e.statusCode, 422);

    // A recusa tem de ser antes do UPDATE - nenhum campo pode ter passado.
    const { data: after } = await client.portal.getInsurancePolicy(unit.id, id, {
      headers: alicePortalHdr,
    });
    assertEquals((after as { validTo?: string }).validTo, isoDay(30));
    assertEquals((after as { policyNumber?: string | null }).policyNumber, null);
    assertEquals((after as { status?: string }).status, "active");
  });

  it("portal confirm em pending_review continua a passar", async () => {
    // Guarda contra um gate demasiado apertado: o caminho normal tem de viver.
    const id = await makePolicy({
      id: `pol_conf_pend_${ts}`,
      status: "pending_review",
      validFrom: isoDay(-1),
      validTo: isoDay(364),
      uploaderUserId: aliceUid,
    });
    const { data } = await client.portal.confirmInsurancePolicy(unit.id, id, {
      validFrom: isoDay(-1),
      validTo: isoDay(364),
      policyNumber: "POL-OK",
      insurer: "Fidelidade",
    }, { headers: alicePortalHdr });
    assertEquals((data as { policyNumber?: string }).policyNumber, "POL-OK");
    assertEquals((data as { status?: string }).status, "pending_review");
  });

  // ── A3: submissões de ocupantes diferentes coexistem ───────────────────

  it("upload do bob não apaga o draft pending_review da alice", async () => {
    // WHY: ADR 0017 - proprietário e inquilino têm apólices independentes. A
    // limpeza de drafts só pode apanhar re-submissões do mesmo uploader.
    const aliceDraft = await makePolicy({
      id: `pol_draft_alice_${ts}`,
      status: "pending_review",
      validFrom: isoDay(-1),
      validTo: isoDay(364),
      uploaderUserId: aliceUid,
    });

    const { data: bobPolicy } = await client.portal.uploadInsurancePolicy(
      unit.id,
      fakePdf("bob.pdf"),
      "bob.pdf",
      { headers: bobPortalHdr },
    );
    const bobFirstId = String((bobPolicy as { id?: string }).id);

    const survivors = await sqlExec(
      `SELECT id FROM core.insurance_policy WHERE id = '${aliceDraft}'`,
    );
    assertEquals(survivors.trim(), aliceDraft);

    // ... mas a re-submissão do próprio bob substitui o draft dele.
    await client.portal.uploadInsurancePolicy(
      unit.id,
      fakePdf("bob-v2.pdf"),
      "bob-v2.pdf",
      { headers: bobPortalHdr },
    );
    const bobOld = await sqlExec(
      `SELECT count(*) FROM core.insurance_policy WHERE id = '${bobFirstId}'`,
    );
    assertEquals(bobOld.trim(), "0");
  });

  // ── A6: linhagem traduzida para linguagem de domínio ───────────────────

  it("admin delete de apólice com sucessora → 409 (não 500 do FK)", async () => {
    // WHY: o ON DELETE RESTRICT de `renewed_from_id` sairia como UNEXPECTED_ERROR e
    // o admin não saberia que tem de apagar a renovação primeiro.
    const predecessor = await makePolicy({
      id: `pol_pred_${ts}`,
      status: "superseded",
      validFrom: isoDay(-380),
      validTo: isoDay(-15),
      uploaderUserId: aliceUid,
    });
    await makePolicy({
      id: `pol_succ_${ts}`,
      status: "active",
      validFrom: isoDay(-15),
      validTo: isoDay(350),
      uploaderUserId: aliceUid,
      renewedFromId: predecessor,
    });

    const e = await assertRejects(
      () => client.admin.deleteInsurancePolicy(predecessor, { headers: adminHdr }),
      ApiError,
    );
    assertEquals(e.statusCode, 409);

    // Continua lá: o 409 é uma recusa, não um delete parcial.
    const still = await sqlExec(
      `SELECT count(*) FROM core.insurance_policy WHERE id = '${predecessor}'`,
    );
    assertEquals(still.trim(), "1");
  });

  it("teardown", async () => {
    // Limpa a linhagem antes do DELETE em bloco: ON DELETE RESTRICT bloquearia
    // apagar um predecessor e a sua sucessora na mesma instrução.
    await sqlExec(`
      DELETE FROM core.insurance_reminder WHERE condominium_id='${condo.id}';
      UPDATE core.insurance_policy SET renewed_from_id = NULL WHERE condominium_id='${condo.id}';
      DELETE FROM core.attachment WHERE condominium_id='${condo.id}';
      DELETE FROM core.insurance_policy WHERE condominium_id='${condo.id}';
      DELETE FROM core.unit_occupant WHERE unit_id='${unit.id}';
      DELETE FROM core.occupant WHERE condominium_id='${condo.id}';
      DELETE FROM core.user WHERE id IN ('${aliceUid}', '${bobUid}');
    `);
    await client.super.deleteCondominium(condo.id, { headers: auth });
  });
});
