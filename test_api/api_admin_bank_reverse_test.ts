import { assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { ApiError, Client, type Unit } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";
import { type ScenarioFixture, seedScenario } from "./_helpers/fixtures.ts";

// Reversão de bank_transaction: bug reportado pelo utilizador.
//
// Cenário: o utilizador concilia uma bank_tx numa fração que NÃO tem
// dívidas; isto faz com que `executeAllocation` registe o valor todo
// como `credit_balance` (excedente). Espera que ao reverter via /reverse
// o crédito desapareça da unit (i.e. `open_credit_cents = 0`).
//
// Hoje, a credit_balance charge fica `open` com `open_amount` = valor da
// tx - saldo fantasma. Este teste afirma o comportamento correcto.

const BASE_URL = "http://localhost:3000";
const AUTH = await loginAsSuper();
const client = new Client({ baseUrl: BASE_URL });

describe("admin bank_transaction reverse - clears credit_balance", () => {
  let fx: ScenarioFixture;
  let unit: Unit;
  let bankAccountId = "";
  let txId = "";

  it("setup - condo + unit + bank_account", async () => {
    fx = await seedScenario(client, AUTH)
      .withCondo("Reverse Credit Test Condo")
      .withUnit({ designation: "F", permillage: 1000 })
      .build();
    unit = fx.units[0];
    const headers = fx.hdr();

    const { data: ba } = await client.admin.createBankAccount(
      {
        bankName: "Banco RT",
        iban: "PT50000700000000000099999",
        accountName: "Reverse Test Account",
        openingBalance: 0,
        openingBalanceDate: "2099-01-01",
      },
      { headers },
    );
    bankAccountId = ba.id as string;
  });

  it("setup - bank_tx 140€ + allocate_to_unit (sem dívidas) cria credit_balance", async () => {
    const headers = fx.hdr();

    // Bank tx +140€ numa unit sem qualquer charge: executeAllocation
    // não tem onde imputar e cria credit_balance + bank_deposit_credit.
    const { data: tx } = await client.admin.createBankTransaction(
      {
        bankAccountId,
        transactionDate: "2099-05-10",
        amount: 14000,
        description: "Adiantamento bancário 140€",
      },
      { headers },
    );
    txId = tx.id as string;

    const allocResp = await fetch(
      `${BASE_URL}/v1/admin/condominiums/${fx.condominium.id}/bank_transactions/${txId}/allocate_to_unit`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ unitId: unit.id }),
      },
    );
    assertEquals(allocResp.status, 201);
    const body = await allocResp.json();
    assertEquals(body.data.count >= 1, true);
    const alloc = body.data.allocations[0] as Record<string, unknown>;
    // O resultado é um settlement bank_deposit_credit (não há débitos a imputar).
    assertEquals(alloc.chargeType, "credit_balance");
    assertEquals(Number(alloc.amountAllocated), 14000);
  });

  it("setup - confirma que unit tem 140€ de crédito antes da reversão", async () => {
    const headers = fx.hdr();
    const { data: u } = await client.admin.getUnit(unit.id, { headers });
    // O serializer de Unit inclui o saldo agregado.
    assertEquals(
      (u as unknown as { balance?: { openCreditCents: number } }).balance
        ?.openCreditCents,
      14000,
    );
  });

  it("reverte a bank_tx - credit_balance deve ser cancelada", async () => {
    const headers = fx.hdr();

    const { data, status } = await client.admin.reverseBankTransaction(
      txId,
      { reason: "Cheque devolvido pelo banco - pagamento não confirmado" },
      { headers },
    );
    assertEquals(status, 200);
    assertEquals(data.status, "reversed");
  });

  it("após reversão, unit não tem mais crédito (saldo limpo)", async () => {
    const headers = fx.hdr();
    const { data: u } = await client.admin.getUnit(unit.id, { headers });
    const balance = (u as unknown as {
      balance?: { openCreditCents: number; openDebtCents: number; netCents: number };
    }).balance;
    // **Este é o bug**: hoje openCreditCents continua 14000 e netCents = -14000.
    assertEquals(
      balance?.openCreditCents,
      0,
      `Esperado openCreditCents=0 após reversão, recebido ${balance?.openCreditCents}`,
    );
    assertEquals(balance?.openDebtCents, 0);
    assertEquals(
      balance?.netCents,
      0,
      `Esperado netCents=0 após reversão, recebido ${balance?.netCents}`,
    );
  });

  it("reverter bank_tx já-revertida → 409 ALREADY_REVERSED", async () => {
    // A bank_tx do setup já foi revertida acima. Re-tentar reverter a
    // mesma deve devolver Conflict (não 200, não 500).
    const headers = fx.hdr();
    const e = await assertRejects(
      () =>
        client.admin.reverseBankTransaction(
          txId,
          { reason: "Tentativa duplicada de reverter para testar 409" },
          { headers },
        ),
      ApiError,
    );
    assertEquals(e.statusCode, 409);
  });

  it("teardown - cleanup", async () => {
    await fx.cleanup();
  });
});

