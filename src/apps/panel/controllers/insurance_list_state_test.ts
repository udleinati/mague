// Filtros da lista de seguros.
// WHY: o ano filtrava por data de submissão e vinha pré-selecionado. As duas
// coisas escondiam frações da tabela enquanto os KPI do topo as contavam. Passa
// a ser vigência (`coveredYears`) e só filtra quando o admin escolhe o ano.

import { assertEquals } from "@std/assert";
import {
  buildInsuranceListState,
  coveredYears,
  matchesInsuranceFilters,
  resolveInsuranceYearFilter,
} from "./insurance_list_state.ts";

const entry = (validFrom: string, validTo: string) => ({ policy: { validFrom, validTo } });

/** Row da lista reduzida ao que os filtros leem. */
const row = (
  aggregate: string,
  ranges: Array<[string, string]>,
  presumedEvidenceDays: number | null = null,
) => ({
  aggregate,
  status: { kind: aggregate },
  presumedEvidenceDays,
  policies: ranges.map(([validFrom, validTo]) => entry(validFrom, validTo)),
});

Deno.test("coveredYears: vigência a cavalo do ano aparece nos dois anos", () => {
  // Apólice submetida em 2025 e válida até março de 2026: em 2026 a fração
  // continua coberta e tem de continuar na lista.
  assertEquals(coveredYears([entry("2025-03-01", "2026-03-01")]), [2026, 2025]);
});

Deno.test("coveredYears: várias apólices juntam-se sem repetir anos", () => {
  assertEquals(
    coveredYears([entry("2025-01-01", "2025-12-31"), entry("2025-06-01", "2026-06-01")]),
    [2026, 2025],
  );
});

Deno.test("coveredYears: data de submissão não conta, só a vigência", () => {
  // Só há `validFrom`/`validTo` na conta - uma apólice criada hoje para vigorar
  // no ano que vem pertence ao ano que vem.
  const anos = coveredYears([entry("2027-01-01", "2027-12-31")]);
  assertEquals(anos, [2027]);
});

Deno.test("coveredYears: fração sem apólices não gera anos", () => {
  assertEquals(coveredYears([]), []);
});

Deno.test("coveredYears: entrada sem policy (never_submitted) é ignorada", () => {
  assertEquals(coveredYears([{ policy: undefined }]), []);
});

Deno.test("coveredYears: ordenação descendente (o mais recente primeiro na dropdown)", () => {
  assertEquals(
    coveredYears([entry("2023-01-01", "2023-12-31"), entry("2026-01-01", "2026-12-31")]),
    [2026, 2023],
  );
});

// ─── matchesInsuranceFilters ──────────────────────────────────────────────────

Deno.test("sem ano escolhido, a vencida do ano passado continua na tabela", () => {
  // WHY: o default era "ano atual". Como os KPI são globais e as abas de estado
  // preservam o ano, "Vencidos: 1" ficava por cima de uma tabela vazia - e a
  // fração escondida era justamente a que precisa de ação. Compõe como listPage.
  const rows = [
    row("active", [["2026-01-01", "2026-12-31"]]),
    row("expired", [["2025-01-01", "2025-12-31"]]),
  ];
  const { availableYears, filterYear } = resolveInsuranceYearFilter(rows, undefined);
  assertEquals(availableYears, [2026, 2025]);
  assertEquals(filterYear, null);

  const visiveis = rows.filter((r) =>
    matchesInsuranceFilters(r, { year: filterYear, status: null })
  );
  // O KPI "Vencidos" conta sobre todas as rows; a tabela tem de dizer o mesmo.
  assertEquals(rows.filter((r) => r.aggregate === "expired").length, 1);
  assertEquals(visiveis.filter((r) => r.aggregate === "expired").length, 1);
});

Deno.test("`?year=` explícito continua a ser respeitado (e `` = Todos)", () => {
  // O default não filtra, mas a escolha do admin manda - incluindo o
  // "Todos" explícito, que o tri-state distingue do param ausente.
  const rows = [row("active", [["2026-01-01", "2026-12-31"]])];
  assertEquals(resolveInsuranceYearFilter(rows, "2026").filterYear, 2026);
  assertEquals(resolveInsuranceYearFilter(rows, "").filterYear, null);
  // Ano fora da lista não vira filtro-fantoche.
  assertEquals(resolveInsuranceYearFilter(rows, "1999").filterYear, null);
});

Deno.test("ano escolhido: vigência a cavalo do ano passa nos dois", () => {
  const r = row("active", [["2025-03-01", "2026-03-01"]]);
  assertEquals(matchesInsuranceFilters(r, { year: 2025, status: null }), true);
  assertEquals(matchesInsuranceFilters(r, { year: 2026, status: null }), true);
});

Deno.test("ano escolhido: apólice fora desse ano sai da lista", () => {
  // Escondida só porque o admin escolheu o ano - já não é o default.
  const r = row("expired", [["2025-01-01", "2025-12-31"]]);
  assertEquals(matchesInsuranceFilters(r, { year: 2026, status: null }), false);
});

Deno.test("ano escolhido: fração sem apólice atravessa sempre", () => {
  // Sem esta porta, o ano escondia quem nunca submeteu - o pior caso da lista.
  assertEquals(
    matchesInsuranceFilters(row("never_submitted", []), { year: 2026, status: null }),
    true,
  );
});

