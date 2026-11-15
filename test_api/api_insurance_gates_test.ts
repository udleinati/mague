// Gates de seguros do PRD #7 / ADR 0040 - wiring dos handlers (admin + portal):
//   • admin renew: vencida <= 1 ano renova (com renewed_from_id); > 1 ano → 422.
//   • admin delete: vencida → ok; ativa saudável → 422 (rejeitar primeiro).
//   • portal: anexar em vencida → 422; remover anexo de ativa → 403;
//     apagar própria por confirmar → 204; confirmada → 422; de outrem → 403.
//
// Estes testes confirmam que os handlers chamam os predicados puros e devolvem os
// códigos HTTP corretos end-to-end. Predicados isolados: policy_status_test.ts.
// Nota operacional: exigem a BD seeded + servidor (não correm contra a BD de
// trabalho - `test:up` recria a BD de desenvolvimento).

import { assertEquals, assertExists, assertRejects } from "@std/assert";
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

/** PDF mínimo válido (header + EOF) - passa o `validateAttachmentMime`. */
const MIN_PDF_BYTES = new Uint8Array([
  0x25,
  0x50,
  0x44,
  0x46,
  0x2D,
  0x31,
  0x2E,
  0x34,
  0x0A,
  0x25,
  0x25,
  0x45,
  0x4F,
  0x46,
  0x0A,
]);

