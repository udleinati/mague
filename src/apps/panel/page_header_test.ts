// Testes de contrato de `page_header.vto` + `status_badge.vto` (ADR 0036):
// renderiza o partial e asserta o HTML, sem BD/API. Protege a escala
// list/detail, o fail-loud sem title, o autoescape, a degradação de tones e
// a gramática da meta line.

import { assert, assertStringIncludes } from "@std/assert";
import { render, renderString } from "./render.ts";

const PARTIAL = "partials/page_header.vto";

Deno.test("page_header: escala list (default) usa text-4xl font-black", async () => {
  const html = await render(PARTIAL, { title: "Frações" });
  assertStringIncludes(html, "text-4xl font-black");
  assertStringIncludes(html, "Frações");
  // Sem corpo (include) → sem coluna de ações.
  assert(!html.includes("shrink-0"), "include sem corpo não deve ter coluna de ações");
});

Deno.test("page_header: escala detail usa text-3xl font-bold", async () => {
  const html = await render(PARTIAL, { title: "Fração 1ºE", scale: "detail" });
  assertStringIncludes(html, "text-3xl font-bold");
  assert(!html.includes("text-4xl"), "detail não deve usar a escala de listagem");
});

Deno.test("page_header: title em falta falha de forma visível", async () => {
  const html = await render(PARTIAL, {});
  assertStringIncludes(html, "[page_header: falta title]");
});

Deno.test("page_header: title é escapado (autoescape no seam)", async () => {
  const html = await render(PARTIAL, { title: "<script>alert(1)</script>" });
  assert(!html.includes("<script>"), "HTML do caller não pode passar cru");
  assertStringIncludes(html, "&lt;script&gt;");
});

Deno.test("page_header: status badge inline no h1", async () => {
  const html = await render(PARTIAL, {
    title: "Fração 1ºE",
    status: { label: "Ativa", tone: "success" },
  });
  assertStringIncludes(html, "Ativa");
  assertStringIncludes(html, "bg-success");
  assertStringIncludes(html, "w-1.5 h-1.5 rounded-full");
});

Deno.test("page_header: code kicker com tone (payable=info)", async () => {
  const html = await render(PARTIAL, {
    title: "Limpeza das escadas",
    scale: "detail",
    code: "D00042",
    codeTone: "info",
  });
  assertStringIncludes(html, "D00042");
  assertStringIncludes(html, "font-mono");
  assertStringIncludes(html, "text-info");
});

Deno.test("page_header: breadcrumbs renderizados via partial canónico", async () => {
  const html = await render(PARTIAL, {
    title: "Fração 1ºE",
    scale: "detail",
    breadcrumbs: [
      { label: "Frações", href: "/admin/c/x/units" },
      { label: "Fração 1ºE" },
    ],
  });
  assertStringIncludes(html, "breadcrumbs");
  assertStringIncludes(html, 'href="/admin/c/x/units"');
});

Deno.test("page_header: meta - separador · é do módulo, falsy filtrados", async () => {
  const html = await render(PARTIAL, {
    title: "Fração 1ºE",
    scale: "detail",
    meta: [
      { label: "Identificador", value: "A" },
      { value: "apartment", plain: true },
      null, // segmento condicional desativado - tem de ser filtrado
      { value: "85,00‰", plain: true },
    ],
  });
  // 3 segmentos visíveis → exatamente 2 separadores.
  const separators = html.split(">·<").length - 1;
  assert(separators === 2, `esperava 2 separadores ·, encontrei ${separators}`);
  assertStringIncludes(html, "Identificador:");
  assertStringIncludes(html, "<strong");
});

Deno.test("page_header: meta com href usa o formato canónico link link-hover (ADR 0015)", async () => {
  const html = await render(PARTIAL, {
    title: "Quota Janeiro",
    scale: "detail",
    meta: [{ label: "Fração", value: "1ºE", href: "/admin/c/x/units/u1" }],
  });
  assertStringIncludes(html, 'class="link link-hover"');
  assertStringIncludes(html, 'href="/admin/c/x/units/u1"');
});

