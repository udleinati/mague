// Bank statement import flow:
//   1. preview: upload XLSX -> JSON com flag is_duplicate por hash.
//   2. commit:  envia rows -> grava bank_transaction batch.
//
// Cobre o pipeline NovoBanco (parseNovoBancoXlsx) + idempotência via
// import_hash. Constroi um XLSX in-memory para evitar fixture binária.

import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { Client } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";
import { type ScenarioFixture, seedScenario } from "./_helpers/fixtures.ts";
import * as XLSX from "xlsx";

const BASE_URL = "http://localhost:3000";
const client = new Client({ baseUrl: BASE_URL });
const AUTH = await loginAsSuper();

// Estrutura esperada pelo parser (libs/bank_import/novo_banco.ts):
//   Linha 1: vazia
//   Linha 2: header "Data Operação", "Data Valor", "Tipo", "Descrição",
//            "Débito", "Crédito", "Saldo Controlo"
//   Linha 3+: data em serial Excel; débito/crédito separados.
//
// Excel serial: o parser usa (serial - 25569) * 86400 * 1000 onde 25569
// é o serial de 1970-01-01. Inverso: serial = days_since_1970 + 25569.
function dateToExcelSerial(year: number, month: number, day: number): number {
  return Math.round(Date.UTC(year, month - 1, day) / 86400000) + 25569;
}

function buildNovoBancoXlsx(): Uint8Array {
  const date1 = dateToExcelSerial(2099, 1, 15);
  const date2 = dateToExcelSerial(2099, 1, 16);

  const rows: unknown[][] = [
    [], // L1 vazia
    ["Data Operação", "Data Valor", "Tipo", "Descrição", "Débito", "Crédito", "Saldo Controlo"],
    [date1, date1, "TRF", "Pagamento quota Janeiro", null, 100.00, 1100.00],
    [date2, date2, "DEB", "Pagamento EDP", 50.00, null, 1050.00],
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Movimentos");
  return XLSX.write(wb, { type: "array", bookType: "xlsx" }) as Uint8Array;
}

describe("admin bank statement import - preview + commit", () => {
  let fx: ScenarioFixture;
  let bankAccountId = "";
  const hdr = () => fx.hdr();

  it("setup - condo + bank_account", async () => {
    fx = await seedScenario(client, AUTH)
      .withCondo("Bank Import Test")
      .build();

    const { data: ba } = await client.admin.createBankAccount(
      {
        bankName: "NovoBanco",
        iban: "PT50000700000000000033333",
        accountName: "Conta Teste Import",
        openingBalance: 100000,
        openingBalanceDate: "2099-01-01",
      },
      { headers: hdr() },
    );
    bankAccountId = ba.id as string;
  });

  let previewRows: Array<Record<string, unknown>> = [];

  it("preview - parser devolve 2 linhas com is_duplicate=false na primeira corrida", async () => {
    const xlsx = buildNovoBancoXlsx();
    const blob = new Blob([xlsx as BlobPart], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const { data, status } = await client.admin.previewBankStatementImport(
      bankAccountId,
      blob,
      "extracto.xlsx",
      { headers: hdr() },
    );
    assertEquals(status, 200);
    assertEquals(Array.isArray(data.rows), true);
    assertEquals(data.rows.length, 2);

    // Primeira linha: crédito 100€.
    const r0 = data.rows[0] as Record<string, unknown>;
    assertEquals(r0.transactionDate, "2099-01-15");
    assertEquals(r0.amountCents, 10000);
    assertEquals(r0.is_duplicate, false);
    assertEquals(typeof r0.import_hash, "string");

    // Segunda: débito -50€.
    const r1 = data.rows[1] as Record<string, unknown>;
    assertEquals(r1.amountCents, -5000);
    assertEquals(r1.is_duplicate, false);

    previewRows = data.rows;
  });

  it("commit - cria 2 bank_transactions e devolve importBatchId", async () => {
    const { data, status } = await client.admin.commitBankStatementImport(
      bankAccountId,
      { rows: previewRows, filename: "extracto.xlsx" },
      { headers: hdr() },
    );
    assertEquals(status, 200);
    assertEquals(data.created, 2);
    assertEquals(data.skipped, 0);
    assertEquals(typeof data.importBatchId, "string");
  });

  it("preview novamente - mesmas linhas vêm com is_duplicate=true", async () => {
    // Re-correr preview com o mesmo XLSX deve sinalizar duplicates pelos hashes.
    const xlsx = buildNovoBancoXlsx();
    const blob = new Blob([xlsx as BlobPart], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const { data } = await client.admin.previewBankStatementImport(
      bankAccountId,
      blob,
      "extracto.xlsx",
      { headers: hdr() },
    );
    assertEquals(data.rows.length, 2);
    assertEquals((data.rows[0] as Record<string, unknown>).is_duplicate, true);
    assertEquals((data.rows[1] as Record<string, unknown>).is_duplicate, true);
  });

  it("commit idempotente - se rows já existem em DB, skipped > 0", async () => {
    const { data, status } = await client.admin.commitBankStatementImport(
      bankAccountId,
      { rows: previewRows, filename: "extracto-2.xlsx" },
      { headers: hdr() },
    );
    assertEquals(status, 200);
    // Hashes idênticos -> tudo é skipped na 2ª corrida.
    assertEquals(data.created, 0);
    assertEquals(data.skipped, 2);
  });

  it("teardown - cleanup", async () => {
    await fx.cleanup();
  });
});
