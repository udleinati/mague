// IDs de outro condomínio no path ou no body (cross-tenant IDOR).
//
// Cada caso pede no condomínio B com um id do condomínio A. Sem o guard, dados de A
// apareciam no ecrã de B (pré-visualizações) ou ficavam gravados em B e eram
// mostrados daí em diante (ata, ficha da fração, orçamento). Os controlos no
// próprio A provam que o 404 vem do tenant e não de um id inválido.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { ApiError, Client } from "$shared/client/mod.ts";
import { loginAs, loginAsSuper } from "./_helpers/auth.ts";
import { deleteTestUser, seedTestUser, sqlExec, sqlExecBeforeTenantGuard } from "./_helpers/db.ts";
import { type ScenarioFixture, seedScenario } from "./_helpers/fixtures.ts";
import { flushMailpit, listMessages, waitForEmail } from "./_helpers/mailpit.ts";

const BASE_URL = "http://localhost:3000";
const AUTH = await loginAsSuper();
const client = new Client({ baseUrl: BASE_URL });
const PDF = new TextEncoder().encode("%PDF-1.4\n%%EOF\n");

async function expect404(fn: () => Promise<unknown>) {
  const e = await assertRejects(fn, ApiError);
  assertEquals(e.statusCode, 404);
}

async function statusOf(url: string, method = "GET"): Promise<number> {
  const res = await fetch(url, { method, headers: AUTH });
  await res.body?.cancel();
  return res.status;
}

// Entidades-pai de anexos, por segmento do path da API.
const ATTACHMENT_PARENTS = ["charges", "inspections", "pathologies", "assemblies"] as const;
type AttachmentParent = typeof ATTACHMENT_PARENTS[number];

async function createAttachmentParent(kind: AttachmentParent, fx: ScenarioFixture) {
  const headers = fx.hdr();
  if (kind === "charges") {
    const { data } = await client.admin.createCharge({
      kind: "payable",
      chargeType: "expense",
      description: "Fatura com anexo",
      issueDate: "2030-03-01",
      competencePeriod: "2030-03-01",
      amountCents: 1000,
    }, { headers });
    return String(data.id);
  }
  if (kind === "inspections") {
    const { data } = await client.admin.createInspection(
      { category: "elevator", description: "Elevador", validUntil: "2099-12-31" },
      { headers },
    );
    return String(data.id);
  }
  if (kind === "pathologies") {
    const { data } = await client.admin.createPathology(
      { title: "Fissura", category: "crack", affectsCommonArea: true },
      { headers },
    );
    return String(data.id);
  }
  const { data } = await client.admin.createAssembly(
    { type: "ordinary", scheduledAt: "2099-06-15T19:00:00.000Z" },
    { headers },
  );
  return String(data.id);
}

async function uploadPdf(cid: string, kind: AttachmentParent, parentId: string) {
  const form = new FormData();
  form.append("file", new Blob([PDF], { type: "application/pdf" }), "anexo.pdf");
  const res = await fetch(
    `${BASE_URL}/v1/admin/condominiums/${cid}/${kind}/${parentId}/attachments`,
    { method: "POST", headers: AUTH, body: form },
  );
  const body = await res.json();
  assertEquals(res.status, 201, JSON.stringify(body));
  // A inspeção devolve a inspeção em `data` e o anexo à parte.
  return String(body.attachment?.id ?? body.data.id);
}

