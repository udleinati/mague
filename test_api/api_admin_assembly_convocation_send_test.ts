// E2E: envio da convocatória a todos (bulk) + reenvio individual com cooldown
// por (pessoa, fração).
//
// Intenção (Rule 9): o envio é POR FRAÇÃO (ADR 0034) - 1 email por ligação
// ativa (occupant × fração) de owner/resident. Um dono de N frações recebe N
// emails (um por fração, assunto identifica a fração); tenant é excluído; quem
// não tem email entra como falha (nunca saltado calado); cada email leva os 2
// anexos PDF; regista-se 1 run em `core.assembly_convocation` (recipients com
// `unitId`); `convocation_sent_at` fica populado. Em rascunho o envio é
// bloqueado (422 CONVOCATION_DRAFT).
//
// Reenvio individual a uma (pessoa, fração) em cooldown -> 422 COOLDOWN_ACTIVE;
// sem email -> 422 NO_EMAIL; par não elegível -> 404. O "enviar a todos" salta
// quem está em cooldown (`skippedCooldown`). O cooldown é por (pessoa, fração) -
// reenviar a fração A não mexe na fração B. O endpoint `recipients` projeta o
// estado de cooldown por (pessoa, fração).
//
// Requer o stack de teste a correr (API :3000 + Mailpit + mague-db). Não
// corre sob `deno task test:unit` (precisa de rede + Chromium + DB).

import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { Client } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";
import { sqlExec } from "./_helpers/db.ts";
import { type ScenarioFixture, seedScenario } from "./_helpers/fixtures.ts";
import { flushMailpit, getMessage, listMessages, waitForEmail } from "./_helpers/mailpit.ts";

const BASE_URL = "http://localhost:3000";
const client = new Client({ baseUrl: BASE_URL });
const MASTER = await loginAsSuper();

// Reunião a 90 dias. A 2ª convocatória é 30 min depois (Art. 1432.º nº 1).
const meetingAt = new Date(Date.now() + 90 * 86_400_000);
meetingAt.setUTCHours(19, 0, 0, 0);
const FUTURE_MEETING = meetingAt.toISOString();
const FUTURE_MEETING_SECOND = new Date(meetingAt.getTime() + 30 * 60_000).toISOString();

