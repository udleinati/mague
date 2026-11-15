// E2E: audit.email_log + bccEmail no condomínio.
//
// Cobre:
//   1. Emit de recibo → email gravado em audit.email_log com category,
//      recipient, condominium_id, unit_id, status='sent', bcc populado se
//      condo tem bccEmail, actor com {id, email, ...}.
//   2. Resend de recibo → novo entry em email_log.
//   3. Forgot-password → NÃO grava em email_log (categoria 'password_reset'
//      é skip).
//   4. updateMe sobre bccEmail funciona (set, unset, change).
//
// Self-contained: cria condo + unit + owner + bank_account + charge + tx +
// settlement (clone do api_admin_receipt_test.ts setup). NIF=123456789 (PT
// válido) no occupant é necessário para emit passar.

import { assertEquals, assertGreater, assertNotEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import postgresjs from "postgresjs";
import bcrypt from "npm:bcryptjs@2.4.3";
import { Client, type Condominium, type Unit } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";

const BASE_URL = "http://localhost:3000";
const DATABASE_URL = Deno.env.get("DATABASE_URL") ??
  "postgres://mague:mague@localhost:5432/mague";
const AUTH = await loginAsSuper();
const client = new Client({ baseUrl: BASE_URL });
const sql = postgresjs(DATABASE_URL, { max: 2 });

describe("audit.email_log + condominium.bccEmail", () => {
  let condo: Condominium;
  let unit: Unit;
  let bankTxId = "";
  let receiptId = "";
  let _receiptNumber = "";
  let headers: Record<string, string>;
  const stamp = Date.now();
  const ownerEmail = `email-log-owner-${stamp}@test.pt`;
  const bccEmail = `bcc-${stamp}@test.pt`;

  it("setup - condominium + unit + owner + bank + tx + settlement", async () => {
    const { data: c } = await client.super.createCondominium(
      { name: "Email Log Test", fiscalNumber: "501234567" },
      { headers: AUTH },
    );
    condo = c;
    headers = { ...AUTH, "x-condominium-id": condo.id };

    const { data: u } = await client.super.createUnit(
      condo.id,
      { designation: "X", permillage: 1000 },
      { headers: AUTH },
    );
    unit = u;

    const { data: occ } = await client.admin.createOccupant(
      {
        name: "Owner Email Log",
        type: "owner",
        nif: "123456789",
        email: ownerEmail,
      },
      { headers },
    );
    await client.admin.createUnitOccupant(
      u.id,
      {
        unitId: u.id,
        occupantId: occ.id as string,
        relationshipType: "owner",
        startDate: "2025-01-01",
      },
      { headers },
    );

    const { data: ba } = await client.admin.createBankAccount(
      { bankName: "Email Log Bank", iban: "PT50000700000000000000000", kind: "bank" },
      { headers },
    );
    const { data: ch } = await client.admin.createCharge(
      {
        kind: "receivable",
        nature: "debit",
        chargeType: "quota",
        scope: "unit",
        unitId: u.id,
        issueDate: "2026-01-01",
        competencePeriod: "2026-01-01",
        amountCents: 5000,
        description: "Quota Email Log Test",
      },
      { headers },
    );
    const { data: bt } = await client.admin.createBankTransaction(
      {
        bankAccountId: ba.id as string,
        transactionDate: "2026-01-15",
        amount: 5000,
        description: "Pagamento Quota Email Log",
      },
      { headers },
    );
    bankTxId = bt.id as string;
    await client.admin.createSettlement(
      {
        settlementType: "bank_reconciliation",
        bankTransactionId: bt.id,
        debitChargeId: ch.id as string,
        amount: 5000,
        settlementDate: "2026-01-15",
      },
      { headers },
    );
  });

  it("updateMe - guarda bccEmail no condo", async () => {
    const { data, status } = await client.admin.updateMe({ bccEmail }, { headers });
    assertEquals(status, 200);
    assertEquals((data as unknown as { bccEmail: string | null }).bccEmail, bccEmail);

    const row = await sql<{ bcc: string | null }[]>`
      SELECT bcc_email AS bcc FROM core.condominium WHERE id = ${condo.id}
    `;
    assertEquals(row[0].bcc, bccEmail);
  });

  it("emitReceipt - grava entry em audit.email_log com bcc + actor + recipient", async () => {
    const before = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM audit.email_log WHERE condominium_id = ${condo.id}
    `;
    assertEquals(before[0].n, 0);

    const { data, status } = await client.admin.emitReceipt(
      { bankTransactionId: bankTxId, unitId: unit.id },
      { headers },
    );
    assertEquals(status, 201);
    receiptId = data.receiptId;
    _receiptNumber = data.number;
    assertEquals(data.emailsSent, 1);

    // Filtramos por category='receipt' porque ao emitir um recibo a um
    // occupant SEM `core.user`, é também enviado um email de convite (auto-
    // invite), gerando 2 entries: 1 "invite" + 1 "receipt". Este teste é
    // especificamente sobre o email do recibo.
    const rows = await sql<{
      category: string;
      recipient: string;
      bcc: string | null;
      condo: string;
      unit: string | null;
      status: string;
      actor: { id: string; email: string | null } | null;
    }[]>`
      SELECT category, recipient, bcc, condominium_id AS condo, unit_id AS unit,
             status, actor
        FROM audit.email_log
       WHERE condominium_id = ${condo.id}
         AND category = 'receipt'
       ORDER BY created_at DESC
    `;
    assertEquals(rows.length, 1);
    assertEquals(rows[0].category, "receipt");
    assertEquals(rows[0].recipient, ownerEmail);
    assertEquals(rows[0].bcc, bccEmail);
    assertEquals(rows[0].condo, condo.id);
    assertEquals(rows[0].unit, unit.id);
    assertEquals(rows[0].status, "sent");
    // actor populado com snapshot do super (id, email).
    assertNotEquals(rows[0].actor, null);
    assertEquals(typeof rows[0].actor!.id, "string");
    assertEquals(rows[0].actor!.email, "super@mague.pt");
  });

  it("resendReceiptEmail - cria novo entry em email_log", async () => {
    const { status } = await client.admin.resendReceiptEmail(receiptId, { headers });
    assertEquals(status, 200);

    // Conta apenas categoria 'receipt' - o invite inicial fica de fora.
    // Com a emissão original (1 receipt) + resend (1 receipt) = 2 receipts.
    const rows = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n
        FROM audit.email_log
       WHERE condominium_id = ${condo.id}
         AND category = 'receipt'
    `;
    assertEquals(rows[0].n, 2);

    // O último entry de receipt tem bcc + actor.
    const last = await sql<{ bcc: string | null; actor: { id: string } | null }[]>`
      SELECT bcc, actor FROM audit.email_log
       WHERE condominium_id = ${condo.id}
         AND category = 'receipt'
       ORDER BY created_at DESC LIMIT 1
    `;
    assertEquals(last[0].bcc, bccEmail);
    assertNotEquals(last[0].actor, null);
  });

  it("limpar bccEmail (null) - emails seguintes NÃO levam BCC", async () => {
    await client.admin.updateMe({ bccEmail: null }, { headers });
    const row = await sql<{ bcc: string | null }[]>`
      SELECT bcc_email AS bcc FROM core.condominium WHERE id = ${condo.id}
    `;
    assertEquals(row[0].bcc, null);

    // Resend de novo → entry sem bcc.
    await client.admin.resendReceiptEmail(receiptId, { headers });
    const last = await sql<{ bcc: string | null }[]>`
      SELECT bcc FROM audit.email_log
       WHERE condominium_id = ${condo.id}
       ORDER BY created_at DESC LIMIT 1
    `;
    assertEquals(last[0].bcc, null);
  });

  it("forgot-password - email enviado mas NÃO logado em email_log", async () => {
    // Cria user com email único e verifica que o forgot-password de um user
    // existente não cria entry. (Não é específico do condo - vamos contar
    // entries onde category='password_reset' e nunca deve haver.)
    const userEmail = `email-log-pw-${stamp}@test.pt`;
    const hash = await bcrypt.hash("TestPass1234", 10);
    await sql`
      INSERT INTO core.user (name, email, role, is_active, password_hash)
      VALUES ('PWReset User', ${userEmail}, NULL, true, ${hash})
    `;

    const before = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM audit.email_log WHERE category = 'password_reset'
    `;
    assertEquals(before[0].n, 0);

    const res = await fetch(`${BASE_URL}/v1/auth/forgot-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: userEmail }),
    });
    // Endpoint sempre devolve 200/204 (sem leak - não revela se email existe).
    assertEquals(res.status === 200 || res.status === 204, true);
    await res.body?.cancel();

    const after = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM audit.email_log WHERE category = 'password_reset'
    `;
    assertEquals(after[0].n, 0);

    // Cleanup user de teste.
    await sql`DELETE FROM core.user WHERE email = ${userEmail}`;
  });

  it("emit_log: status='failed' e error preenchido se SMTP atirar", {
    ignore: true, // requer mock de SMTP - placeholder p/ futuro.
  }, () => {});

  it("audit.email_log está na cdc_skip_list (não auto-loga em audit.cdc_log)", async () => {
    const rows = await sql<{ schema: string; table: string }[]>`
      SELECT schema_name AS schema, table_name AS table
        FROM audit.cdc_skip_list
       WHERE schema_name = 'audit' AND table_name = 'email_log'
    `;
    assertEquals(rows.length, 1);
  });

  it("partições email_log existem para 2026/2027/2028 + default", async () => {
    const rows = await sql<{ relname: string }[]>`
      SELECT c.relname FROM pg_class c
        JOIN pg_inherits i ON i.inhrelid = c.oid
        JOIN pg_class p ON p.oid = i.inhparent
       WHERE p.relname = 'email_log' AND p.relnamespace = 'audit'::regnamespace
       ORDER BY c.relname
    `;
    const names = rows.map((r) => r.relname);
    assertEquals(names.includes("email_log_2026"), true);
    assertEquals(names.includes("email_log_2027"), true);
    assertEquals(names.includes("email_log_2028"), true);
    assertEquals(names.includes("email_log_default"), true);
  });

  it("audit.cdc_log existe (renomeado de audit.log) com partições yearly", async () => {
    const rows = await sql<{ relname: string }[]>`
      SELECT c.relname FROM pg_class c
        JOIN pg_inherits i ON i.inhrelid = c.oid
        JOIN pg_class p ON p.oid = i.inhparent
       WHERE p.relname = 'cdc_log' AND p.relnamespace = 'audit'::regnamespace
       ORDER BY c.relname
    `;
    const names = rows.map((r) => r.relname);
    assertEquals(names.includes("cdc_log_2026"), true);
    assertEquals(names.includes("cdc_log_2027"), true);
    assertEquals(names.includes("cdc_log_2028"), true);
  });

  it("audit.email_log guarda body_html + attachments + metadata", async () => {
    const cols = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'audit' AND table_name = 'email_log'
    `;
    const names = cols.map((c) => c.column_name);
    // body_html + attachments: o admin vê o email enviado.
    assertEquals(names.includes("body_html"), true);
    assertEquals(names.includes("attachments"), true);
    // Assertar que existem os campos de metadata esperados.
    for (const expected of ["category", "recipient", "bcc", "subject", "actor", "status"]) {
      assertEquals(
        names.includes(expected),
        true,
        `coluna "${expected}" deveria existir`,
      );
    }
    assertGreater(names.length, 0);
  });

  it("cleanup - remove condo + fecha conexão", async () => {
    try {
      await client.super.deleteCondominium(condo.id, { headers: AUTH });
    } finally {
      await sql.end();
    }
  });
});