describe("cross-tenant: ids de A pedidos no condomínio B", () => {
  const stamp = Date.now();
  let A: ScenarioFixture;
  let B: ScenarioFixture;
  let accountA = "";
  let supplierA = "";
  let bankAccountA = "";
  let creditTxA = "";

  it("setup", async () => {
    A = await seedScenario(client, AUTH)
      .withCondo(`Tenant A ${stamp}`)
      .withUnit({ designation: "A1" })
      .withOccupant({
        name: `Dona de A ${stamp}`,
        email: `dona-a-${stamp}@example.pt`,
        unitDesignation: "A1",
      })
      .build();
    B = await seedScenario(client, AUTH)
      .withCondo(`Tenant B ${stamp}`)
      .withUnit({ designation: "B1" })
      .withOccupant({
        name: `Dono de B ${stamp}`,
        email: `dono-b-${stamp}@example.pt`,
        unitDesignation: "B1",
      })
      .build();

    // Lembretes de cobrança só pré-visualizam em condomínio já conciliado.
    await sqlExec(
      `UPDATE core.condominium SET reconciled_through_date = CURRENT_DATE
        WHERE id IN ('${A.condominium.id}', '${B.condominium.id}')`,
    );

    accountA = String(
      (await client.admin.createChartOfAccount(
        {
          code: `ISO_${stamp.toString(36).toUpperCase()}`,
          name: `Conta privada A ${stamp}`,
          type: "expense",
          parentCode: "5",
        },
        { headers: A.hdr() },
      )).data.id,
    );
    supplierA = String(
      (await client.admin.createSupplier(
        { name: `Fornecedor A ${stamp}`, nif: "501234567" },
        { headers: A.hdr() },
      )).data.id,
    );
    const { data: ba } = await client.admin.createBankAccount({
      bankName: "Banco A",
      iban: "PT50000700000000000000077",
      accountName: "Conta A",
      openingBalance: 0,
      openingBalanceDate: "2030-01-01",
    }, { headers: A.hdr() });
    bankAccountA = (ba as { id: string }).id;
    creditTxA = String(
      (await client.admin.createBankTransaction({
        bankAccountId: bankAccountA,
        transactionDate: "2030-03-05",
        amount: 10000,
        description: "TRF quota A1",
      }, { headers: A.hdr() })).data.id,
    );
  });

  it("lembrete de cobrança: a fração de A não se pré-visualiza em B", async () => {
    // O HTML trazia o nome do condómino, a fração e o nome do condomínio A; o envio
    // mandava o email aos condóminos de A em nome da administração de B.
    const own = await client.admin.previewBillingReminder(A.units[0].id, { headers: A.hdr() });
    assertStringIncludes(JSON.stringify(own.data), `Dona de A ${stamp}`);
    await expect404(() => client.admin.previewBillingReminder(A.units[0].id, { headers: B.hdr() }));
  });

  it("lembrete de seguro: a fração de A não se pré-visualiza em B", async () => {
    const own = await client.admin.previewInsuranceReminder(A.units[0].id, { headers: A.hdr() });
    assertStringIncludes(JSON.stringify(own.data), `Dona de A ${stamp}`);
    // O assunto do modal é o do envio (fração sem apólice -> "Seguro em falta").
    assertStringIncludes(own.data.subject, "Seguro em falta - ");
    await expect404(() =>
      client.admin.previewInsuranceReminder(A.units[0].id, { headers: B.hdr() })
    );
  });

  it("lembretes: o envio com a fração de A em B não manda email", async () => {
    // Sem o guard, a condómina de A recebia lembretes de cobrança e de seguro em nome de B.
    const donaA = `dona-a-${stamp}@example.pt`;
    await flushMailpit();
    await expect404(() =>
      client.admin.sendBillingReminder(A.units[0].id, {}, { headers: B.hdr() })
    );
    await expect404(() => client.admin.sendInsuranceReminder(A.units[0].id, { headers: B.hdr() }));

    // Controlo: o envio no próprio A chega ao Mailpit, logo a ausência acima não é do SMTP.
    await client.admin.sendBillingReminder(A.units[0].id, {}, { headers: A.hdr() });
    await waitForEmail({ to: donaA });
    const toDonaA = (await listMessages()).filter((m) =>
      m.To.some((t) => t.Address.toLowerCase() === donaA)
    );
    assertEquals(toDonaA.length, 1);
  });

  it("anexos: um anexo de A não se lê nem apaga pelo path de B", async () => {
    // O ficheiro (fatura, ata, fotografia) de A passava a abrir num ecrã de B.
    const base = (cid: string) => `${BASE_URL}/v1/admin/condominiums/${cid}`;
    for (const kind of ATTACHMENT_PARENTS) {
      const parentA = await createAttachmentParent(kind, A);
      const parentB = await createAttachmentParent(kind, B);
      const attA = await uploadPdf(A.condominium.id, kind, parentA);
      const ownUrl = `${base(A.condominium.id)}/${kind}/${parentA}/attachments/${attA}`;
      assertEquals(await statusOf(ownUrl), 200, `${kind}: controlo em A`);

      // Id da entidade de A no path de B, e entidade de B com o id do anexo de A.
      const viaParentA = `${base(B.condominium.id)}/${kind}/${parentA}/attachments/${attA}`;
      const viaParentB = `${base(B.condominium.id)}/${kind}/${parentB}/attachments/${attA}`;
      for (const url of [viaParentA, viaParentB]) {
        assertEquals(await statusOf(url), 404, `${kind}: GET ${url}`);
        assertEquals(await statusOf(url, "DELETE"), 404, `${kind}: DELETE ${url}`);
      }
      if (kind !== "inspections") {
        const list = `${base(B.condominium.id)}/${kind}/${parentA}/attachments`;
        assertEquals(await statusOf(list), 404, `${kind}: listagem`);
      }
      assertEquals(await statusOf(ownUrl), 200, `${kind}: o anexo continua em A`);
    }
  });

  it("imputação: o movimento de A não se pré-visualiza nem imputa em B", async () => {
    // A pré-visualização listava as cobranças em aberto da fração de A; a execução
    // gravava settlements em A com autoria de quem gere B.
    await client.admin.previewAllocationToUnit(creditTxA, { unitId: A.units[0].id }, {
      headers: A.hdr(),
    });
    await expect404(() =>
      client.admin.previewAllocationToUnit(creditTxA, { unitId: A.units[0].id }, {
        headers: B.hdr(),
      })
    );
    await expect404(() =>
      client.admin.allocateBankTransactionToUnit(creditTxA, { unitId: A.units[0].id }, {
        headers: B.hdr(),
      })
    );
  });

  it("imputação a fornecedor: o movimento de A não imputa em B", async () => {
    // Gravava settlements nas faturas do fornecedor de A com autoria de quem gere B.
    await client.admin.createCharge({
      kind: "payable",
      chargeType: "expense",
      description: "Fatura fornecedor A",
      issueDate: "2030-03-01",
      competencePeriod: "2030-03-01",
      amountCents: 4000,
      supplierId: supplierA,
    }, { headers: A.hdr() });
    const debitTxA = String(
      (await client.admin.createBankTransaction({
        bankAccountId: bankAccountA,
        transactionDate: "2030-03-06",
        amount: -4000,
        description: "TRF fornecedor A",
      }, { headers: A.hdr() })).data.id,
    );

    await expect404(() =>
      client.admin.allocateBankTransactionToSupplier(debitTxA, { supplierId: supplierA }, {
        headers: B.hdr(),
      })
    );
    const own = await client.admin.allocateBankTransactionToSupplier(debitTxA, {
      supplierId: supplierA,
    }, { headers: A.hdr() });
    assertEquals(own.status, 201);
  });

  it("plano de contas: o tenant vem do path, não do header", async () => {
    // O header X-Condominium-Id escolhia de que condomínio vinham as contas privadas,
    // sem validar que quem pede o gere. Efeito lateral: sem header, as contas
    // privadas do próprio condomínio nunca apareciam.
    const ownList = await client.admin.listExpenseCategories({ headers: A.hdr() });
    assert(ownList.data.some((a) => a.id === accountA), "a conta privada de A aparece em A");

    const res = await fetch(
      `${BASE_URL}/v1/admin/condominiums/${B.condominium.id}/chart_of_accounts`,
      {
        headers: { ...AUTH, "X-Condominium-Id": A.condominium.id },
      },
    );
    const body = await res.json();
    assert(
      !body.data.some((a: { id: string }) => a.id === accountA),
      "a conta de A não aparece em B",
    );
    await expect404(() => client.admin.getChartOfAccount(accountA, { headers: B.hdr() }));
  });

  it("inspeção: fornecedor de A recusado em B", async () => {
    // A ficha da inspeção de B passava a mostrar nome e NIF do fornecedor de A.
    await expect404(() =>
      client.admin.createInspection(
        {
          category: "fire_extinguisher",
          description: "Extintores",
          validUntil: "2099-12-31",
          supplierId: supplierA,
        },
        { headers: B.hdr() },
      )
    );
  });

  it("ocorrência: fração de A recusada em B", async () => {
    await expect404(() =>
      client.admin.createTicket(
        { title: "Elevador parado", category: "elevator", unitId: A.units[0].id },
        { headers: B.hdr() },
      )
    );
  });

  it("fração: ocupante de A não se liga a fração de B", async () => {
    // A ficha da fração de B (e a folha de presenças) passava a mostrar nome, email e NIF do ocupante de A.
    await expect404(() =>
      client.admin.createUnitOccupant(
        B.units[0].id,
        {
          unitId: B.units[0].id,
          occupantId: A.occupants[0].id,
          relationshipType: "owner",
          startDate: "2025-01-01",
        },
        { headers: B.hdr() },
      )
    );
  });

  it("orçamento: conta privada de A recusada numa linha de B", async () => {
    const { data: budget } = await client.admin.createBudget({ year: "2099" }, {
      headers: B.hdr(),
    });
    await expect404(() =>
      client.admin.createBudgetLine(String(budget.id), {
        accountId: accountA,
        annualAmount: 100000,
      }, {
        headers: B.hdr(),
      })
    );
  });

  it("assembleia: presidente, presenças e votos só com gente e frações de B", async () => {
    // Todos acabavam impressos na ata de B.
    const { data: asm } = await client.admin.createAssembly(
      { type: "ordinary", scheduledAt: "2099-06-15T19:00:00.000Z" },
      { headers: B.hdr() },
    );
    const assemblyId = String(asm.id);

    await expect404(() =>
      client.admin.updateAssembly(assemblyId, { presidentOccupantId: A.occupants[0].id }, {
        headers: B.hdr(),
      })
    );
    await expect404(() =>
      client.admin.createAssemblyAgendaItem(
        assemblyId,
        {
          sequence: 1,
          subject: "Obras",
          itemType: "approve_budget",
          votes: [{ unitId: A.units[0].id, vote: "against", permillageApplied: 1000 }],
        },
        { headers: B.hdr() },
      )
    );

    await sqlExec(`UPDATE core.assembly SET status='scheduled' WHERE id='${assemblyId}'`);
    await expect404(() =>
      client.admin.createAssemblyAttendee(
        assemblyId,
        {
          unitId: A.units[0].id,
          occupantId: A.occupants[0].id,
          permillageAtMeeting: 1000,
          isProxy: false,
        },
        { headers: B.hdr() },
      )
    );
    await expect404(() =>
      client.admin.createAssemblyAttendee(
        assemblyId,
        {
          unitId: B.units[0].id,
          occupantId: B.occupants[0].id,
          permillageAtMeeting: 1000,
          isProxy: true,
          proxyHolderOccupantId: A.occupants[0].id,
        },
        { headers: B.hdr() },
      )
    );
  });

  it("convocatória: a assembleia de A não lista destinatários em B", async () => {
    // Devolvia os destinatários de B sob o id da assembleia de A, em vez de 404.
    const { data: asmA } = await client.admin.createAssembly(
      { type: "ordinary", scheduledAt: "2099-06-15T19:00:00.000Z" },
      { headers: A.hdr() },
    );
    await client.admin.listAssemblyConvocationRecipients(String(asmA.id), { headers: A.hdr() });
    await expect404(() =>
      client.admin.listAssemblyConvocationRecipients(String(asmA.id), { headers: B.hdr() })
    );
  });

  it("assembleia: documento da ata de A recusado em B", async () => {
    const { data: docA } = await client.admin.createDocument(
      { title: `Ata A ${stamp}`, category: "minutes", isPublic: false },
      { headers: A.hdr() },
    );
    const docId = String(docA.id);
    const scheduledAt = "2099-06-15T19:00:00.000Z";
    const own = await client.admin.createAssembly(
      { type: "ordinary", scheduledAt, minutesDocumentId: docId },
      { headers: A.hdr() },
    );
    assertEquals(own.status, 201);

    await expect404(() =>
      client.admin.createAssembly(
        { type: "ordinary", scheduledAt, minutesDocumentId: docId },
        { headers: B.hdr() },
      )
    );
    const { data: asmB } = await client.admin.createAssembly(
      { type: "ordinary", scheduledAt },
      { headers: B.hdr() },
    );
    await expect404(() =>
      client.admin.updateAssembly(String(asmB.id), { minutesDocumentId: docId }, {
        headers: B.hdr(),
      })
    );
  });

  it("orçamento: linha gravada com conta de A não mostra o nome dela em B", async () => {
    // Ligação anterior ao guard: a listagem de B lia a conta só pelo id.
    const { data: budget } = await client.admin.createBudget({ year: "2098" }, {
      headers: B.hdr(),
    });
    const globalAccount = (await client.admin.listExpenseCategories({ headers: B.hdr() })).data
      .find((a) => a.id !== accountA)!;
    const { data: line } = await client.admin.createBudgetLine(String(budget.id), {
      accountId: globalAccount.id,
      annualAmount: 100000,
    }, { headers: B.hdr() });
    await sqlExecBeforeTenantGuard(
      "core.budget_line",
      `UPDATE core.budget_line SET account_id='${accountA}' WHERE id='${line.id}'`,
    );

    const { data: lines } = await client.admin.listBudgetLines(String(budget.id), {
      headers: B.hdr(),
    });
    assertEquals(lines.length, 1);
    assert(!JSON.stringify(lines).includes(`Conta privada A ${stamp}`), "nome da conta de A em B");
  });

  it("portal: quem sai da fração deixa de ler o condomínio", async () => {
    // O gate do condomínio olhava para core.occupant, que fica depois de a ligação
    // terminar: o ex-condómino continuava a ver documentos, IBAN e assembleias.
    const email = `ex-condomino-${stamp}@example.pt`;
    const userId = await seedTestUser({ email, password: "test12345" });
    try {
      await sqlExec(`UPDATE core.occupant SET user_id='${userId}' WHERE id='${B.occupants[0].id}'`);
      const auth = await loginAs(email, "test12345");
      const url = `${BASE_URL}/v1/portal/condominiums/${B.condominium.id}/documents`;

      const before = await fetch(url, { headers: auth });
      await before.body?.cancel();
      assertEquals(before.status, 200);

      await sqlExec(
        `UPDATE core.unit_occupant SET end_date = CURRENT_DATE - 1 WHERE occupant_id='${
          B.occupants[0].id
        }'`,
      );
      const after = await fetch(url, { headers: auth });
      await after.body?.cancel();
      assertEquals(after.status, 404);
    } finally {
      await sqlExec(`UPDATE core.occupant SET user_id=NULL WHERE id='${B.occupants[0].id}'`);
      await deleteTestUser(userId);
    }
  });

  it("ordem do dia: orçamento de A recusado em B e fora do relatório de execução", async () => {
    // O relatório "execução por Ata" de B mostrava o orçamento de A: ano, estado,
    // rubricas (com as contas privadas de A) e valores orçados.
    const { data: budgetA } = await client.admin.createBudget({ year: "2097" }, {
      headers: A.hdr(),
    });
    const budgetId = String(budgetA.id);
    const scheduledAt = "2099-06-15T19:00:00.000Z";
    const { data: asmA } = await client.admin.createAssembly({ type: "ordinary", scheduledAt }, {
      headers: A.hdr(),
    });
    const own = await client.admin.createAssemblyAgendaItem(
      String(asmA.id),
      { sequence: 1, subject: "Orçamento", refType: "budget", refId: budgetId },
      { headers: A.hdr() },
    );
    assertEquals(own.status, 201);

    const { data: asmB } = await client.admin.createAssembly({ type: "ordinary", scheduledAt }, {
      headers: B.hdr(),
    });
    const assemblyB = String(asmB.id);
    await expect404(() =>
      client.admin.createAssemblyAgendaItem(
        assemblyB,
        { sequence: 1, subject: "Orçamento", refType: "budget", refId: budgetId },
        { headers: B.hdr() },
      )
    );
    const { data: item } = await client.admin.createAssemblyAgendaItem(
      assemblyB,
      { sequence: 1, subject: "Orçamento" },
      { headers: B.hdr() },
    );
    await expect404(() =>
      client.admin.updateAssemblyAgendaItem(
        assemblyB,
        String(item.id),
        { refType: "budget", refId: budgetId },
        { headers: B.hdr() },
      )
    );

    // Ligação gravada antes do guard: o relatório de B não a segue.
    await sqlExecBeforeTenantGuard(
      "core.assembly_agenda_item",
      `UPDATE core.assembly_agenda_item SET ref_type='budget', ref_id='${budgetId}'
        WHERE id='${item.id}'`,
    );
    await expect404(() => client.admin.assemblyExecutionDetail(assemblyB, { headers: B.hdr() }));
    const { data: report } = await client.admin.assemblyExecutionReport({ headers: B.hdr() });
    assert(!JSON.stringify(report).includes(budgetId), "orçamento de A no relatório de B");
  });

  it("fornecedor: conta privada de A recusada em B", async () => {
    // O reembolso a fornecedor copiava a conta para a cobrança: o nome e o código da
    // conta de A apareciam na cobrança e no ledger de B.
    const own = await client.admin.createSupplier(
      { name: `Fornecedor com conta A ${stamp}`, accountId: accountA },
      { headers: A.hdr() },
    );
    assertEquals(own.status, 201);
    await expect404(() =>
      client.admin.createSupplier(
        { name: `Fornecedor B ${stamp}`, accountId: accountA },
        { headers: B.hdr() },
      )
    );
    const { data: supB } = await client.admin.createSupplier(
      { name: `Fornecedor B2 ${stamp}` },
      { headers: B.hdr() },
    );
    await expect404(() =>
      client.admin.updateSupplier(String(supB.id), { accountId: accountA }, { headers: B.hdr() })
    );
  });

  it("imputação e reembolso: id de A em B responde como id inexistente", async () => {
    // Um 400 "pertence a outro condomínio" confirmava a quem gere B que o id existe em A.
    const { data: baB } = await client.admin.createBankAccount({
      bankName: "Banco B",
      iban: "PT50000700000000000000078",
      accountName: "Conta B",
      openingBalance: 0,
      openingBalanceDate: "2030-01-01",
    }, { headers: B.hdr() });
    const bankAccountB = (baB as { id: string }).id;
    const txB = async (amount: number) =>
      String(
        (await client.admin.createBankTransaction({
          bankAccountId: bankAccountB,
          transactionDate: "2030-03-07",
          amount,
          description: `TRF B ${amount}`,
        }, { headers: B.hdr() })).data.id,
      );
    const { data: chargeA } = await client.admin.createCharge({
      kind: "payable",
      chargeType: "expense",
      description: "Fatura A para reembolso",
      issueDate: "2030-03-01",
      competencePeriod: "2030-03-01",
      amountCents: 1500,
      supplierId: supplierA,
    }, { headers: A.hdr() });
    const { data: supB } = await client.admin.createSupplier(
      { name: `Fornecedor reembolso B ${stamp}` },
      { headers: B.hdr() },
    );

    const creditB = await txB(5000);
    const debitB = await txB(-5000);
    await expect404(() =>
      client.admin.previewAllocationToUnit(creditB, { unitId: A.units[0].id }, {
        headers: B.hdr(),
      })
    );
    await expect404(() =>
      client.admin.allocateBankTransactionToSupplier(debitB, { supplierId: supplierA }, {
        headers: B.hdr(),
      })
    );
    await expect404(() =>
      client.admin.refundSupplierBankTransaction(creditB, { supplierId: supplierA, amount: 100 }, {
        headers: B.hdr(),
      })
    );
    await expect404(() =>
      client.admin.refundSupplierBankTransaction(
        creditB,
        { supplierId: String(supB.id), sourceChargeId: String(chargeA.id), amount: 100 },
        { headers: B.hdr() },
      )
    );
  });

  it("recibo: ocupante de B ligado à fração de A não entra no recibo de A", async () => {
    // Ligação anterior aos guards: o nome e o NIF do ocupante de B iam para o recibo de A
    // (documento fiscal) e o recibo, com convite, seguia para o email dele.
    const strayEmail = `recibo-cruzado-b-${stamp}@example.pt`;
    const strayId = (await sqlExec(
      `INSERT INTO core.occupant (condominium_id, name, email, nif)
       VALUES ('${B.condominium.id}', 'Ocupante B cruzado ${stamp}', '${strayEmail}', '287654321')
       RETURNING id`,
    )).split("\n")[0].trim();
    await sqlExecBeforeTenantGuard(
      "core.unit_occupant",
      `INSERT INTO core.unit_occupant (unit_id, occupant_id, relationship_type, start_date)
       VALUES ('${A.units[0].id}', '${strayId}', 'owner', '2025-01-01')`,
    );
    try {
      const { data: charge } = await client.admin.createCharge({
        kind: "receivable",
        nature: "debit",
        chargeType: "quota",
        scope: "unit",
        unitId: A.units[0].id,
        issueDate: "2030-04-01",
        competencePeriod: "2030-04-01",
        amountCents: 2500,
        description: "Quota Abr A1",
      }, { headers: A.hdr() });
      const { data: tx } = await client.admin.createBankTransaction({
        bankAccountId: bankAccountA,
        transactionDate: "2030-04-10",
        amount: 2500,
        description: "TRF quota Abr A1",
      }, { headers: A.hdr() });
      await client.admin.createSettlement({
        settlementType: "bank_reconciliation",
        bankTransactionId: tx.id,
        debitChargeId: charge.id,
        amount: 2500,
        settlementDate: "2030-04-10",
      }, { headers: A.hdr() });
      const emitted = await client.admin.emitReceipt(
        { bankTransactionId: String(tx.id), unitId: A.units[0].id },
        { headers: A.hdr() },
      );
      assertEquals(emitted.status, 201);

      const snapshot = await sqlExec(
        `SELECT recipients_snapshot::text FROM finance.receipt
          WHERE bank_transaction_id='${tx.id}' AND unit_id='${A.units[0].id}'`,
      );
      assertStringIncludes(snapshot, `Dona de A ${stamp}`);
      assert(!snapshot.includes(`Ocupante B cruzado ${stamp}`), "ocupante de B no recibo de A");
      assertEquals(
        await sqlExec(`SELECT COUNT(*) FROM audit.email_log WHERE recipient='${strayEmail}'`),
        "0",
      );
    } finally {
      await sqlExec(`DELETE FROM core.unit_occupant WHERE occupant_id='${strayId}'`);
    }
  });

  it("portal como super: a fração de A não abre com o cid de B", async () => {
    // A ocorrência ficava gravada com condomínio B e fração A: B via uma fração que não
    // tem, A não a via.
    const unitUrl = (cid: string) =>
      `${BASE_URL}/v1/portal/condominiums/${cid}/units/${A.units[0].id}/tickets`;
    const post = (cid: string) =>
      fetch(unitUrl(cid), {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ title: `Portal cruzado ${stamp}` }),
      });

    const cross = await post(B.condominium.id);
    await cross.body?.cancel();
    assertEquals(cross.status, 404);
    assertEquals(
      await sqlExec(
        `SELECT COUNT(*) FROM core.ticket WHERE condominium_id='${B.condominium.id}'
          AND unit_id='${A.units[0].id}'`,
      ),
      "0",
    );

    const own = await post(A.condominium.id);
    await own.body?.cancel();
    assertEquals(own.status, 201);
  });

  it("teardown", async () => {
    await A.cleanup();
    await B.cleanup();
  });
});
