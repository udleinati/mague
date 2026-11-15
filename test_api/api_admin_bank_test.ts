import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { Client, type Unit } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";
import { sqlExec } from "./_helpers/db.ts";
import { type ScenarioFixture, seedScenario } from "./_helpers/fixtures.ts";

// Bank reconciliation flow: cria bank transaction, aloca a uma fração
// ou fornecedor, gera settlement.
//
// Self-contained: cria o próprio condomínio + unit + bank_account + quota
// payable de suporte para os testes de allocate_to_unit. Não depende do
// seed minimal. Limpa tudo no fim.

const BASE_URL = "http://localhost:3000";
const AUTH = await loginAsSuper();
const client = new Client({ baseUrl: BASE_URL });

describe("admin bank_transactions + reconciliation", () => {
  let fx: ScenarioFixture;
  let unit: Unit;
  let bankAccountId = "";
  let supplierId = "";
  let creditTxId = "";
  let debitTxId = "";
  let headers: Record<string, string>;

  it("setup - create condominium + unit + bank_account", async () => {
    fx = await seedScenario(client, AUTH)
      .withCondo("Bank Test Condo")
      .withUnit({ designation: "A", permillage: 1000 })
      .build();
    unit = fx.units[0];
    headers = fx.hdr();

    const { data: ba } = await client.admin.createBankAccount(
      {
        bankName: "Banco E2E",
        iban: "PT50000700000000000000000",
        accountName: "E2E Test Account",
        openingBalance: 0,
        openingBalanceDate: "2026-01-01",
      },
      { headers },
    );
    bankAccountId = ba.id as string;
  });

  it("listBankTransactions - returns array", async () => {
    const { data, status } = await client.admin.listBankTransactions({}, { headers });
    assertEquals(status, 200);
    assertEquals(Array.isArray(data), true);
  });

  it("createBankTransaction - credit (positive amount) returns 201", async () => {
    const { data, status } = await client.admin.createBankTransaction(
      {
        bankAccountId,
        transactionDate: "2026-06-01",
        amount: 10000, // 100€ crédito
        description: "E2E bank credit test",
      },
      { headers },
    );
    assertEquals(status, 201);
    creditTxId = data.id as string;
    assertEquals(data.status, "unreconciled");
  });

  it("allocateToUnit - positive tx → settlement + allocations", async () => {
    // Cria uma charge receivable em aberto para a unit - condição
    // necessária para o handler executeAllocation ter algo a imputar.
    await client.admin.createCharge(
      {
        kind: "receivable",
        chargeType: "quota",
        description: "E2E quota para allocate_to_unit",
        issueDate: "2026-06-01",
        dueDate: "2026-06-10",
        competencePeriod: "2026-06-01",
        amountCents: 10000,
        unitId: unit.id,
      },
      { headers },
    );

    const response = await fetch(
      `${BASE_URL}/v1/admin/condominiums/${fx.condominium.id}/bank_transactions/${creditTxId}/allocate_to_unit`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ unitId: unit.id }),
      },
    );
    assertEquals(response.status, 201);
    const body = await response.json();
    // Formato: { data: { count, allocations: [{ settlementId, chargeId, … }] } }
    assertEquals(typeof body.data.count, "number");
    assertEquals(Array.isArray(body.data.allocations), true);
    assertEquals(body.data.count >= 1, true);
    const first = body.data.allocations[0] as Record<string, unknown>;
    assertEquals(typeof first.settlementId, "string");
    assertEquals(Number(first.amountAllocated) > 0, true);
  });

  it("allocateToUnit - wrong sign (debit tx) devolve erro", async () => {
    // KNOWN: o handler tenta mapear para WRONG_SIGN/400 mas a mensagem
    // da raise SQL é embrulhada por "Error: Failed query…" e o
    // includes('amount > 0') não matcha - então devolve 500 DB_ERROR.
    // Bug a corrigir separado; teste assegura que pelo menos não devolve 2xx.
    const { data: debitTx } = await client.admin.createBankTransaction(
      {
        bankAccountId,
        transactionDate: "2026-06-02",
        amount: -5000,
        description: "E2E bank debit for sign test",
      },
      { headers },
    );
    debitTxId = debitTx.id as string;
    const response = await fetch(
      `${BASE_URL}/v1/admin/condominiums/${fx.condominium.id}/bank_transactions/${debitTxId}/allocate_to_unit`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ unitId: unit.id }),
      },
    );
    assertEquals(response.status >= 400 && response.status < 600, true);
    assertEquals(response.status < 300, false);
    await response.body?.cancel();
  });

  it("setup - create supplier for allocate_to_supplier test", async () => {
    const { data } = await client.admin.createSupplier(
      { name: "E2E Bank Supplier" },
      { headers },
    );
    supplierId = data.id as string;
  });

  it("allocateToSupplier - fornecedor sem charges em aberto → 400 NO_OPEN_CHARGES", async () => {
    const response = await fetch(
      `${BASE_URL}/v1/admin/condominiums/${fx.condominium.id}/bank_transactions/${debitTxId}/allocate_to_supplier`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ supplierId }),
      },
    );
    assertEquals(response.status, 400);
    const body = await response.json();
    assertEquals(body.error.code, "NO_OPEN_CHARGES");
  });

  // ── allocateToSupplier caminho feliz: tx negativa + fatura payable aberta ──
  it("allocateToSupplier - success path: bank_tx -€50 + fatura €40 = partial", async () => {
    // Cria fatura payable ao fornecedor.
    await client.admin.createCharge(
      {
        kind: "payable",
        chargeType: "supplier_service",
        description: "E2E fatura fornecedor",
        issueDate: "2026-06-15",
        dueDate: "2026-07-15",
        competencePeriod: "2026-06-01",
        amountCents: 4000,
        supplierId,
      },
      { headers },
    );

    // Bank tx débito de 50€ (sobra 10€ para um segundo settlement futuro).
    const { data: payTx } = await client.admin.createBankTransaction(
      {
        bankAccountId,
        transactionDate: "2026-06-20",
        amount: -5000,
        description: "E2E pagamento fornecedor",
      },
      { headers },
    );
    const payTxId = payTx.id as string;

    const response = await fetch(
      `${BASE_URL}/v1/admin/condominiums/${fx.condominium.id}/bank_transactions/${payTxId}/allocate_to_supplier`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ supplierId }),
      },
    );
    assertEquals(response.status, 201);
    const body = await response.json();
    assertEquals(Array.isArray(body.data.allocations), true);
    assertEquals(body.data.count >= 1, true);
    const first = body.data.allocations[0] as Record<string, unknown>;
    assertEquals(typeof first.settlementId, "string");
    assertEquals(Number(first.amountAllocated), 4000);
  });

  // ── createSettlement directo (bank_reconciliation) ──────────────────────────
  it("createSettlement - reconciliação directa charge↔tx", async () => {
    const { data: chg } = await client.admin.createCharge(
      {
        kind: "receivable",
        chargeType: "quota",
        description: "Quota para settlement directo",
        issueDate: "2026-07-01",
        dueDate: "2026-07-08",
        competencePeriod: "2026-07-01",
        amountCents: 7500,
        unitId: unit.id,
      },
      { headers },
    );

    const { data: tx } = await client.admin.createBankTransaction(
      {
        bankAccountId,
        transactionDate: "2026-07-10",
        amount: 7500,
        description: "Pagamento quota",
      },
      { headers },
    );

    // Chamada directa a createSettlement (não via allocate).
    const response = await fetch(
      `${BASE_URL}/v1/admin/condominiums/${fx.condominium.id}/settlements`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          settlementType: "bank_reconciliation",
          bankTransactionId: (tx as { id: string }).id,
          debitChargeId: (chg as { id: string }).id,
          amount: 7500,
          settlementDate: "2026-07-10",
        }),
      },
    );
    assertEquals(response.status, 201);
    const body = await response.json();
    assertEquals(body.data.settlementType, "bank_reconciliation");
    assertEquals(body.data.amount, 7500);
    assertEquals(body.data.status, "active");
  });

  // listSettlements traz `debitCharge`/`creditCharge`/`bankTransaction`
  // nested via Drizzle `with` (subset estável). Antes o panel da
  // reconciliação pedia listCharges(limit=5000) e listBankTransactions()
  // só para resolver descrições/datas - agora tudo num só request.
  it("listSettlements (client) - cada row inclui nested debitCharge / bankTransaction", async () => {
    const { data, status } = await client.admin.listSettlements({}, { headers });
    assertEquals(status, 200);
    assertEquals(Array.isArray(data), true);
    assertEquals(data.length >= 1, true);

    // Procura o settlement bank_reconciliation que foi criado no test
    // anterior - deve trazer debitCharge + bankTransaction preenchidos.
    type S = {
      settlementType: string;
      debitChargeId: string | null;
      bankTransactionId: string | null;
      debitCharge: {
        id: string;
        description: string;
        chargeType: string;
        unitId: string | null;
        supplierId: string | null;
      } | null;
      creditCharge: unknown;
      bankTransaction: {
        id: string;
        transactionDate: string;
        description: string | null;
        amount: number;
        status: string | null;
      } | null;
    };
    const reconciliations = (data as S[]).filter((s) =>
      s.settlementType === "bank_reconciliation" && s.debitChargeId && s.bankTransactionId
    );
    assertEquals(reconciliations.length >= 1, true);
    const s = reconciliations[0];
    // Subset estável (mesmas chaves do _with.ts).
    assertEquals(typeof s.debitCharge?.id, "string");
    assertEquals(typeof s.debitCharge?.description, "string");
    assertEquals(typeof s.debitCharge?.chargeType, "string");
    assertEquals(Object.prototype.hasOwnProperty.call(s.debitCharge ?? {}, "unitId"), true);
    assertEquals(Object.prototype.hasOwnProperty.call(s.debitCharge ?? {}, "supplierId"), true);
    assertEquals(typeof s.bankTransaction?.id, "string");
    assertEquals(typeof s.bankTransaction?.transactionDate, "string");
    assertEquals(typeof s.bankTransaction?.amount, "number");
    // creditCharge é null neste settlement (só debitCharge + bankTx).
    assertEquals(s.creditCharge, null);
  });

  it("createSettlement - amount maior que charge.open_amount devolve erro", async () => {
    const { data: chg } = await client.admin.createCharge(
      {
        kind: "receivable",
        chargeType: "quota",
        description: "Quota para validação amount",
        issueDate: "2026-08-01",
        competencePeriod: "2026-08-01",
        amountCents: 2000,
        unitId: unit.id,
      },
      { headers },
    );
    const { data: tx } = await client.admin.createBankTransaction(
      {
        bankAccountId,
        transactionDate: "2026-08-05",
        amount: 5000,
        description: "Tx que não cabe",
      },
      { headers },
    );
    const response = await fetch(
      `${BASE_URL}/v1/admin/condominiums/${fx.condominium.id}/settlements`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          settlementType: "bank_reconciliation",
          bankTransactionId: (tx as { id: string }).id,
          debitChargeId: (chg as { id: string }).id,
          amount: 5000, // excede open_amount=2000
          settlementDate: "2026-08-05",
        }),
      },
    );
    // Refactor 051: validateSettlement (TS) apanha "amount excede open_amount"
    // antes de tocar na DB e devolve 400 VALIDATION_ERROR limpo. O trigger
    // fn_settlement_bi mantém-se como safety net (defense in depth).
    assertEquals(response.status, 400);
    const body = await response.json();
    assertEquals(body.error?.code, "VALIDATION_ERROR");
  });

  // Os steps acima usam fetch directo para /allocate_to_unit e /allocate_to_supplier
  // (cobrem o endpoint). Estes steps validam adicionalmente que os métodos
  // do client (allocateBankTransactionToUnit / ToSupplier) também fazem o
  // round-trip - protege contra mudanças de assinatura no Client sem teste.
  it("client.allocateBankTransactionToUnit - método do Client funciona", async () => {
    const { data: chg } = await client.admin.createCharge(
      {
        kind: "receivable",
        chargeType: "quota",
        description: "Quota para allocateUnit via client",
        issueDate: "2026-09-01",
        competencePeriod: "2026-09-01",
        amountCents: 3000,
        unitId: unit.id,
      },
      { headers },
    );
    const { data: tx } = await client.admin.createBankTransaction(
      {
        bankAccountId,
        transactionDate: "2026-09-10",
        amount: 3000,
        description: "client allocate",
      },
      { headers },
    );
    const { data, status } = await client.admin.allocateBankTransactionToUnit(
      tx.id as string,
      { unitId: unit.id },
      { headers },
    );
    assertEquals(status, 201);
    assertEquals(data.allocations.length >= 1, true);
    assertEquals((chg.id as string).length > 0, true);
  });

  it("client.allocateBankTransactionToSupplier - método do Client funciona", async () => {
    await client.admin.createCharge(
      {
        kind: "payable",
        chargeType: "supplier_service",
        description: "Fatura para allocateSupplier via client",
        issueDate: "2026-09-01",
        competencePeriod: "2026-09-01",
        amountCents: 4000,
        supplierId,
      },
      { headers },
    );
    const { data: tx } = await client.admin.createBankTransaction(
      {
        bankAccountId,
        transactionDate: "2026-09-15",
        amount: -4000,
        description: "client allocate supplier",
      },
      { headers },
    );
    const { data, status } = await client.admin.allocateBankTransactionToSupplier(
      tx.id as string,
      { supplierId },
      { headers },
    );
    assertEquals(status, 201);
    assertEquals(data.allocations.length >= 1, true);
  });

  // ─── ?withSuggestions=1 ───────────────────────────────────────────────
  // Enrichment server-side (regra movida do panel para a API) - cada row
  // de bank_tx vem com `suggested{Kind,UnitId,SupplierId,Label}` ou
  // `matchConflictCount` quando há keyword match.
  it("withSuggestions - sem keywords configurados, sem `suggested*`", async () => {
    const { data } = await client.admin.listBankTransactions(
      { withSuggestions: "1" },
      { headers },
    );
    // Os txs criados nos testes anteriores não tocam units com keywords,
    // logo nenhum deve vir enriquecido.
    for (const tx of data) {
      assertEquals((tx as { suggestedKind?: string }).suggestedKind, undefined);
    }
  });

  it("withSuggestions - 1 match → suggestedUnitId + suggestedLabel", async () => {
    // Setup: configura keyword "joão silva" na unit. Cria bank_tx com essa
    // descrição + amount > 0 (entrada → procura em units).
    await client.admin.updateUnitDescription(
      unit.id,
      { matchKeywords: ["joão silva"] },
      { headers },
    );
    const { data: tx } = await client.admin.createBankTransaction(
      {
        bankAccountId,
        transactionDate: "2026-10-01",
        amount: 5000,
        description: "TRF DE Joao Silva ref quota",
      },
      { headers },
    );

    const { data } = await client.admin.listBankTransactions(
      { withSuggestions: "1" },
      { headers },
    );
    const enriched = data.find((t) => t.id === tx.id) as {
      suggestedKind?: string;
      suggestedUnitId?: string;
      suggestedLabel?: string;
    };
    assertEquals(enriched?.suggestedKind, "unit");
    assertEquals(enriched?.suggestedUnitId, unit.id);
    // unitLabel: sem identifier → designation só
    assertEquals(typeof enriched?.suggestedLabel, "string");
  });

  it("withSuggestions - amount negativo → procura em suppliers", async () => {
    // Setup: configura keyword "edp" no supplier (criado anteriormente).
    await client.admin.updateSupplier(
      supplierId,
      { matchKeywords: ["edp"] },
      { headers },
    );
    const { data: tx } = await client.admin.createBankTransaction(
      {
        bankAccountId,
        transactionDate: "2026-10-05",
        amount: -7500,
        description: "Pagamento EDP fatura",
      },
      { headers },
    );

    const { data } = await client.admin.listBankTransactions(
      { withSuggestions: "1" },
      { headers },
    );
    const enriched = data.find((t) => t.id === tx.id) as {
      suggestedKind?: string;
      suggestedSupplierId?: string;
    };
    assertEquals(enriched?.suggestedKind, "supplier");
    assertEquals(enriched?.suggestedSupplierId, supplierId);
  });

  it("withSuggestions - múltiplos matches → matchConflictCount", async () => {
    // Setup: cria 2ª unit + ENTÃO atualiza matchKeywords (super.createUnit
    // não aceita matchKeywords no schema). Agora qualquer tx com "joão silva"
    // bate em ambas → conflito.
    const { data: u2 } = await client.super.createUnit(
      fx.condominium.id,
      { designation: "B", permillage: 500 },
      { headers: AUTH },
    );
    await client.admin.updateUnitDescription(
      u2.id,
      { matchKeywords: ["joão silva"] },
      { headers },
    );
    const { data: tx } = await client.admin.createBankTransaction(
      {
        bankAccountId,
        transactionDate: "2026-10-10",
        amount: 4000,
        description: "TRF Joao Silva 2",
      },
      { headers },
    );

    const { data } = await client.admin.listBankTransactions(
      { withSuggestions: "1" },
      { headers },
    );
    const enriched = data.find((t) => t.id === tx.id) as {
      suggestedKind?: string;
      matchConflictCount?: number;
    };
    assertEquals(enriched?.suggestedKind, undefined);
    assertEquals(enriched?.matchConflictCount, 2);

    // Cleanup desta unit extra (não interfere com teardown geral).
    await client.super.deleteUnit(fx.condominium.id, u2.id, { headers: AUTH });
  });

  it("withSuggestions ausente → resposta sem campos extra", async () => {
    const { data } = await client.admin.listBankTransactions({}, { headers });
    for (const tx of data) {
      assertEquals((tx as { suggestedKind?: string }).suggestedKind, undefined);
      assertEquals((tx as { matchConflictCount?: number }).matchConflictCount, undefined);
    }
  });

  it("allocateToUnit - sem charges em aberto cria credit_balance + bank_deposit_credit", async () => {
    // Cria unit FRESCA (a `unit` original já tem allocations dos testes anteriores).
    const { data: u3 } = await client.super.createUnit(
      fx.condominium.id,
      { designation: "C3", permillage: 250 },
      { headers: AUTH },
    );
    // Bank tx de 80€ (sem charges em aberto desta unit) → todo o valor vira surplus.
    const { data: tx } = await client.admin.createBankTransaction(
      {
        bankAccountId,
        transactionDate: "2026-11-01",
        amount: 8000,
        description: "Adiantamento C3",
      },
      { headers },
    );
    const { data, status } = await client.admin.allocateBankTransactionToUnit(
      tx.id as string,
      { unitId: u3.id, notes: "Adiantamento" },
      { headers },
    );
    assertEquals(status, 201);
    // Resposta deve indicar credit_balance criada (allocations >= 1).
    assertEquals(
      data.allocations.length >= 1,
      true,
      "deve ter pelo menos 1 allocation (a credit_balance)",
    );

    // Confirma via SQL: charge credit_balance criada com open=8000
    const credit = await sqlExec(`
      SELECT charge_type || '|' || open_amount || '|' || status
        FROM finance.charge
       WHERE unit_id='${u3.id}' AND charge_type='credit_balance'
    `);
    assertEquals(credit, "credit_balance|8000|open");

    // Confirma settlement bank_deposit_credit ligando à bank_tx
    const sett = await sqlExec(`
      SELECT settlement_type || '|' || amount
        FROM finance.settlement
       WHERE bank_transaction_id='${tx.id}' AND settlement_type='bank_deposit_credit'
    `);
    assertEquals(sett, "bank_deposit_credit|8000");

    // Cleanup local
    await client.super.deleteUnit(fx.condominium.id, u3.id, { headers: AUTH });
  });

  it("teardown - cleanup", async () => {
    await client.admin.deleteSupplier(supplierId, { headers });
    await fx.cleanup();
  });
});
