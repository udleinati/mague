# ADR 0022 - Coluna de ações em listagens: SVG + label + hierarquia de cor

## Contexto

A coluna de ações (à direita) das tabelas de listagem do painel admin precisa de uma gramática
visual única. Sem norma, cada template improvisa: links só de texto, emojis, `×` para apagar, labels
com maiúsculas e verbos diferentes ("ver", "Abrir", "Eliminar"). O resultado lê-se como uma
aplicação por acabar.

## Decisão

**Cada ação da coluna é um `<a>` (ou `<button>`) com um SVG monocromático de 14px + label, e as
ações de uma linha agrupam-se num `<div class="inline-flex items-center gap-4">`.**

### Partial canónico

[`partials/action_link.vto`](../../src/apps/panel/templates/partials/action_link.vto) renderiza a
ação completa (classes, SVG, label, `title`):

```vto
<td class="pr-4 text-right whitespace-nowrap">
  <div class="inline-flex items-center gap-4">
    {{ include "partials/action_link.vto" {
      kind: "view",
      href: "/admin/c/" + currentCondominiumId + "/bank-accounts/" + a.id,
    } }}
    {{ include "partials/action_link.vto" { kind: "edit", href: "..." } }}
    {{# Apagar dentro de form, ver abaixo #}}
  </div>
</td>
```

Parâmetros: `kind`, `href`, `label?` (substitui o label por omissão), `title?` (tooltip; por omissão
igual ao label) e `asButton?` (gera `<button type="submit">` em vez de `<a>`, para usar dentro de um
`<form>`). `gap-4` separa as ações; o `gap-1` entre ícone e label vem do partial.

| `kind`   | Label    | Hierarquia | Ícone                        |
| -------- | -------- | ---------- | ---------------------------- |
| `view`   | Ver      | Primária   | olho                         |
| `edit`   | Editar   | Secundária | lápis sobre quadrado         |
| `import` | Importar | Secundária | tabuleiro com seta para cima |
| `export` | Exportar | Secundária | tabuleiro com seta para cima |
| `pause`  | Pausar   | Secundária | pausa                        |
| `resume` | Retomar  | Secundária | play                         |
| `pdf`    | PDF      | Secundária | documento                    |
| `delete` | Apagar   | Destrutiva | caixote                      |

Os paths SVG vivem no partial, que é a fonte de verdade (as ações escritas inline copiam-nos de lá).
São ícones [heroicons](https://heroicons.com/) outline 24×24, com `fill="none"`,
`stroke="currentColor"` (o ícone segue a cor do link) e `stroke-width="2"`.

Guard do ícone de `import`: usa a seta para **cima** (`arrow-up-tray`: importar = enviar ficheiro =
upload). Não trocar por `arrow-down-tray`. `import` e `export` desenham o mesmo glifo.

### Hierarquia de cor e ordem

| Tipo           | Classes                                                        | Quando                              |
| -------------- | -------------------------------------------------------------- | ----------------------------------- |
| **Primária**   | `link link-primary`                                            | Ver (a ação esperada)               |
| **Secundária** | `link link-hover text-base-content/70 hover:text-base-content` | Editar, Importar, Exportar, toggles |
| **Destrutiva** | `link link-error`                                              | Apagar                              |

A ação primária é **sempre a primeira**, da esquerda para a direita. Apagar é **sempre a última**.

### Labels canónicas (PT-PT, inicial maiúscula)

**Ver** (não "ver", "abrir", "Abrir", "open"), **Editar**, **Importar** / **Exportar**, **Apagar**
(não "Eliminar", "Remover", "×"), **Pausar** / **Retomar** (toggles binários). Quando a ação tem um
nome próprio, passa-se `label` e mantém-se o padrão visual (ex.: "Não aprovar" / "Reabrir" em
`pages/budget/list.vto`).

### Ações destrutivas com confirmação

"Apagar" vai dentro de um `<form>` com `data-confirm-*`
([ADR 0013](./0013-confirm-modal-global.md)); o partial gera o botão de submit com `asButton: true`:

```vto
<form method="post" action="..." class="inline"
      data-confirm-title="Apagar fornecedor?"
      data-confirm-body="..."
      data-confirm-ok="Apagar"
      data-confirm-danger="true">
  {{ include "partials/action_link.vto" { kind: "delete", asButton: true } }}
</form>
```

### Quando o partial não chega

O partial só gera `<a href>` ou `<button type="submit">`. Um botão que abre um modal
(`type="button"` + `onclick`) ou um link com atributos extra (`target="_blank"`, `data-*`)
escreve-se inline, com as mesmas classes, `title` e o SVG copiado do partial:

```vto
<button type="button"
        class="inline-flex items-center gap-1 link link-hover text-xs text-base-content/70 hover:text-base-content"
        title="Editar fornecedor"
        onclick="...">
  <svg class="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" stroke-width="2"
       viewBox="0 0 24 24" aria-hidden="true">
    <path stroke-linecap="round" stroke-linejoin="round" d="{PATH do partial}"/>
  </svg>
  Editar
</button>
```

Exemplos: `pages/suppliers/list.vto` (botões que abrem modal) e `pages/receipts/_list_fragment.vto`
(link "PDF" com `target="_blank"`).

## Exceções

- **Páginas de detalhe (`show.vto`).** As ações principais ficam no cabeçalho como
  `btn btn-sm btn-primary`. O padrão deste ADR é para listagens densas, onde a coluna de ações é
  compacta.

## Consequências

- Padrão visual reconhecível: o ícone reforça a label, a cor distingue a ação primária e torna a
  destrutiva óbvia, e o vocabulário PT-PT é único (Ver / Editar / Apagar).
- O partial centraliza os SVG e a acessibilidade (`aria-hidden="true"` no SVG, `title` no elemento):
  alterar um ícone propaga-se a todas as listagens que o usam.
- Custo: markup mais pesado quando a ação tem de ser escrita inline.

## Sinais de alerta para code review

- `<a class="link link-primary text-xs">ver</a>` (sem SVG, label em minúsculas) → usar o partial.
- `>×<`, `📥`, `🗑`, `>abrir<`, `>open<` numa coluna de ações → reescrever conforme este ADR.
- Hierarquia de cor trocada (Editar a `link-primary`, Ver a `link-hover`).
- Ação destrutiva fora de um form com confirmação (ADR 0013).

## Referências

- [`pages/bank_accounts/list.vto`](../../src/apps/panel/templates/pages/bank_accounts/list.vto) -
  coluna com Ver / Editar / Importar.
- [`pages/suppliers/list.vto`](../../src/apps/panel/templates/pages/suppliers/list.vto) - botões
  inline + Apagar com confirmação.
- [`payment_plan_views_test.ts`](../../src/apps/panel/payment_plan_views_test.ts) - teste "ícone
  'Ver' (ADR 0022)".
- [ADR 0019](./0019-create-edit-modals-pattern.md) - forms de criar/editar em `<dialog>` modal (o
  botão Editar abre um modal ou navega para a página de edição).
