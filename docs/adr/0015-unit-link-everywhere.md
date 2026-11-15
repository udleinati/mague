# ADR 0015 - Designação de fração: link clicável em todo o admin panel

## Contexto

A designação de uma fração (`unit.designation`, opcionalmente seguida do `identifier`) aparece em
dezenas de páginas do painel admin: listagens, detalhe de recibos, mapa de quotas, conciliação,
relatórios. Se nuns sítios é texto e noutros é link, o utilizador não sabe quando pode saltar para a
página da fração (saldo, cobranças, ocupantes) e acaba por voltar ao menu.

## Decisão

**No painel admin, sempre que aparece a designação de uma fração (com ou sem `identifier`), é um
link** para `/admin/c/<cid>/units/<id>`.

Formato canónico, em células de tabela e blocos inline:

```vto
<a href="/admin/c/{{ currentCondominiumId }}/units/{{ unitId }}" class="link link-hover">
  <span class="font-bold">{{ designation }}</span>{{ if identifier }}<span class="text-base-content/50 font-normal"> - {{ identifier }}</span>{{ /if }}
</a>
```

- `link link-hover` - sublinhado só no hover; cor herdada do contexto.
- Designação em `font-bold`; `identifier` em `text-base-content/50 font-normal`, separado por
  `" - "` (com espaços). O link cobre a designação **e** o `identifier`.
- **Não usar** `link link-primary` em listas e tabelas: a cor da marca torna-se ruído quando há
  dezenas de células.
- Contextos compactos (chips, células densas) podem ajustar peso e tamanho (`font-semibold`,
  `text-[11px]`), mantendo `link link-hover` e o destino.
- Em cabeçalhos de página, a fração vai na linha `meta` do `partials/page_header.vto` com `href`
  (`{ label: "Fração", value, href }`); o partial renderiza `<a class="link link-hover">`. Exemplo:
  `pages/charges/show.vto`.

## Exceções

1. **Listagem das frações** (`pages/units/list.vto`). Cada linha já é a fração e tem a ação "Ver".
2. **Páginas da própria fração** (`pages/units/show.vto`, `pages/units/edit.vto`). O título "Fração
   X" é a página atual.
3. **Popups e modais** (`<dialog>`, comboboxes, `data-confirm-body`, tooltips). O utilizador está
   focado numa ação; navegar fechava o contexto. Texto simples.
4. **`<option>` em `<select>`**. O HTML não admite links dentro de `<option>`.
5. **Preview de import** (`pages/units/import_preview.vto`). As linhas são frações a criar, ainda
   sem `id`.
6. **PDFs e emails**. Saídas não interativas.
7. **Portal**. Esta regra é só do painel admin.

## Como verificar drift

```bash
grep -rn "unit\\?\\.designation\\|u\\.designation\\|\\.unitDesignation" \
  src/apps/panel/templates/pages/ \
  | grep -v "/portal/\\|templates/pages/units/" \
  | grep -v "<option\\|data-label\\|data-haystack\\|data-confirm-body\\|data-refact-haystack"
```

Cada resultado deve estar dentro de um `<a href=".../units/<id>">` ou ser uma das exceções acima.

## Alternativas rejeitadas

1. **Partial `partials/unit_link.vto`.** São cerca de 3 linhas inline; o partial troca-as por um
   `include` com parâmetros em cada uso, sem ganho real.
2. **Filtro Vento `unitLink`** (`{{ unit |> unitLink }}`). Mesmo motivo: abstração para algo que
   cabe numa linha de template.
3. **Link só em algumas páginas** (listagens sim, cabeçalhos não). A inconsistência é precisamente o
   problema a resolver.

## Sinais de alerta para code review

- Designação de fração em `<strong>` ou `<span class="font-bold">` numa página admin, sem `<a>` à
  volta e fora das exceções.
- `link link-primary` num link de fração dentro de uma tabela.
- Link que cobre a designação e deixa o `identifier` de fora.

## Referências

- [`pages/insurance/_rows.vto`](../../src/apps/panel/templates/pages/insurance/_rows.vto) e
  [`pages/receipts/_list_fragment.vto`](../../src/apps/panel/templates/pages/receipts/_list_fragment.vto) -
  usos canónicos.
- [`page_header_test.ts`](../../src/apps/panel/page_header_test.ts) (`meta` com `href`) e
  [`charges_refacturation_views_test.ts`](../../src/apps/panel/charges_refacturation_views_test.ts)
  ("a fração mostra o identificador e liga à fração") - testes; cabeçalho no
  [ADR 0036](./0036-page-header-canonical.md).
