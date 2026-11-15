# ADR 0036 - Cabeçalho de página canónico (`page_header.vto` + `status_badge.vto`)

## Contexto

O cabeçalho de página (título, navegação, estado, meta, ações) repete-se em todas as páginas do
admin. Escrito à mão, a interface que cada página tem de conhecer (classes, espaçamento,
breakpoints, ordem dos blocos) é tão complexa como a implementação: as variantes de tipografia
multiplicam-se, coexistem padrões de navegação concorrentes (breadcrumbs e links "← Voltar") e os
badges de estado copiam-se com pequenas diferenças. Mudar a tipografia dos títulos custa um ficheiro
por página.

## Decisão

### Um seam para o cabeçalho: `partials/page_header.vto`

Todas as páginas do admin renderizam o cabeçalho com `partials/page_header.vto`; nenhuma escreve
`<h1>` com classes à mão. Ficam fora do âmbito o portal e as páginas de `auth/` e `errors/`. Há duas
formas de chamar:

```vto
{{# Sem ações: #}}
{{ include "partials/page_header.vto" { title: "Frações" } }}

{{# Com ações - o corpo do layout é a coluna direita, HTML livre: #}}
{{ layout "partials/page_header.vto" {
  title: "Fração " + unit.designation,
  scale: "detail",
  breadcrumbs: [
    { label: "Frações", href: "/admin/c/" + currentCondominiumId + "/units" },
    { label: "Fração " + unit.designation },
  ],
  status: unit.isActive
    ? { label: "Ativa", tone: "success" }
    : { label: "Inativa", tone: "muted" },
  meta: [
    unit.identifier ? { label: "Identificador", value: unit.identifier } : null,
    { value: _pm + "‰", plain: true },
  ]
} }}
  <a href="/admin/c/{{ currentCondominiumId }}/units/{{ unitId }}/edit"
     class="btn btn-sm btn-primary">Editar</a>
{{ /layout }}
```

Interface (o comentário no topo do partial tem o detalhe): `title` (obrigatório; se faltar,
renderiza `[page_header: falta title]` visível), `scale` (`"list"` por omissão, ou `"detail"`),
`breadcrumbs` (`[{ label, href? }]`), `code` + `codeTone` (entity code acima do título; `"info"`,
`"success"` ou `"neutral"`), `status` (`{ label, tone }`) e `meta`
(`[{ value, label?, href?, tone?, plain? }]`; segmentos falsy são filtrados, o que permite
`cond ? { ... } : null` no chamador).

### Regras que o seam codifica

1. **Escala tipográfica.** Listagens e raízes de secção: `text-4xl font-black`. Páginas de detalhe:
   `text-3xl font-bold`. As páginas não injetam classes de tipografia; querer uma terceira escala é
   uma conversa de design, não um parâmetro.
2. **Navegação = breadcrumbs, sempre.** É o único padrão de navegação no cabeçalho. O detalhe típico
   usa dois itens (`Frações / Fração A`). Links "← Voltar" no cabeçalho e botões "Voltar"
   redundantes na coluna de ações estão descontinuados.
3. **Code acima do título** (ver "Charge code" em `CONTEXT.md`): `font-mono` com `tracking-widest`;
   payable = `info`, receivable = `success`.
4. **O corpo do `{{ layout }}` é a coluna de ações.** HTML livre: botões de modal, forms,
   condicionais. As ações não se estruturam em dados.
5. **Meta de linha única, com o separador `·` do módulo.** O chamador nunca escreve o separador.
   Conteúdo multilinha (ex.: a nota da fração em `units/show.vto`) fica fora do seam, abaixo do
   cabeçalho.
6. **Presentation-pure.** Os valores chegam pré-formatados (`{{ set _x = y |> formatX }}` antes da
   chamada) e os hrefs resolvidos; o módulo não conhece domínio, filtros nem tenancy. O mapeamento
   domínio → `{ label, tone }` é do chamador; quando se repete entre páginas, vive num helper
   exposto como global do Vento (`chargeStatusBadge`, `insuranceStatusBadge`). Todos os params são
   escapados: não se passa HTML em `title` nem em `meta`.

### Badge de estado: `partials/status_badge.vto`

