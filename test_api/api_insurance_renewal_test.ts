// Renovação e undo:
//   • renovar cria a sucessora presumida e arquiva a antiga, sem duas ativas;
//   • desfazer devolve o predecessor a active e limpa `superseded_at`;
//   • com comprovativo anexado o undo recusa (apagá-la levava a evidência);
//   • linhagem: só a renovação mais recente é desfazível.
//
// Nota operacional: exigem a BD seeded + servidor (não correm contra a BD de
// trabalho - `test:up` recria a BD de desenvolvimento).

import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { ApiError, Client, type Condominium, type Unit } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";
import { sqlExec } from "./_helpers/db.ts";

const BASE_URL = "http://localhost:3000";
const client = new Client({ baseUrl: BASE_URL });

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

function isoDay(n: number): string {
  return new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
}

describe("seguros - renovação atómica e undo", () => {
  const ts = Date.now();
  let auth: { Authorization: string };
  let condo: Condominium;
  let unit: Unit;
  let adminHdr: Record<string, string>;

  /** Apólice via SQL (o admin não tem caminho de upload - ADR 0016). */
  async function makePolicy(args: {
    id: string;
    status: string;
    validFrom: string;
    validTo: string;
  }): Promise<string> {
    return (await sqlExec(`
      INSERT INTO core.insurance_policy
        (id, condominium_id, unit_id, status, valid_from, valid_to, policy_number, uploaded_by,
         confirmed_at, approved_at)
      VALUES ('${args.id}', '${condo.id}', '${unit.id}', '${args.status}',
              '${args.validFrom}', '${args.validTo}', 'POL-${args.id}', '{}'::jsonb,
              now(), now())
      RETURNING id`)).split("\n")[0].trim();
  }

  const statusOf = (id: string) =>
    sqlExec(`SELECT status FROM core.insurance_policy WHERE id = '${id}'`).then((s) => s.trim());

  it("setup: condo + fração", async () => {
    auth = await loginAsSuper();
    condo = (await client.super.createCondominium(
      { name: `Seguros Renovação ${ts}` },
      { headers: auth },
    )).data;
    unit = (await client.super.createUnit(
      condo.id,
      { designation: "A1", permillage: 1000 } as Record<string, unknown>,
      { headers: auth },
    )).data;
    adminHdr = { ...auth, "x-condominium-id": condo.id };
  });

  // ── A7: a transição é atómica e não deixa duas ativas ──────────────────

  it("renovar arquiva a antiga e cria a sucessora presumida (nunca duas ativas)", async () => {
    const oldId = await makePolicy({
      id: `pol_ren_${ts}`,
      status: "active",
      validFrom: isoDay(-350),
      validTo: isoDay(15),
    });
    const { data, status } = await client.admin.renewInsurancePolicy(oldId, { headers: adminHdr });
    assertEquals(status, 201);
    const newId = String((data as { id?: string }).id);
    assertEquals((data as { renewedFromId?: string }).renewedFromId, oldId);
    assertExists((data as { presumedAt?: string }).presumedAt);

    assertEquals(await statusOf(oldId), "superseded");
    const actives = await sqlExec(
      `SELECT count(*) FROM core.insurance_policy
        WHERE unit_id = '${unit.id}' AND status = 'active'`,
    );
    assertEquals(actives.trim(), "1");

    // ── A5: e o undo devolve tudo ao sítio ──────────────────────────────
    const { data: restored } = await client.admin.undoInsuranceRenewal(newId, {
      headers: adminHdr,
    });
    assertEquals((restored as { id?: string }).id, oldId);
    assertEquals((restored as { status?: string }).status, "active");
    // `superseded_at` limpo: senão a apólice restaurada continua a parecer
    // arquivada para quem olhar para a data.
    const clean = await sqlExec(
      `SELECT superseded_at IS NULL FROM core.insurance_policy WHERE id = '${oldId}'`,
    );
    assertEquals(clean.trim(), "t");
    const gone = await sqlExec(
      `SELECT count(*) FROM core.insurance_policy WHERE id = '${newId}'`,
    );
    assertEquals(gone.trim(), "0");
  });

  it("undo recusa (422) quando a renovação já tem comprovativo anexado", async () => {
    // WHY: o undo apaga a apólice; com um ficheiro lá dentro apagava a evidência
    // que o condómino acabou de enviar.
    const oldId = await makePolicy({
      id: `pol_ev_old_${ts}`,
      status: "active",
      validFrom: isoDay(-350),
      validTo: isoDay(15),
    });
    const { data } = await client.admin.renewInsurancePolicy(oldId, { headers: adminHdr });
    const newId = String((data as { id?: string }).id);
    await sqlExec(`
      INSERT INTO core.attachment
        (condominium_id, entity_type, entity_id, filename, mime_type, storage_key, file_size,
         created_by)
      VALUES ('${condo.id}', 'insurance', '${newId}', 'recibo.pdf', 'application/pdf',
              '${condo.id}/insurance/${newId}/recibo-${ts}.pdf', 10, '{}'::jsonb);
    `);

    const e = await assertRejects(
      () => client.admin.undoInsuranceRenewal(newId, { headers: adminHdr }),
      ApiError,
    );
    assertEquals(e.statusCode, 422);
    // Recusa, não delete parcial: a sucessora e o predecessor ficam como estavam.
    assertEquals(await statusOf(newId), "active");
    assertEquals(await statusOf(oldId), "superseded");
  });

  it("undo recusa (422) uma apólice submetida de raiz - não há nada para restaurar", async () => {
    const id = await makePolicy({
      id: `pol_raiz_${ts}`,
      status: "active",
      validFrom: isoDay(-10),
      validTo: isoDay(355),
    });
    const e = await assertRejects(
      () => client.admin.undoInsuranceRenewal(id, { headers: adminHdr }),
      ApiError,
    );
    assertEquals(e.statusCode, 422);
    assertEquals(await statusOf(id), "active");
  });

  it("numa cadeia de duas renovações, só a mais recente é desfazível", async () => {
    // Desfazer no meio partia a linhagem (e o ON DELETE RESTRICT de `renewed_from_id`
    // recusaria na mesma, com um 500 opaco).
    const raiz = await makePolicy({
      id: `pol_ch_raiz_${ts}`,
      status: "active",
      validFrom: isoDay(-700),
      validTo: isoDay(-340),
    });
    const { data: r1 } = await client.admin.renewInsurancePolicy(raiz, { headers: adminHdr });
    const meio = String((r1 as { id?: string }).id);
    const { data: r2 } = await client.admin.renewInsurancePolicy(meio, { headers: adminHdr });
    const topo = String((r2 as { id?: string }).id);

    const e = await assertRejects(
      () => client.admin.undoInsuranceRenewal(meio, { headers: adminHdr }),
      ApiError,
    );
    assertEquals(e.statusCode, 422);

    // A mais recente desfaz-se e devolve o meio a active.
    await client.admin.undoInsuranceRenewal(topo, { headers: adminHdr });
    assertEquals(await statusOf(meio), "active");
  });

  // ── Renovar com documento: o que o admin transcreve manda, o resto herda ──
  //
  // WHY: os dados da renovação eram copiados do predecessor em silêncio e não
  // havia como corrigi-los no ato. Numa renovação real muda o capital (ou o nº,
  // quando a seguradora reemite) - se a transcrição não vencesse, o admin
  // gravava o valor do ano anterior com o documento novo em anexo a contradizê-lo.

  it("renovar com documento: campo transcrito vence, campo omitido herda", async () => {
    const oldId = await makePolicy({
      id: `pol_det_${ts}`,
      status: "active",
      validFrom: isoDay(-350),
      validTo: isoDay(15),
    });
    await sqlExec(
      `UPDATE core.insurance_policy
          SET insurer = 'Fidelidade', coverage_amount_cents = 5000000
        WHERE id = '${oldId}'`,
    );

    const { data } = await client.admin.renewInsurancePolicyWithDocument(
      oldId,
      MIN_PDF_BYTES,
      "renovacao.pdf",
      "application/pdf",
      {
        validFrom: isoDay(15),
        validTo: isoDay(380),
        // Nº novo e capital atualizado; a seguradora fica de fora de propósito.
        policyNumber: "POL-NOVA-2027",
        coverageAmountCents: "7500000",
      },
      { headers: adminHdr },
    );

    const nova = data as Record<string, unknown>;
    assertEquals(nova.policyNumber, "POL-NOVA-2027");
    assertEquals(nova.coverageAmountCents, 7_500_000);
    // Omitida no formulário: herda a do predecessor em vez de ficar vazia.
    assertEquals(nova.insurer, "Fidelidade");
    assertEquals(nova.renewedFromId, oldId);
    // Com documento a antiga só sai de cena na aprovação (ADR 0040).
    assertEquals(nova.status, "pending_review");
    assertEquals(await statusOf(oldId), "active");
  });

  it("teardown", async () => {
    await sqlExec(`
      DELETE FROM core.insurance_reminder WHERE condominium_id='${condo.id}';
      UPDATE core.insurance_policy SET renewed_from_id = NULL WHERE condominium_id='${condo.id}';
      DELETE FROM core.attachment WHERE condominium_id='${condo.id}';
      DELETE FROM core.insurance_policy WHERE condominium_id='${condo.id}';
    `);
    await client.super.deleteCondominium(condo.id, { headers: auth });
  });
});
