# ADR 0012 - Flash messages: render único via layout

## Contexto

O panel comunica o resultado de uma operação (sucesso, erro, aviso) através de "flash messages"
propagadas na querystring do redirect (`...?flash=Ap%C3%B3lice%20apagada.&flashType=success`).

Se cada controller ler a querystring e cada página renderizar o seu próprio alerta, a mesma mensagem
aparece duas vezes (layout + página) ou não aparece de todo. É preciso um único ponto de leitura e
um único ponto de render.

## Decisão

**Layout-only.** Os layouts `admin.vto` e `portal.vto` são os únicos responsáveis por renderizar a
flash da querystring:

1. O handler de mutação redireciona com `?flash=<mensagem>&flashType=<tipo>`, com `<tipo>` em
   `success | warning | info | danger`. `runFormAction` e `htmxAction` constroem este redirect
   ([ADR 0030](./0030-shared-action-helpers.md)).
2. O middleware em `main.ts` guarda um `Flash` (`{ type, message }`) no `AsyncLocalStorage`:
   `danger` passa a `error`, `warning` e `info` mantêm-se, qualquer outro valor (ou nenhum) dá
   `success`.
3. `render.ts` injeta `globalFlash` (lido com `currentFlash()`) em todos os templates.
4. O layout mostra-o no topo do `<main>`. Em `admin.vto`:

   ```vto
   {{ if globalFlash }}
     <div class="mb-6">
       {{ include "partials/alert.vto" { type: globalFlash.type, message: globalFlash.message } }}
     </div>
   {{ /if }}
   ```

   `portal.vto` tem um bloco inline equivalente, com as mesmas quatro variantes.

Regras:

- Controllers **não** chamam `parseFlashFromQuery(c)` nem passam `flash` ao `render()` de uma página
  com layout; o handler limita-se ao redirect.
- Páginas que herdam de `admin.vto` ou `portal.vto` **não** têm blocos `{{ if flash }}`.
- `partials/alert.vto` marca o alerta com `data-server-flash`, e esse atributo é um guard: o script
  de toast do `admin.vto` limpa `flash`/`flashType` da URL (a mensagem não reaparece num refresh) e
  só cria um toast quando **não** existe `[data-server-flash]` no DOM. Retirá-lo duplica a mensagem.

## Exceções

As páginas standalone (sem layout) `login.vto`, `forgot_password.vto`, `reset_password.vto` e
`accept_invite.vto`, em `pages/auth/`, não herdam o bloco do layout: o controller
(`controllers/auth.ts`) constrói `flash` e a página renderiza-o com `{{ if flash }}` +
`partials/alert.vto`. Não converter estas páginas para `globalFlash`.

## Alternativas rejeitadas

1. **Sem `globalFlash`, render inline em cada página.** Perde-se a garantia de que toda a página
   mostra a flash, e cada controller repete o mesmo boilerplate.
2. **Layout só renderiza se o controller não passar `flash`.** Mais código condicional, e a fonte de
   verdade continua repartida por dois sítios.

## Sinais de alerta para code review

- Rota ou controller a chamar `parseFlashFromQuery` e a passar `flash:` ao `render()` de uma página
  com layout. Há rotas admin que o fazem (ex.: `routes/admin/units.ts` -> `controllers/units.ts`),
  mas nenhum template com layout lê essa variável: é um argumento morto, não um padrão a copiar.
- Um `.vto` que herda de `admin.vto` ou `portal.vto` com `{{ if flash }}`.

## Referências

- [`main.ts`](../../src/apps/panel/main.ts) (middleware),
  [`context.ts`](../../src/apps/panel/context.ts) (`Flash`, `currentFlash()`) e
  [`render.ts`](../../src/apps/panel/render.ts) (`globalFlash`).
- [`layouts/admin.vto`](../../src/apps/panel/templates/layouts/admin.vto),
  [`layouts/portal.vto`](../../src/apps/panel/templates/layouts/portal.vto) e
  [`partials/alert.vto`](../../src/apps/panel/templates/partials/alert.vto).
- [`routes/_form_action.ts`](../../src/apps/panel/routes/_form_action.ts) - `runFormAction`.