describe("seguros gates (ADR 0040) - renovação, congelamento, autoridade de eliminação", () => {
  const ts = Date.now();
  let auth: { Authorization: string };
  let aliceHeaders: { Authorization: string };
  let aliceUid = "";
  let condo: Condominium;
  let unit: Unit;
  let adminHdr: Record<string, string>;
  let portalHdr: Record<string, string>;

  /** Cria uma apólice via SQL e devolve o id. uploader default = alice. */
  async function makePolicy(args: {
    id: string;
    status: string;
    validFrom: string;
    validTo: string;
    confirmedAt?: boolean;
    uploaderUserId?: string;
  }): Promise<string> {
    const uploader = JSON.stringify({ user_id: args.uploaderUserId ?? aliceUid });
    const confirmed = args.confirmedAt ? "now()" : "NULL";
    return (await sqlExec(`
      INSERT INTO core.insurance_policy
        (id, condominium_id, unit_id, status, valid_from, valid_to, confirmed_at, uploaded_by)
      VALUES ('${args.id}', '${condo.id}', '${unit.id}', '${args.status}',
              '${args.validFrom}', '${args.validTo}', ${confirmed}, '${uploader}'::jsonb)
      RETURNING id`)).split("\n")[0].trim();
  }

  it("setup: condo + unit + owner (alice) com acesso ao portal", async () => {
    auth = await loginAsSuper();
    condo = (await client.super.createCondominium(
      { name: `Seguros Gates ${ts}` },
      { headers: auth },
    )).data;
    unit = (await client.super.createUnit(
      condo.id,
      { designation: "A1", permillage: 1000 } as Record<string, unknown>,
      { headers: auth },
    )).data;
    adminHdr = { ...auth, "x-condominium-id": condo.id };

    const aliceEmail = `alice-seg-${ts}@example.pt`;
    aliceUid = await seedTestUser({
      email: aliceEmail,
      password: "test12345",
      name: "Alice Seguros",
      active: true,
    });
    const aliceOcc = (await sqlExec(`
      INSERT INTO core.occupant (user_id, name, email, condominium_id)
      VALUES ('${aliceUid}', 'Alice Seguros', '${aliceEmail}', '${condo.id}')
      RETURNING id`)).split("\n")[0].trim();
    await sqlExec(`
      INSERT INTO core.unit_occupant (unit_id, occupant_id, relationship_type, start_date)
      VALUES ('${unit.id}', '${aliceOcc}', 'owner', CURRENT_DATE);
    `);
    aliceHeaders = await loginAs(aliceEmail, "test12345");
    portalHdr = { ...aliceHeaders, "x-condominium-id": condo.id };
  });

  // ── Admin renew: janela de 1 ano + linhagem ────────────────────────────

  it("admin renew: vencida há 100 dias → 201, nova active presumida com renewedFromId", async () => {
    // WHY: tratar precisamente as que falharam há pouco, registando continuidade.
    const oldId = await makePolicy({
      id: `pol_ren_ok_${ts}`,
      status: "active",
      validFrom: isoDay(-465),
      validTo: isoDay(-100),
    });
    const { data, status } = await client.admin.renewInsurancePolicy(oldId, { headers: adminHdr });
    assertEquals(status, 201);
    assertEquals((data as { renewedFromId?: string }).renewedFromId, oldId);
    assertEquals((data as { status?: string }).status, "active");
    assertExists((data as { presumedAt?: string }).presumedAt);

    // A antiga passou a superseded (linhagem navegável).
    const { data: oldNow } = await client.admin.getInsurancePolicy(oldId, { headers: adminHdr });
    assertEquals((oldNow as { status?: string }).status, "superseded");
  });

  it("admin renew: vencida há 400 dias → 422 (continuidade nasceria já vencida)", async () => {
    const oldId = await makePolicy({
      id: `pol_ren_old_${ts}`,
      status: "active",
      validFrom: isoDay(-765),
      validTo: isoDay(-400),
    });
    const e = await assertRejects(
      () => client.admin.renewInsurancePolicy(oldId, { headers: adminHdr }),
      ApiError,
    );
    assertEquals(e.statusCode, 422);
  });

  // ── Admin delete: cobertura viva exige rejeitar primeiro ───────────────

  it("admin delete: vencida → 204 (sem cobertura viva)", async () => {
    const id = await makePolicy({
      id: `pol_del_exp_${ts}`,
      status: "active",
      validFrom: isoDay(-380),
      validTo: isoDay(-15),
    });
    const { status } = await client.admin.deleteInsurancePolicy(id, { headers: adminHdr });
    assertEquals(status, 204);
  });

  it("admin delete: ativa saudável → 422 (rejeitar primeiro)", async () => {
    const id = await makePolicy({
      id: `pol_del_act_${ts}`,
      status: "active",
      validFrom: isoDay(-30),
      validTo: isoDay(330),
    });
    const e = await assertRejects(
      () => client.admin.deleteInsurancePolicy(id, { headers: adminHdr }),
      ApiError,
    );
    assertEquals(e.statusCode, 422);
  });

  // ── Portal: congelamento de anexos ─────────────────────────────────────

  it("portal add attachment: apólice vencida → 422 (congelada, renovar)", async () => {
    const id = await makePolicy({
      id: `pol_att_exp_${ts}`,
      status: "active",
      validFrom: isoDay(-380),
      validTo: isoDay(-5),
    });
    const file = new File([new Uint8Array([1, 2, 3])], "x.pdf", { type: "application/pdf" });
    const e = await assertRejects(
      () => client.portal.addInsurancePolicyAttachment(unit.id, id, file, { headers: portalHdr }),
      ApiError,
    );
    assertEquals(e.statusCode, 422);
  });

  it("portal remove attachment: apólice ativa → 403 (não despir evidência aprovada)", async () => {
    // O gate dispara antes de procurar o ficheiro - o attachmentId pode ser fictício.
    const id = await makePolicy({
      id: `pol_att_act_${ts}`,
      status: "active",
      validFrom: isoDay(-30),
      validTo: isoDay(330),
    });
    const e = await assertRejects(
      () =>
        client.portal.deleteInsurancePolicyAttachment(unit.id, id, "att_ficticio", {
          headers: portalHdr,
        }),
      ApiError,
    );
    assertEquals(e.statusCode, 403);
  });

  // ── Portal: autoridade de eliminação ───────────────────────────────────

  it("portal delete: própria por confirmar → 204 (limpar engano antes da fila)", async () => {
    const id = await makePolicy({
      id: `pol_pdel_own_${ts}`,
      status: "pending_review",
      validFrom: isoDay(-1),
      validTo: isoDay(364),
    });
    const { status } = await client.portal.deleteInsurancePolicy(unit.id, id, {
      headers: portalHdr,
    });
    assertEquals(status, 204);
  });

  it("portal delete: própria já confirmada → 422 (eliminação é da administração)", async () => {
    const id = await makePolicy({
      id: `pol_pdel_conf_${ts}`,
      status: "pending_review",
      validFrom: isoDay(-1),
      validTo: isoDay(364),
      confirmedAt: true,
    });
    const e = await assertRejects(
      () => client.portal.deleteInsurancePolicy(unit.id, id, { headers: portalHdr }),
      ApiError,
    );
    assertEquals(e.statusCode, 422);
  });

  it("portal delete: por confirmar mas de outro uploader → 403", async () => {
    const id = await makePolicy({
      id: `pol_pdel_other_${ts}`,
      status: "pending_review",
      validFrom: isoDay(-1),
      validTo: isoDay(364),
      uploaderUserId: "outro_user_qualquer",
    });
    const e = await assertRejects(
      () => client.portal.deleteInsurancePolicy(unit.id, id, { headers: portalHdr }),
      ApiError,
    );
    assertEquals(e.statusCode, 403);
  });

  // ── Portal: a fração renova a sua apólice ──────────────────────────────
  //
  // WHY: a renovação era exclusiva do admin, que a criava presumida e perseguia
  // o comprovativo. Numa renovação tácita quem tem o papel (o recibo) é a
  // fração - faltava-lhe a porta para o entregar sem submeter tudo de novo.

  it("portal renew: com recibo cria a renovação em revisão, com linhagem e dados herdados", async () => {
    const oldId = await makePolicy({
      id: `pol_pren_${ts}`,
      status: "active",
      validFrom: isoDay(-350),
      validTo: isoDay(15),
    });
    await sqlExec(
      `UPDATE core.insurance_policy
          SET policy_number = 'POL-HERDA', insurer = 'Fidelidade', coverage_amount_cents = 4000000
        WHERE id = '${oldId}'`,
    );
    const recibo = new File([MIN_PDF_BYTES], "recibo.pdf", { type: "application/pdf" });

    const { data, status } = await client.portal.renewInsurancePolicy(
      unit.id,
      oldId,
      recibo,
      { validFrom: isoDay(15), validTo: isoDay(380), coverageAmountCents: "4500000" },
      { headers: portalHdr },
    );
    assertEquals(status, 201);
    const nova = data as Record<string, unknown>;
    assertEquals(nova.renewedFromId, oldId);
    assertEquals(nova.evidenceSource, "unit");
    // Omitidos no formulário: herdam do predecessor.
    assertEquals(nova.policyNumber, "POL-HERDA");
    assertEquals(nova.insurer, "Fidelidade");
    // Enviado: vence a herança.
    assertEquals(nova.coverageAmountCents, 4_500_000);
    // Passo único: a fração confirmou ao submeter, senão o approve recusava.
    assertExists(nova.confirmedAt);
    // Não presume nada e não tira cobertura: a antiga só sai no approve.
    assertEquals(nova.presumedAt, null);
    assertEquals(nova.status, "pending_review");
    const antiga = await sqlExec(
      `SELECT status FROM core.insurance_policy WHERE id = '${oldId}'`,
    );
    assertEquals(antiga.trim(), "active");
  });

  it("portal renew: sem recibo → 400 (presumir sem prova é do admin)", async () => {
    const oldId = await makePolicy({
      id: `pol_pren_semdoc_${ts}`,
      status: "active",
      validFrom: isoDay(-350),
      validTo: isoDay(15),
    });
    const vazio = new File([], "vazio.pdf", { type: "application/pdf" });
    const e = await assertRejects(
      () =>
        client.portal.renewInsurancePolicy(
          unit.id,
          oldId,
          vazio,
          { validFrom: isoDay(15), validTo: isoDay(380) },
          { headers: portalHdr },
        ),
      ApiError,
    );
    assertEquals(e.statusCode, 400);
  });

  it("portal renew: vencida há mais de 1 ano → 422 (a mesma janela do admin)", async () => {
    const oldId = await makePolicy({
      id: `pol_pren_velha_${ts}`,
      status: "active",
      validFrom: isoDay(-800),
      validTo: isoDay(-400),
    });
    const recibo = new File([MIN_PDF_BYTES], "recibo.pdf", { type: "application/pdf" });
    const e = await assertRejects(
      () =>
        client.portal.renewInsurancePolicy(
          unit.id,
          oldId,
          recibo,
          { validFrom: isoDay(-400), validTo: isoDay(-35) },
          { headers: portalHdr },
        ),
      ApiError,
    );
    assertEquals(e.statusCode, 422);
  });

  it("teardown", async () => {
    // Limpa a linhagem antes do DELETE em bloco: ON DELETE RESTRICT bloquearia
    // apagar um predecessor e a sua sucessora na mesma instrução.
    await sqlExec(`
      DELETE FROM core.insurance_reminder WHERE condominium_id='${condo.id}';
      UPDATE core.insurance_policy SET renewed_from_id = NULL WHERE condominium_id='${condo.id}';
      DELETE FROM core.insurance_policy WHERE condominium_id='${condo.id}';
      DELETE FROM core.unit_occupant WHERE unit_id='${unit.id}';
      DELETE FROM core.occupant WHERE condominium_id='${condo.id}';
      DELETE FROM core.user WHERE id='${aliceUid}';
    `);
    await client.super.deleteCondominium(condo.id, { headers: auth });
  });
});