describe("admin assembly - envio da convocatória a todos (bulk)", () => {
  let fx: ScenarioFixture;
  let assemblyId = "";
  let unitA = "";
  let unitB = "";
  const ts = Date.now();
  const aliceEmail = `alice-${ts}@test.pt`;
  const bobEmail = `bob-${ts}@test.pt`;
  const danEmail = `dan-${ts}@test.pt`;
  const eveEmail = `eve-${ts}@test.pt`;
  const hdr = () => fx.hdr();
  const base = () => `/v1/admin/condominiums/${fx.condominium.id}/assemblies/${assemblyId}`;

  it("setup - condo + 2 frações + occupants (Alice dona de A e B, Carol sem email, Dan tenant)", async () => {
    fx = await seedScenario(client, MASTER)
      .withCondo(`Convocation Send ${ts}`)
      .withUnit({ designation: "A", permillage: 500 })
      .withUnit({ designation: "B", permillage: 500 })
      .build();
    const cid = fx.condominium.id;
    unitA = fx.units[0].id;
    unitB = fx.units[1].id;

    // Occupants: Alice (dona de A e B - recebe 1 email POR FRAÇÃO), Bob
    // (residente de A), Carol (dona de B SEM email), Dan (tenant de A - deve
    // ser excluído).
    await sqlExec(
      `INSERT INTO core.occupant (id, condominium_id, name, email) VALUES ` +
        `('occ_al_${ts}','${cid}','Alice','${aliceEmail}'),` +
        `('occ_bo_${ts}','${cid}','Bob','${bobEmail}'),` +
        `('occ_ca_${ts}','${cid}','Carol', NULL),` +
        `('occ_da_${ts}','${cid}','Dan','${danEmail}')`,
    );
    await sqlExec(
      `INSERT INTO core.unit_occupant (id, unit_id, occupant_id, relationship_type, start_date) VALUES ` +
        `('uo_a1_${ts}','${unitA}','occ_al_${ts}','owner','2025-01-01'),` +
        `('uo_a2_${ts}','${unitB}','occ_al_${ts}','owner','2025-01-01'),` +
        `('uo_bo_${ts}','${unitA}','occ_bo_${ts}','resident','2025-01-01'),` +
        `('uo_ca_${ts}','${unitB}','occ_ca_${ts}','owner','2025-01-01'),` +
        `('uo_da_${ts}','${unitA}','occ_da_${ts}','tenant','2025-01-01')`,
    );

    const { data, status } = await client.admin.createAssembly(
      {
        type: "ordinary",
        // Data relativa: a convocatória só se envia enquanto a reunião não
        // decorreu, e a literal que estava aqui ("2026-07-10") passou a estar no
        // passado - a suite inteira caía em CONVOCATION_MEETING_PASSED.
        scheduledAt: FUTURE_MEETING,
        secondConvocationAt: FUTURE_MEETING_SECOND,
        location: "Sala do condomínio",
      },
      { headers: hdr() },
    );
    assertEquals(status, 201);
    assertEquals(data.status, "draft");
    assemblyId = data.id as string;

    await client.admin.createAssemblyAgendaItem(
      assemblyId,
      { sequence: 1, subject: "Aprovação do orçamento 2026", itemType: "info" },
      { headers: hdr() },
    );
  });

  it("envio em rascunho -> 422 CONVOCATION_DRAFT", async () => {
    const res = await fetch(`${BASE_URL}${base()}/convocation/send`, {
      method: "POST",
      headers: { ...hdr(), "Content-Type": "application/json" },
      body: "{}",
    });
    assertEquals(res.status, 422);
    const body = await res.json();
    assertEquals(body.error.code, "CONVOCATION_DRAFT");
  });

  it("convocar (draft -> scheduled)", async () => {
    const { data } = await client.admin.updateAssembly(
      assemblyId,
      { status: "scheduled" },
      { headers: hdr() },
    );
    assertEquals(data.status, "scheduled");
  });

  it("enviar a todos -> contagens por fração (4 destinatários, 3 enviados, 1 sem email)", async () => {
    await flushMailpit();
    const { data, status } = await client.admin.sendAssemblyConvocation(assemblyId, {
      headers: hdr(),
    });
    assertEquals(status, 200);
    // Por fração: Alice×A, Alice×B, Bob×A, Carol×B = 4; Dan (tenant) excluído.
    assertEquals(data.totalRecipients, 4);
    assertEquals(data.sent, 3); // Alice×A, Alice×B, Bob×A
    assertEquals(data.noEmail, 1); // Carol×B
    assertEquals(data.failed, 0); // Mailpit não falha o transporte
  });

  it("por fração: Alice (2 frações) recebe 2 emails, um por fração, com 2 anexos cada", async () => {
    await waitForEmail({ to: aliceEmail, subjectIncludes: "Convocatória - Assembleia" });
    const all = await listMessages();
    const toAlice = all.filter((m) => m.To.some((t) => t.Address.toLowerCase() === aliceEmail));
    // 2 emails para Alice - um por fração (não dedup).
    assertEquals(toAlice.length, 2);
    // Os assuntos identificam frações distintas (A e B).
    const subjects = toAlice.map((m) => m.Subject).sort();
    assertEquals(subjects.some((s) => s.includes("Fração A")), true);
    assertEquals(subjects.some((s) => s.includes("Fração B")), true);
    // Cada email leva 2 anexos: convocatória + procuração.
    for (const m of toAlice) {
      const full = await getMessage(m.ID);
      const names = full.Attachments.map((a) => a.FileName).sort();
      assertEquals(names, ["convocatoria.pdf", "procuracao.pdf"]);
    }
  });

  it("pré-visualização: o assunto é o mesmo do email enviado a Alice×A", async () => {
    const { data } = await client.admin.previewAssemblyConvocation(
      assemblyId,
      `occ_al_${ts}`,
      unitA,
      { headers: hdr() },
    );
    const all = await listMessages();
    const sentToAliceA = all.find((m) =>
      m.To.some((t) => t.Address.toLowerCase() === aliceEmail) && m.Subject.includes("Fração A")
    );
    assertEquals(data.subject, sentToAliceA?.Subject);
  });

  it("Bob (residente) recebe; Dan (tenant) NÃO recebe", async () => {
    await waitForEmail({ to: bobEmail });
    const all = await listMessages();
    const toDan = all.filter((m) => m.To.some((t) => t.Address.toLowerCase() === danEmail));
    assertEquals(toDan.length, 0);
  });

  it("regista 1 run em assembly_convocation (trigger=bulk, 4 recipients com unitId)", async () => {
    const trigger = await sqlExec(
      `SELECT trigger FROM core.assembly_convocation WHERE assembly_id='${assemblyId}'`,
    );
    assertEquals(trigger, "bulk");
    const count = await sqlExec(
      `SELECT count(*) FROM core.assembly_convocation WHERE assembly_id='${assemblyId}'`,
    );
    assertEquals(count, "1");
    const recipientCount = await sqlExec(
      `SELECT jsonb_array_length(recipients) FROM core.assembly_convocation WHERE assembly_id='${assemblyId}'`,
    );
    assertEquals(recipientCount, "4");
    // Cada entrada da auditoria guarda a fração (unitId) do despacho.
    const withUnit = await sqlExec(
      `SELECT count(*) FROM core.assembly_convocation ac` +
        ` CROSS JOIN LATERAL jsonb_array_elements(ac.recipients) AS r` +
        ` WHERE ac.assembly_id='${assemblyId}' AND r->>'unitId' IS NOT NULL`,
    );
    assertEquals(withUnit, "4");
  });

  it("convocation_sent_at populado no 1º envio com >=1 sent", async () => {
    const { data } = await client.admin.getAssembly(assemblyId, { headers: hdr() });
    assertEquals(typeof data.convocationSentAt, "string");
  });

  // ─── Reenvio individual + cooldown 24h por (pessoa, fração) (ADR 0032/0034) ──

  it("reenvio individual a uma (pessoa, fração) em cooldown -> 422 COOLDOWN_ACTIVE", async () => {
    // Alice×A acabou de receber (bulk acima) -> dentro da janela de 24h.
    const res = await fetch(`${BASE_URL}${base()}/convocation/send/occ_al_${ts}/${unitA}`, {
      method: "POST",
      headers: { ...hdr(), "Content-Type": "application/json" },
      body: "{}",
    });
    assertEquals(res.status, 422);
    assertEquals((await res.json()).error.code, "COOLDOWN_ACTIVE");
  });

  it("reenvio individual a (pessoa, fração) sem email (Carol×B) -> 422 NO_EMAIL", async () => {
    const res = await fetch(`${BASE_URL}${base()}/convocation/send/occ_ca_${ts}/${unitB}`, {
      method: "POST",
      headers: { ...hdr(), "Content-Type": "application/json" },
      body: "{}",
    });
    assertEquals(res.status, 422);
    assertEquals((await res.json()).error.code, "NO_EMAIL");
  });

  it("reenvio individual a par (pessoa, fração) não elegível -> 404 RECIPIENT_NOT_FOUND", async () => {
    // Bob não é owner/resident da fração B -> par inexistente.
    const res = await fetch(`${BASE_URL}${base()}/convocation/send/occ_bo_${ts}/${unitB}`, {
      method: "POST",
      headers: { ...hdr(), "Content-Type": "application/json" },
      body: "{}",
    });
    assertEquals(res.status, 404);
    assertEquals((await res.json()).error.code, "RECIPIENT_NOT_FOUND");
  });

  it("recipients: Alice×A e Alice×B em cooldown, Carol×B sem email", async () => {
    const res = await fetch(`${BASE_URL}${base()}/convocation/recipients`, {
      headers: hdr(),
    });
    assertEquals(res.status, 200);
    const { data } = await res.json() as {
      data: Array<
        {
          occupantId: string;
          unitId: string;
          hasEmail: boolean;
          inCooldown: boolean;
          lastSentAt: string | null;
        }
      >;
    };
    const byKey = Object.fromEntries(data.map((r) => [`${r.occupantId}:${r.unitId}`, r]));
    assertEquals(byKey[`occ_al_${ts}:${unitA}`].inCooldown, true);
    assertEquals(byKey[`occ_al_${ts}:${unitA}`].lastSentAt !== null, true);
    assertEquals(byKey[`occ_al_${ts}:${unitB}`].inCooldown, true);
    assertEquals(byKey[`occ_bo_${ts}:${unitA}`].inCooldown, true);
    assertEquals(byKey[`occ_ca_${ts}:${unitB}`].hasEmail, false);
    assertEquals(byKey[`occ_ca_${ts}:${unitB}`].inCooldown, false);
  });

  it("enviar a todos de novo -> salta cooldown (3), Carol sem email (1), 0 enviados", async () => {
    const { data, status } = await client.admin.sendAssemblyConvocation(assemblyId, {
      headers: hdr(),
    });
    assertEquals(status, 200);
    assertEquals(data.totalRecipients, 4); // Alice×A, Alice×B, Bob×A, Carol×B
    assertEquals(data.sent, 0);
    assertEquals(data.skippedCooldown, 3); // Alice×A, Alice×B, Bob×A (em cooldown)
    assertEquals(data.noEmail, 1); // Carol×B (sem email, nunca em cooldown)
  });

  it("reenvio individual a quem nunca recebeu (Eve×A) -> 200 sent=1, run trigger=individual", async () => {
    // Eve entra depois do bulk -> fora de cooldown (nunca recebeu).
    const cid = fx.condominium.id;
    await sqlExec(
      `INSERT INTO core.occupant (id, condominium_id, name, email) VALUES ` +
        `('occ_ev_${ts}','${cid}','Eve','${eveEmail}')`,
    );
    await sqlExec(
      `INSERT INTO core.unit_occupant (id, unit_id, occupant_id, relationship_type, start_date) VALUES ` +
        `('uo_ev_${ts}','${unitA}','occ_ev_${ts}','resident','2025-01-01')`,
    );
    await flushMailpit();
    const { data, status } = await client.admin.resendAssemblyConvocation(
      assemblyId,
      `occ_ev_${ts}`,
      unitA,
      { headers: hdr() },
    );
    assertEquals(status, 200);
    assertEquals(data.totalRecipients, 1);
    assertEquals(data.sent, 1);
    assertEquals(data.skippedCooldown, 0);
    await waitForEmail({ to: eveEmail, subjectIncludes: "Convocatória - Assembleia" });
    const trig = await sqlExec(
      `SELECT count(*) FROM core.assembly_convocation WHERE assembly_id='${assemblyId}' AND trigger='individual'`,
    );
    assertEquals(trig, "1");
  });

  it("reenvio individual a Eve×A logo a seguir -> 422 COOLDOWN_ACTIVE", async () => {
    // Acabou de receber acima -> agora dentro da janela.
    const res = await fetch(`${BASE_URL}${base()}/convocation/send/occ_ev_${ts}/${unitA}`, {
      method: "POST",
      headers: { ...hdr(), "Content-Type": "application/json" },
      body: "{}",
    });
    assertEquals(res.status, 422);
    assertEquals((await res.json()).error.code, "COOLDOWN_ACTIVE");
  });

  it("cleanup", async () => {
    await fx.cleanup();
  });
});
