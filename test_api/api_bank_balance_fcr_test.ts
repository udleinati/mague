// Pentest E2E: roundtrip completo do FCR via HTTP, da criação da quota
// à reconciliação bancária, à leitura do balance.
//
// Cobre o fluxo end-to-end:
//   1. Super cria condomínio, unit, bank_account com opening balance (com FCR)
//   2. Admin cria budget com fcr_percentage=10%
//   3. Geração da quota (110€ = 100 ord + 10 FCR)
//   4. Bank tx é registado e reconciliado contra a charge
//   5. GET /bank-accounts/balances devolve `fcr_cents` aumentado
//
// Validações:
//   - O ratio FCR é preservado do charge ao bank balance
//   - Se o settlement entrasse só na bolsa ordinária, (5) falhava

import { assertEquals, assertExists } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { Client, type Condominium, type Unit } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";
import { sqlExec } from "./_helpers/db.ts";

const BASE_URL = "http://localhost:3000";
const client = new Client({ baseUrl: BASE_URL });
const MASTER = await loginAsSuper();

describe("E2E - FCR bank balance roundtrip via HTTP", () => {
  let condo: Condominium;
  let unit: Unit;
  let bankAccountId = "";
  let chargeId = "";

  const hdr = () => ({ ...MASTER, "x-condominium-id": condo.id });

  it("setup: condo + unit + bank account com opening balance", async () => {
    const ts = Date.now();
    condo = (await client.super.createCondominium(
      { name: `FCR E2E ${ts}` },
      { headers: MASTER },
    )).data;
    unit = (await client.super.createUnit(
      condo.id,
      { designation: "FRACA", permillage: 1000 },
      { headers: MASTER },
    )).data;

    // Bank account inserido directo via SQL (mais simples que via API)
    bankAccountId = (await sqlExec(`
      INSERT INTO finance.bank_account
        (id, condominium_id, bank_name, account_name, iban, kind,
         opening_balance, opening_balance_ordinary_cents, opening_balance_fcr_cents,
         opening_balance_date)
      VALUES ('bk_e2e_${ts}', '${condo.id}', 'Banco E2E', 'Principal', 'PT50E2E${ts}',
              'bank', 0, 0, 0, '2026-01-01')
      RETURNING id`)).split("\n")[0].trim();
    assertExists(bankAccountId);
  });

  it("(1) GET /bank-accounts/balances inicial - tudo zero", async () => {
    const { data } = await client.admin.getBankAccountsBalances({ headers: hdr() });
    assertEquals(data.ordinaryCents, 0);
    assertEquals(data.fcrCents, 0);
    assertEquals(data.totalCents, 0);
  });

  it("(2) Cria budget com FCR 10% + quota de 110€ via SQL (geração depende de fluxos longos)", async () => {
    const ts = Date.now();
    // Budget directo via SQL (com fcr_percentage=10) + quota directa
    await sqlExec(`
      INSERT INTO core.budget (id, condominium_id, year, type, status, fcr_percentage)
      VALUES ('bg_e2e_${ts}', '${condo.id}', 2026, 'principal', 'approved', 10.00);
    `);
    // Charge: original_amount=11000 (110€), fn_charge_ai vai automaticamente
    // emitir 721=10000 + 723=1000 (10% FCR aditivo)
    chargeId = (await sqlExec(`
      INSERT INTO finance.charge (
        id, condominium_id, unit_id, scope, kind, nature, charge_type, description,
        issue_date, due_date, competence_period, original_amount, expected_amount,
        open_amount, amount, source_type, source_id
      ) VALUES (
        'ch_e2e_${ts}', '${condo.id}', '${unit.id}', 'unit',
        'receivable', 'debit', 'quota', 'Quota Janeiro FCR 10%',
        '2026-01-01', '2026-01-15', '2026-01-01',
        11000, 11000, 11000, 0, 'budget', 'bg_e2e_${ts}'
      ) RETURNING id`)).split("\n")[0].trim();
    assertExists(chargeId);
  });

  it("(3) Reconcilia charge via API: cria bank_tx + settlement de 110€", async () => {
    const ts = Date.now();
    // Bank transaction via SQL (simula extracto importado)
    const btxId = (await sqlExec(`
      INSERT INTO finance.bank_transaction (
        id, condominium_id, bank_account_id, transaction_date, amount, description, status
      ) VALUES (
        'btx_e2e_${ts}', '${condo.id}', '${bankAccountId}', '2026-01-20', 11000,
        'Pag quota Jan', 'unreconciled'
      ) RETURNING id`)).split("\n")[0].trim();

    // Settlement de bank_reconciliation via API (exercita o trigger com FCR
    // split). Endpoint: POST /v1/admin/condominiums/:cid/settlements
    const url = `${BASE_URL}/v1/admin/condominiums/${condo.id}/settlements`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { ...hdr(), "Content-Type": "application/json" },
      body: JSON.stringify({
        settlementType: "bank_reconciliation",
        bankTransactionId: btxId,
        debitChargeId: chargeId,
        amount: 11000,
        settlementDate: "2026-01-20",
        notes: "Pagamento quota integral",
      }),
    });
    assertEquals(resp.status, 201, `Settlement create status: ${resp.status}`);
    await resp.body?.cancel();
  });

  it("(4) GET /bank-accounts/balances reflete o split: 100€ ord + 10€ FCR", async () => {
    const { data } = await client.admin.getBankAccountsBalances({ headers: hdr() });
    assertEquals(data.ordinaryCents, 10000, "ordinaryCents devia ser 10000 (€100)");
    assertEquals(
      data.fcrCents,
      1000,
      "fcrCents devia ser 1000 (€10) - FCR físico alinhado com 723",
    );
    assertEquals(data.totalCents, 11000, "totalCents = 11000 (€110, total da quota)");
  });

  it("(5) v_bank_balance via SQL bate com a API", async () => {
    const result = await sqlExec(`
      SELECT ordinary_cents, fcr_cents, total_cents
        FROM finance.v_bank_balance
       WHERE condominium_id='${condo.id}'`);
    const [ord, fcr, total] = result.split("|").map((s) => Number(s.trim()));
    assertEquals(ord, 10000);
    assertEquals(fcr, 1000);
    assertEquals(total, 11000);
  });

  it("teardown", async () => {
    await client.super.deleteCondominium(condo.id, { headers: MASTER });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Reverse de bank_tx com FCR via HTTP
// ═══════════════════════════════════════════════════════════════════════════
// pgTAP 0046 (caso A) cobre o ledger inverse no SQL. Aqui validamos o
// caminho HTTP completo: handler `reverseBankTransaction` (TS) orquestra
// UPDATE bank_tx + iter settlements + applyReverseEffects + auto-void
// recibos. O fluxo todo deve devolver o balance ao zero E reabrir a charge.

describe("E2E - reverse bank_tx com FCR devolve balance ao zero", () => {
  let condo: Condominium;
  let unit: Unit;
  let bankAccountId = "";
  let chargeId = "";
  let bankTxId = "";

  const hdr = () => ({ ...MASTER, "x-condominium-id": condo.id });

  it("setup + reconciliação inicial (110€ = 100 ord + 10 fcr)", async () => {
    const ts = Date.now();
    condo = (await client.super.createCondominium(
      { name: `FCR Reverse E2E ${ts}` },
      { headers: MASTER },
    )).data;
    unit = (await client.super.createUnit(
      condo.id,
      { designation: "FRACA", permillage: 1000 },
      { headers: MASTER },
    )).data;
    bankAccountId = (await sqlExec(`
      INSERT INTO finance.bank_account
        (id, condominium_id, bank_name, account_name, iban, kind,
         opening_balance, opening_balance_ordinary_cents, opening_balance_fcr_cents,
         opening_balance_date)
      VALUES ('bk_rev_${ts}', '${condo.id}', 'Banco Rev', 'Principal',
              'PT50REV${ts}', 'bank', 0, 0, 0, '2026-01-01')
      RETURNING id`)).split("\n")[0].trim();
    await sqlExec(`
      INSERT INTO core.budget (id, condominium_id, year, type, status, fcr_percentage)
      VALUES ('bg_rev_${ts}', '${condo.id}', 2026, 'principal', 'approved', 10.00)`);
    chargeId = (await sqlExec(`
      INSERT INTO finance.charge (
        id, condominium_id, unit_id, scope, kind, nature, charge_type, description,
        issue_date, due_date, competence_period, original_amount, expected_amount,
        open_amount, amount, source_type, source_id
      ) VALUES (
        'ch_rev_${ts}', '${condo.id}', '${unit.id}', 'unit',
        'receivable', 'debit', 'quota', 'Quota Reverse FCR 10%',
        '2026-01-01', '2026-01-15', '2026-01-01',
        11000, 11000, 11000, 0, 'budget', 'bg_rev_${ts}'
      ) RETURNING id`)).split("\n")[0].trim();
    bankTxId = (await sqlExec(`
      INSERT INTO finance.bank_transaction (
        id, condominium_id, bank_account_id, transaction_date, amount, description, status
      ) VALUES (
        'btx_rev_${ts}', '${condo.id}', '${bankAccountId}', '2026-01-20', 11000,
        'Pag rev', 'unreconciled'
      ) RETURNING id`)).split("\n")[0].trim();

    // Reconcilia via API (faz applySettlementEffects + ledger trigger + FCR split).
    const { status } = await client.admin.createSettlement(
      {
        settlementType: "bank_reconciliation",
        bankTransactionId: bankTxId,
        debitChargeId: chargeId,
        amount: 11000,
        settlementDate: "2026-01-20",
      },
      { headers: hdr() },
    );
    assertEquals(status, 201);

    // Estado pós-reconciliação
    const { data: bal } = await client.admin.getBankAccountsBalances({ headers: hdr() });
    assertEquals(bal.ordinaryCents, 10000);
    assertEquals(bal.fcrCents, 1000);
  });

  it("reverseBankTransaction → balance volta a zero (ord+fcr)", async () => {
    const { data, status } = await client.admin.reverseBankTransaction(
      bankTxId,
      { reason: "Pagamento devolvido pelo banco - estorno" },
      { headers: hdr() },
    );
    assertEquals(status, 200);
    assertEquals(data.status, "reversed");

    const { data: bal } = await client.admin.getBankAccountsBalances({ headers: hdr() });
    assertEquals(bal.ordinaryCents, 0, "ord deve voltar a zero");
    assertEquals(bal.fcrCents, 0, "fcr deve voltar a zero (ledger inverso preserva split)");
    assertEquals(bal.totalCents, 0);
  });

  it("após reverse, charge volta a abertura com open_amount=11000", async () => {
    const { data: charge } = await client.admin.getCharge(chargeId, { headers: hdr() });
    // Status deve ter regredido de paid → aberta. Como a due_date (2026-01-15)
    // está no passado, o computed status é 'overdue'; em condos com due futura
    // viria 'open'. Aceitamos ambos.
    const status = (charge as { status: string }).status;
    assertEquals(["open", "overdue"].includes(status), true, `unexpected status: ${status}`);
    assertEquals(Number((charge as { openAmount: number }).openAmount), 11000);
  });

  it("settlement original ficou 'reversed'", async () => {
    // Procuramos via SQL porque listSettlements não filtra por bank_tx ID.
    const result = await sqlExec(`
      SELECT status FROM finance.settlement
       WHERE bank_transaction_id = '${bankTxId}'`);
    assertEquals(result, "reversed");
  });

  it("teardown", async () => {
    await client.super.deleteCondominium(condo.id, { headers: MASTER });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Pagamento parcial com FCR proporcional via HTTP
// ═══════════════════════════════════════════════════════════════════════════
// pgTAP 0046 (caso B) valida que settlement parcial gera ledger ord/fcr
// proporcional. Aqui validamos via API: balance reflete split correcto e
// charge fica `partial` com open_amount restante.

describe("E2E - settlement parcial reflete split FCR proporcional", () => {
  let condo: Condominium;
  let unit: Unit;
  let bankAccountId = "";
  let chargeId = "";
  let bankTxId1 = "";
  let bankTxId2 = "";

  const hdr = () => ({ ...MASTER, "x-condominium-id": condo.id });

  it("setup: condo + quota 110€ (10% FCR) + 2 bank_txs de 55€ cada", async () => {
    const ts = Date.now();
    condo = (await client.super.createCondominium(
      { name: `FCR Partial E2E ${ts}` },
      { headers: MASTER },
    )).data;
    unit = (await client.super.createUnit(
      condo.id,
      { designation: "FRACA", permillage: 1000 },
      { headers: MASTER },
    )).data;
    bankAccountId = (await sqlExec(`
      INSERT INTO finance.bank_account
        (id, condominium_id, bank_name, account_name, iban, kind,
         opening_balance, opening_balance_ordinary_cents, opening_balance_fcr_cents,
         opening_balance_date)
      VALUES ('bk_par_${ts}', '${condo.id}', 'Banco Par', 'Principal',
              'PT50PAR${ts}', 'bank', 0, 0, 0, '2026-01-01')
      RETURNING id`)).split("\n")[0].trim();
    await sqlExec(`
      INSERT INTO core.budget (id, condominium_id, year, type, status, fcr_percentage)
      VALUES ('bg_par_${ts}', '${condo.id}', 2026, 'principal', 'approved', 10.00)`);
    chargeId = (await sqlExec(`
      INSERT INTO finance.charge (
        id, condominium_id, unit_id, scope, kind, nature, charge_type, description,
        issue_date, due_date, competence_period, original_amount, expected_amount,
        open_amount, amount, source_type, source_id
      ) VALUES (
        'ch_par_${ts}', '${condo.id}', '${unit.id}', 'unit',
        'receivable', 'debit', 'quota', 'Quota Partial FCR 10%',
        '2026-01-01', '2026-01-15', '2026-01-01',
        11000, 11000, 11000, 0, 'budget', 'bg_par_${ts}'
      ) RETURNING id`)).split("\n")[0].trim();
    bankTxId1 = (await sqlExec(`
      INSERT INTO finance.bank_transaction
        (id, condominium_id, bank_account_id, transaction_date, amount, description, status)
      VALUES ('btx_par1_${ts}', '${condo.id}', '${bankAccountId}', '2026-01-20',
              5500, 'Pag parcial 1', 'unreconciled')
      RETURNING id`)).split("\n")[0].trim();
    bankTxId2 = (await sqlExec(`
      INSERT INTO finance.bank_transaction
        (id, condominium_id, bank_account_id, transaction_date, amount, description, status)
      VALUES ('btx_par2_${ts}', '${condo.id}', '${bankAccountId}', '2026-02-15',
              5500, 'Pag parcial 2', 'unreconciled')
      RETURNING id`)).split("\n")[0].trim();
  });

  it("(1) Settlement parcial 50% → ord 50€ + fcr 5€ (proporcional)", async () => {
    const { status } = await client.admin.createSettlement(
      {
        settlementType: "bank_reconciliation",
        bankTransactionId: bankTxId1,
        debitChargeId: chargeId,
        amount: 5500,
        settlementDate: "2026-01-20",
      },
      { headers: hdr() },
    );
    assertEquals(status, 201);

    const { data: bal } = await client.admin.getBankAccountsBalances({ headers: hdr() });
    assertEquals(bal.ordinaryCents, 5000, "ord deve ser 50€ (proporção 90.9% de 55€)");
    assertEquals(bal.fcrCents, 500, "fcr deve ser 5€ (proporção 9.1% de 55€)");
    assertEquals(bal.totalCents, 5500);
  });

  it("(2) Charge fica 'partial' com open_amount=5500", async () => {
    const { data: charge } = await client.admin.getCharge(chargeId, { headers: hdr() });
    assertEquals((charge as { status: string }).status, "partial");
    assertEquals(Number((charge as { openAmount: number }).openAmount), 5500);
    assertEquals(Number((charge as { settledAmount: number }).settledAmount), 5500);
  });

  it("(3) Segundo settlement completa → ord 100€ + fcr 10€", async () => {
    const { status } = await client.admin.createSettlement(
      {
        settlementType: "bank_reconciliation",
        bankTransactionId: bankTxId2,
        debitChargeId: chargeId,
        amount: 5500,
        settlementDate: "2026-02-15",
      },
      { headers: hdr() },
    );
    assertEquals(status, 201);

    const { data: bal } = await client.admin.getBankAccountsBalances({ headers: hdr() });
    assertEquals(bal.ordinaryCents, 10000, "soma final dos 2 settlements: 100€");
    assertEquals(bal.fcrCents, 1000, "soma final dos 2 settlements: 10€");
    assertEquals(bal.totalCents, 11000);
  });

  it("(4) Charge fica 'paid' com open_amount=0", async () => {
    const { data: charge } = await client.admin.getCharge(chargeId, { headers: hdr() });
    assertEquals((charge as { status: string }).status, "paid");
    assertEquals(Number((charge as { openAmount: number }).openAmount), 0);
    assertEquals(Number((charge as { settledAmount: number }).settledAmount), 11000);
  });

  it("teardown", async () => {
    await client.super.deleteCondominium(condo.id, { headers: MASTER });
  });
});
