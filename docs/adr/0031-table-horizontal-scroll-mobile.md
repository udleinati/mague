# ADR 0031 - Scroll horizontal de tabelas em mobile (`.table-scroll`)

## Contexto

A maioria das listagens do admin mostra os dados numa tabela dentro de um card com
`overflow-hidden`. Esse `overflow-hidden` existe para cortar o conteúdo pelos cantos arredondados
(`rounded-xl`): sem ele, a primeira e a última linha da tabela sangram para fora da borda.

Num ecrã estreito, uma tabela de 6 a 9 colunas é mais larga do que a viewport e o mesmo
`overflow-hidden` corta as colunas que não cabem, sem scroll lateral. O utilizador fica sem acesso
ao resto da informação e aos botões de ação, que estão na última coluna.

Pôr `overflow-x-auto` no card não resolve: o cabeçalho do card (título e pesquisa) ficava dentro da
área de scroll e deslocava-se com a tabela.

## Decisão

Toda a `<table>` de dados do admin vai dentro de `<div class="table-scroll">`. A classe global
`.table-scroll`, definida uma vez no `<style>` de `layouts/admin.vto`, dá scroll horizontal só à
tabela; o card exterior não muda e mantém `overflow-hidden`:

```html
<div class="bg-base-100 rounded-xl border border-base-200 overflow-hidden shadow-sm"
  data-table-search-scope>
  <div class="...cabeçalho do card...">...</div>
  <div class="table-scroll">
    <table class="table table-sm">...</table>
  </div>
</div>
```

A classe faz duas coisas:

1. **Scroll horizontal** (`overflow-x: auto`): a tabela mantém a largura natural das colunas e
   arrasta-se na horizontal quando não cabe.
2. **Scroll-shadow** (técnica de Lea Verou, só CSS): sombras suaves nas extremidades, que aparecem e
   desaparecem consoante há mais conteúdo para cada lado. Sem este sinal, em mobile não se descobre
   que a tabela arrasta. As gradientes de cobertura usam `hsl(var(--b1))` (base-100, o fundo do
   card), por isso acompanham o tema. Uma scrollbar fina reforça o sinal em desktop.

**Inerte quando a tabela cabe**: sem overflow, as coberturas tapam as sombras e não se vê nada.
Aplica-se a todas as tabelas, sem decidir caso a caso se a tabela é "larga".

Regras de aplicação:

- O wrapper envolve a `<table>` e só ela, nunca o cabeçalho do card.
- O card exterior mantém `overflow-hidden` e não leva `overflow-x-auto`.
- `data-table-search-scope` fica no card: a tabela continua a ser descendente do scope e a pesquisa
  client-side não é afetada.
- Fragmentos HTMX que devolvem a tabela inteira (`_list_fragment.vto`) incluem o wrapper; fragmentos
  que só trocam linhas ou o `<tbody>` não, e o wrapper fica no template que contém a `<table>`.
- Cards cujo cabeçalho é título (+count) (+pesquisa) usam `partials/table_card.vto`, que aplica o
  wrapper por construção ([ADR 0038](./0038-table-card-canonical.md)).

### Âmbito

Convenção do admin: a classe só existe em `layouts/admin.vto`. Se o portal precisar do mesmo,
replica-se a classe em `layouts/portal.vto`, como as outras peças replicadas entre layouts
([ADR 0013](./0013-confirm-modal-global.md), [ADR 0027](./0027-htmx-loading-indicator.md)).

## Consequências

- Em mobile, todas as colunas e os botões de ação ficam acessíveis.
- Aplicar o padrão é envolver a `<table>`; como é inerte quando a tabela cabe, não tem custo.
- A sombra torna o scroll descobrível sem JS.
- Ler uma tabela de 8 colunas em mobile obriga a arrastar. É o compromisso aceite face a esconder
  informação ou redesenhar cada tabela.

## Alternativas rejeitadas

1. **Cards empilhados em mobile** (cada linha vira um card, tabela com `hidden md:block`). Lê-se
   melhor em ecrãs pequenos, mas exige markup alternativo por página, diverge do desktop e é caro de
   manter. O scroll resolve de forma uniforme.
2. **Esconder colunas secundárias em mobile** (`hidden sm:table-cell`). Esconde dados de que o
   administrador pode precisar (datas, estado); o scroll preserva tudo.
3. **`overflow-x-auto` simples, sem sombra.** Dá scroll, mas ninguém descobre que a tabela arrasta.
4. **`overflow-x-auto` no card exterior, ou tirar-lhe o `overflow-hidden`.** No primeiro caso o
   cabeçalho desloca-se com a tabela; no segundo a tabela sangra para fora dos cantos arredondados e
   continua sem scroll.

## Sinais de alerta para code review

- `<table>` dentro de um card `overflow-hidden` sem `.table-scroll` à volta. → propor o wrapper (ou
  `table_card.vto`).
- `<div class="overflow-x-auto">` ad-hoc à volta de uma tabela do admin. → `.table-scroll`.
- `overflow-x-auto` no card exterior. → mover para o wrapper interno.
- `hidden sm:table-cell` (ou `md:`) a esconder colunas de dados. → questionar; preferir scroll.

## Referências

- [`layouts/admin.vto`](../../src/apps/panel/templates/layouts/admin.vto) - definição de
  `.table-scroll` no `<style>`.
- [`partials/table_card.vto`](../../src/apps/panel/templates/partials/table_card.vto) - aplica o
  wrapper por construção.
- Card escrito à mão (cabeçalho com controlos próprios), com o wrapper dentro do fragmento HTMX:
  [`_list_fragment.vto`](../../src/apps/panel/templates/pages/charges/_list_fragment.vto).
- [ADR 0026](./0026-scroll-preservation-htmx.md) - scroll vertical em swaps HTMX; este ADR trata do
  scroll horizontal de tabelas.
- [ADR 0029](./0029-kpi-card-responsive.md) - responsividade dos KPI cards.
