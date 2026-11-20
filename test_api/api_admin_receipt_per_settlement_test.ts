// Um recibo por conciliação: um movimento conciliado aos poucos gera vários recibos.
//
// Porquê: o depósito da seguradora fica "Em aberto" e vai sendo consumido à medida que cada
// reparação é refaturada à fração. Com "um recibo por par", a 2.ª conciliação na mesma fração
// nunca voltava aos pendentes e esse dinheiro ficava sem recibo, sem aviso.
//
// Comportamento testado:
//   1. Conciliação parcial → recibo só desse valor; o resto do movimento continua por conciliar.
//   2. Nova conciliação no mesmo par → volta aos pendentes só com o valor novo → 2.º recibo.
//   3. Anular o 1.º recibo devolve à fila só as conciliações dele (o 2.º continua ativo).
//   4. Recibo antigo (settlement_ids vazio) cobre o que existia na emissão; o que vem depois não.
//   5. Excedente imputado mais tarde como crédito → recibo "Adiantamento à conta" só desse valor.

import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import postgresjs from "postgresjs";
import { Client, type Condominium } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";

const BASE_URL = "http://localhost:3000";
const DATABASE_URL = Deno.env.get("DATABASE_URL") ??
  "postgres://mague:mague@localhost:5432/mague";
const AUTH = await loginAsSuper();
const client = new Client({ baseUrl: BASE_URL });
const sql = postgresjs(DATABASE_URL, { max: 2 });

describe("admin receipts - um recibo por conciliação", () => {
  let condo: Condominium;
  let headers: Record<string, string>;
  let bankAccountId = "";
  const unitIds = { a: "", b: "", c: "" };
  const receipts = { r1: "", r2: "" };
  let deposit = "";

  const pendingFor = async (bankTransactionId: string) => {
    const { data } = await client.admin.listPendingReceipts({ headers });
    return data.filter((p) => p.bankTransactionId === bankTransactionId)
      .map((p) => [p.unitId, p.recipientAmount]);
  };

  const debit = async (unitId: string, amountCents: number, description: string) => {
    const { data } = await client.admin.createCharge(
      {
        kind: "receivable",
        nature: "debit",
        chargeType: "extraordinary_quota",
        scope: "unit",
        unitId,
        issueDate: "2026-10-01",
        competencePeriod: "2026-10-01",
        amountCents,
        description,
      },
      { headers },
    );
    return data.id;
  };

  const settle = (bankTransactionId: string, debitChargeId: string, amount: number) =>
    client.admin.createSettlement(
      {
        settlementType: "bank_reconciliation",
        bankTransactionId,
        debitChargeId,
        amount,
        settlementDate: "2026-10-27",
      },
      { headers },
    );

  const newDeposit = async (amount: number, description: string) => {
    const { data } = await client.admin.createBankTransaction(
      { bankAccountId, transactionDate: "2026-10-27", amount, description },
      { headers },
    );
    return data.id as string;
  };

  const emit = async (bankTransactionId: string, unitId: string) => {
    const { data } = await client.admin.emitReceipt({ bankTransactionId, unitId }, { headers });
    const { data: r } = await client.admin.getReceipt(data.receiptId, { headers });
    return r;
  };

  it("setup - 3 frações com proprietário + conta", async () => {
    const { data: c } = await client.super.createCondominium(
      { name: "Per Settlement Receipt Test", fiscalNumber: "509300300" },
      { headers: AUTH },
    );
    condo = c;
    headers = { ...AUTH, "x-condominium-id": condo.id };
    for (const k of ["a", "b", "c"] as const) {
      const { data: u } = await client.super.createUnit(
        condo.id,
        { designation: k.toUpperCase(), permillage: 300 },
        { headers: AUTH },
      );
      unitIds[k] = u.id;
      const { data: occ } = await client.admin.createOccupant(
        { name: `Dono ${k.toUpperCase()}`, nif: "234567899" },
        { headers },
      );
      await client.admin.createUnitOccupant(
        u.id,
        { unitId: u.id, occupantId: occ.id, relationshipType: "owner", startDate: "2025-01-01" },
        { headers },
      );
    }
    const { data: ba } = await client.admin.createBankAccount(
      { bankName: "Per Settlement Bank", iban: "PT50000700000000000099993", kind: "bank" },
      { headers },
    );
    bankAccountId = String(ba.id);
  });

  it("conciliação parcial → recibo só desse valor", async () => {
    deposit = await newDeposit(71860, "Seguradora - sinistro");
    await settle(deposit, await debit(unitIds.a, 45203, "Reparação 1"), 45203);
    assertEquals(await pendingFor(deposit), [[unitIds.a, 45203]]);

    const r1 = await emit(deposit, unitIds.a);
    receipts.r1 = r1.id;
    assertEquals(r1.amountCents, 45203);
    assertEquals(r1.linesSnapshot?.map((l) => l.amount), [45203]);
    assertEquals(await pendingFor(deposit), []);
  });

  it("nova conciliação no mesmo par → pendente só com o valor novo → 2.º recibo", async () => {
    await settle(deposit, await debit(unitIds.a, 50000, "Reparação 2"), 26657);
    assertEquals(await pendingFor(deposit), [[unitIds.a, 26657]]);

    const r2 = await emit(deposit, unitIds.a);
    receipts.r2 = r2.id;
    assertEquals(r2.amountCents, 26657);
    assertEquals(r2.linesSnapshot?.map((l) => l.amount), [26657]);
    assertEquals(await pendingFor(deposit), []);
  });

  it("anular o 1.º recibo devolve à fila só as conciliações dele", async () => {
    await client.admin.voidReceipt(receipts.r1, { reason: "teste por conciliação" }, { headers });
    assertEquals(await pendingFor(deposit), [[unitIds.a, 45203]]);
    const { data: r2 } = await client.admin.getReceipt(receipts.r2, { headers });
    assertEquals(r2.isVoided, false);
  });

  it("recibo antigo (sem settlement_ids) cobre o que existia na emissão, não o que vem depois", async () => {
    const tx = await newDeposit(30000, "Pagamento B");
    await settle(tx, await debit(unitIds.b, 20000, "Quota B"), 20000);
    const old = await emit(tx, unitIds.b);
    // Simula um recibo emitido antes da migration 004.
    await sql`UPDATE finance.receipt SET settlement_ids = '{}' WHERE id = ${old.id}`;
    assertEquals(await pendingFor(tx), []);

    await settle(tx, await debit(unitIds.b, 10000, "Obra B"), 10000);
    assertEquals(await pendingFor(tx), [[unitIds.b, 10000]]);
  });

  it("excedente imputado mais tarde como crédito → recibo 'Adiantamento à conta' desse valor", async () => {
    const tx = await newDeposit(30000, "Pagamento C a mais");
    await settle(tx, await debit(unitIds.c, 20000, "Quota C"), 20000);
    await emit(tx, unitIds.c);

    // Sem cobranças em aberto na fração C: o que falta do movimento vira crédito.
    await client.admin.allocateBankTransactionToUnit(tx, { unitId: unitIds.c }, { headers });
    assertEquals(await pendingFor(tx), [[unitIds.c, 10000]]);

    const credit = await emit(tx, unitIds.c);
    assertEquals(credit.amountCents, 10000);
    assertEquals(credit.linesSnapshot?.map((l) => l.description), ["Adiantamento à conta"]);
  });

  it("teardown", async () => {
    await sql.end();
  });
});
