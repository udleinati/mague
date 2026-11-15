# ADR 0029 - KPI cards responsivos: grid e fonte fluida

## Contexto

As listagens e os dashboards do panel (admin e portal) abrem com uma fila de **KPI cards**: um
rótulo curto, um valor grande em destaque e uma legenda. Em ecrãs estreitos há dois riscos:

1. **Valor em fonte fixa.** Em mobile o grid mostra 2 colunas e cada card fica com cerca de 115px de
   largura interior. Um valor monetário a `text-3xl` (30px) ocupa cerca de 165px e transborda: com
   `whitespace-nowrap` é cortado; sem ele, o `€` cai sozinho para a linha de baixo.
2. **Grid que salta cedo demais.** Com 4 ou 5 colunas logo a partir de `md` (768px), cada card fica
   com cerca de 90px - estreito até para uma fonte intermédia.

## Decisão

### 1. O card é o partial `kpi_card.vto`

```vto
{{ set _futuresValue = stats.futureDebtCents |> formatMoney }}
{{ include "partials/kpi_card.vto" {
  tone: "warning", label: "Futuras", value: _futuresValue, caption: "quotas lançadas por vencer"
} }}
```

Parâmetros: `tone` (`success | warning | error | info | primary | neutral`; por omissão `primary`),
`label`, `value`, `caption?`, `highlightValue?` (tinge o valor com o tom do rótulo) e `valueClass?`.
O partial aplica por construção a fonte fluida (ponto 3) e o `whitespace-nowrap` (ponto 4). Guards:

- `value` é uma **string já formatada**: os filtros `|>` não funcionam dentro dos parâmetros de um
  `include`, por isso pré-formata-se com `{{ set }}`.
- `value` é renderizado com `|> safe` (sem escape): nunca lhe passar texto livre do utilizador.
- `valueClass` **substitui** o `whitespace-nowrap` por omissão (ex.: `"truncate"`).
- O mapeamento `tone` → classes usa literais (o Tailwind só gera classes que encontra escritas por
  extenso): não construir nomes de classe por interpolação.

Um card que o partial não cobre (tooltip no valor, legenda estruturada, cor condicional própria)
escreve-se à mão com as classes dos pontos 3 e 4. Exemplos: "Saldo bancário" em
`pages/dashboard.vto` e os KPI de `pages/portal/dashboard.vto`.

### 2. Grid (escrito pela página)

```
grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4                  (4 cards; 3 cards: lg:grid-cols-3)
grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 sm:gap-4   (5 cards)
```

- **Mobile (`<640px`)**: sempre `grid-cols-2`.
- **4 ou 5 colunas só em `lg:`** (≥1024px), onde há largura real. Com 5 cards, um passo intermédio
  `md:grid-cols-3` suaviza a transição.
- **`gap-3 sm:gap-4`**: o gap menor em mobile devolve alguns píxeis aos cards.

### 3. Valor do KPI - fonte fluida

```
text-xl sm:text-2xl xl:text-3xl font-black
```

- `<640px` → `text-xl` (20px): um valor como `99.999,99 €` cabe nos ~115px do card a 2 colunas.
- `640-1280px` → `text-2xl` (24px).
- `≥1280px` (`xl`) → `text-3xl` (30px): o tamanho máximo, mesmo em desktop largo.

Nunca `text-3xl` / `text-4xl` fixo no valor. Títulos de página não são KPI: vêm do
`partials/page_header.vto` ([ADR 0036](./0036-page-header-canonical.md)).

### 4. `whitespace-nowrap` em valores monetários

Impede o `€` de cair para a linha seguinte. Com a fonte fluida o número cabe, pelo que o `nowrap`
não causa overflow: é só a salvaguarda contra a quebra.

## Consequências

- Valores legíveis e inteiros em qualquer viewport; um KPI novo usa o partial e fica correto sem
  copiar classes.
- Os cards escritos à mão dependem de uma convenção implícita: sem a tripla
  `text-xl sm:text-2xl xl:text-3xl`, o valor volta a transbordar em mobile.

## Alternativas rejeitadas

1. **1 coluna em mobile.** A fonte fixa caberia, mas 4-5 cards empilhados são muito scroll antes do
   conteúdo útil.
2. **Manter a fonte fixa e aceitar o overflow.** Corta o dado mais importante do card.
3. **Container com scroll horizontal.** Esconde KPIs que deviam ler-se de relance.
4. **Reduzir só o padding do card.** Ganha cerca de 10px, insuficiente para um `text-3xl`.

## Sinais de alerta para code review

- KPI card escrito à mão quando o partial serve.
- Valor de KPI com `text-3xl` / `text-4xl` **sem** as variantes `sm:` / `xl:`.
- Grid de KPIs com `md:grid-cols-4` / `md:grid-cols-5` (4 e 5 colunas entram em `lg:`).
- Valor monetário de KPI sem `whitespace-nowrap`.

## Referências

- [`partials/kpi_card.vto`](../../src/apps/panel/templates/partials/kpi_card.vto) - o partial.
- [`pages/dashboard.vto`](../../src/apps/panel/templates/pages/dashboard.vto) (5 cards, partial e
  cards escritos à mão) e
  [`pages/units/list.vto`](../../src/apps/panel/templates/pages/units/list.vto) (4 cards).
