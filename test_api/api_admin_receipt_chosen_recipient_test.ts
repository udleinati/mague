// "Emitir para…": o admin escolhe para quem sai o recibo.
//
// Porquê: numa fração onde ora paga o proprietário ora outro ocupante, a regra por defeito põe
// todos os owners/residents no "Recebido de" e manda email conforme a preferência de cada um.
// O recibo tem de poder sair só em nome de quem pagou, e o email ir só para essa pessoa.
//
// Comportamento testado:
//   1. Opções = todos os ocupantes da fração na data do pagamento (inclui inquilino).
//   2. Proprietário escolhido com opt-out: só ele no recibo e recebe o email (residente não).
//   3. Inquilino escolhido (fora da regra por defeito) fica como único destinatário.
//   4. Manual: nome/NIF externos, email sem link do portal e sem criar conta.
//   5. Ocupante de outra fração ou manual sem NIF: recusado, a linha continua pendente.
//   6. Re-enviar um recibo escolhido vai só ao escolhido, mesmo com opt-out.
//   7. Pré-visualizar mostra o recibo como sairia (por defeito ou escolhido) sem emitir.

import { assertEquals, assertNotEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import postgresjs from "postgresjs";
import { Client, type Condominium, type Unit } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";

const BASE_URL = "http://localhost:3000";
const DATABASE_URL = Deno.env.get("DATABASE_URL") ??
  "postgres://mague:mague@localhost:5432/mague";
const AUTH = await loginAsSuper();
const client = new Client({ baseUrl: BASE_URL });
const sql = postgresjs(DATABASE_URL, { max: 2 });

describe("admin receipts - destinatário escolhido na emissão", () => {
  let condo: Condominium;
  let unit: Unit;
  let headers: Record<string, string>;
  const ids = { owner: "", tenant: "", resident: "", otherUnitOwner: "" };
  const txs: string[] = [];
  let ownerReceiptId = "";
  const stamp = Date.now();
  const email = {
    owner: `chosen-owner-${stamp}@example.pt`,
    tenant: `chosen-tenant-${stamp}@example.pt`,
    resident: `chosen-resident-${stamp}@example.pt`,
    manual: `chosen-manual-${stamp}@example.pt`,
  };

  const receiptMails = async (to: string) => {
    const [r] = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM audit.email_log
       WHERE recipient = ${to} AND category = 'receipt'
    `;
    return r.n;
  };

  const expectRejected = async (
    body: Parameters<typeof client.admin.emitReceipt>[0],
    status: number,
  ) => {
    try {
      await client.admin.emitReceipt(body, { headers });
      assertEquals(true, false, `esperado erro ${status}`);
    } catch (e) {
      // deno-lint-ignore no-explicit-any
      assertEquals((e as any).statusCode, status);
    }
  };

  it("setup - fração com proprietário (opt-out), inquilino, residente + 4 pagamentos", async () => {
    const { data: c } = await client.super.createCondominium(
      { name: "Chosen Recipient Test", fiscalNumber: "509300200" },
      { headers: AUTH },
    );
    condo = c;
    headers = { ...AUTH, "x-condominium-id": condo.id };

    const { data: u } = await client.super.createUnit(
      condo.id,
      { designation: "C", permillage: 500 },
      { headers: AUTH },
    );
    unit = u;
    const { data: other } = await client.super.createUnit(
      condo.id,
      { designation: "D", permillage: 500 },
      { headers: AUTH },
    );

    const link = async (
      unitId: string,
      name: string,
      nif: string,
      mail: string,
      relationshipType: "owner" | "tenant" | "resident",
    ) => {
      const { data: occ } = await client.admin.createOccupant(
        { name, nif, email: mail },
        { headers },
      );
      await client.admin.createUnitOccupant(
        unitId,
        { unitId, occupantId: occ.id, relationshipType, startDate: "2025-01-01" },
        { headers },
      );
      return occ.id;
    };
    ids.owner = await link(unit.id, "A Proprietária", "502626836", email.owner, "owner");
    ids.tenant = await link(unit.id, "B Inquilina", "514498893", email.tenant, "tenant");
    ids.resident = await link(unit.id, "C Residente", "234567899", email.resident, "resident");
    ids.otherUnitOwner = await link(
      other.id,
      "Dono D",
      "345678915",
      `chosen-other-${stamp}@example.pt`,
      "owner",
    );
    // Caso real: o proprietário desligou "Receber recibos por email".
    await sql`UPDATE core.occupant SET receive_receipt_emails = FALSE WHERE id = ${ids.owner}`;

    const { data: ba } = await client.admin.createBankAccount(
      { bankName: "Chosen Bank", iban: "PT50000700000000000099992", kind: "bank" },
      { headers },
    );
    for (const month of ["06", "07", "08", "09"]) {
      const { data: ch } = await client.admin.createCharge(
        {
          kind: "receivable",
          nature: "debit",
          chargeType: "quota",
          scope: "unit",
          unitId: unit.id,
          issueDate: `2026-${month}-01`,
          competencePeriod: `2026-${month}-01`,
          amountCents: 8000,
          description: `Quota ${month}`,
        },
        { headers },
      );
      const { data: bt } = await client.admin.createBankTransaction(
        {
          bankAccountId: ba.id,
          transactionDate: `2026-${month}-15`,
          amount: 8000,
          description: `Pagto ${month}`,
        },
        { headers },
      );
      await client.admin.createSettlement(
        {
          settlementType: "bank_reconciliation",
          bankTransactionId: bt.id,
          debitChargeId: ch.id,
          amount: 8000,
          settlementDate: `2026-${month}-15`,
        },
        { headers },
      );
      txs.push(bt.id);
    }
  });

  it("opções incluem todos os ocupantes da fração na data, inclusive o inquilino", async () => {
    const { data } = await client.admin.getReceiptRecipientOptions(
      { bankTransactionId: txs[0], unitId: unit.id },
      { headers },
    );
    assertEquals(data.amountCents, 8000);
    assertEquals(
      data.candidates.map((c) => [c.occupantId, c.relationshipType]),
      [[ids.owner, "owner"], [ids.tenant, "tenant"], [ids.resident, "resident"]],
    );
  });

  it("pré-visualização mostra o recibo como sairia e não emite nada", async () => {
    const before = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM finance.receipt WHERE condominium_id = ${condo.id}
    `;
    const { data: byDefault } = await client.admin.previewReceipt(
      { bankTransactionId: txs[3], unitId: unit.id },
      { headers },
    );
    // Regra por defeito: owner + residente, inquilino de fora.
    assertEquals(byDefault.html.includes("A Proprietária"), true);
    assertEquals(byDefault.html.includes("C Residente"), true);
    assertEquals(byDefault.html.includes("B Inquilina"), false);
    assertEquals(byDefault.html.includes("PRÉ-VISUALIZAÇÃO"), true);

    const { data: chosen } = await client.admin.previewReceipt(
      { bankTransactionId: txs[3], unitId: unit.id, recipient: { occupantId: ids.tenant } },
      { headers },
    );
    assertEquals(chosen.html.includes("B Inquilina"), true);
    assertEquals(chosen.html.includes("A Proprietária"), false);

    const after = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM finance.receipt WHERE condominium_id = ${condo.id}
    `;
    assertEquals(after[0].n, before[0].n);
    const { data: pending } = await client.admin.listPendingReceipts({ headers });
    assertEquals(pending.some((p) => p.bankTransactionId === txs[3]), true);
  });

  it("proprietário escolhido com opt-out: só ele no recibo e só ele recebe email", async () => {
    const { data } = await client.admin.emitReceipt(
      { bankTransactionId: txs[0], unitId: unit.id, recipient: { occupantId: ids.owner } },
      { headers },
    );
    ownerReceiptId = data.receiptId;
    assertEquals(data.emailsSent, 1);

    const { data: receipt } = await client.admin.getReceipt(ownerReceiptId, { headers });
    assertEquals(receipt.recipientsSnapshot?.map((r) => [r.occupantId, r.chosen]), [
      [ids.owner, true],
    ]);
    assertEquals(await receiptMails(email.owner), 1);
    assertEquals(await receiptMails(email.resident), 0);
  });

  it("inquilino escolhido fica como único destinatário", async () => {
    const { data } = await client.admin.emitReceipt(
      { bankTransactionId: txs[1], unitId: unit.id, recipient: { occupantId: ids.tenant } },
      { headers },
    );
    const { data: receipt } = await client.admin.getReceipt(data.receiptId, { headers });
    assertEquals(receipt.recipientsSnapshot?.map((r) => r.occupantId), [ids.tenant]);
    assertEquals(await receiptMails(email.tenant), 1);
  });

  it("manual: recibo em nome externo, email sem portal e sem criar conta", async () => {
    const { data } = await client.admin.emitReceipt(
      {
        bankTransactionId: txs[2],
        unitId: unit.id,
        recipient: { name: "Externa, Lda", nif: "509 999 990", email: email.manual },
      },
      { headers },
    );
    const { data: receipt } = await client.admin.getReceipt(data.receiptId, { headers });
    assertEquals(receipt.recipientsSnapshot, [{
      occupantId: null,
      name: "Externa, Lda",
      nif: "509999990",
      email: email.manual,
      receiveEmails: true,
      chosen: true,
    }]);

    const [mail] = await sql<{ html: string }[]>`
      SELECT body_html AS html FROM audit.email_log
       WHERE recipient = ${email.manual} AND category = 'receipt'
    `;
    assertNotEquals(mail, undefined);
    assertEquals(mail.html.includes("/portal/"), false);
    assertEquals(mail.html.includes("accept-invite"), false);
    const [users] = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM core.user WHERE email = ${email.manual}
    `;
    assertEquals(users.n, 0);
  });

  it("ocupante de outra fração ou manual sem NIF: recusado e a linha continua pendente", async () => {
    await expectRejected(
      { bankTransactionId: txs[3], unitId: unit.id, recipient: { occupantId: ids.otherUnitOwner } },
      400,
    );
    await expectRejected(
      { bankTransactionId: txs[3], unitId: unit.id, recipient: { name: "Externa", nif: "" } },
      400,
    );
    const { data: pending } = await client.admin.listPendingReceipts({ headers });
    assertEquals(pending.some((p) => p.bankTransactionId === txs[3]), true);
  });

  it("re-enviar recibo escolhido vai só ao escolhido, mesmo com opt-out", async () => {
    const { data } = await client.admin.resendReceiptEmail(ownerReceiptId, { headers });
    assertEquals(data.sent, 1);
    assertEquals(await receiptMails(email.owner), 2);
    assertEquals(await receiptMails(email.resident), 0);
  });

  it("teardown", async () => {
    try {
      await sql`DELETE FROM core.user WHERE email IN (${email.owner}, ${email.tenant})`;
    } finally {
      await sql.end();
    }
  });
});
