# ADR 0026 - HTMX swaps preservam scroll; uploads usam dropzone canónica

## Contexto

O admin usa HTMX para trocar partes da página em vez de a recarregar. Uma ação localizada (anexar um
ficheiro, comentar) no fundo de uma página longa não pode tirar o utilizador do sítio onde está. Há
três causas distintas para a viewport "saltar":

1. **Scroll do HTMX.** O HTMX faz `scrollIntoView` do conteúdo trocado quando o swap resolve para
   `show:top` ou `show:bottom`; no htmx 2.0 é esse o valor por omissão dos pedidos boosted
   (`scrollIntoViewOnBoost`).
2. **Mudança de altura.** O elemento trocado cresce ou encolhe e desloca o que está abaixo, mesmo
   com a posição de scroll intacta.
3. **`sr-only` sem âncora.** O `sr-only` do Tailwind é `position: absolute` sem `top`/`left`. Num
   `<input class="sr-only">` dentro de um `<label>` sem `position: relative`, o input ancora-se ao
   primeiro ancestral posicionado (em regra o `<body>`) e fica no canto superior esquerdo da página;
   ao clicar no label, o browser foca o input e faz scroll até ele.

## Decisão

As regras 1 e 1b aplicam-se ao admin, o único layout que carrega o HTMX. As regras 2 e 3 aplicam-se
a admin e portal.

### Regra 1 - `hx-swap` declara `show:no`

Todo o `hx-swap` que substitui conteúdo inclui o modifier `show:no`:

```html
<form ... hx-swap="outerHTML show:no">
```

`show:no` diz ao HTMX para não mexer no scroll depois do swap: a posição do utilizador deixa de
depender dos defaults do HTMX. A regra é por swap, e não uma configuração global, para que as
exceções fiquem explícitas e locais: um wizard que leva o utilizador ao topo do passo seguinte
declara `show:top`; uma mensagem de erro fora da viewport, `show:window:top`. Um `hx-swap` de
conteúdo sem `show:` é um defeito a corrigir em code review.

Fora do âmbito: `hx-swap="none"` e swaps OOB (`hx-swap-oob`).

### Regra 1b - o alvo do swap é o elemento mais pequeno que muda

`show:no` não evita o salto por mudança de altura. A solução é trocar só a região que muda, com
`hx-target` e `hx-select` a apontar para o mesmo id:

```html
<form method="post" action="..."
  hx-post="..."
  hx-target="#ticket-attachments"
  hx-select="#ticket-attachments"
  hx-swap="outerHTML show:no">
```

O handler não precisa de conhecer a região: devolve o template inteiro e o HTMX extrai da resposta
só `#ticket-attachments`; o resto do DOM fica intacto. O alvo certo é o elemento mais pequeno que
contém tudo o que pode mudar, contadores incluídos: nem o corpo todo, nem um elemento tão pequeno
que deixe um contador desatualizado.

- **Servidor**: `htmxOrRedirect` em
  [`routes/_htmx_response.ts`](../../src/apps/panel/routes/_htmx_response.ts) escolhe entre devolver
  o HTML de `renderFragment` (pedido com `HX-Request: true`) e redirecionar com flash (pedido
  normal). O alvo vive no markup, não no handler.
- **Lista de anexos**: `partials/attachments_list.vto` aceita `hxTarget`/`hxSelect`; quando
  passados, cada form de remoção adota este padrão.
- **Form dentro de `<dialog>`**: o wrapper alvo do swap fica fora do dialog, senão o swap destrói o
  modal a meio. Para fechar só em caso de sucesso (em erro, o que o utilizador preencheu mantém-se):

  ```html
  hx-on::after-request="if (event.detail.successful) document.getElementById('modal_X').close()"
  ```

### Regra 2 - `sr-only` dentro de wrapper interativo exige `position: relative`

Um `<input class="sr-only">` dentro de um `<label>` (ou de qualquer parent que recebe cliques ou
foco) obriga o parent a ter `relative`, para ancorar o input localmente:

```html
<label class="relative ...">
  <input type="file" class="sr-only">
  <!-- conteúdo visual -->
</label>
```

Vale para qualquer input escondido visualmente com `position: absolute`. A falha é silenciosa: o
markup parece correto até alguém clicar.

### Regra 3 - uploads usam `partials/file_dropzone.vto`

Uploads de ficheiros, no admin e no portal, usam o partial
[`partials/file_dropzone.vto`](../../src/apps/panel/templates/partials/file_dropzone.vto) em vez de
`<input class="file-input">`:

- **Visual único**: dropzone tracejada com drag-and-drop, pré-visualização dos ficheiros e contador.
- **Regra 2 por construção**: o `relative` já está no `<label>` do partial.
- **Gating do submit**: o botão de submit do form leva `data-upload-submit disabled`; o JS global
  ([`partials/_dropzone_script.vto`](../../src/apps/panel/templates/partials/_dropzone_script.vto),
  incluído nos dois layouts) ativa-o quando há ficheiros selecionados. Usa event delegation no
  `document`, por isso sobrevive a swaps HTMX.

O partial gera só a dropzone; o chamador escreve o `<form>`:

```vto
<form method="post" action="..." enctype="multipart/form-data" class="space-y-3">
  {{ include "partials/file_dropzone.vto" {
    name: "file",
    multiple: false,
    accept: uploadAccept,
    helpText: "PDF ou imagem. Máximo " + String(uploadMaxMb) + " MB.",
  } }}
  <button type="submit" class="btn btn-sm btn-primary" data-upload-submit disabled>Carregar</button>
</form>
```

Params: `name` (por omissão `"files"`), `multiple` (por omissão `true`), `required` (por omissão
`true`), `accept`, `helpText`. `uploadAccept` e `uploadMaxMb` são globais do `render()`: a mesma
allowlist e o mesmo limite que o servidor valida. Imports XLSX usam `multiple: false` e
`accept: ".xlsx,..."`.

Upload por HTMX combina as regras 1 e 1b; `hx-encoding` é obrigatório para multipart:

```vto
<form method="post" action="..." enctype="multipart/form-data"
      hx-post="..."
      hx-target="#pathology-attachments"
      hx-select="#pathology-attachments"
      hx-swap="outerHTML show:no"
      hx-encoding="multipart/form-data"
      class="space-y-3">
  {{ include "partials/file_dropzone.vto" { name: "files", multiple: true, accept: uploadAccept } }}
  ...
</form>
```

## Exceções

- **Regra 3**: o comprovativo de renovação em `portal/insurance/show.vto` usa um input próprio,
  porque o fluxo obriga a pré-visualizar e confirmar o ficheiro antes de o enviar e restringe o
  `accept`. Cumpre a regra 2 (`relative` no `<label>`).

## Consequências

- O utilizador não perde a posição por causa de uma ação localizada.
- Regras mecânicas, fáceis de aplicar e de detetar em revisão, sem bibliotecas adicionais.
- Cada `hx-swap` fica mais verboso.
- O `relative` no label é uma armadilha que não se adivinha pelo markup; fica documentada aqui e num
  comentário no partial.

## Como detetar deriva

Swaps de conteúdo sem modifier `show:`:

```sh
grep -rnE 'hx-swap="[^"]*"' src/apps/panel/templates | grep -v 'show:' | grep -v 'hx-swap="none"'
```

O comando ainda devolve ocorrências (filtros e paginação dos `_list_fragment.vto`, linhas da
conciliação, partes de `assembly/`); alinham-se quando o ficheiro for tocado.

## Alternativas rejeitadas

1. **Configuração global do HTMX ou listener global em `htmx:afterSwap`** para fixar o scroll. Tira
   o modifier explícito por swap, que é o que permite exceções legítimas (`show:top`).
2. **Extensão de morph (`morph:outerHTML`)**. Preserva o scroll por só tocar nos nós que mudam, mas
   acrescenta uma extensão e complexidade; `show:no` + `hx-select` chegam.
3. **Esconder o input com `opacity: 0; pointer-events: none`** em vez de `sr-only`. O `sr-only` é o
   utilitário certo para esconder mantendo o input acessível; o defeito é a falta de âncora, que se
   resolve com `relative`.
4. **Wrapper `<div class="relative">` extra dentro do label.** Markup desnecessário; o `relative`
   vai no próprio label.

## Sinais de alerta para code review

- `hx-swap` de conteúdo sem `show:no`. → acrescentar, ou justificar o `show:` escolhido.
- `hx-target` no corpo todo da página quando só uma secção muda. → `hx-target` + `hx-select` na
  secção.
- `<input class="sr-only">` dentro de `<label>` sem `relative`. → acrescentar `relative`.
- `<input type="file">` ou `file-input` fora do partial. → `file_dropzone.vto`.
- Botão de submit de upload sem `data-upload-submit disabled`. → acrescentar.
- Alvo de swap dentro do `<dialog>` que contém o form. → mover o wrapper para fora.

## Referências

- [`partials/file_dropzone.vto`](../../src/apps/panel/templates/partials/file_dropzone.vto) e
  [`partials/_dropzone_script.vto`](../../src/apps/panel/templates/partials/_dropzone_script.vto) -
  dropzone canónica.
- [`pages/ticket/_ticket_body.vto`](../../src/apps/panel/templates/pages/ticket/_ticket_body.vto) e
  [`pages/pathology/show.vto`](../../src/apps/panel/templates/pages/pathology/show.vto) - upload e
  remoção de anexos com `hx-select`.
- [`pages/charges/show.vto`](../../src/apps/panel/templates/pages/charges/show.vto) - upload em
  modal com o alvo fora do `<dialog>`.
- [`routes/_htmx_response.ts`](../../src/apps/panel/routes/_htmx_response.ts) - `htmxOrRedirect`,
  testado em [`_htmx_response_test.ts`](../../src/apps/panel/routes/_htmx_response_test.ts).
- [ADR 0013](./0013-confirm-modal-global.md) - modal de confirmação global.
- [ADR 0019](./0019-create-edit-modals-pattern.md) - forms de mutação em `<dialog>`.
- [ADR 0027](./0027-htmx-loading-indicator.md) - indicador de loading dos pedidos HTMX.
- [ADR 0030](./0030-shared-action-helpers.md) - `htmxAction`, para mutações com resposta OOB.
- [HTMX: `hx-swap`, scroll e show](https://htmx.org/attributes/hx-swap/#scrolling-scroll-show).
