# ADR 0027 - Indicador de loading único: barra no topo para todos os pedidos

## Contexto

O panel é SSR: cada ação do utilizador faz pelo menos um round-trip ao servidor, por três vias -
pedidos HTMX (swap parcial), navegação do browser (links, submits nativos, redirects) e `fetch`
manual em JS. Sem um indicador uniforme, o utilizador não sabe se a ação foi recebida e repete o
clique, o que pode reenviar o pedido (o mesmo upload duas vezes). Barras locais por página duplicam
markup e divergem no aspeto.

## Decisão

O indicador de loading do panel é uma única barra no topo da viewport: `#htmx-progress-bar`, 3px,
rose-500 (`#f43f5e`) com glow, `position: fixed`, `z-index: 9999`. Existe uma vez em cada layout
(`layouts/admin.vto` e `layouts/portal.vto`), com o mesmo script. A animação segue o padrão
NProgress, sem dependências: salta para 30% em 150ms, cresce até 90% em 4s e, quando o pedido
termina, vai a 100% e desvanece.

A barra cobre três casos:

1. **Pedidos HTMX** - automático. O script liga `start` a `htmx:beforeRequest` e `finish` a
   `htmx:afterRequest`, `htmx:sendError` e `htmx:timeout`, no `document.body`. O chamador não faz
   nada: basta o pedido ser feito por atributos `hx-*`.
2. **`fetch` manual** - `window.__progress.start()` antes do pedido e `window.__progress.finish()`
   quando termina, com sucesso ou com erro.
3. **Submits nativos lentos** (form sem HTMX que pode demorar, como um upload) -
   `window.__progress.start()` no listener de `submit`. Não precisa de `finish()`: a navegação
   descarta a página.

`window.__progress = { start, finish }` é exposto pelo script da barra nos dois layouts. O portal
não carrega o HTMX, por isso ali a barra só avança por `window.__progress`.

Submit nativo:

```js
form.addEventListener("submit", function () {
  if (window.__progress) window.__progress.start();
});
```

`fetch` manual:

```js
if (window.__progress) window.__progress.start();
fetch(url, { method: "POST", body: fd })
  .then(function (res) {
    if (window.__progress) window.__progress.finish();
    // ...
  })
  .catch(function (err) {
    if (window.__progress) window.__progress.finish();
    // ...
  });
```

O guard `if (window.__progress)` é degradação graciosa: se o script do layout não correu, o pedido
funciona na mesma, só sem feedback visual.

Nenhuma página cria a sua própria barra no topo, salvo a exceção abaixo. Indicadores localizados (um
spinner dentro de um modal, o texto "A submeter…" num botão) são complemento da barra, nunca
substituto.

## Exceções

A barra é indeterminada: a animação não mede nada. Quando há **progresso real** a comunicar
("Enviado 3 / 7"), a página mantém uma barra própria com o contador.

Única exceção viva: `portal/insurance/confirm.vto`, que envia N ficheiros em sequência por `fetch` e
atualiza a barra a cada ficheiro concluído.

## Consequências

- Feedback igual em todo o panel, admin e portal.
- Uma funcionalidade nova com HTMX ganha a barra sem escrever código.
- A barra não comunica progresso real; chega para pedidos curtos e a exceção acima cobre o resto.
- A cor é fixa no layout; mudá-la é mudar o padrão em todo o lado.

## Alternativas rejeitadas

1. **Overlay com spinner em página inteira.** Bloqueia a UI toda; a barra deixa o utilizador
   continuar a ler enquanto o pedido decorre.
2. **Skeleton placeholders.** Úteis para o carregamento inicial de listas, não para mutações, onde o
   que muda nem sempre tem uma forma que um placeholder consiga antecipar. Não substituem a barra.
3. **Indicador inline junto ao botão como padrão.** Legítimo como complemento em forms pequenos, não
   como indicador por omissão.
4. **Extensão `htmx-ext-loading-states`.** Mais JS para um problema que os eventos nativos do HTMX
   já resolvem.

## Sinais de alerta para code review

- Form de upload sem HTMX que não chama `window.__progress.start()` no submit. → propor.
- `<div>` com `position: fixed` no topo, ou `id="upload-progress"`, fora de `confirm.vto`. → usar a
  API global.
- Mudança da cor da barra, ou estilos que se sobrepõem a `#htmx-progress-bar`. → é uma decisão de
  padrão, discutir antes.
- Overlay com spinner em página inteira. → propor a barra.

## Referências

- [`layouts/admin.vto`](../../src/apps/panel/templates/layouts/admin.vto) - barra, script e
  `window.__progress`; replicado em
  [`layouts/portal.vto`](../../src/apps/panel/templates/layouts/portal.vto) (ao alterar um, alinhar
  o outro, como em [ADR 0013](./0013-confirm-modal-global.md)).
- Submit nativo com `window.__progress.start()`:
  [`upload.vto`](../../src/apps/panel/templates/pages/portal/insurance/upload.vto).
- Exceção com progresso real:
  [`confirm.vto`](../../src/apps/panel/templates/pages/portal/insurance/confirm.vto).
- [ADR 0026](./0026-scroll-preservation-htmx.md) - regras de swap HTMX (scroll e `hx-select`).
