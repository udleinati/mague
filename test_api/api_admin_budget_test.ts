import { assertEquals, assertRejects } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import {
  ApiError,
  type Budget,
  type ChartOfAccount,
  Client,
  type Condominium,
} from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";
import { sqlExec } from "./_helpers/db.ts";

const BASE_URL = "http://localhost:3000";
const client = new Client({ baseUrl: BASE_URL });

const MASTER_HEADERS = await loginAsSuper();

describe("admin budgets", () => {
  let createdCondo: Condominium;
  let createdCategory: ChartOfAccount;
  let createdBudget: Budget;
  let altBudget: Budget;
  let approvalCounter = 0;

  const hdr = () => ({ ...MASTER_HEADERS, "x-condominium-id": createdCondo.id });

  // Helper: aprova/rejeita budget via assembleia.
  //
  // Como o caminho de aprovação passou do `create_decision` para o trigger
  // `trg_assembly_held_approve_budgets`, cada aprovação
  // precisa de uma assembleia fresca - uma vez marcada como held, fica selada.
  // O fluxo: criar assembleia → adicionar deliberação (approve_budget) →
  // marcar held (dispara trigger). Falhas da trigger (budget sem linhas, etc.)
  // aparecem no updateAssembly → o caller faz assertRejects.
  const approveBudgetViaAssembly = async (budgetId: string, approved: boolean) => {
    approvalCounter++;
    // Cada assembleia tem de ter uma data única (não há constraint formal,
    // mas facilita o debug).
    const scheduledAt = `2027-0${1 + (approvalCounter % 9)}-15T19:00:00Z`;
    const { data: assembly } = await client.admin.createAssembly(
      { type: "ordinary", scheduledAt },
      { headers: hdr() },
    );
    // O resultado é DERIVADO dos votos (não do campo `approved`, ignorado pela
    // API). approve_budget = maioria simples: favor > contra para aprovar.
    await client.admin.createAssemblyAgendaItem(
      assembly.id as string,
      {
        sequence: 1,
        subject: approved ? "Aprovação do orçamento" : "Rejeição do orçamento",
        itemType: "approve_budget",
        refType: "budget",
        refId: budgetId,
        votesInFavor: approved ? 1000 : 0,
        votesAgainst: approved ? 0 : 1000,
        votesAbstain: 0,
      },
      { headers: hdr() },
    );
    return await client.admin.updateAssembly(
      assembly.id as string,
      { status: "held", heldAt: scheduledAt },
      { headers: hdr() },
    );
  };

  it("setup - create condominium and category", async () => {
    const { data: condo } = await client.super.createCondominium(
      { name: "Budget Test Condo" },
      { headers: MASTER_HEADERS },
    );
    createdCondo = condo;

    const { data: cat } = await client.admin.createChartOfAccount(
      { code: "9.9.1", name: "Eletricidade", type: "expense" },
      { headers: hdr() },
    );
    createdCategory = cat;
  });

  it("create - valid principal budget returns 201", async () => {
    const { data, status } = await client.admin.createBudget(
      { year: "2027" },
      { headers: hdr() },
    );
    assertEquals(status, 201);
    assertEquals(typeof data.id, "string");
    assertEquals(data.year, "2027");
    assertEquals(data.status, "draft");
    assertEquals(data.type, "principal");
    assertEquals(data.totalAmount, 0);
    createdBudget = data;
  });

  it("create - missing year returns 400", async () => {
    const e = await assertRejects(
      () =>
        client.admin.createBudget(
          {},
          { headers: hdr() },
        ),
      ApiError,
    );
    assertEquals(e.statusCode, 400);
  });

  it("create - multiple principals for same year are allowed", async () => {
    // Cada principal representa uma proposta distinta votável em assembleia;
    // o endpoint aceita vários para o mesmo ano, diferenciados pelas notes.
    const { data, status } = await client.admin.createBudget(
      { year: "2027", notes: "Proposta alternativa" },
      { headers: hdr() },
    );
    assertEquals(status, 201);
    assertEquals(data.type, "principal");
    assertEquals(String(data.year), "2027");
  });

  it("get - returns created budget with totalAmount", async () => {
    const { data, status } = await client.admin.getBudget(
      createdBudget.id,
      { headers: hdr() },
    );
    assertEquals(status, 200);
    assertEquals(data.id, createdBudget.id);
    assertEquals(data.totalAmount, 0);
  });

  it("update - notes returns 200", async () => {
    const { data, status } = await client.admin.updateBudget(
      createdBudget.id,
      { notes: "Notas do orçamento" },
      { headers: hdr() },
    );
    assertEquals(status, 200);
    assertEquals(data.notes, "Notas do orçamento");
  });

  it("update - fcrPercentage returns 200", async () => {
    const { data, status } = await client.admin.updateBudget(
      createdBudget.id,
      { fcrPercentage: "15.00" },
      { headers: hdr() },
    );
    assertEquals(status, 200);
    assertEquals(data.fcrPercentage, "15.00");
  });

  it("approve (via assembly) - without lines returns error", async () => {
    // A falha vem do trigger `fn_assembly_held_approve_budgets` quando
    // marca held - não da criação da deliberação (que é permitida sem
    // validação). O PG RAISE EXCEPTION é devolvido como ApiError.
    await assertRejects(
      () => approveBudgetViaAssembly(createdBudget.id, true),
      ApiError,
    );
  });

  let createdLineId = "";

  it("add lines - create line returns 201", async () => {
    const { data, status } = await client.admin.createBudgetLine(
      createdBudget.id,
      {
        accountId: createdCategory.id,
        annualAmount: 1200000, // 12000.00 €
      },
      { headers: hdr() },
    );
    assertEquals(status, 201);
    assertEquals(data.accountId, createdCategory.id);
    assertEquals(data.annualAmount, 1200000);
    createdLineId = data.id as string;
  });

  it("get - lines vêm enriquecidas com categoryCode/categoryDescription da API", async () => {
    // Refactor #4: enriquecimento que vivia no panel (junção com chartOfAccount)
    // mudou para a API. lines[0] tem que expor code + description diretamente.
    const { data } = await client.admin.getBudget(createdBudget.id, { headers: hdr() });
    const line = data.lines.find((l) => l.id === createdLineId);
    assertEquals(line?.categoryName, "Eletricidade");
    assertEquals(line?.categoryCode, "9.9.1");
    assertEquals(line?.categoryDescription, null);
  });

  it("listBudgets - retorna o budget criado", async () => {
    const { data, status } = await client.admin.listBudgets({ headers: hdr() });
    assertEquals(status, 200);
    assertEquals(Array.isArray(data), true);
    const found = data.find((b) => b.id === createdBudget.id);
    assertEquals(found?.year, "2027");
  });

  it("listBudgetLines - retorna a linha criada", async () => {
    const { data, status } = await client.admin.listBudgetLines(
      createdBudget.id,
      { headers: hdr() },
    );
    assertEquals(status, 200);
    assertEquals(data.length >= 1, true);
    const found = data.find((l) => l.id === createdLineId);
    assertEquals(found?.annualAmount, 1200000);
  });

  it("updateBudgetLine - patch annualAmount funciona", async () => {
    const { data, status } = await client.admin.updateBudgetLine(
      createdBudget.id,
      createdLineId,
      { annualAmount: 1500000 },
      { headers: hdr() },
    );
    assertEquals(status, 200);
    assertEquals(data.annualAmount, 1500000);

    // Confirma totalAmount do budget atualizado.
    const { data: b } = await client.admin.getBudget(createdBudget.id, { headers: hdr() });
    assertEquals(b.totalAmount, 1500000);
  });

  it("deleteBudgetLine - remove e listBudgetLines fica vazio", async () => {
    // Cria 2ª linha (ad-hoc) para apagar - mantém a 1ª para o flow de approval.
    const { data: extra } = await client.admin.createBudgetLine(
      createdBudget.id,
      { accountId: createdCategory.id, annualAmount: 50000 },
      { headers: hdr() },
    );
    const extraId = extra.id as string;

    const { status } = await client.admin.deleteBudgetLine(
      createdBudget.id,
      extraId,
      { headers: hdr() },
    );
    assertEquals(status, 204);

    // Confirma soft-delete: a linha apagada nao aparece em listBudgetLines.
    const { data } = await client.admin.listBudgetLines(
      createdBudget.id,
      { headers: hdr() },
    );
    assertEquals(data.find((l) => l.id === extraId), undefined);
    // A linha original mantém-se.
    assertEquals(data.find((l) => l.id === createdLineId)?.annualAmount, 1500000);
  });

  it("add lines - without category returns 400", async () => {
    const e = await assertRejects(
      () =>
        client.admin.createBudgetLine(
          createdBudget.id,
          { annualAmount: 100 },
          { headers: hdr() },
        ),
      ApiError,
    );
    assertEquals(e.statusCode, 400);
  });

  it("get - budget now has totalAmount calculated", async () => {
    // updateBudgetLine acima mudou para 1500000 (15000.00 €).
    const { data, status } = await client.admin.getBudget(
      createdBudget.id,
      { headers: hdr() },
    );
    assertEquals(status, 200);
    assertEquals(data.totalAmount, 1500000);
    assertEquals(data.fcrAmount, 225000); // 15% of 1500000
  });

  it("approve (via assembly) - with lines creates decision and flips status", async () => {
    const { status } = await approveBudgetViaAssembly(createdBudget.id, true);
    // status 200 do updateAssembly (mark held)
    assertEquals(status, 200);

    // Verifica side-effect disparado pelo trigger.
    const { data: budget } = await client.admin.getBudget(
      createdBudget.id,
      { headers: hdr() },
    );
    assertEquals(budget.status, "approved");
    assertEquals(budget.approvedAt !== null, true);
  });

  it("approve (via assembly) - already approved is idempotent", async () => {
    // O trigger salta orçamentos já em `approved` (continue). Não falha.
    // Reflecte a nova semântica: a deliberação é criada livremente; o
    // trigger só atualiza budgets ainda em `draft`.
    const { status } = await approveBudgetViaAssembly(createdBudget.id, true);
    assertEquals(status, 200);
    const { data: budget } = await client.admin.getBudget(
      createdBudget.id,
      { headers: hdr() },
    );
    assertEquals(budget.status, "approved");
  });

  it("update - approved budget returns 409", async () => {
    const e = await assertRejects(
      () =>
        client.admin.updateBudget(
          createdBudget.id,
          { notes: "Não deve funcionar" },
          { headers: hdr() },
        ),
      ApiError,
    );
    assertEquals(e.statusCode, 409);
  });

  it("add lines - approved budget returns 409", async () => {
    const e = await assertRejects(
      () =>
        client.admin.createBudgetLine(
          createdBudget.id,
          { accountId: createdCategory.id, annualAmount: 100 },
          { headers: hdr() },
        ),
      ApiError,
    );
    assertEquals(e.statusCode, 409);
  });

  it("delete - approved budget returns 409", async () => {
    const e = await assertRejects(
      () =>
        client.admin.deleteBudget(
          createdBudget.id,
          { headers: hdr() },
        ),
      ApiError,
    );
    assertEquals(e.statusCode, 409);
  });

  it("create suplementar - from approved parent returns 201", async () => {
    // Suplementar tem de partilhar o ano do pai e exige nº de prestações.
    // Envia fcrPercentage="10" de propósito: a obra força sempre FCR 0.
    const { data, status } = await client.admin.createBudget(
      {
        year: "2027",
        parentBudgetId: createdBudget.id,
        notes: "Orçamento suplementar",
        installments: 3,
        fcrPercentage: "10",
      },
      { headers: hdr() },
    );
    assertEquals(status, 201);
    assertEquals(data.type, "suplementar");
    assertEquals(data.parentBudgetId, createdBudget.id);
    assertEquals(data.installments, 3);
    // FCR ignorado nos suplementares - sempre 0.
    assertEquals(data.fcrPercentage, "0.00");
  });

  it("create suplementar - sem prestações returns 400", async () => {
    const e = await assertRejects(
      () =>
        client.admin.createBudget(
          {
            year: "2027",
            parentBudgetId: createdBudget.id,
            notes: "Suplementar sem N",
          },
          { headers: hdr() },
        ),
      ApiError,
    );
    assertEquals(e.statusCode, 400);
  });

  it("create suplementar - from non-approved parent returns 400", async () => {
    // This would need a second draft budget to test properly
    // Skipping for now as it requires creating a new draft budget
  });

  it("generateQuotas - budget aprovado gera charges por fração", async () => {
    // Cria uma unit em createdCondo para gerar charges contra ela.
    await client.super.createUnit(
      createdCondo.id,
      { designation: "BG-A", permillage: 500 },
      { headers: MASTER_HEADERS },
    );
    await client.super.createUnit(
      createdCondo.id,
      { designation: "BG-B", permillage: 500 },
      { headers: MASTER_HEADERS },
    );

    const { data, status } = await client.admin.generateQuotas(
      createdBudget.id,
      {},
      { headers: hdr() },
    );
    assertEquals(status, 200);
    // Resposta inclui contagem de charges criadas.
    assertEquals(typeof data.chargesCreated, "number");
    assertEquals(Number(data.chargesCreated) > 0, true);
  });

  // Geração incremental: re-chamar com through_date menor é no-op (tudo já existe).
  // Este teste confirma a idempotência do trigger a nível de competence_period.
  it("generateQuotas - re-chamada é idempotente (0 charges novas)", async () => {
    const { data, status } = await client.admin.generateQuotas(
      createdBudget.id,
      { throughDate: "2027-03-31" },
      { headers: hdr() },
    );
    assertEquals(status, 200);
    // Todas as charges de Jan..Mar já existem da chamada anterior (12 meses).
    assertEquals(Number(data.chargesCreated), 0);
  });

  it("getBudgetQuotaMap - retorna matriz unidade × mês", async () => {
    const { data, status } = await client.admin.getBudgetQuotaMap(
      createdBudget.id,
      { headers: hdr() },
    );
    assertEquals(status, 200);
    assertEquals(data.budgetId, createdBudget.id);
    assertEquals(Array.isArray(data.units), true);
    assertEquals(data.units.length >= 2, true);
    const u0 = data.units[0];
    assertEquals(typeof u0.monthlyTotalCents, "number");
    assertEquals(typeof u0.annualTotalCents, "number");
    // Refactor #4: `identifier` (Bloco/Piso/Loja) vem do LEFT JOIN com
    // core.unit no handler (a view não o expõe). Antes o panel fazia
    // `listUnits` separado e juntava em JS.
    assertEquals("identifier" in u0, true);
    // Units neste teste são criadas só com designation (sem block/floor/door)
    // → identifier = null no schema (stored generated).
    assertEquals(u0.identifier, null);
  });

  // ── Marcação manual "não aprovado" (draft <-> not_approved) ──────────────
  // Proposta alternativa preterida: o admin marca à mão (não é a assembleia).
  // Reversível e, ao contrário do aprovado, ainda apagável.
  it("reject - draft budget flips to not_approved", async () => {
    const { data: draft } = await client.admin.createBudget(
      { year: "2028", notes: "Proposta alternativa" },
      { headers: hdr() },
    );
    altBudget = draft;
    const { data, status } = await client.admin.rejectBudget(draft.id, { headers: hdr() });
    assertEquals(status, 200);
    assertEquals(data.status, "not_approved");
  });

  it("reject - approved budget returns 409", async () => {
    const e = await assertRejects(
      () => client.admin.rejectBudget(createdBudget.id, { headers: hdr() }),
      ApiError,
    );
    assertEquals(e.statusCode, 409);
  });

  it("reopen - not_approved budget returns to draft", async () => {
    const { data, status } = await client.admin.reopenBudget(altBudget.id, { headers: hdr() });
    assertEquals(status, 200);
    assertEquals(data.status, "draft");
  });

  it("reopen - draft budget returns 409", async () => {
    const e = await assertRejects(
      () => client.admin.reopenBudget(altBudget.id, { headers: hdr() }),
      ApiError,
    );
    assertEquals(e.statusCode, 409);
  });

  it("delete - not_approved budget is allowed (gate é status !== approved)", async () => {
    await client.admin.rejectBudget(altBudget.id, { headers: hdr() });
    const { status } = await client.admin.deleteBudget(altBudget.id, { headers: hdr() });
    assertEquals(status, 204);
  });

  it("teardown - delete condominium", async () => {
    await client.super.deleteCondominium(createdCondo.id, {
      headers: MASTER_HEADERS,
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Quota generation - edge cases (0 units, fcrPercentage=0, idempotência)
// ═══════════════════════════════════════════════════════════════════════════
// O describe acima cobre o happy path. Aqui validamos protecções:
//   - Condomínio sem units ativas → 422 (não 500)
//   - Budget com fcrPercentage=0 → gera quotas sem componente FCR
//   - Re-correr generateQuotas é idempotente (skip de meses já gerados)
//
// NOTA: fcrPercentage NULL é impossível por NOT NULL constraint no schema.

describe("admin budget - generateQuotas edge cases", () => {
  let MASTER: { Authorization: string };
  let condoId = "";

  it("setup - condomínio NOVO sem units + 1 budget aprovado", async () => {
    MASTER = await loginAsSuper();
    const ts = Date.now();
    const { data: c } = await client.super.createCondominium(
      { name: `Quota Edge ${ts}` },
      { headers: MASTER },
    );
    condoId = c.id;
    // NÃO cria units - é o ponto da proteção.
    // Budget approved via SQL para skipar o fluxo de assembleia (que requer units).
    await sqlExec(`
      INSERT INTO finance.chart_of_account (id, code, condominium_id, name, type, parent_code)
      VALUES ('acc_qe_${ts}', '62299', '${condoId}', 'Test', 'expense', '6226');
      INSERT INTO core.budget (id, condominium_id, year, type, status, fcr_percentage)
      VALUES ('bg_qe_${ts}', '${condoId}', 2030, 'principal', 'approved', 10.00);
      INSERT INTO core.budget_line (budget_id, account_id, annual_amount)
      VALUES ('bg_qe_${ts}', 'acc_qe_${ts}', 12000);
    `);
  });

  it("generateQuotas em condo sem units → 422 INVALID_STATE (não 500)", async () => {
    const headers = { ...MASTER, "x-condominium-id": condoId };
    // O budget id usa o ts do setup; recuperamos via query.
    const budgetId = await sqlExec(`
      SELECT id FROM core.budget WHERE condominium_id='${condoId}' LIMIT 1
    `);
    const e = await assertRejects(
      () => client.admin.generateQuotas(budgetId, {}, { headers }),
      ApiError,
    );
    assertEquals(e.statusCode, 422);
    // Mensagem deve mencionar "sem unidades" ou similar.
    assertEquals(/unidades?|units/i.test(e.message), true, `unexpected message: ${e.message}`);
  });

  let nofcrBudgetId = "";

  it("generateQuotas com fcrPercentage=0 → gera só componente ordinária (sem FCR)", async () => {
    // Adiciona 1 unit + cria 2º budget com fcr_percentage=0.
    const ts = Date.now();
    await client.super.createUnit(
      condoId,
      { designation: "U1", permillage: 1000 } as Record<string, unknown>,
      { headers: MASTER },
    );
    nofcrBudgetId = `bg_qe0_${ts}`;
    await sqlExec(`
      INSERT INTO finance.chart_of_account (id, code, condominium_id, name, type, parent_code)
      VALUES ('acc_qe0_${ts}', '62298', '${condoId}', 'No FCR', 'expense', '6226');
      INSERT INTO core.budget (id, condominium_id, year, type, status, fcr_percentage)
      VALUES ('${nofcrBudgetId}', '${condoId}', 2031, 'principal', 'approved', 0);
      INSERT INTO core.budget_line (budget_id, account_id, annual_amount)
      VALUES ('${nofcrBudgetId}', 'acc_qe0_${ts}', 12000);
    `);

    const headers = { ...MASTER, "x-condominium-id": condoId };
    const { data, status } = await client.admin.generateQuotas(
      nofcrBudgetId,
      { throughDate: "2031-12-31" },
      { headers },
    );
    assertEquals(status, 200);
    assertEquals(data.chargesCreated, 12); // 12 meses × 1 unit
    // 12000 / 12 = 1000 cêntimos por mês (sem FCR adicional)
    const total = await sqlExec(`
      SELECT COALESCE(SUM(original_amount), 0)::text
        FROM finance.charge
       WHERE source_id='${nofcrBudgetId}'
    `);
    assertEquals(Number(total), 12000, "Σ charges = totalAnnual sem FCR");
  });

  it("generateQuotas idempotente: re-correr com mesmo throughDate → 0 charges novas", async () => {
    const headers = { ...MASTER, "x-condominium-id": condoId };
    const { data, status } = await client.admin.generateQuotas(
      nofcrBudgetId,
      { throughDate: "2031-12-31" },
      { headers },
    );
    assertEquals(status, 200);
    assertEquals(data.chargesCreated, 0, "re-correr não cria duplicados");
  });

  it("generateQuotas incremental: throughDate maior só gera meses novos", async () => {
    const headers = { ...MASTER, "x-condominium-id": condoId };
    // Cria 3º budget para 2032, gera só até Mar.
    const ts = Date.now();
    const incBudget = `bg_qinc_${ts}`;
    await sqlExec(`
      INSERT INTO finance.chart_of_account (id, code, condominium_id, name, type, parent_code)
      VALUES ('acc_qinc_${ts}', '62297', '${condoId}', 'Inc', 'expense', '6226');
      INSERT INTO core.budget (id, condominium_id, year, type, status, fcr_percentage)
      VALUES ('${incBudget}', '${condoId}', 2032, 'principal', 'approved', 0);
      INSERT INTO core.budget_line (budget_id, account_id, annual_amount)
      VALUES ('${incBudget}', 'acc_qinc_${ts}', 12000);
    `);
    const r1 = await client.admin.generateQuotas(
      incBudget,
      { throughDate: "2032-03-31" },
      { headers },
    );
    assertEquals(r1.data.chargesCreated, 3, "3 meses (Jan/Fev/Mar)");

    // Agora extender até Junho - deve gerar só Apr/Mai/Jun (não duplicar Jan-Mar)
    const r2 = await client.admin.generateQuotas(
      incBudget,
      { throughDate: "2032-06-30" },
      { headers },
    );
    assertEquals(r2.data.chargesCreated, 3, "incremental: só Abr/Mai/Jun (3)");

    // Confirma total final = 6 meses
    const total = await sqlExec(`
      SELECT COUNT(*)::text FROM finance.charge
       WHERE source_id='${incBudget}'
    `);
    assertEquals(Number(total), 6, "total = 6 meses (não duplicados)");
  });

  it("teardown", async () => {
    await client.super.deleteCondominium(condoId, { headers: MASTER });
  });
});