// "Atualizar" da lista de seguros: o registo de raiz só passa quando
// `unitUpdateAction` diz "register" - sem nada renovável nem por rever. Antes
// não havia gate na API (só a UI escondia o botão fora de "sem submissão").
describe("seguros - registo de raiz pelo admin (gate do 'Atualizar')", () => {
  const ts = Date.now();
  let auth: { Authorization: string };
  let condo: Condominium;
  let unit: Unit;
  let adminHdr: Record<string, string>;
  let policyId = "";
  let registeredId = "";
  const dates = { validFrom: isoDay(0), validTo: isoDay(365) };
  const register = () =>
    client.admin.createInsurancePolicy(
      unit.id,
      MIN_PDF_BYTES,
      "apolice.pdf",
      "application/pdf",
      dates,
      { headers: adminHdr },
    );

  it("setup: condo + unit com uma apólice ativa", async () => {
    auth = await loginAsSuper();
    condo = (await client.super.createCondominium(
      { name: `Seguros Registo ${ts}` },
      { headers: auth },
    )).data;
    unit = (await client.super.createUnit(
      condo.id,
      { designation: "A1", permillage: 1000 } as Record<string, unknown>,
      { headers: auth },
    )).data;
    adminHdr = { ...auth, "x-condominium-id": condo.id };
    policyId = (await sqlExec(`
      INSERT INTO core.insurance_policy
        (id, condominium_id, unit_id, status, valid_from, valid_to, confirmed_at, uploaded_by)
      VALUES ('pol_reg_${ts}', '${condo.id}', '${unit.id}', 'active',
              '${isoDay(-165)}', '${isoDay(200)}', now(), '{}'::jsonb)
      RETURNING id`)).split("\n")[0].trim();
  });

  it("com apólice renovável → 409 (renovar preserva a linhagem)", async () => {
    const e = await assertRejects(register, ApiError);
    assertEquals(e.statusCode, 409);
  });

  it("só com a rejeitada → 201, documento da administração por rever", async () => {
    await sqlExec(
      `UPDATE core.insurance_policy SET status = 'rejected', rejected_at = now() WHERE id = '${policyId}'`,
    );
    const { data, status } = await register();
    assertEquals(status, 201);
    registeredId = String((data as { id?: string }).id);
    assertEquals((data as { status?: string }).status, "pending_review");
    assertEquals((data as { evidenceSource?: string }).evidenceSource, "admin");
  });

  it("com a registada ainda por rever → 409 (não empilhar submissões)", async () => {
    const e = await assertRejects(register, ApiError);
    assertEquals(e.statusCode, 409);
  });

  it("teardown", async () => {
    // Pelo API: apaga o anexo no S3 antes da linha (ADR 0021).
    if (registeredId) {
      await client.admin.deleteInsurancePolicy(registeredId, { headers: adminHdr });
    }
    await sqlExec(`DELETE FROM core.insurance_policy WHERE condominium_id='${condo.id}';`);
    await client.super.deleteCondominium(condo.id, { headers: auth });
  });
});