Deno.test("page_header: modo layout - corpo vira coluna de ações", async () => {
  const html = await renderString(
    `{{ layout "partials/page_header.vto" { title: "Frações" } }}
      <button class="btn btn-sm btn-primary">+ Nova fração</button>
    {{ /layout }}`,
  );
  assertStringIncludes(html, "+ Nova fração");
  assertStringIncludes(html, "shrink-0");
  assertStringIncludes(html, "text-4xl font-black");
});

Deno.test("page_header: corpo de ações avalia no scope do caller", async () => {
  // As páginas definem {{ set canEdit = ... }} ANTES da chamada e usam a
  // variável dentro do corpo (ex: charges/show.vto). O slot tem de ver o
  // scope do template exterior.
  const html = await renderString(
    `{{ set canEdit = true }}
    {{ layout "partials/page_header.vto" { title: "T" } }}
      {{ if canEdit }}<button>Editar</button>{{ /if }}
    {{ /layout }}`,
  );
  assertStringIncludes(html, "<button>Editar</button>");
});

Deno.test("status_badge: tones mapeiam para classes literais", async () => {
  const success = await render("partials/status_badge.vto", { label: "Pago", tone: "success" });
  assertStringIncludes(success, "bg-success");
  assertStringIncludes(success, "text-success font-medium");

  const muted = await render("partials/status_badge.vto", { label: "Cancelado", tone: "muted" });
  assertStringIncludes(muted, "bg-base-300");
  assert(!muted.includes("font-medium"), "muted não leva font-medium");
});

Deno.test("status_badge: tone desconhecido degrada para neutral", async () => {
  const html = await render("partials/status_badge.vto", { label: "X", tone: "banana" });
  assertStringIncludes(html, "bg-base-content/40");
});

Deno.test("status_badge: size xs para células de tabela", async () => {
  const html = await render("partials/status_badge.vto", {
    label: "Pago",
    tone: "success",
    size: "xs",
  });
  assertStringIncludes(html, "text-xs");
});

Deno.test("table_card: header com título, count e pesquisa; tabela sempre em .table-scroll", async () => {
  const html = await renderString(
    `{{ layout "partials/table_card.vto" { title: "Cobranças", count: 12, searchable: true } }}
      <table class="table table-sm"><tbody><tr><td>X</td></tr></tbody></table>
    {{ /layout }}`,
  );
  assertStringIncludes(html, "Cobranças");
  assertStringIncludes(html, "· 12");
  assertStringIncludes(html, "data-table-search-scope");
  assertStringIncludes(html, "data-table-search");
  assertStringIncludes(html, 'class="table-scroll"');
  assertStringIncludes(html, "<td>X</td>");
  assertStringIncludes(html, "overflow-hidden");
});

Deno.test("table_card: sem searchable não há scope nem input; headerRight aparece", async () => {
  const html = await renderString(
    `{{ layout "partials/table_card.vto" { title: "Movimentos", headerRight: "3 movimentos" } }}
      <table></table>
    {{ /layout }}`,
  );
  assert(!html.includes("data-table-search"), "sem searchable não deve haver pesquisa");
  assertStringIncludes(html, "3 movimentos");
  assertStringIncludes(html, 'class="table-scroll"');
});

// Smoke test de compilação: TODOS os templates têm de fazer parse. Apanha
// erros de sintaxe Vento (ex: trailing comma no objeto de params de um
// {{ layout }}) sem precisar de fixtures de dados (não executa o template).
Deno.test("todos os templates compilam", async () => {
  const vento = (await import("vento")).default;
  const { fromFileUrl, join, relative } = await import("@std/path");
  const root = fromFileUrl(new URL("./templates/", import.meta.url));
  const env = vento({ includes: root, autoescape: true });

  const templates: string[] = [];
  async function walk(dir: string) {
    for await (const entry of Deno.readDir(dir)) {
      const full = join(dir, entry.name);
      if (entry.isDirectory) await walk(full);
      else if (entry.name.endsWith(".vto")) templates.push(relative(root, full));
    }
  }
  await walk(root);

  if (templates.length < 50) {
    throw new Error(`só ${templates.length} templates encontrados - glob partido?`);
  }
  for (const page of templates) {
    try {
      await env.load(page);
    } catch (cause) {
      throw new Error(`template não compila: ${page}`, { cause });
    }
  }
});