// Reverter a conciliação tem de anular o recibo emitido para a tupla
// (bank_tx, unit) E regenerar o PDF com a tarja "ANULADO" - senão quem tem o
// ficheiro (email já enviado, download no portal) fica com um recibo com
// aspeto válido de um pagamento que deixou de existir.

describe("admin bank_transaction reverse - anula o recibo emitido", () => {
  let fx: ScenarioFixture;
  let unit: Unit;
  let bankTxId = "";
  let receiptId = "";
  let pdfSizeOnEmit = 0;

  it("setup - condo + unit + owner + banco + quota conciliada", async () => {
    fx = await seedScenario(client, AUTH)
      .withCondo("Reverse Receipt Test Condo")
      .withUnit({ designation: "A", permillage: 1000 })
      .withOccupant({
        name: "Dono Reverse Test",
        email: "dono.reverse@example.pt",
        nif: "123456789",
        unitDesignation: "A",
        relationshipType: "owner",
      })
      .build();
    unit = fx.units[0];
    const headers = fx.hdr();

    const { data: ba } = await client.admin.createBankAccount(
      {
        bankName: "Banco RR",
        iban: "PT50000700000000000099998",
        accountName: "Reverse Receipt Account",
      },
      { headers },
    );

    const { data: ch } = await client.admin.createCharge(
      {
        kind: "receivable",
        nature: "debit",
        chargeType: "quota",
        scope: "unit",
        unitId: unit.id,
        issueDate: "2026-01-01",
        competencePeriod: "2026-01-01",
        amountCents: 5000,
        description: "Quota Janeiro/2026",
      },
      { headers },
    );

    const { data: bt } = await client.admin.createBankTransaction(
      {
        bankAccountId: ba.id as string,
        transactionDate: "2026-01-15",
        amount: 5000,
        description: "Pagamento Quota Jan",
      },
      { headers },
    );
    bankTxId = bt.id as string;

    await client.admin.createSettlement(
      {
        settlementType: "bank_reconciliation",
        bankTransactionId: bankTxId,
        debitChargeId: ch.id as string,
        amount: 5000,
        settlementDate: "2026-01-15",
      },
      { headers },
    );
  });

  it("setup - emite o recibo da tupla", async () => {
    const headers = fx.hdr();
    const { data } = await client.admin.emitReceipt(
      { bankTransactionId: bankTxId, unitId: unit.id },
      { headers },
    );
    receiptId = data.receiptId;

    const { data: r } = await client.admin.getReceipt(receiptId, { headers });
    assertEquals(r.isVoided, false);
    pdfSizeOnEmit = r.fileSize ?? 0;
  });

  it("reverter a conciliação anula o recibo", async () => {
    const headers = fx.hdr();
    await client.admin.reverseBankTransaction(
      bankTxId,
      { reason: "Conciliação errada - reverter para corrigir a imputação" },
      { headers },
    );

    const { data: r } = await client.admin.getReceipt(receiptId, { headers });
    assertEquals(r.isVoided, true, `recibo ${r.number} ficou ativo após reverter a conciliação`);
    assertEquals(r.voidedReason, "bank_tx_reversed");
  });

  it("o PDF no S3 é regenerado com a tarja ANULADO", async () => {
    // A tarja vive dentro do PDF comprimido; o sinal observável de que houve
    // re-render é o tamanho do ficheiro mudar face ao emitido.
    const { data: r } = await client.admin.getReceipt(receiptId, { headers: fx.hdr() });
    assertNotEquals(
      r.fileSize,
      pdfSizeOnEmit,
      "PDF não foi regenerado - o condómino continua com um recibo sem tarja ANULADO",
    );
  });

  it("teardown - cleanup", async () => {
    await fx.cleanup();
  });
});
