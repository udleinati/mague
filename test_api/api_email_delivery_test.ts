// E2E: validação de que `sendEmail` realmente entrega via Mailpit (SMTP
// local de dev). Os outros tests do email só validam a lógica TS - aqui
// validamos o pipeline inteiro (template → transport → SMTP → Mailpit) e
// que os headers `Bcc` e `Reply-To` chegam ao recipiente.
//
// Cobre as 3 categorias business (que aplicam BCC/ReplyTo) + a system
// (que NÃO aplica):
//
//   • invite              ← POST .../occupants/:id/invite
//   • insurance_reminder  ← POST .../insurance/reminders/:unitId
//   • password_reset      ← POST /v1/auth/forgot-password (system: sem BCC/ReplyTo)
//
// `receipt` partilha o mesmo pipeline mas tem setup pesado (charge +
// bank_tx + settlement). Coberto indiretamente via E2E existentes
// (api_admin_receipt_test.ts) - os headers passam pelo mesmo `sendEmail`.

import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { Client, type Condominium, type Unit } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";
import { sqlExec } from "./_helpers/db.ts";
import { addresses, flushMailpit, waitForEmail } from "./_helpers/mailpit.ts";

const BASE_URL = "http://localhost:3000";
const AUTH = await loginAsSuper();
const client = new Client({ baseUrl: BASE_URL });

const BCC = "bcc@mague.test";
const REPLY_TO = "admin@mague.test";

