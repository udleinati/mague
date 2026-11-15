import { assertEquals, assertThrows } from "@std/assert";
import {
  ACC_BANK_FCR,
  ACC_BANK_ORDINARY,
  fcrTransferAccounts,
  fcrTransferCreateSchema,
  fcrTransferSourceBalance,
} from "./fcr_transfer.ts";

// A dupla partida tem de debitar a bolsa que RECEBE e creditar a que dá. Trocar
// os códigos inverte o sentido do dinheiro sem nenhum erro visível: o ledger
// continua a fechar (ambas são contas de ativo) e o KPI mostra o contrário do
// que o admin pediu.
Deno.test("fcrTransferAccounts - reforço debita a bolsa FCR e credita a ordinária", () => {
  assertEquals(fcrTransferAccounts("to_fcr"), {
    debit: ACC_BANK_FCR,
    credit: ACC_BANK_ORDINARY,
  });
});

Deno.test("fcrTransferAccounts - levantamento debita a ordinária e credita a FCR", () => {
  assertEquals(fcrTransferAccounts("to_ordinary"), {
    debit: ACC_BANK_ORDINARY,
    credit: ACC_BANK_FCR,
  });
});

Deno.test("fcrTransferAccounts - as duas direções nunca partilham perna", () => {
  const a = fcrTransferAccounts("to_fcr");
  const b = fcrTransferAccounts("to_ordinary");
  assertEquals(a.debit, b.credit);
  assertEquals(a.credit, b.debit);
});

// A validação de saldo tem de olhar para a bolsa de ORIGEM. Ler a de destino
// deixaria esvaziar o FCR para lá do que tem, desde que a ordinária cobrisse.
Deno.test("fcrTransferSourceBalance - origem é a bolsa que perde o dinheiro", () => {
  const balances = { ordinaryCents: 30000, fcrCents: 5000 };
  assertEquals(fcrTransferSourceBalance("to_fcr", balances), 30000);
  assertEquals(fcrTransferSourceBalance("to_ordinary", balances), 5000);
});

Deno.test("fcrTransferCreateSchema - aceita payload completo", () => {
  const parsed = fcrTransferCreateSchema.parse({
    direction: "to_fcr",
    amountCents: 15000,
    date: "2026-07-28",
    reason: "Deliberação da assembleia de 12/03/2026",
  });
  assertEquals(parsed.amountCents, 15000);
  assertEquals(parsed.reason, "Deliberação da assembleia de 12/03/2026");
});

// Motivo obrigatório é o que torna a transferência auditável (DF2): sem ele
// fica dinheiro reclassificado sem ninguém saber porquê. Espaços não contam.
Deno.test("fcrTransferCreateSchema - motivo em branco é rejeitado", () => {
  assertThrows(() =>
    fcrTransferCreateSchema.parse({
      direction: "to_fcr",
      amountCents: 15000,
      date: "2026-07-28",
      reason: "   ",
    })
  );
});

Deno.test("fcrTransferCreateSchema - montante tem de ser positivo em cêntimos", () => {
  const base = { direction: "to_fcr", date: "2026-07-28", reason: "x" };
  assertThrows(() => fcrTransferCreateSchema.parse({ ...base, amountCents: 0 }));
  assertThrows(() => fcrTransferCreateSchema.parse({ ...base, amountCents: -100 }));
  assertThrows(() => fcrTransferCreateSchema.parse({ ...base, amountCents: 12.5 }));
});

Deno.test("fcrTransferCreateSchema - direção fora do enum é rejeitada", () => {
  assertThrows(() =>
    fcrTransferCreateSchema.parse({
      direction: "to_bank",
      amountCents: 100,
      date: "2026-07-28",
      reason: "x",
    })
  );
});

Deno.test("fcrTransferCreateSchema - data tem de ser YYYY-MM-DD", () => {
  const base = { direction: "to_fcr", amountCents: 100, reason: "x" };
  assertThrows(() => fcrTransferCreateSchema.parse({ ...base, date: "28/07/2026" }));
  assertThrows(() => fcrTransferCreateSchema.parse({ ...base, date: "2026-07" }));
});
