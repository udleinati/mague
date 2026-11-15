// Auto-invite na emissão de recibo.
//
// Comportamento testado:
//   1. Owner SEM `core.user` → receipt emit dispara 2 emails (invite +
//      receipt) + cria user + linka ao occupant + invite_token para
//      `/accept-invite?token=…&next=portalUrl`.
//   2. Owner COM `core.user` → receipt emit dispara 1 email (só receipt)
//      + sem novo invite_token.
//   3. 2.ª emissão ao mesmo owner (já com user pós-1) → 1 email só.
//
// A feature foi adicionada para que occupants sem conta no portal recebam
// recibo + via para criar conta e aceder. Sem auto-invite, o link "Consultar
// no portal" caía no login e o user não tinha forma de entrar.

import { assertEquals, assertGreater, assertNotEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import postgresjs from "postgresjs";
import { Client, type Condominium, type Unit } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";

const BASE_URL = "http://localhost:3000";
const DATABASE_URL = Deno.env.get("DATABASE_URL") ??
  "postgres://mague:mague@localhost:5432/mague";
const AUTH = await loginAsSuper();
const client = new Client({ baseUrl: BASE_URL });
const sql = postgresjs(DATABASE_URL, { max: 2 });

describe("admin receipts - auto-invite na emissão", () => {
  let condo: Condominium;
  let unitNoUser: Unit;
  let unitWithUser: Unit;
  let occupantNoUserId = "";
  let headers: Record<string, string>;
  const stamp = Date.now();
  const emailNoUser = `auto-invite-new-${stamp}@example.pt`;
  const emailWithUser = `auto-invite-existing-${stamp}@example.pt`;

  it("setup - condo + 2 owners (1 com user, 1 sem)", async () => {
    const { data: c } = await client.super.createCondominium(
      { name: "Auto-Invite Test", fiscalNumber: "509300100" },
      { headers: AUTH },
    );
    condo = c;
    headers = { ...AUTH, "x-condominium-id": condo.id };

    const { data: u1 } = await client.super.createUnit(
      condo.id,
      { designation: "A1", permillage: 500 },
      { headers: AUTH },
    );
    unitNoUser = u1;
    const { data: u2 } = await client.super.createUnit(
      condo.id,
      { designation: "A2", permillage: 500 },
      { headers: AUTH },
    );
    unitWithUser = u2;

    // Occupant 1 - SEM user
    const { data: occ1 } = await client.admin.createOccupant(
      { name: "Owner New", type: "owner", nif: "234567899", email: emailNoUser },
      { headers },
    );
    occupantNoUserId = occ1.id;
    await client.admin.createUnitOccupant(
      unitNoUser.id,
      {
        unitId: unitNoUser.id,
        occupantId: occ1.id,
        relationshipType: "owner",
        startDate: "2025-01-01",
      },
      { headers },
    );

    // Occupant 2 - pré-criamos user e ligamos via SQL directo (simula o
    // estado pós-1.º invite anterior).
    const { data: occ2 } = await client.admin.createOccupant(
      { name: "Owner Existing", type: "owner", nif: "345678915", email: emailWithUser },
      { headers },
    );
    const userRows = await sql<{ id: string }[]>`
      INSERT INTO core.user (name, email, role, is_active)
      VALUES ('Owner Existing', ${emailWithUser}, NULL, true)
      RETURNING id
    `;
    await sql`
      UPDATE core.occupant SET user_id = ${userRows[0].id}
       WHERE id = ${occ2.id}
    `;
    await client.admin.createUnitOccupant(
      unitWithUser.id,
      {
        unitId: unitWithUser.id,
        occupantId: occ2.id,
        relationshipType: "owner",
        startDate: "2025-01-01",
      },
      { headers },
    );

    // Bank account + 2 charges + 2 tx + 2 settlements (1 por unit).
    const { data: ba } = await client.admin.createBankAccount(
      { bankName: "Auto-Invite Bank", iban: "PT50000700000000000099991", kind: "bank" },
      { headers },
    );
    for (const u of [unitNoUser, unitWithUser]) {
      const { data: ch } = await client.admin.createCharge(
        {
          kind: "receivable",
          nature: "debit",
          chargeType: "quota",
          scope: "unit",
          unitId: u.id,
          issueDate: "2026-03-01",
          competencePeriod: "2026-03-01",
          amountCents: 7500,
          description: `Quota Mar ${u.designation}`,
        },
        { headers },
      );
      const { data: bt } = await client.admin.createBankTransaction(
        {
          bankAccountId: ba.id,
          transactionDate: "2026-03-15",
          amount: 7500,
          description: `Pagto Mar ${u.designation}`,
        },
        { headers },
      );
      await client.admin.createSettlement(
        {
          settlementType: "bank_reconciliation",
          bankTransactionId: bt.id,
          debitChargeId: ch.id,
          amount: 7500,
          settlementDate: "2026-03-15",
        },
        { headers },
      );
    }
  });

  it("emit recibo para owner SEM user → cria user, gera token, dispara 2 emails", async () => {
    // Sanity pré: user não existe ainda, occupant.user_id NULL, sem token.
    const before = await sql<{ uid: string | null; tokens: number; mails: number }[]>`
      SELECT
        (SELECT user_id FROM core.occupant WHERE id = ${occupantNoUserId}) AS uid,
        (SELECT COUNT(*)::int FROM core.invite_token
          WHERE user_id IN (SELECT user_id FROM core.occupant WHERE id = ${occupantNoUserId})
            AND used_at IS NULL) AS tokens,
        (SELECT COUNT(*)::int FROM audit.email_log
          WHERE recipient = ${emailNoUser}) AS mails
    `;
    assertEquals(before[0].uid, null);
    assertEquals(before[0].tokens, 0);
    assertEquals(before[0].mails, 0);

    // Acha o pending receipt para esta unit.
    const { data: pending } = await client.admin.listPendingReceipts({ headers });
    const target = pending.find((p) => p.unitId === unitNoUser.id);
    assertNotEquals(target, undefined);

    const { status } = await client.admin.emitReceipt(
      { bankTransactionId: target!.bankTransactionId, unitId: unitNoUser.id },
      { headers },
    );
    assertEquals(status, 201);

    // Pós: occupant agora tem user_id, há token de convite válido, e
    // email_log tem 2 entries (1 invite + 1 receipt) para este owner.
    const after = await sql<{
      uid: string | null;
      activeTokens: number;
      inviteEmails: number;
      receiptEmails: number;
    }[]>`
      SELECT
        (SELECT user_id FROM core.occupant WHERE id = ${occupantNoUserId}) AS uid,
        (SELECT COUNT(*)::int FROM core.invite_token
          WHERE user_id = (SELECT user_id FROM core.occupant WHERE id = ${occupantNoUserId})
            AND purpose = 'invite' AND used_at IS NULL
            AND expires_at > NOW()) AS "activeTokens",
        (SELECT COUNT(*)::int FROM audit.email_log
          WHERE recipient = ${emailNoUser} AND category = 'invite') AS "inviteEmails",
        (SELECT COUNT(*)::int FROM audit.email_log
          WHERE recipient = ${emailNoUser} AND category = 'receipt') AS "receiptEmails"
    `;
    assertNotEquals(after[0].uid, null);
    assertGreater(after[0].activeTokens, 0);
    assertEquals(after[0].inviteEmails, 1);
    assertEquals(after[0].receiptEmails, 1);
  });

  it("emit recibo para owner COM user pré-existente → 1 email só (sem invite)", async () => {
    const { data: pending } = await client.admin.listPendingReceipts({ headers });
    const target = pending.find((p) => p.unitId === unitWithUser.id);
    assertNotEquals(target, undefined);

    const { status } = await client.admin.emitReceipt(
      { bankTransactionId: target!.bankTransactionId, unitId: unitWithUser.id },
      { headers },
    );
    assertEquals(status, 201);

    // Para este recipient só existe 1 email (receipt). Nenhum invite.
    const rows = await sql<{ inviteN: number; receiptN: number }[]>`
      SELECT
        COUNT(*) FILTER (WHERE category = 'invite')::int  AS "inviteN",
        COUNT(*) FILTER (WHERE category = 'receipt')::int AS "receiptN"
        FROM audit.email_log
       WHERE recipient = ${emailWithUser}
    `;
    assertEquals(rows[0].inviteN, 0);
    assertEquals(rows[0].receiptN, 1);
  });

  it("teardown", async () => {
    try {
      // Apaga users criados (incluindo o auto-invitado).
      await sql`DELETE FROM core.user WHERE email IN (${emailNoUser}, ${emailWithUser})`;
    } finally {
      await sql.end();
    }
  });
});
