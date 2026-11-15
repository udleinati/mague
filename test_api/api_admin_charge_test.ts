// Testes para o módulo de charges:
//   - createCharge (payable debit, receivable credit adjustment)
//   - updateCharge (novo endpoint PATCH /charges/:id)
//   - filters por kind/nature/scope
//   - competencePeriod no formato YYYY-MM (serializer truncates)
//   - locks: charges com settlements não podem ser editadas

import { assertEquals, assertRejects } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { ApiError, Client, type Condominium, type Unit } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";
import { type ScenarioFixture, seedScenario } from "./_helpers/fixtures.ts";

const BASE_URL = "http://localhost:3000";
const client = new Client({ baseUrl: BASE_URL });
const MASTER = await loginAsSuper();

describe("admin charges - CRUD + filters", () => {
  let fx: ScenarioFixture;
  let condo: Condominium;
  let unit: Unit;
  let debitChargeId = "";
  let creditChargeId = "";

  const hdr = () => fx.hdr();

  it("setup - condomínio + unit", async () => {
    fx = await seedScenario(client, MASTER)
      .withCondo("Charges Test Condo")
      .withUnit({ designation: "A", permillage: 500, description: "unit A" })
      .build();
    condo = fx.condominium;
    unit = fx.units[0];
  });

  // ─── Create ──────────────────────────────────────────────────────
  it("createCharge - payable debit (fatura fornecedor) retorna 201", async () => {
    const { data, status } = await client.admin.createCharge(
      {
        kind: "payable",
        chargeType: "expense",
        description: "EDP Abril 2027",
        issueDate: "2027-04-15",
        dueDate: "2027-05-01",
        competencePeriod: "2027-04-01",
        amountCents: 10000,
      },
      { headers: hdr() },
    );
    assertEquals(status, 201);
    assertEquals(data.nature, "debit"); // default
    assertEquals(data.kind, "payable");
    debitChargeId = data.id as string;
  });

  // O serializer trunca competencePeriod para YYYY-MM.
  it("getCharge - competencePeriod é devolvido como YYYY-MM", async () => {
    const { data } = await client.admin.getCharge(debitChargeId, { headers: hdr() });
    assertEquals(data.competencePeriod, "2027-04");
  });

  // Nested unit/supplier/account: a API resolve via Drizzle `with`
  // (subset estável). Para esta charge payable sem unit/supplier/account
  // FKs, todos os 3 vêm null. O panel deixa de pedir 3 listagens
  // completas só para resolver os nomes.
  it("getCharge - nested unit/supplier/account null quando FKs são null", async () => {
    const { data } = await client.admin.getCharge(debitChargeId, { headers: hdr() }) as unknown as {
      data: { unit: unknown; supplier: unknown; account: unknown };
    };
    assertEquals(data.unit, null);
    assertEquals(data.supplier, null);
    assertEquals(data.account, null);
  });

  it("getCharge - nested unit preenchido quando charge é de uma fração", async () => {
    // Cria uma quota receivable contra a unit do setup.
    const { data: chg } = await client.admin.createCharge(
      {
        kind: "receivable",
        chargeType: "quota",
        description: "Quota teste nested",
        issueDate: "2031-01-15",
        dueDate: "2031-01-31",
        competencePeriod: "2031-01-01",
        amountCents: 5000,
        unitId: unit.id,
      },
      { headers: hdr() },
    );
    const { data } = await client.admin.getCharge(chg.id as string, {
      headers: hdr(),
    }) as unknown as {
      data: {
        unit: { id: string; designation: string; identifier: string | null } | null;
        supplier: unknown;
        account: unknown;
      };
    };
    assertEquals(data.unit?.id, unit.id);
    assertEquals(typeof data.unit?.designation, "string");
    // identifier é nullable mas a propriedade tem de existir.
    assertEquals(Object.prototype.hasOwnProperty.call(data.unit ?? {}, "identifier"), true);
    // Supplier e account ainda nulos (nesta charge).
    assertEquals(data.supplier, null);
    assertEquals(data.account, null);
  });

  it("listCharges - cada row inclui nested unit/supplier/account", async () => {
    const { data } = await client.admin.listCharges({}, { headers: hdr() }) as unknown as {
      data: Array<Record<string, unknown>>;
    };
    assertEquals(data.length >= 1, true);
    for (const c of data) {
      // Os 3 campos têm de existir em todas as linhas, ainda que null.
      assertEquals(Object.prototype.hasOwnProperty.call(c, "unit"), true);
      assertEquals(Object.prototype.hasOwnProperty.call(c, "supplier"), true);
      assertEquals(Object.prototype.hasOwnProperty.call(c, "account"), true);
    }
  });

  it("createCharge - receivable credit (ajuste à fração) retorna 201", async () => {
    const { data, status } = await client.admin.createCharge(
      {
        kind: "receivable",
        nature: "credit",
        chargeType: "credit_adjustment",
        description: "Reembolso ajuste",
        issueDate: "2027-04-20",
        competencePeriod: "2027-04-01",
        amountCents: 5000,
        unitId: unit.id,
      },
      { headers: hdr() },
    );
    assertEquals(status, 201);
    assertEquals(data.nature, "credit");
    assertEquals(data.kind, "receivable");
    assertEquals(data.scope, "unit");
    creditChargeId = data.id as string;
  });

  // ─── Filters ──────────────────────────────────────────────────────
  it("listCharges - filter by nature=debit só devolve débitos", async () => {
    const { data } = await client.admin.listCharges(
      { nature: "debit" },
      { headers: hdr() },
    ) as unknown as { data: Array<{ nature: string }> };
    assertEquals(data.every((c) => c.nature === "debit"), true);
  });

  it("listCharges - filter by nature=credit só devolve créditos", async () => {
    const { data } = await client.admin.listCharges(
      { nature: "credit" },
      { headers: hdr() },
    ) as unknown as { data: Array<{ nature: string }> };
    assertEquals(data.every((c) => c.nature === "credit"), true);
    assertEquals(data.length >= 1, true);
  });

  it("listCharges - filter by scope=unit excluí condominium-level", async () => {
    const { data } = await client.admin.listCharges(
      { scope: "unit" },
      { headers: hdr() },
    ) as unknown as { data: Array<{ scope: string }> };
    assertEquals(data.every((c) => c.scope === "unit"), true);
  });

  // ─── Filtro de tipo (vista "A Receber" do panel) ─────────────────
  // O painel separa quota ordinária / extraordinária / "Outras". "Outras" vai
  // por EXCLUSÃO (chargeTypeNot): um tipo novo (juros, penalização) aparece lá
  // sozinho, em vez de desaparecer até alguém o acrescentar a uma include-list.
  it("listCharges - chargeType=extraordinary_quota só devolve extraordinárias", async () => {
    await client.admin.createCharge(
      {
        kind: "receivable",
        chargeType: "extraordinary_quota",
        description: "Obra da cobertura",
        issueDate: "2032-03-01",
        dueDate: "2032-03-31",
        competencePeriod: "2032-03-01",
        amountCents: 20000,
        unitId: unit.id,
      },
      { headers: hdr() },
    );
    const { data } = await client.admin.listCharges(
      { kind: "receivable", nature: "debit", chargeType: "extraordinary_quota" },
      { headers: hdr() },
    ) as unknown as { data: Array<{ chargeType: string }> };
    assertEquals(data.length > 0, true);
    assertEquals(data.every((c) => c.chargeType === "extraordinary_quota"), true);
  });

  it("listCharges - chargeTypeNot=quota,extraordinary_quota devolve só as 'Outras'", async () => {
    await client.admin.createCharge(
      {
        kind: "receivable",
        chargeType: "interest",
        description: "Juros de mora",
        issueDate: "2032-04-01",
        dueDate: "2032-04-30",
        competencePeriod: "2032-04-01",
        amountCents: 500,
        unitId: unit.id,
      },
      { headers: hdr() },
    );
    const { data } = await client.admin.listCharges(
      {
        kind: "receivable",
        nature: "debit",
        chargeTypeNot: "quota,extraordinary_quota",
      },
      { headers: hdr() },
    ) as unknown as { data: Array<{ chargeType: string }> };
    assertEquals(data.some((c) => c.chargeType === "interest"), true);
    assertEquals(
      data.some((c) => c.chargeType === "quota" || c.chargeType === "extraordinary_quota"),
      false,
    );
  });

  // Exclusão vazia não pode significar "exclui tudo" (o panel manda o param
  // ausente quando o filtro está em "Todos").
  it("listCharges - sem chargeTypeNot devolve quotas e não-quotas", async () => {
    const { data } = await client.admin.listCharges(
      { kind: "receivable", nature: "debit" },
      { headers: hdr() },
    ) as unknown as { data: Array<{ chargeType: string }> };
    assertEquals(data.some((c) => c.chargeType === "quota"), true);
    assertEquals(data.some((c) => c.chargeType === "interest"), true);
  });

  // ─── Update ──────────────────────────────────────────────────────
  it("updateCharge - altera descrição", async () => {
    const { data, status } = await client.admin.updateCharge(
      debitChargeId,
      { description: "EDP Abril 2027 (atualizada)" },
      { headers: hdr() },
    );
    assertEquals(status, 200);
    assertEquals(data.description, "EDP Abril 2027 (atualizada)");
  });

  // Verifica que o endpoint de ledger devolve as 2 entries iniciais
  // (Dr categoria / Cr fornecedor) criadas pelo `fn_charge_ai`. Garante
  // que o show page do panel consegue mostrar o efeito contabilístico
  // sem ter de varrer o ledger inteiro.
  it("getChargeLedger - devolve as entries da criação (Dr+Cr balanceadas)", async () => {
    const { data, status } = await client.admin.getChargeLedger(debitChargeId, { headers: hdr() });
    assertEquals(status, 200);
    assertEquals(data.length, 2);
    const totalDebit = data
      .filter((l) => l.direction === "debit")
      .reduce((s, l) => s + Number(l.amount), 0);
    const totalCredit = data
      .filter((l) => l.direction === "credit")
      .reduce((s, l) => s + Number(l.amount), 0);
    assertEquals(totalDebit, totalCredit);
    assertEquals(totalDebit, 10000);
    for (const l of data) {
      assertEquals(l.refType, "charge");
      assertEquals(l.refId, debitChargeId);
      assertEquals(l.entryType, "charge_created");
    }
  });

  it("getChargeLedger - charge inexistente retorna 404", async () => {
    const e = await assertRejects(
      () => client.admin.getChargeLedger("nonexistent", { headers: hdr() }),
      ApiError,
    );
    assertEquals(e.statusCode, 404);
  });

  it("updateCharge - altera valor (dispara trigger ledger delta)", async () => {
    const { data, status } = await client.admin.updateCharge(
      debitChargeId,
      { amountCents: 12000 },
      { headers: hdr() },
    );
    assertEquals(status, 200);
    assertEquals(Number(data.originalAmount), 12000);
    // Regressão: expected_amount tem de acompanhar original (sem isto, um
    // settlement posterior deixa resíduo na charge - ver 0024 SQL test).
    assertEquals(Number(data.expectedAmount), 12000);
    assertEquals(Number(data.openAmount), 12000);
    // amount deve ser 0 até haver settlement (é acumulador de liquidação).
    assertEquals(Number(data.amount), 0);
  });

  // Regressão: PATCH sem `competencePeriod` no body NÃO pode apagar a
  // competência existente (um null partiria os reports mensais). Três defesas:
  //   1. DB: coluna NOT NULL (qualquer null → falha).
  //   2. API schema: não-nullable, regex YYYY-MM-01 obrigatório quando
  //      enviado.
  //   3. Panel controller: omite competencePeriod do body se vier vazio
  //      (handler preserva o valor existente).
  it("updateCharge - PATCH sem competencePeriod preserva o valor existente", async () => {
    const before = await client.admin.getCharge(debitChargeId, { headers: hdr() });
    const competenceBefore = before.data.competencePeriod;
    assertEquals(typeof competenceBefore, "string");

    // Body sem competencePeriod - handler tem de preservar.
    const { data, status } = await client.admin.updateCharge(
      debitChargeId,
      { description: "Sem mexer em competência" },
      { headers: hdr() },
    );
    assertEquals(status, 200);
    assertEquals(data.competencePeriod, competenceBefore);
  });

  // Regressão extra: PATCH com formato errado é rejeitado (não silenciosamente
  // aceite e nem null-ed).
  it("updateCharge - competencePeriod inválido devolve 400", async () => {
    const e = await assertRejects(
      () =>
        client.admin.updateCharge(
          debitChargeId,
          { competencePeriod: "2030-04-15" }, // Zod regex exige YYYY-MM-01
          { headers: hdr() },
        ),
      ApiError,
    );
    assertEquals(e.statusCode, 400);
  });

  it("updateCharge - PATCH com competencePeriod válido atualiza o valor", async () => {
    const { data, status } = await client.admin.updateCharge(
      debitChargeId,
      { competencePeriod: "2030-05-01" },
      { headers: hdr() },
    );
    assertEquals(status, 200);
    assertEquals(data.competencePeriod, "2030-05");
  });

  // Credit adjustment auto-compensa contra débitos da mesma fração via
  // fn_charge_ai - não há débitos para esta unit, por isso o credit fica
  // em aberto (status=open). Tentar editar valor deve dar erro de tipo.
  it("updateCharge - amount edit é bloqueado para nature=credit", async () => {
    const e = await assertRejects(
      () =>
        client.admin.updateCharge(
          creditChargeId,
          { amountCents: 6000 },
          { headers: hdr() },
        ),
      ApiError,
    );
    assertEquals(e.statusCode, 409);
  });

  // ─── Fluxo "Ajustar + Reconciliar" end-to-end ──────────────────────────
  // Simula o botão do modal de reconciliação que faz 2 chamadas à API:
  //   1) PATCH /charges/:id amountCents=X (alinha com o valor do extracto)
  //   2) POST /settlements bank_reconciliation com amount=X
  //
  // Regressão do bug: se o PATCH não atualiza `expected_amount`, o trigger
  // fn_settlement_ai usa o expected antigo → open fica ≠ 0. Aqui validamos
  // que o estado final da charge é `paid` com `open=0` (sem resíduo).
  it("adjust+reconcile flow - PATCH amount + settlement liquida charge sem resíduo", async () => {
    // Arrange: fatura payable de 17,00 € e bank_tx -16,26 €.
    const { data: chg } = await client.admin.createCharge(
      {
        kind: "payable",
        chargeType: "expense",
        description: "Água - 01/2030 (adjust+reconcile)",
        issueDate: "2030-01-02",
        dueDate: "2030-01-31",
        competencePeriod: "2030-01-01",
        amountCents: 1700,
      },
      { headers: hdr() },
    );
    const chargeId = chg.id as string;

    // Cria bank_account + bank_tx no mesmo condomínio.
    const { data: ba } = await client.admin.createBankAccount(
      {
        bankName: "Banco Charge Test",
        iban: "PT50000700000000000000031",
        accountName: "Charge adjust",
        openingBalance: 0,
        openingBalanceDate: "2030-01-01",
      },
      { headers: hdr() },
    );
    const { data: tx } = await client.admin.createBankTransaction(
      {
        bankAccountId: ba.id as string,
        transactionDate: "2030-01-02",
        amount: -1626,
        description: "PAG AGUA",
      },
      { headers: hdr() },
    );
    const bankTxId = (tx as { id: string }).id;

    // Passo 1: PATCH amountCents = 1626 (alinha charge com o extracto).
    const patched = await client.admin.updateCharge(
      chargeId,
      { amountCents: 1626 },
      { headers: hdr() },
    );
    assertEquals(patched.status, 200);
    assertEquals(Number(patched.data.originalAmount), 1626);
    assertEquals(Number(patched.data.expectedAmount), 1626);
    assertEquals(Number(patched.data.openAmount), 1626);
    assertEquals(Number(patched.data.amount), 0);

    // Passo 2: settlement 1626 contra a charge.
    const settleRes = await fetch(
      `${BASE_URL}/v1/admin/condominiums/${condo.id}/settlements`,
      {
        method: "POST",
        headers: { ...hdr(), "Content-Type": "application/json" },
        body: JSON.stringify({
          settlementType: "bank_reconciliation",
          bankTransactionId: bankTxId,
          debitChargeId: chargeId,
          amount: 1626,
          settlementDate: "2030-01-02",
        }),
      },
    );
    assertEquals(settleRes.status, 201);
    await settleRes.body?.cancel();

    // Assert: charge terminou em `paid` sem resíduo.
    const finalChg = await client.admin.getCharge(chargeId, { headers: hdr() });
    assertEquals(finalChg.data.status, "paid");
    assertEquals(Number(finalChg.data.openAmount), 0);
    assertEquals(Number(finalChg.data.expectedAmount), 1626);
    assertEquals(Number(finalChg.data.settledAmount), 1626);
    // `amount` é o acumulador de liquidação (soma dos settlements ativos).
    // Com um só settlement de 1626, deve ser exatamente 1626 (não 3252 - bug).
    assertEquals(Number(finalChg.data.amount), 1626);
  });

  it("updateCharge - não existente retorna 404", async () => {
    const e = await assertRejects(
      () =>
        client.admin.updateCharge(
          "nonexistent",
          { description: "x" },
          { headers: hdr() },
        ),
      ApiError,
    );
    assertEquals(e.statusCode, 404);
  });

  // ─── Refaturações ────────────────────────────────────────────────────
  // POST /charges/:chargeId/refacturations: distribui uma fatura payable
  // por charges receivable (uma por fração afetada).
  it("createRefacturations - reparte payable em duas units", async () => {
    // 2ª unit para ter > 1 fração a receber a refact.
    const { data: unit2 } = await client.super.createUnit(
      condo.id,
      { designation: "B", permillage: 500, description: "unit B" },
      { headers: MASTER },
    );

    // Fatura payable source (e.g. eletricidade comum).
    const { data: source } = await client.admin.createCharge(
      {
        kind: "payable",
        chargeType: "supplier_service",
        description: "Fatura Eletricidade 04/2028",
        issueDate: "2028-04-10",
        dueDate: "2028-05-01",
        competencePeriod: "2028-04-01",
        amountCents: 12000,
      },
      { headers: hdr() },
    );

    const { data, status } = await client.admin.createRefacturations(
      source.id as string,
      {
        allocations: [
          { unitId: unit.id, amountCents: 6000, description: "50% A" },
          { unitId: unit2.id, amountCents: 6000, description: "50% B" },
        ],
        issueDate: "2028-04-10",
        dueDate: "2028-05-31",
      },
      { headers: hdr() },
    );
    assertEquals(status, 201);
    assertEquals(data.created, 2);
    assertEquals(data.total_cents, 12000);
    assertEquals(data.remaining_cents, 0);
    assertEquals(data.charges.length, 2);
    // Refacts são receivables nature=debit chargeType=refacturation contra units.
    for (const r of data.charges) {
      assertEquals(r.kind, "receivable");
      assertEquals(r.nature, "debit");
      assertEquals(r.chargeType, "refacturation");
      assertEquals(r.sourceType, "refacturation");
      assertEquals(r.sourceId, source.id);
    }
    // Regressão: refaturação herda a competência da source charge (a API
    // passou a preencher automaticamente em create_refacturations). Sem
    // isto, com a coluna NOT NULL a insertion rebentaria. Antes
    // desta mudança, o campo era default-null e partia reports mensais.
    for (const r of data.charges) {
      assertEquals(r.competencePeriod, source.competencePeriod);
    }
    // O vencimento é do batch e chega a todas as filhas. Sem `due_date`, a
    // refaturação nunca entra em `v_unit_balance.overdue_debt_cents` nem nos
    // lembretes de cobrança - dívida invisível.
    for (const r of data.charges) {
      assertEquals(r.dueDate, "2028-05-31");
    }

    // Regressão: filtro `?sourceId=<charge.id>` devolve só as refaturações
    // desta charge, sem ter de varrer toda a lista. Importante para o panel
    // - antes, a página do show pedia `listCharges({})` (limit 500) e
    // descartava refaturações antigas que caíam fora do corte. Agora o
    // filtro server-side traz exatamente as filhas, independentemente do
    // volume do histórico.
    const byParent = await client.admin.listCharges(
      { sourceId: source.id as string },
      { headers: hdr() },
    ) as unknown as { data: Array<{ id: string; sourceId: string; chargeType: string }> };
    assertEquals(byParent.data.length, 2);
    for (const r of byParent.data) {
      assertEquals(r.sourceId, source.id);
      assertEquals(r.chargeType, "refacturation");
    }
  });

  // Regressão: permitir refaturar uma despesa JÁ paga. Antes o UI (e
  // algumas guardas obsoletas) bloqueavam status=paid - só deixavam
  // refaturar enquanto a despesa estivesse open/partial/overdue. Use-case:
  // descobrir depois que o custo é imputável a uma fração (ex: infiltração
  // paga à empresa, mas a responsabilidade é de uma fração).
  // O trigger fn_refacturation_validate não olha para status, só para kind
  // e account; este teste valida o caminho end-to-end via API.
  it("createRefacturations - funciona com source payable já 'paid'", async () => {
    // Fatura payable 1500, liquidada imediatamente a seguir.
    const { data: source } = await client.admin.createCharge(
      {
        kind: "payable",
        chargeType: "supplier_service",
        description: "Infiltração resolvida em 2030-03",
        issueDate: "2030-03-01",
        dueDate: "2030-03-31",
        competencePeriod: "2030-03-01",
        amountCents: 15000,
      },
      { headers: hdr() },
    );
    // Cria bank_account + bank_tx e fecha a charge via settlement full.
    const { data: ba } = await client.admin.createBankAccount(
      {
        bankName: "Banco Refact Paid",
        iban: "PT50000700000000000000041",
        accountName: "Refact paid",
        openingBalance: 0,
        openingBalanceDate: "2030-03-01",
      },
      { headers: hdr() },
    );
    const { data: tx } = await client.admin.createBankTransaction(
      {
        bankAccountId: ba.id as string,
        transactionDate: "2030-03-02",
        amount: -15000,
        description: "PAG infiltração",
      },
      { headers: hdr() },
    );
    const settleRes = await fetch(
      `${BASE_URL}/v1/admin/condominiums/${condo.id}/settlements`,
      {
        method: "POST",
        headers: { ...hdr(), "Content-Type": "application/json" },
        body: JSON.stringify({
          settlementType: "bank_reconciliation",
          bankTransactionId: (tx as { id: string }).id,
          debitChargeId: source.id,
          amount: 15000,
          settlementDate: "2030-03-02",
        }),
      },
    );
    assertEquals(settleRes.status, 201);
    await settleRes.body?.cancel();

    // Confirma que a source está `paid` antes de refaturar.
    const after = await client.admin.getCharge(source.id as string, { headers: hdr() });
    assertEquals(after.data.status, "paid");

    // Refaturação TOTAL sobre a despesa já paga.
    const { data, status } = await client.admin.createRefacturations(
      source.id as string,
      {
        allocations: [{ unitId: unit.id, amountCents: 15000, description: "100% para A" }],
        issueDate: "2030-03-05",
        dueDate: "2030-04-30",
      },
      { headers: hdr() },
    );
    assertEquals(status, 201);
    assertEquals(data.created, 1);
    assertEquals(data.total_cents, 15000);
    // Competência continua herdada da source, mesmo com a source paga.
    assertEquals(data.charges[0].competencePeriod, "2030-03");
    // E herda também a accountId da source (constraint fn_refacturation_validate).
    assertEquals(data.charges[0].sourceId, source.id);
  });

  it("createRefacturations - soma excede disponível rebenta 400", async () => {
    const { data: source } = await client.admin.createCharge(
      {
        kind: "payable",
        chargeType: "supplier_service",
        description: "Fatura para validação de soma",
        issueDate: "2028-05-10",
        competencePeriod: "2028-05-01",
        amountCents: 10000,
      },
      { headers: hdr() },
    );
    // Nota: refaturação parcial é permitida (podem-se refaturar em
    // vários batches). A API só rebenta quando a soma EXCEDE o disponível.
    const e = await assertRejects(
      () =>
        client.admin.createRefacturations(
          source.id as string,
          {
            allocations: [
              { unitId: unit.id, amountCents: 15000 }, // 150€ > 100€ da source
            ],
            issueDate: "2028-05-10",
            dueDate: "2028-06-30",
          },
          { headers: hdr() },
        ),
      ApiError,
    );
    assertEquals(e.statusCode, 400);
    assertEquals(
      (e.data as { error?: { code?: string } } | undefined)?.error?.code,
      "REFACTURATION_EXCEEDS_TOTAL",
    );
  });

  it("createRefacturations - sem dueDate → 400 (vencimento é obrigatório)", async () => {
    // Regressão: o batch aceitava dueDate omitido e gravava NULL. A charge
    // ficava a dever para sempre sem nunca aparecer em atraso.
    const { data: source } = await client.admin.createCharge(
      {
        kind: "payable",
        chargeType: "supplier_service",
        description: "Fatura sem vencimento de refaturação",
        issueDate: "2028-07-10",
        competencePeriod: "2028-07-01",
        amountCents: 5000,
      },
      { headers: hdr() },
    );
    const e = await assertRejects(
      () =>
        client.admin.createRefacturations(
          String(source.id),
          // deno-lint-ignore no-explicit-any
          { allocations: [{ unitId: unit.id, amountCents: 5000 }] } as any,
          { headers: hdr() },
        ),
      ApiError,
    );
    assertEquals(e.statusCode, 400);
  });

  it("createRefacturations - source inexistente → 404", async () => {
    const e = await assertRejects(
      () =>
        client.admin.createRefacturations(
          "00000000000000000000000",
          { allocations: [{ unitId: unit.id, amountCents: 1 }], dueDate: "2028-06-30" },
          { headers: hdr() },
        ),
      ApiError,
    );
    assertEquals(e.statusCode, 404);
  });

  // ─── Defaults inferidos (chargeType + competencePeriod) ─────────────
  // Regra movida do panel para a API: caller pode omitir `chargeType` (fica
  // inferido a partir de kind+supplierId) e `competencePeriod` (derivado do
  // primeiro dia do mês de issueDate). Ver charge/defaults.ts.
  it("createCharge sem chargeType + payable + supplierId → infer 'supplier_service'", async () => {
    const { data: sup } = await client.admin.createSupplier(
      { name: "Supplier para defaults", nif: "100200300" },
      { headers: hdr() },
    );
    const { data, status } = await client.admin.createCharge(
      {
        kind: "payable",
        description: "Fatura sem chargeType",
        issueDate: "2031-08-15",
        dueDate: "2031-09-30",
        amountCents: 5000,
        supplierId: sup.id,
        // chargeType + competencePeriod omitidos
      },
      { headers: hdr() },
    );
    assertEquals(status, 201);
    assertEquals((data as { chargeType: string }).chargeType, "supplier_service");
    // Competence derivada: issueDate 2031-08-15 → 2031-08
    assertEquals((data as { competencePeriod: string }).competencePeriod, "2031-08");
  });

  it("createCharge sem chargeType + payable sem supplier → infer 'expense'", async () => {
    const { data, status } = await client.admin.createCharge(
      {
        kind: "payable",
        description: "Despesa avulsa sem fornecedor",
        issueDate: "2031-08-20",
        amountCents: 1500,
        // sem supplierId, sem chargeType
      },
      { headers: hdr() },
    );
    assertEquals(status, 201);
    assertEquals((data as { chargeType: string }).chargeType, "expense");
  });

  it("createCharge sem chargeType + receivable → infer 'quota'", async () => {
    const { data, status } = await client.admin.createCharge(
      {
        kind: "receivable",
        description: "Receivable sem chargeType",
        issueDate: "2031-09-10",
        amountCents: 2000,
        unitId: unit.id,
        // chargeType omitido
      },
      { headers: hdr() },
    );
    assertEquals(status, 201);
    assertEquals((data as { chargeType: string }).chargeType, "quota");
  });

  it("createCharge com chargeType explícito → respeita override", async () => {
    const { data } = await client.admin.createCharge(
      {
        kind: "payable",
        chargeType: "extraordinary_quota",
        description: "Override do chargeType",
        issueDate: "2031-10-01",
        amountCents: 3000,
      },
      { headers: hdr() },
    );
    assertEquals((data as { chargeType: string }).chargeType, "extraordinary_quota");
  });

  it("createCharge com competencePeriod explícito → respeita override", async () => {
    // issueDate em Agosto, competencePeriod em Outubro - tem que prevalecer.
    const { data } = await client.admin.createCharge(
      {
        kind: "payable",
        chargeType: "expense",
        description: "Competence override",
        issueDate: "2031-08-15",
        competencePeriod: "2031-10-01",
        amountCents: 1000,
      },
      { headers: hdr() },
    );
    assertEquals((data as { competencePeriod: string }).competencePeriod, "2031-10");
  });

  it("createCharge com issueDate inválido → 400 (não consegue derivar competence)", async () => {
    // issueDate fora do regex YYYY-MM-DD - dtoValidator rejeita antes do
    // handler chegar a chamar deriveCompetenceFromIssueDate.
    const e = await assertRejects(
      () =>
        client.admin.createCharge(
          {
            kind: "payable",
            description: "Bad issue date",
            issueDate: "15/08/2031",
            amountCents: 100,
          },
          { headers: hdr() },
        ),
      ApiError,
    );
    assertEquals(e.statusCode, 400);
  });

  it("createRefacturations - source payable parcialmente paga: refatura sobre originalAmount (não openAmount)", async () => {
    // Cria payable de 100€, paga metade (50€), depois refatura.
    // Expectativa contabilística: refaturação distribui o valor TOTAL (100€)
    // pelas units alvo, independentemente do que já foi liquidado. O handler
    // calcula `availableToRefact = originalAmount - alreadyRefactured` (não
    // usa openAmount). Ver create_refacturations.ts.
    const { data: source } = await client.admin.createCharge(
      {
        kind: "payable",
        chargeType: "expense",
        description: "Source para refact partial",
        issueDate: "2032-01-15",
        competencePeriod: "2032-01-01",
        amountCents: 10000,
      },
      { headers: hdr() },
    );

    // Cria bank_tx + settlement de 5000 (50%) → charge fica `partial`.
    const { data: ba } = await client.admin.createBankAccount(
      {
        bankName: "RP",
        accountName: "Refact Partial",
        iban: "PT50RPRP00000000000000000",
        openingBalance: 0,
      },
      { headers: hdr() },
    );
    const { data: bt } = await client.admin.createBankTransaction(
      {
        bankAccountId: String(ba.id),
        transactionDate: "2032-01-20",
        amount: -5000,
        description: "Pag parcial",
      },
      { headers: hdr() },
    );
    await client.admin.createSettlement(
      {
        settlementType: "bank_reconciliation",
        bankTransactionId: String(bt.id),
        debitChargeId: source.id,
        amount: 5000,
        settlementDate: "2032-01-20",
      },
      { headers: hdr() },
    );

    // Confirma estado: source partial com open=5000
    const { data: srcAfter } = await client.admin.getCharge(String(source.id), { headers: hdr() });
    assertEquals((srcAfter as { status: string }).status, "partial");
    assertEquals(Number((srcAfter as { openAmount: number }).openAmount), 5000);

    // Refatura para 1 unit por 100€ (valor TOTAL original) - deve passar.
    const { data: r, status } = await client.admin.createRefacturations(
      String(source.id),
      {
        allocations: [{ unitId: unit.id, amountCents: 10000 }],
        dueDate: "2028-06-30",
      },
      { headers: hdr() },
    );
    assertEquals(status, 201);
    assertEquals(r.created, 1);
    assertEquals(r.total_cents, 10000, "refatura sobre originalAmount, não openAmount");
    assertEquals(r.remaining_cents, 0);
  });

  it("createRefacturations - parcial sobre source partial: 1ª refact OK + 2ª excede → 400", async () => {
    // Cria nova source (10000), paga 4000 (partial), refatura 6000 (OK), tenta +5000 (excede).
    const { data: source } = await client.admin.createCharge(
      {
        kind: "payable",
        chargeType: "expense",
        description: "Source para refact partial 2",
        issueDate: "2032-02-15",
        dueDate: "2032-03-31",
        competencePeriod: "2032-02-01",
        amountCents: 10000,
      },
      { headers: hdr() },
    );

    // 1ª refact: 60% (6000) - permitido
    const { data: r1, status: s1 } = await client.admin.createRefacturations(
      String(source.id),
      { allocations: [{ unitId: unit.id, amountCents: 6000 }], dueDate: "2028-06-30" },
      { headers: hdr() },
    );
    assertEquals(s1, 201);
    assertEquals(r1.remaining_cents, 4000, "remaining = original - já refaturado");

    // 2ª refact: 5000 → excede os 4000 disponíveis → 400
    const e = await assertRejects(
      () =>
        client.admin.createRefacturations(
          String(source.id),
          { allocations: [{ unitId: unit.id, amountCents: 5000 }], dueDate: "2028-06-30" },
          { headers: hdr() },
        ),
      ApiError,
    );
    assertEquals(e.statusCode, 400);
  });

  it("teardown - apaga condomínio", async () => {
    await fx.cleanup();
  });
});
