import { assertEquals } from "@std/assert";
import {
  computeAvailableYears,
  currentOrMostRecent,
  mostRecent,
  noDefault,
  oldestWith,
  resolveServerYearParam,
  resolveYearFilter,
  resolveYearFilterFrom,
  yearOf,
  yearsInRange,
} from "./mod.ts";

Deno.test("yearOf: ISO date string", () => {
  assertEquals(yearOf("2026-05-08"), 2026);
  assertEquals(yearOf("2024-01"), 2024);
  assertEquals(yearOf("1999-12-31T00:00:00Z"), 1999);
});

Deno.test("yearOf: Date object", () => {
  assertEquals(yearOf(new Date(Date.UTC(2026, 0, 1))), 2026);
});

Deno.test("yearOf: null/undefined/curto/inválido devolve null", () => {
  assertEquals(yearOf(null), null);
  assertEquals(yearOf(undefined), null);
  assertEquals(yearOf(""), null);
  assertEquals(yearOf("abc"), null);
});

Deno.test("computeAvailableYears: ordenado descendente, deduplicado", () => {
  const items = [
    { d: "2024-01" },
    { d: "2026-03" },
    { d: "2024-12" },
    { d: "2025-06" },
  ];
  assertEquals(
    computeAvailableYears(items, (i) => i.d),
    [2026, 2025, 2024],
  );
});

Deno.test("computeAvailableYears: ignora items sem data válida", () => {
  const items = [{ d: null }, { d: "2026-01" }, { d: undefined }];
  assertEquals(computeAvailableYears(items, (i) => i.d), [2026]);
});

Deno.test("resolveYearFilter: param undefined → aplica strategy", () => {
  const items = [{ d: "2024-01" }, { d: "2026-01" }];
  const r = resolveYearFilter({
    items,
    getDate: (i) => i.d,
    param: undefined,
    defaultStrategy: mostRecent(),
  });
  assertEquals(r.filterYear, 2026);
  assertEquals(r.availableYears, [2026, 2024]);
});

Deno.test('resolveYearFilter: param "" → null (Todos explícito)', () => {
  const items = [{ d: "2026-01" }];
  const r = resolveYearFilter({
    items,
    getDate: (i) => i.d,
    param: "",
    defaultStrategy: mostRecent(),
  });
  assertEquals(r.filterYear, null);
});

Deno.test("resolveYearFilter: param numérico válido na lista → respeita", () => {
  const items = [{ d: "2024-01" }, { d: "2026-01" }];
  const r = resolveYearFilter({
    items,
    getDate: (i) => i.d,
    param: "2024",
    defaultStrategy: mostRecent(),
  });
  assertEquals(r.filterYear, 2024);
});

Deno.test("resolveYearFilter: param numérico fora da lista → null (defensivo)", () => {
  const items = [{ d: "2024-01" }];
  const r = resolveYearFilter({
    items,
    getDate: (i) => i.d,
    param: "2099",
    defaultStrategy: mostRecent(),
  });
  assertEquals(r.filterYear, null);
});

Deno.test("currentOrMostRecent: ano atual presente → escolhe-o", () => {
  const now = new Date().getUTCFullYear();
  const items = [{ d: `${now - 2}-01` }, { d: `${now}-06` }];
  const r = resolveYearFilter({
    items,
    getDate: (i) => i.d,
    param: undefined,
    defaultStrategy: currentOrMostRecent(),
  });
  assertEquals(r.filterYear, now);
});

Deno.test("currentOrMostRecent: ano atual ausente → fallback most recent", () => {
  const items = [{ d: "2020-01" }, { d: "2021-06" }];
  const r = resolveYearFilter({
    items,
    getDate: (i) => i.d,
    param: undefined,
    defaultStrategy: currentOrMostRecent(),
  });
  assertEquals(r.filterYear, 2021);
});

Deno.test("oldestWith: filtra items por predicate, devolve ano mais antigo", () => {
  const items = [
    { d: "2024-01", openDebt: false },
    { d: "2023-06", openDebt: true },
    { d: "2025-03", openDebt: true },
    { d: "2022-09", openDebt: false }, // ignorado pelo predicate
  ];
  const r = resolveYearFilter({
    items,
    getDate: (i) => i.d,
    param: undefined,
    defaultStrategy: oldestWith(
      (i: typeof items[number]) => i.openDebt,
      (i: typeof items[number]) => i.d,
    ),
  });
  assertEquals(r.filterYear, 2023);
});