Deno.test("filtro de estado compara com o AGREGADO, não com a apólice selecionada", () => {
  // Fração com uma active e uma pending: o agregado é "active" e ela não
  // pertence à aba "A aprovar" - senão o admin agia sobre quem já está coberto.
  const r = {
    aggregate: "active",
    status: { kind: "awaiting_approval" },
    presumedEvidenceDays: null,
    policies: [],
  };
  assertEquals(matchesInsuranceFilters(r, { year: null, status: "active" }), true);
  assertEquals(matchesInsuranceFilters(r, { year: null, status: "awaiting_approval" }), false);
});

Deno.test("presumed_pending atravessa os agregados (uma presumida está 'Ativa')", () => {
  // Literal de propósito: é o valor que viaja no `?status=` da URL.
  const cobertura: [string, string] = ["2026-01-01", "2026-12-31"];
  const semProva = row("active", [cobertura], 45);
  const documentada = row("active", [cobertura], null);
  assertEquals(matchesInsuranceFilters(semProva, { year: null, status: "presumed_pending" }), true);
  assertEquals(
    matchesInsuranceFilters(documentada, { year: null, status: "presumed_pending" }),
    false,
  );
});

// ─── buildInsuranceListState ─────────────────────────────────────────────────
// WHY: a composição (filtrar -> enriquecer -> contar) não tinha nome nem teste;
// o teste de render reconstruía-a à mão e podia divergir dela em silêncio. O
// invariante que interessa é o que já mordeu: os KPI do topo contam SEMPRE tudo,
// a tabela conta só o que passou os filtros.

const NOW = new Date("2026-06-20T00:00:00Z");

/** Row completa, com o que `withCooldown` lê além dos filtros. */
const fullRow = (
  aggregate: string,
  ranges: Array<[string, string]>,
  extra: { presumedEvidenceDays?: number | null; lastReminderAt?: string | null } = {},
) => ({
  ...row(aggregate, ranges, extra.presumedEvidenceDays ?? null),
  lastReminderAt: extra.lastReminderAt ?? null,
  lastRenewalEvidenceAt: null,
});

Deno.test("KPI contam tudo; a tabela conta só o filtrado", () => {
  const rows = [
    fullRow("active", [["2026-01-01", "2026-12-31"]]),
    fullRow("expired", [["2025-01-01", "2025-12-31"]]),
    fullRow("never_submitted", []),
  ];

  const state = buildInsuranceListState(rows, { year: "2026" }, NOW);

  // Tabela: a vencida de 2025 sai; a fração sem apólice atravessa o ano.
  assertEquals(state.units.length, 2);
  assertEquals(state.totalUnits, 3);
  // KPI: continuam a ver a vencida, mesmo escondida da tabela.
  assertEquals(state.summary.expired, 1);
  assertEquals(state.summary.active, 1);
  assertEquals(state.summary.never_submitted, 1);
});

Deno.test("summary arranca a zeros para os estados sem frações", () => {
  // O template lê `summary.rejected_only` sem guarda; ausente daria "undefined".
  const state = buildInsuranceListState([fullRow("active", [])], {}, NOW);
  assertEquals(state.summary.rejected_only, 0);
  assertEquals(state.summary.awaiting_confirmation, 0);
});

Deno.test("cooldown e remindable contam sobre tudo, não sobre o filtrado", () => {
  const ontem = new Date(NOW.getTime() - 86_400_000).toISOString();
  const rows = [
    // Precisa de lembrete e levou um ontem: está em cooldown.
    fullRow("expired", [["2025-01-01", "2025-12-31"]], { lastReminderAt: ontem }),
    // Precisa de lembrete e nunca levou nenhum.
    fullRow("never_submitted", []),
    // Coberta e documentada: não entra em nenhuma das contas.
    fullRow("active", [["2026-01-01", "2026-12-31"]]),
  ];

  // Filtra para 2026, o que esconde a vencida de 2025 da tabela.
  const state = buildInsuranceListState(rows, { year: "2026" }, NOW);

  assertEquals(state.remindableCount, 2);
  assertEquals(state.cooldownCount, 1);
  // ... e a que está em cooldown nem sequer está visível.
  assertEquals(state.units.length, 2);
});

Deno.test("as rows visíveis levam o trigger e as datas de renovação", () => {
  const state = buildInsuranceListState(
    [fullRow("expired", [["2025-01-01", "2025-12-31"]])],
    {},
    NOW,
  );
  const [u] = state.units;
  assertEquals(u.reminderTrigger, "individual");
  assertEquals(u.inCooldown, false);
  // A vigência seguinte que o modal pré-preenche começa onde a atual acaba.
  assertEquals(u.policies[0].renewFrom, "2025-12-31");
  assertEquals(u.policies[0].renewTo, "2026-12-31");
});

Deno.test("condomínio sem frações distingue-se de filtros sem resultados", () => {
  // `totalUnits` é o que o template usa para escolher entre o empty-state global
  // e "a tabela filtrou tudo" - os dois casos não podem colapsar num só.
  assertEquals(buildInsuranceListState([], {}, NOW).totalUnits, 0);

  const semResultados = buildInsuranceListState(
    [fullRow("active", [["2026-01-01", "2026-12-31"]])],
    { status: "expired" },
    NOW,
  );
  assertEquals(semResultados.units.length, 0);
  assertEquals(semResultados.totalUnits, 1);
});
