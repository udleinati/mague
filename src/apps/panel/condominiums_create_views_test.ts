// Smoke tests de render da criação de condomínio (super). Sem BD/API - render
// puro com dados mock, mesmo harness do fcr_transfer_views_test.

import { assert, assertStringIncludes } from "@std/assert";
import { render } from "./render.ts";
import { testAdminNav } from "./_admin_nav_fixture.ts";

Deno.test("condomínios: a listagem oferece criar um novo", async () => {
  // Sem este botão o super não tinha por onde registar um condomínio na UI:
  // a API existia, mas só se chegava lá à mão.
  const html = await render("pages/condominiums/list.vto", {
    currentCondominiumId: "c1",
    adminNav: testAdminNav,
    condominiums: [],
  });
  assertStringIncludes(html, 'href="/admin/c/c1/condominiums/new"');
});

Deno.test("condomínios: o formulário de criação submete para a rota de criação", async () => {
  const html = await render("pages/condominiums/new.vto", {
    currentCondominiumId: "c1",
    adminNav: testAdminNav,
  });
  assertStringIncludes(html, 'action="/admin/c/c1/condominiums"');
  assertStringIncludes(html, 'name="name"');
});

Deno.test("condomínios: a criação não pede campos que a API descartaria", async () => {
  // O create da API ignora BCC e Reply-To (só o update os grava). Pedi-los aqui
  // fazia o super preenchê-los e perdê-los sem aviso; configuram-se na edição.
  const html = await render("pages/condominiums/new.vto", {
    currentCondominiumId: "c1",
    adminNav: testAdminNav,
  });
  assert(!html.includes('name="bccEmail"'));
  assert(!html.includes('name="replyToEmail"'));
});
