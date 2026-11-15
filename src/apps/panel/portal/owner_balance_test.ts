import { assertEquals } from "@std/assert";
import { computeOwnerBalance } from "./owner_balance.ts";

Deno.test("computeOwnerBalance - vazio devolve zeros", () => {
  assertEquals(computeOwnerBalance([], null), {
    openDebt: 0,
    openCredit: 0,
    overdueCents: 0,
    futureDebtCents: 0,
    netCents: 0,
  });
});

Deno.test("computeOwnerBalance - soma só status open/partial/overdue", () => {
  const charges = [
    { nature: "debit", status: "open", openAmount: 10000, dueDate: null },
    { nature: "debit", status: "paid", openAmount: 99999, dueDate: null }, // ignorado
    { nature: "debit", status: "partial", openAmount: 5000, dueDate: null },
    { nature: "debit", status: "voided", openAmount: 99999, dueDate: null }, // ignorado
    { nature: "credit", status: "open", openAmount: 3000, dueDate: null },
  ];
  const b = computeOwnerBalance(charges, null);
  assertEquals(b.openDebt, 15000);
  assertEquals(b.openCredit, 3000);
  assertEquals(b.netCents, 12000);
});

Deno.test("computeOwnerBalance - cutoff null não acusa overdue", () => {
  const charges = [
    { nature: "debit", status: "overdue", openAmount: 5000, dueDate: "2020-01-01" },
  ];
  const b = computeOwnerBalance(charges, null);
  assertEquals(b.overdueCents, 0);
  assertEquals(b.futureDebtCents, 5000); // tudo cai em "futuro" sem cutoff
});

Deno.test("computeOwnerBalance - overdue == dueDate <= cutoff", () => {
  const charges = [
    { nature: "debit", status: "open", openAmount: 1000, dueDate: "2024-01-01" }, // <= cutoff → overdue
    { nature: "debit", status: "open", openAmount: 2000, dueDate: "2024-06-30" }, // == cutoff → overdue
    { nature: "debit", status: "open", openAmount: 3000, dueDate: "2024-07-01" }, // > cutoff → future
    { nature: "debit", status: "open", openAmount: 500, dueDate: null }, // sem dueDate → future
  ];
  const b = computeOwnerBalance(charges, "2024-06-30");
  assertEquals(b.openDebt, 6500);
  assertEquals(b.overdueCents, 3000);
  assertEquals(b.futureDebtCents, 3500);
});

Deno.test("computeOwnerBalance - credito não conta para overdue", () => {
  const charges = [
    { nature: "credit", status: "open", openAmount: 1000, dueDate: "2020-01-01" },
  ];
  const b = computeOwnerBalance(charges, "2024-06-30");
  assertEquals(b.openDebt, 0);
  assertEquals(b.openCredit, 1000);
  assertEquals(b.overdueCents, 0);
  assertEquals(b.netCents, -1000);
});

Deno.test("computeOwnerBalance - openAmount null/undefined trata como 0", () => {
  const charges = [
    { nature: "debit", status: "open", openAmount: null, dueDate: null },
    { nature: "debit", status: "open", dueDate: null },
    { nature: "debit", status: "open", openAmount: 100, dueDate: null },
  ];
  const b = computeOwnerBalance(charges, null);
  assertEquals(b.openDebt, 100);
});
