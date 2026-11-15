// Contrato de nav.ts (fonte única do menu + palette) e render dos 3 partials
// que o consomem. Sem BD/API: buildAdminNav é puro; render() degrada globais
// a vazio sem token (mesmo padrão de page_header_test.ts).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { render } from "./render.ts";
import { type AdminNav, buildAdminNav } from "./nav.ts";

function sample(): AdminNav {
  const nav = buildAdminNav({
    cid: "C1",
    activeSection: "documents",
    inspectionAlertCount: 3,
    availableCondominiums: [{ id: "C1", name: "Alpha" }, { id: "C2", name: "Beta" }],
    occupantUnits: [{ condominiumId: "C9", unitId: "U9" }],
  });
  assert(nav, "buildAdminNav devolve modelo com cid");
  return nav;
}

Deno.test("buildAdminNav: null sem cid (portal/sem condo)", () => {
  const nav = buildAdminNav({
    cid: null,
    activeSection: null,
    inspectionAlertCount: 0,
    availableCondominiums: [],
    occupantUnits: [],
  });
  assertEquals(nav, null);
});

Deno.test("buildAdminNav: 8 entradas de topo, taxonomia congelada", () => {
  const { entries } = sample();
  assertEquals(entries.map((e) => e.label), [
    "Painel",
    "Cobranças",
    "Despesas",
    "Banco",
    "Imóvel",
    "Governance",
    "Relatórios",
    "Sistema",
  ]);
});

Deno.test("buildAdminNav: secção ativa propaga ao grupo (Documentos -> Imóvel ativo)", () => {
  const { entries } = sample();
  const imovel = entries.find((e) => e.label === "Imóvel");
  assert(imovel && imovel.kind === "group");
  assert(imovel.active, "grupo do item ativo fica ativo");
  const docs = imovel.subgroups.flatMap((s) => s.items).find((i) => i.label === "Documentos");
  assert(docs && docs.active, "o próprio item fica ativo");
  // Um item de outro grupo não fica ativo.
  const banco = entries.find((e) => e.label === "Banco");
  assert(banco && banco.kind === "group" && !banco.active);
});

Deno.test("buildAdminNav: badge de inspeções pendura no item e acende o ponto do grupo", () => {
  const { entries } = sample();
  const imovel = entries.find((e) => e.label === "Imóvel");
  assert(imovel && imovel.kind === "group" && imovel.hasBadge, "grupo Imóvel tem ponto");
  const insp = imovel.subgroups.flatMap((s) => s.items).find((i) => i.label === "Inspeções");
  assertEquals(insp?.badgeCount, 3);
  const docs = imovel.subgroups.flatMap((s) => s.items).find((i) => i.label === "Documentos");
  assertEquals(docs?.badgeCount, 0, "outros itens sem badge");
});

Deno.test("buildAdminNav: palette tem caminho grupo->subgrupo e hrefs com cid", () => {
  const { palette } = sample();
  const fracoes = palette.find((p) => p.label === "Frações");
  assertEquals(fracoes?.path, "Imóvel → Pessoas e frações");
  assertEquals(fracoes?.href, "/admin/c/C1/units");
  // Link de topo não tem caminho (já é topo).
  const painel = palette.find((p) => p.label === "Painel");
  assertEquals(painel?.path, "");
});

Deno.test("buildAdminNav: palette inclui atalho ao portal e troca de condomínio", () => {
  const { palette } = sample();
  const portal = palette.find((p) => p.label === "Portal da minha fração");
  assertEquals(portal?.href, "/portal/c/C9/u/U9");
  // Troca de condomínio: só os OUTROS condos (não o atual).
  const beta = palette.find((p) => p.group === "Trocar de condomínio" && p.label === "Beta");
  assertEquals(beta?.href, "/admin/c/C2/dashboard");
  assert(!palette.some((p) => p.group === "Trocar de condomínio" && p.label === "Alpha"));
});

Deno.test("buildAdminNav: sem troca de condomínio com um único condo", () => {
  const nav = buildAdminNav({
    cid: "C1",
    activeSection: null,
    inspectionAlertCount: 0,
    availableCondominiums: [{ id: "C1", name: "Alpha" }],
    occupantUnits: [],
  })!;
  assert(!nav.palette.some((p) => p.group === "Trocar de condomínio"));
});

Deno.test("nav_desktop.vto: renderiza dropdown, item ativo e badge", async () => {
  const html = await render("partials/nav_desktop.vto", { nav: sample().entries });
  assertStringIncludes(html, "/admin/c/C1/documents");
  assertStringIncludes(html, "Pessoas e frações"); // cabeçalho de subgrupo
  assertStringIncludes(html, 'class="flex justify-between items-center active"'); // Documentos ativo
  assertStringIncludes(html, ">3</span>"); // badge de inspeções
});

Deno.test("nav_drawer.vto: renderiza details e itens", async () => {
  const html = await render("partials/nav_drawer.vto", { nav: sample().entries });
  assertStringIncludes(html, "<details");
  assertStringIncludes(html, "/admin/c/C1/units");
  assertStringIncludes(html, "Manutenção");
});

Deno.test("layouts/admin.vto: compõe nav + drawer + palette + botões de procura", async () => {
  const html = await render("layouts/admin.vto", {
    title: "Frações",
    section: "units",
    content: "",
    currentCondominiumId: "C1",
    currentUser: { name: "Ana Gestora", email: "ana@mague.pt", role: "manager", occupantUnits: [] },
    availableCondominiums: [{ id: "C1", name: "Alpha" }],
    adminNav: sample(),
  });
  // Nav desktop + drawer (via includes).
  assertStringIncludes(html, "/admin/c/C1/units");
  assertStringIncludes(html, "<details");
  // Afordâncias de procura (desktop + mobile) e o palette.
  assertStringIncludes(html, "data-command-open");
  assertStringIncludes(html, "data-cmdk-hint");
  assertStringIncludes(html, 'id="command_palette"');
  assertStringIncludes(html, "window.normalizeSearch");
});

Deno.test("command_palette.vto: emite dialog + dados JSON escapados", async () => {
  const html = await render("partials/command_palette.vto", { adminNav: sample() });
  assertStringIncludes(html, 'id="command_palette"');
  assertStringIncludes(html, "data-items=");
  // O caminho com seta tem de aparecer no JSON serializado (escapado pelo Vento).
  assertStringIncludes(html, "Pessoas e fra");
  // Sem adminNav (portal), não renderiza nada.
  const empty = await render("partials/command_palette.vto", { adminNav: null });
  assert(!empty.includes('id="command_palette"'));
});