Dot + label como seam próprio (`{ label, tone, size?, variant? }`), usado pelo `page_header` e
disponível para qualquer página:

- `tone` - `success`, `warning`, `error`, `info`, `neutral` (por omissão) ou `muted` (cancelado ou
  inativo). Tom desconhecido degrada para `neutral`.
- `size` - `"sm"` (por omissão, cabeçalhos) ou `"xs"` (células de tabela).
- `variant` - `"plain"` (por omissão, dot + label) ou `"pill"` (chip com fundo do tom, para listas
  densas onde o badge tem de se destacar do texto à volta).

O mapa tom → classes usa literais, porque o JIT do Tailwind só vê literais. O partial é
apresentacional: o estado de uma cobrança vem de `chargeStatusBadge` ou de `charge_status.vto`
([ADR 0037](./0037-charge-effective-status.md)); o de um seguro, do global `insuranceStatusBadge`
(`$panel/libs/insurance_status.ts`).

### Armadilha do Vento: trailing comma no modo layout

No modo `{{ layout }}`, a última propriedade do objeto de params não pode ter vírgula final: o
plugin injeta `content` por splice e a vírgula gera `,,` no compilado (erro de parse). Vírgulas
dentro de arrays e objetos aninhados são aceites, e no modo `{{ include }}` a vírgula final também.

### Testes

O contrato vive em [`page_header_test.ts`](../../src/apps/panel/page_header_test.ts): escala,
fail-loud do `title`, autoescape, gramática da meta, modo layout, tons do `status_badge` e
compilação de todos os templates. Renderiza diretamente, sem BD nem API.

## Consequências

- Tipografia, navegação, badge e meta têm uma única definição: mudar o cabeçalho de todo o admin é
  editar um ficheiro, e uma página nova ganha o cabeçalho certo em poucas linhas declarativas.
- Alterar o partial muda pixels em todas as páginas: rever visualmente, não só por diff.
- A armadilha da trailing comma é atrito real do Vento.

## Alternativas rejeitadas

1. **Interface máxima** (params para tudo: `backHref`, `codePlacement`, `note`, `titleClass`,
   segmentos com `html`). Params que servem uma ou duas páginas deixam a interface quase tão larga
   como a implementação, e um escape hatch de HTML ou de classes é a porta por onde as variantes
   voltam a entrar. Os casos exóticos ficam fora do módulo.
2. **Escala derivada da navegação** (há breadcrumbs → detalhe). É falso no codebase:
   `receipts/pending.vto` tem breadcrumbs e é uma listagem. Fica o `scale` explícito.
3. **`back` + `breadcrumbs` como dois params de navegação.** Manter dois padrões visuais é a média
   dos dois mundos; o breadcrumb de dois itens cobre o caso lista → item.
4. **Ações estruturadas em dados** (`actions: [{ kind, label }]`). HTML é a melhor interface para
   botões, forms e condicionais.

## Sinais de alerta para code review

- `<h1 class="text-...">` à mão numa página do admin. → `page_header.vto`.
- Link "← Voltar" no cabeçalho, ou `<div class="breadcrumbs">` escrito à mão. → param `breadcrumbs`.
- `{{ layout "partials/page_header.vto" { ..., } }}` com vírgula final na última propriedade. →
  remover a vírgula.
- Novo `inline-flex items-center gap-1.5 ... rounded-full` à mão para um estado. →
  `status_badge.vto`.

## Referências

- [`partials/page_header.vto`](../../src/apps/panel/templates/partials/page_header.vto) e
  [`partials/status_badge.vto`](../../src/apps/panel/templates/partials/status_badge.vto) -
  implementação e comentário de uso.
- [`pages/units/show.vto`](../../src/apps/panel/templates/pages/units/show.vto) - detalhe com
  estado, meta e ações.
- [`pages/charges/show.vto`](../../src/apps/panel/templates/pages/charges/show.vto) - detalhe com
  code e estado efetivo da cobrança.
- [ADR 0015](./0015-unit-link-everywhere.md) - formato `link link-hover`, que o `meta` com `href`
  emite.
- [ADR 0029](./0029-kpi-card-responsive.md) - mesmo padrão de partial com mapa tom → classes
  literais.
- [ADR 0038](./0038-table-card-canonical.md) - card de tabela, mesmo padrão de partial com slot.
