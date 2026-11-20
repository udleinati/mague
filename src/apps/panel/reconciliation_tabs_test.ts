// Separadores da conciliação. Sem BD/API - render puro com dados mock.
//
// "Em aberto" é o separador por omissão e junta tudo o que ainda se concilia: um movimento
// parcial ou revertido não pode desaparecer da fila só porque já teve um settlement.

import { assert, assertStringIncludes } from "@std/assert";
import { render } from "./render.ts";
import { OPEN_STATUS_FILTER } from "./controllers/reconciliation.ts";

const FRAGMENT = "pages/reconciliation/_list_fragment.vto";

const tx = (over: Record<string, unknown>) => ({
  id: "tx1",
  transactionDate: "2099-03-10",
  description: "TRF ENTRADA TESTE",
  amount: 50000,
  status: "unreconciled",
  settlements: [],
  ...over,
});

const ctx = (over: Record<string, unknown> = {}) => ({
  currentCondominiumId: "c1",
  transactions: [],
  bankAccounts: [],
  filterStatus: OPEN_STATUS_FILTER,
  openStatusFilter: OPEN_STATUS_FILTER,
  filterBankAccountId: "",
  filterYear: 2026,
  availableYears: [2026],
  pagination: null,
  today: "2026-11-20",
  ...over,
});

Deno.test("Em aberto inclui por conciliar, parciais e revertidos", () => {
  for (const status of ["unreconciled", "partial", "reversed"]) {
    assert(OPEN_STATUS_FILTER.split(",").includes(status), status);
  }
});

Deno.test("conciliação: Em aberto substitui Todos e fica ativo por omissão", async () => {
  const html = await render(FRAGMENT, ctx());
  assertStringIncludes(html, `reconciliation?status=${OPEN_STATUS_FILTER}&amp;year=2026`);
  assert(/tab-active[^>]*>Em aberto</.test(html), "Em aberto devia estar ativo");
  assert(!html.includes(">Todos</a>"), "o separador Todos foi substituído");
});

Deno.test("conciliação: movimento parcial em Em aberto mantém o conciliar", async () => {
  const html = await render(
    FRAGMENT,
    ctx({
      transactions: [
        tx({ status: "partial", unallocated: 20000 }),
        tx({ id: "tx2", status: "reversed", unallocated: 50000 }),
      ],
    }),
  );
  // O que falta conciliar fica à vista na lista, sem abrir o modal.
  assertStringIncludes(html, "(falta 200,00 €)");
  assertStringIncludes(html, "Revertido");
  assertStringIncludes(html, "/reconciliation/tx/tx1/modal");
  assertStringIncludes(html, "/reconciliation/tx/tx2/modal");
});
