// Anti-regressão: o PDF do recibo enviado por email tem de ser **byte-a-byte
// idêntico** ao que o panel descarrega via /v1/admin/.../receipts/:id/pdf.
//
// Histórico: o transport SMTP em Deno tem um footgun com `Uint8Array` -
// passa o type-check do nodemailer mas o pipeline MIME corrompe os bytes
// silenciosamente (PDF chega com tamanho ~igual mas inválido). A correção
// vive em `transport.ts` (Buffer.from(uint8Array)). Este teste fecha o
// loop: se alguém regredir esse fix, o SHA-256 do anexo deixa de bater
// com o do download e o teste falha.
//
// Estratégia:
//   1. Setup minimal (condo + unit + owner com email + bank_account).
//   2. Cria charge + bank_tx + settlement → emite recibo.
//   3. Descarrega o PDF diretamente via API (caminho que sabemos funcionar).
//   4. Re-envia por email (limpa Mailpit antes).
//   5. Pull do attachment via Mailpit + SHA-256.
//   6. Asserta: tamanhos batem, magic header é `%PDF-`, SHA-256 idêntico.

import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { Client, type Condominium, type Unit } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";
import {
  flushMailpit,
  getMessageAttachmentBytes,
  sha256Hex,
  waitForEmail,
} from "./_helpers/mailpit.ts";

const BASE_URL = "http://localhost:3000";
const AUTH = await loginAsSuper();
const client = new Client({ baseUrl: BASE_URL });

describe("admin receipt - PDF email integridade (byte-exato vs download)", () => {
  let condo: Condominium;
  let unit: Unit;
  let receiptId = "";
  let ownerEmail = "";
  const hdr = () => ({ ...AUTH, "x-condominium-id": condo.id });

  it("setup: condo + unit + owner + bank account + charge paga", async () => {
    const ts = Date.now();
    ownerEmail = `pdf-integrity-${ts}@maguetest.pt`;

    const { data: c } = await client.super.createCondominium(
      { name: `PDF Integrity ${ts}`, fiscalNumber: "509000001" },
      { headers: AUTH },
    );
    condo = c;

    const { data: u } = await client.super.createUnit(
      condo.id,
      { designation: "A", permillage: 1000 },
      { headers: AUTH },
    );
    unit = u;

    const { data: occ } = await client.admin.createOccupant(
      { name: "PDF Owner", type: "owner", email: ownerEmail, nif: "509000001" },
      { headers: hdr() },
    );
    await client.admin.createUnitOccupant(
      unit.id,
      {
        unitId: unit.id,
        occupantId: occ.id,
        relationshipType: "owner",
        startDate: "2025-01-01",
      },
      { headers: hdr() },
    );

    const { data: ba } = await client.admin.createBankAccount(
      {
        bankName: "Banco PDF Integrity",
        iban: "PT50000700000000000088888",
        kind: "bank",
      },
      { headers: hdr() },
    );

    const { data: ch } = await client.admin.createCharge(
      {
        kind: "receivable",
        nature: "debit",
        chargeType: "quota",
        scope: "unit",
        unitId: unit.id,
        issueDate: "2026-03-01",
        competencePeriod: "2026-03-01",
        amountCents: 5000,
        description: "Quota Mar/A",
      },
      { headers: hdr() },
    );
    const { data: bt } = await client.admin.createBankTransaction(
      {
        bankAccountId: ba.id as string,
        transactionDate: "2026-03-15",
        amount: 5000,
        description: "Pagto Mar A",
      },
      { headers: hdr() },
    );
    await client.admin.createSettlement(
      {
        settlementType: "bank_reconciliation",
        bankTransactionId: bt.id,
        debitChargeId: ch.id,
        amount: 5000,
        settlementDate: "2026-03-15",
      },
      { headers: hdr() },
    );

    const { data: bulk } = await client.admin.emitBulkReceipts({ headers: hdr() });
    assertEquals(bulk.success, 1);
    receiptId = bulk.results[0].receiptId ?? "";
    assertEquals(receiptId.length > 0, true);
  });

  it("PDF enviado por email == PDF descarregado (SHA-256 byte-exato)", async () => {
    // Caminho de referência: download direto via API. É o "truth" - o que
    // o painel mostra ao admin que clica no botão "ver/descarregar".
    const dlRes = await fetch(
      `${BASE_URL}/v1/admin/condominiums/${condo.id}/receipts/${receiptId}/pdf`,
      { headers: AUTH },
    );
    assertEquals(dlRes.status, 200);
    assertEquals(dlRes.headers.get("content-type"), "application/pdf");
    const downloadedBytes = new Uint8Array(await dlRes.arrayBuffer());
    const downloadedHash = await sha256Hex(downloadedBytes);

    // Sanidade: PDF válido começa por `%PDF-`.
    const magic = new TextDecoder().decode(downloadedBytes.slice(0, 5));
    assertEquals(magic, "%PDF-", `download não é um PDF válido (magic=${magic})`);

    // Limpa Mailpit antes de disparar o re-envio para garantir que o email
    // que vamos buscar é o da call abaixo (não um vestígio de outro test).
    await flushMailpit();

    const resend = await client.admin.resendReceiptEmail(receiptId, {
      headers: hdr(),
    });
    assertEquals(resend.status, 200);
    assertEquals(resend.data.sent, 1);
    assertEquals(resend.data.failed, 0);

    const message = await waitForEmail({
      to: ownerEmail,
      subjectIncludes: "Recibo",
      timeoutMs: 10_000,
    });
    assertEquals(message.Attachments.length, 1);
    const att = message.Attachments[0];
    assertEquals(att.ContentType, "application/pdf");
    assertEquals(
      att.Size,
      downloadedBytes.byteLength,
      `tamanhos diferem: anexo=${att.Size} download=${downloadedBytes.byteLength}`,
    );

    const attachmentBytes = await getMessageAttachmentBytes(message.ID, att.PartID);
    const attachmentMagic = new TextDecoder().decode(attachmentBytes.slice(0, 5));
    assertEquals(
      attachmentMagic,
      "%PDF-",
      `anexo não é um PDF válido (magic=${attachmentMagic}). Provável falta do Buffer.from() em transport.ts.`,
    );

    const attachmentHash = await sha256Hex(attachmentBytes);
    assertEquals(
      attachmentHash,
      downloadedHash,
      `SHA-256 diferem entre PDF do anexo e PDF do download. ` +
        `Indica corrupção no pipeline SMTP/MIME - investigar transport.ts. ` +
        `download=${downloadedHash} anexo=${attachmentHash}`,
    );
  });

  it("teardown: cleanup", async () => {
    await client.super.deleteCondominium(condo.id, { headers: AUTH });
  });
});
