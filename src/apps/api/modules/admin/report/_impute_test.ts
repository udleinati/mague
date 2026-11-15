// A imputação decide que número vai à assembleia. Cada teste fixa uma regra
// que, se mudar, muda o valor "já gasto" de uma Ata.
//
// Correr: deno test --allow-env src/apps/api/modules/admin/report/_impute_test.ts

import { assertEquals } from "@std/assert";
import {
  buildAccountClaims,
  type ImputableLine,
  type ImputablePayable,
  imputePayable,
  isAmbiguousAccount,
} from "./_impute.ts";

// Ata 11 aprova o orçamento principal 2026; Ata 12 aprova a obra (suplementar
// do mesmo ano). Rubricas distintas - o caso limpo.
const LINES: ImputableLine[] = [
  { budget_id: "principal26", account_id: "acc_luz" },
  { budget_id: "principal26", account_id: "acc_limpeza" },
  { budget_id: "obra26", account_id: "acc_obras" },
];
const YEARS = new Map([["principal26", "2026"], ["obra26", "2026"]]);
const REPORTED = new Set(["principal26", "obra26"]);

const payable = (over: Partial<ImputablePayable> = {}): ImputablePayable => ({
  budget_id: null,
  account_id: "acc_luz",
  competence_period: "2026-03-01",
  ...over,
});

Deno.test("rubrica de um só orçamento no ano: a despesa conta nesse orçamento", () => {
  // Sem isto o relatório mostrava 0 gasto em Atas que nunca ninguém etiquetou
  // à mão - que é o estado de todo o histórico.
  const claims = buildAccountClaims(LINES, YEARS);
  assertEquals(imputePayable(payable(), claims, REPORTED), [
    { budgetId: "principal26", source: "inferred" },
  ]);
});

Deno.test("ano diferente do orçamento: a despesa não conta", () => {
  // A rubrica "Eletricidade" existe todos os anos. Sem o corte pelo ano, a
  // execução da Ata de 2026 comia as faturas de 2025 e 2027.
  const claims = buildAccountClaims(LINES, YEARS);
  assertEquals(imputePayable(payable({ competence_period: "2025-11-01" }), claims, REPORTED), []);
});

Deno.test("rubrica fora do orçamento: a despesa não conta", () => {
  const claims = buildAccountClaims(LINES, YEARS);
  assertEquals(imputePayable(payable({ account_id: "acc_seguros" }), claims, REPORTED), []);
});

Deno.test("etiqueta manual ganha à inferência, mesmo contra a rubrica", () => {
  // O caso que justifica a coluna: uma fatura de eletricidade que a assembleia
  // decidiu imputar à obra. Sem a precedência, ficava na Ata errada.
  const claims = buildAccountClaims(LINES, YEARS);
  assertEquals(
    imputePayable(payable({ budget_id: "obra26" }), claims, REPORTED),
    [{ budgetId: "obra26", source: "tagged" }],
  );
});

Deno.test("etiqueta a apontar para orçamento sem Ata cai na inferência", () => {
  // Orçamento sem ponto da ordem do dia não aparece no relatório; a etiqueta
  // não pode fazer a despesa desaparecer do total das Atas que existem.
  const claims = buildAccountClaims(LINES, YEARS);
  assertEquals(
    imputePayable(payable({ budget_id: "orcamento_sem_ata" }), claims, REPORTED),
    [{ budgetId: "principal26", source: "inferred" }],
  );
});

Deno.test("rubrica partilhada por dois orçamentos do ano: ambígua, não conta em nenhum", () => {
  // Duas obras no mesmo ano na mesma rubrica. Somar aos dois duplicava o
  // gasto; escolher um mentia. Marca-se e pede-se a etiqueta ao admin.
  const shared: ImputableLine[] = [
    ...LINES,
    { budget_id: "obra26", account_id: "acc_luz" },
  ];
  const claims = buildAccountClaims(shared, YEARS);
  assertEquals(imputePayable(payable(), claims, REPORTED), [
    { budgetId: "principal26", source: "ambiguous" },
    { budgetId: "obra26", source: "ambiguous" },
  ]);
  assertEquals(isAmbiguousAccount(claims, "acc_luz", "2026"), true);
  assertEquals(isAmbiguousAccount(claims, "acc_obras", "2026"), false);
});

Deno.test("etiqueta resolve a ambiguidade", () => {
  const shared: ImputableLine[] = [...LINES, { budget_id: "obra26", account_id: "acc_luz" }];
  const claims = buildAccountClaims(shared, YEARS);
  assertEquals(
    imputePayable(payable({ budget_id: "principal26" }), claims, REPORTED),
    [{ budgetId: "principal26", source: "tagged" }],
  );
});

Deno.test("mesma rubrica em anos diferentes não é ambiguidade", () => {
  // Orçamento principal de 2026 e de 2027 partilham rubricas por construção.
  // Se isso contasse como empate, nada seria inferido nunca.
  const twoYears: ImputableLine[] = [
    { budget_id: "principal26", account_id: "acc_luz" },
    { budget_id: "principal27", account_id: "acc_luz" },
  ];
  const years = new Map([["principal26", "2026"], ["principal27", "2027"]]);
  const claims = buildAccountClaims(twoYears, years);
  assertEquals(isAmbiguousAccount(claims, "acc_luz", "2026"), false);
  assertEquals(
    imputePayable(payable(), claims, new Set(["principal26", "principal27"])),
    [{ budgetId: "principal26", source: "inferred" }],
  );
});

Deno.test("despesa sem rubrica não entra em nenhum orçamento", () => {
  const claims = buildAccountClaims(LINES, YEARS);
  assertEquals(imputePayable(payable({ account_id: null }), claims, REPORTED), []);
});