Deno.test("oldestWith: nenhum item satisfaz → null (sem filtro)", () => {
  const items = [{ d: "2024-01", openDebt: false }];
  const r = resolveYearFilter({
    items,
    getDate: (i) => i.d,
    param: undefined,
    defaultStrategy: oldestWith(
      (i: typeof items[number]) => i.openDebt,
      (i: typeof items[number]) => i.d,
    ),
  });
  assertEquals(r.filterYear, null);
});

Deno.test("noDefault: sempre devolve null (sem auto-filter)", () => {
  const items = [{ d: "2024-01" }, { d: "2026-01" }];
  const r = resolveYearFilter({
    items,
    getDate: (i) => i.d,
    param: undefined,
    defaultStrategy: noDefault(),
  });
  assertEquals(r.filterYear, null);
});

Deno.test("lista vazia → availableYears vazio + filterYear null", () => {
  const r = resolveYearFilter({
    items: [] as Array<{ d: string }>,
    getDate: (i) => i.d,
    param: undefined,
    defaultStrategy: mostRecent(),
  });
  assertEquals(r.availableYears, []);
  assertEquals(r.filterYear, null);
});

Deno.test("resolveServerYearParam: param ausente devolve o ano default", () => {
  assertEquals(resolveServerYearParam(undefined, 2026), 2026);
  assertEquals(resolveServerYearParam(null, 2026), 2026);
});

Deno.test("resolveServerYearParam: vazio devolve null (Todos)", () => {
  assertEquals(resolveServerYearParam("", 2026), null);
});

Deno.test("resolveServerYearParam: YYYY válido respeita-se", () => {
  assertEquals(resolveServerYearParam("2024", 2026), 2024);
});

Deno.test("resolveServerYearParam: YYYY inválido cai para o default", () => {
  // Sem availableYears para validar, param malformado degrada para o default
  // (vs resolveYearFilter que devolveria null).
  assertEquals(resolveServerYearParam("99", 2026), 2026);
  assertEquals(resolveServerYearParam("20240", 2026), 2026);
  assertEquals(resolveServerYearParam("abcd", 2026), 2026);
});

// ─── yearsInRange / resolveYearFilterFrom ───────────────────────────────────
// WHY: numa lista de seguros o item cobre um PERÍODO, não uma data. Filtrar por
// data de criação faz desaparecer, em janeiro, todas as frações cuja apólice foi
// submetida no ano anterior mas continua em vigor.

Deno.test("yearsInRange: vigência dentro do mesmo ano → um ano só", () => {
  assertEquals(yearsInRange("2026-01-01", "2026-12-31"), [2026]);
});

Deno.test("yearsInRange: vigência a cavalo de dois anos → os dois", () => {
  // O caso que motiva tudo: cobertura de março a março aparece em ambos.
  assertEquals(yearsInRange("2025-03-01", "2026-03-01"), [2025, 2026]);
});

Deno.test("yearsInRange: intervalo longo devolve todos os anos intermédios", () => {
  assertEquals(yearsInRange("2024-06-01", "2027-05-31"), [2024, 2025, 2026, 2027]);
});

Deno.test("yearsInRange: só uma ponta → o ano dessa ponta", () => {
  assertEquals(yearsInRange(null, "2026-04-01"), [2026]);
  assertEquals(yearsInRange("2026-04-01", undefined), [2026]);
});

Deno.test("yearsInRange: sem datas → vazio (não inventa anos)", () => {
  assertEquals(yearsInRange(null, null), []);
  assertEquals(yearsInRange("", "x"), []);
});

Deno.test("yearsInRange: pontas trocadas continuam a dar o intervalo", () => {
  assertEquals(yearsInRange("2026-01-01", "2025-01-01"), [2025, 2026]);
});

Deno.test("resolveYearFilterFrom: respeita anos pré-calculados e o tri-state", () => {
  const items = [{ id: "a" }];
  const availableYears = [2027, 2026, 2025];
  assertEquals(
    resolveYearFilterFrom({ items, availableYears, param: "2025", defaultStrategy: noDefault() })
      .filterYear,
    2025,
  );
  // Vazio = "Todos"; fora da lista = null (não filtra por um ano fantasma).
  assertEquals(
    resolveYearFilterFrom({ items, availableYears, param: "", defaultStrategy: mostRecent() })
      .filterYear,
    null,
  );
  assertEquals(
    resolveYearFilterFrom({ items, availableYears, param: "1999", defaultStrategy: noDefault() })
      .filterYear,
    null,
  );
  // Ausente aplica a estratégia sobre os anos que lhe demos.
  assertEquals(
    resolveYearFilterFrom({
      items,
      availableYears,
      param: undefined,
      defaultStrategy: mostRecent(),
    }).filterYear,
    2027,
  );
});
