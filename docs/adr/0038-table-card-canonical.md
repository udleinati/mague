# ADR 0038 - Card de tabela canónico (`table_card.vto`)

## Contexto

As listagens do admin repetem o mesmo invólucro de tabela: card
`bg-base-100 rounded-xl border border-base-200 overflow-hidden shadow-sm`, cabeçalho com título,
contagem e pesquisa, e o wrapper `.table-scroll` (ADR 0031). Copiado à mão, o invólucro diverge de
página para página e o `.table-scroll` esquece-se, o que deixa a tabela sem scroll em mobile.

## Decisão

Cards de tabela cujo cabeçalho é título (+count) (+pesquisa) usam `partials/table_card.vto` em modo
`{{ layout }}`. O corpo é a `<table>`, e só ela:

```vto
{{ layout "partials/table_card.vto" { title: "Lista", count: items.length, searchable: true } }}
  <table class="table table-sm">...</table>
{{ /layout }}
```

Interface: `title` (obrigatório; se faltar, renderiza `[table_card: falta title]`), `count?`
(mostrado como "· N"), `subtitle?`, `searchable?` (por omissão `false`; liga
`data-table-search-scope` no card e o input `data-table-search` no cabeçalho), `headerRight?` (texto
à direita, ignorado quando `searchable`), `wrapperClass?` (só utilities de espaçamento ou largura,
ex.: `"mb-6"`; nunca cores, bordas ou sombras).

O partial garante por construção as regras do ADR 0031: `overflow-hidden` no card (cantos
arredondados) e a tabela sempre dentro de `.table-scroll`. Como em qualquer partial em modo
`{{ layout }}`, a última propriedade dos params não leva vírgula final (ADR 0036).

### O que não cabe

- **Cabeçalhos com filtros, selects, tabs ou botões**: ficam escritos à mão, ou os filtros sobem
  para fora do card. O slot único é da tabela.
- **Placeholder de pesquisa próprio** (ex.: `receipts/pending.vto`): o partial usa "Pesquisar…"
  fixo. Um param só se justifica com dois ou mais casos.
- **Empty states**: ficam no chamador (uma linha no `<tbody>`, ou outro card no lugar deste).
- **Modais e outro markup associado à tabela**: fora do corpo do layout (ex.:
  `partials/email_log_table.vto`).
- **Conteúdo não tabular** (listas `divide-y`, cards de dashboard).

Os cards escritos à mão seguem o ADR 0031 diretamente. Os que cabem neste âmbito e ainda não usam o
partial (ex.: `units/list.vto`) convertem-se quando o ficheiro for tocado.

## Consequências

- As regras do ADR 0031 passam de disciplina a estrutura, e o cabeçalho de card fica uniforme.
- O slot único deixa de fora os cabeçalhos ricos. É a condição para a interface não ficar tão larga
  como a implementação.

## Sinais de alerta para code review

- Novo card de tabela escrito à mão com cabeçalho título (+count) (+pesquisa). → `table_card.vto`.
- `wrapperClass` com cores, bordas ou sombras. → essas decisões são do módulo.
- Vírgula final na última propriedade dos params. → erro de parse do Vento; remover.

## Referências

- [`partials/table_card.vto`](../../src/apps/panel/templates/partials/table_card.vto) -
  implementação; testes em [`page_header_test.ts`](../../src/apps/panel/page_header_test.ts).
- [`pages/users/list.vto`](../../src/apps/panel/templates/pages/users/list.vto) - uso de referência.
- [ADR 0031](./0031-table-horizontal-scroll-mobile.md) - `.table-scroll`.
- [ADR 0036](./0036-page-header-canonical.md) - mesmo padrão de partial com slot e a mesma armadilha
  do Vento.