describe("email delivery via Mailpit - BCC + Reply-To headers", () => {
  let condo: Condominium;
  let unit: Unit;
  let occupantId = "";
  let userEmail = "";

  it("setup: condo com bccEmail + replyToEmail + 1 unit + 1 occupant", async () => {
    const ts = Date.now();
    userEmail = `email-delivery-${ts}@test.pt`;

    const { data: c } = await client.super.createCondominium(
      { name: `Email Delivery ${ts}` },
      { headers: AUTH },
    );
    condo = c;

    // Configurar BCC + Reply-To via super endpoint (panel passa por aqui).
    await client.super.updateCondominium(
      condo.id,
      { bccEmail: BCC, replyToEmail: REPLY_TO } as Record<string, unknown>,
      { headers: AUTH },
    );

    const headers = { ...AUTH, "x-condominium-id": condo.id };
    const { data: u } = await client.super.createUnit(
      condo.id,
      { designation: "A", permillage: 1000 },
      { headers: AUTH },
    );
    unit = u;

    // Occupant com email - necessário para invite + insurance reminder.
    const { data: occ } = await client.admin.createOccupant(
      { name: "Email Test Occupant", type: "owner", email: userEmail },
      { headers },
    );
    occupantId = occ.id;
    await client.admin.createUnitOccupant(
      unit.id,
      { unitId: unit.id, occupantId, relationshipType: "owner", startDate: "2025-01-01" },
      { headers },
    );
  });

  // ── 1. invite (business: aplica BCC + ReplyTo) ──────────────────────────

  it("invite occupant → email entregue COM Bcc + Reply-To do condo", async () => {
    await flushMailpit();
    const r = await fetch(
      `${BASE_URL}/v1/admin/condominiums/${condo.id}/occupants/${occupantId}/invite`,
      {
        method: "POST",
        headers: { ...AUTH, "x-condominium-id": condo.id, "Content-Type": "application/json" },
        body: "{}",
      },
    );
    assertEquals(r.ok, true, `invite endpoint: HTTP ${r.status}`);
    await r.body?.cancel();

    const m = await waitForEmail({ to: userEmail, subjectIncludes: "Convite" });
    assertEquals(addresses(m.To), [userEmail.toLowerCase()]);
    // BCC + Reply-To resolvidos pelo `sendEmail` a partir do condominiumId.
    assertEquals(addresses(m.Bcc), [BCC]);
    assertEquals(addresses(m.ReplyTo), [REPLY_TO]);
    // Subject inclui o nome do condomínio.
    assertEquals(m.Subject.includes(condo.name), true);
    // Body contém o link de aceitar.
    assertEquals(m.HTML.includes("/accept-invite?token="), true);
  });

  // ── 2. insurance_reminder (business: aplica BCC + ReplyTo) ─────────────

  it("insurance reminder → email entregue COM Bcc + Reply-To do condo", async () => {
    await flushMailpit();
    const r = await client.admin.sendInsuranceReminder(unit.id, {
      headers: { ...AUTH, "x-condominium-id": condo.id },
    });
    assertEquals(r.data.sent, 1, "1 occupant elegível com email → 1 sent");

    const m = await waitForEmail({ to: userEmail, subjectIncludes: "Seguro em falta" });
    assertEquals(addresses(m.Bcc), [BCC]);
    assertEquals(addresses(m.ReplyTo), [REPLY_TO]);
    // Body menciona a fração + link para o portal.
    assertEquals(m.HTML.includes("/insurances"), true);
  });

  // ── 3. password_reset (system: NÃO aplica BCC nem ReplyTo) ─────────────

  it("forgot_password → email entregue SEM Bcc nem Reply-To (system email)", async () => {
    // Cria user para poder recuperar password (occupant sem user → endpoint
    // devolve 204 mas não envia email - precisamos de um user real).
    const stamp = Date.now();
    const resetEmail = `reset-${stamp}@test.pt`;
    await sqlExec(`
      INSERT INTO core."user" (id, email, name, role, is_active, password_hash)
      VALUES ('usr_reset_${stamp}', '${resetEmail}', 'Reset Test', NULL, true,
              crypt('test12345', gen_salt('bf', 10)))
    `);

    await flushMailpit();
    const r = await fetch(`${BASE_URL}/v1/auth/forgot-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Endpoint aceita `identifier` (email OU NIF). Não há fallback `email`.
      body: JSON.stringify({ identifier: resetEmail }),
    });
    // Endpoint devolve sempre 204 (não vaza existência do user).
    assertEquals(r.status, 204);
    await r.body?.cancel();

    const m = await waitForEmail({ to: resetEmail, subjectIncludes: "Reset" });
    // System email: nunca carrega config do condo (BCC = privacy leak,
    // Reply-To = anti-redireccionar respostas a um link de reset).
    assertEquals(m.Bcc.length, 0);
    assertEquals(m.ReplyTo.length, 0);
    // Body tem o link de reset.
    assertEquals(m.HTML.includes("/reset-password?token="), true);

    // Cleanup do user de reset.
    await sqlExec(`DELETE FROM core.invite_token WHERE user_id = 'usr_reset_${stamp}'`);
    await sqlExec(`DELETE FROM core."user" WHERE id = 'usr_reset_${stamp}'`);
  });

  // ── 4. condominio sem config de email → headers ausentes ───────────────

  it("condo sem bcc/reply-to → emails não carregam estes headers", async () => {
    // Limpa a config do condo para ver o efeito.
    await client.super.updateCondominium(
      condo.id,
      { bccEmail: null, replyToEmail: null } as Record<string, unknown>,
      { headers: AUTH },
    );
    // ADR 0032: o lembrete de seguro tem cooldown de 14 dias. O envio do teste
    // anterior (mesma `unit`) deixa o último lembrete dentro da janela e este
    // 2.º envio devolveria 422. Recuamos o `sent_at` para fora da janela
    // (15 > 14 dias) - o que importa aqui é o header, não o cooldown.
    await sqlExec(
      `UPDATE core.insurance_reminder SET sent_at = NOW() - INTERVAL '15 days' WHERE unit_id = '${unit.id}'`,
    );
    await flushMailpit();
    const r = await client.admin.sendInsuranceReminder(unit.id, {
      headers: { ...AUTH, "x-condominium-id": condo.id },
    });
    assertEquals(r.data.sent, 1);

    const m = await waitForEmail({ to: userEmail, subjectIncludes: "Seguro em falta" });
    // Sem config no condo, headers não aparecem (não defaults globais).
    assertEquals(m.Bcc.length, 0);
    assertEquals(m.ReplyTo.length, 0);
  });

  it("teardown", async () => {
    const cid = `'${condo.id}'`;
    await sqlExec(`DELETE FROM core.insurance_reminder WHERE condominium_id = ${cid}`);
    await sqlExec(`DELETE FROM core.invite_token WHERE user_id IN (
      SELECT user_id FROM core.occupant WHERE condominium_id = ${cid} AND user_id IS NOT NULL
    )`);
    await sqlExec(`DELETE FROM core.unit_occupant WHERE unit_id IN (
      SELECT id FROM core.unit WHERE condominium_id = ${cid}
    )`);
    await sqlExec(`DELETE FROM core.occupant WHERE condominium_id = ${cid}`);
    await sqlExec(`DELETE FROM core.unit WHERE condominium_id = ${cid}`);
    await sqlExec(`DELETE FROM core.condominium WHERE id = ${cid}`);
  });
});
