// Smoke tests de render do cartão "Acesso" em users/show.vto (reset assistido
// de password). Sem BD/API - render puro com dados mock, mesmo harness do
// fcr_transfer_views_test.

import { assert, assertStringIncludes } from "@std/assert";
import { render } from "./render.ts";
import { testAdminNav } from "./_admin_nav_fixture.ts";

const showCtx = (over: Record<string, unknown> = {}) => ({
  currentCondominiumId: "c1",
  adminNav: testAdminNav,
  title: "Ana Pinto",
  section: "users",
  target: {
    id: "u1",
    name: "Ana Pinto",
    email: "ana@example.pt",
    isActive: true,
    isManager: false,
    units: [],
    firstLoginAt: null,
    lastLoginAt: null,
    createdAt: "2026-01-05T10:00:00.000Z",
  },
  flash: null,
  access: null,
  ...over,
});

Deno.test("acesso: repor password exige escrever CONFIRMO", async () => {
  // O guard não é o modal - é o typed-match. Um clique acidental em "Repor
  // password" invalidava a password de alguém que estava a conseguir entrar,
  // e o código novo só se recupera repondo outra vez.
  const html = await render("pages/users/show.vto", showCtx());
  assertStringIncludes(html, 'data-confirm-typed-match="CONFIRMO"');
  assertStringIncludes(html, "Repor password");
});

Deno.test("acesso: sem reset, a página não mostra password nenhuma", async () => {
  // Estado normal da página. Se o cartão vazasse um valor aqui, qualquer
  // pessoa que abrisse a ficha via a credencial de outra.
  const html = await render("pages/users/show.vto", showCtx());
  assert(!html.includes('id="temp-password"'));
});

Deno.test("acesso: depois do reset, a password aparece com o aviso de uma só vez", async () => {
  // A password não é guardada em lado nenhum: se o admin sair da página sem a
  // copiar, tem de repor outra vez. O aviso é o que evita esse desperdício.
  const html = await render(
    "pages/users/show.vto",
    showCtx({
      access: {
        reset: {
          userId: "u1",
          name: "Ana Pinto",
          email: "ana@example.pt",
          temporaryPassword: "BUZKYG",
          resetAt: "2026-08-21T19:32:14.045Z",
        },
      },
    }),
  );
  assertStringIncludes(html, "BUZKYG");
  assertStringIncludes(html, "Só aparece agora");
  // Já reposta: não volta a oferecer o botão na mesma renderização.
  assert(!html.includes('data-confirm-typed-match="CONFIRMO"'));
});

Deno.test("acesso: conta com acesso a outro condomínio não oferece o botão", async () => {
  // A API recusa (403) a quem não gere todos os condomínios da conta: o botão só
  // levava o admin a escrever CONFIRMO para receber um erro.
  const target = { ...showCtx().target, passwordResetRequiresSuper: true };
  const html = await render("pages/users/show.vto", showCtx({ target }));
  assert(!html.includes('data-confirm-typed-match="CONFIRMO"'));
  assertStringIncludes(html, "Só um super pode repor a password");
});

Deno.test("acesso: erro da API aparece dentro do cartão, não num flash perdido", async () => {
  // O swap HTMX faz `hx-select="#user-access"`: um flash no layout era
  // descartado e o admin ficava sem saber porque nada aconteceu.
  const html = await render(
    "pages/users/show.vto",
    showCtx({
      access: { error: "Utilizador inativo: reative a conta antes de repor a password." },
    }),
  );
  assertStringIncludes(html, "Utilizador inativo");
  // Continua a oferecer o botão - o erro é recuperável.
  assertStringIncludes(html, 'data-confirm-typed-match="CONFIRMO"');
});
