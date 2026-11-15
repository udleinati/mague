# ADR 0013 - Modal de confirmação: replicado em ambos os layouts

## Contexto

Toda a operação destrutiva ou irreversível no panel (apagar, desativar, anular, rejeitar) exige
confirmação explícita antes de submeter, com o visual e a acessibilidade do resto da aplicação (o
`window.confirm()` nativo não serve).

O panel tem dois layouts, `admin.vto` e `portal.vto`. Um `<form>` com atributos de confirmação numa
página cujo layout não tenha o modal e o respetivo JavaScript submete **sem confirmação**: falha
silenciosa e perigosa.

## Decisão

**`admin.vto` e `portal.vto` têm cada um a sua cópia inline** do `<dialog id="modal_confirm">` e do
`<script>` que regista `window.confirmAction` e os interceptores de `submit` e `htmx:confirm`. Não
há partial partilhado.

### Padrão declarativo (o que se usa sempre)

```vto
<form method="post" action="..." class="inline"
      data-confirm-title="Apagar apólice?"
      data-confirm-body="Apaga os ficheiros e a submissão. Esta ação é irreversível."
      data-confirm-ok="Apagar"
      data-confirm-danger="true">
  <button type="submit" class="btn btn-xs btn-ghost text-error">Apagar</button>
</form>
```

Os atributos vão no `<form>`, não no botão:

- `data-confirm-title` e `data-confirm-body` - título e texto. Obrigatórios por convenção (o
  interceptor ativa-se com qualquer um dos dois).
- `data-confirm-ok` / `data-confirm-cancel` - texto dos botões. Por omissão "Sim" / "Não"; em modo
  danger, "Eliminar" / "Cancelar".
- `data-confirm-danger="true"` - botão de confirmação vermelho, ícone de aviso e linha "Executado
  por" ([ADR 0025](./0025-danger-zone-pattern.md)).
- `data-confirm-prompt="<name>"` - pede um texto obrigatório e injeta-o no form como
  `<input type="hidden" name="<name>">`. Complementos: `data-confirm-prompt-label`,
  `data-confirm-prompt-placeholder`, `data-confirm-prompt-options="a|b"` (chips de preenchimento).
- `data-confirm-typed-match="<TEXTO>"` - só confirma se o utilizador escrever exatamente `<TEXTO>`
  (sensível a maiúsculas); implica danger. Usado pela zona perigosa (ADR 0025).
- `data-confirm-busy="true"` - depois de confirmar, o modal fica aberto em "A processar…" com
  contador até a navegação acontecer. Complementos: `data-confirm-busy-message`,
  `data-confirm-busy-tip`. Só em submits nativos (não HTMX).

**Nunca** `window.confirm(...)` nem `onclick="return confirm(...)"`.

### Padrão imperativo (raro)

Para confirmações decididas em JavaScript (ex.: `pages/users/edit.vto`):

```js
const ok = await window.confirmAction({ title: "Apagar?", body: "...", danger: true });
if (ok) { /* ... */ }
```

Opções: `title`, `body`, `danger`, `okText`, `cancelText`, `promptName`, `promptLabel`,
`promptPlaceholder`, `promptOptions`, `typedMatch`, `busy: { message, tip }`. Resolve para um
booleano; com `promptName` ou `typedMatch`, para `{ ok, value }`.

### HTMX

Um elemento com `hx-post`/`hx-get`/`hx-put`/`hx-delete` **não dispara o evento `submit` nativo**: o
HTMX emite a request diretamente e o interceptor de `submit` não corre. Por isso cada layout regista
também um listener em `htmx:confirm` (disparado pelo HTMX antes de cada request) que:

1. Lê `data-confirm-*` no próprio elemento ou no `<form>` que o contém; aceita também
   `hx-confirm="..."` (o texto é o corpo do modal).
2. Se houver título, corpo ou `hx-confirm`, chama `evt.preventDefault()` e abre o modal.
3. Quando o utilizador confirma, chama `evt.detail.issueRequest(true)` para emitir a request.

Acrescentar `hx-*` a um form com `data-confirm-*` não exige mais nada. Os dois interceptores são
ambos necessários: remover qualquer um reabre o caminho "submete sem confirmar". Verificação manual:
em DevTools → Network, a request **não** pode sair no clique, só depois de confirmar no modal.

### Manter os dois layouts em sync

Qualquer alteração ao modal (markup, lógica, textos) faz-se nos dois ficheiros. Para comparar:

```bash
diff \
  <(awk '/MODAL de confirmação global/,/<\/script>/' src/apps/panel/templates/layouts/admin.vto) \
  <(awk '/MODAL de confirmação global/,/<\/script>/' src/apps/panel/templates/layouts/portal.vto)
```

O resultado não é vazio. Diferenças existentes entre as cópias, além dos comentários:

- O `admin.vto` tem, no mesmo IIFE, o handler dos `.dropdown-hover`; o portal não tem dropdowns
  desse tipo.
- O hook `htmx:confirm` do portal só lê título, corpo, `ok`, `cancel` e `danger`: no portal,
  `data-confirm-prompt*` num form HTMX é ignorado.
- `data-confirm-typed-match` só funciona no admin: a cópia de `confirmAction` no `portal.vto` sai
  sem abrir o modal quando recebe `typedMatch`. Nenhuma página do portal o usa.

Qualquer outra diferença é drift a corrigir.

## Alternativas rejeitadas

1. **Extrair para um partial incluído nos dois layouts.** Abstração para apenas dois usos, que torna
   o markup mais opaco em code review. O custo aceite é manter as duas cópias alinhadas à mão.
2. **Mover o JavaScript para um ficheiro global em `static/`.** O `<dialog>` teria de continuar
   inline no HTML; a solução híbrida complica o raciocínio sem eliminar a duplicação.
3. **Usar uma biblioteca (ex.: SweetAlert).** Dependência externa para algo que cabe em poucas
   centenas de linhas.

## Sinais de alerta para code review

- `data-confirm-*` num `<form>` de uma página cujo layout **não tem** `<dialog id="modal_confirm">`
  (ex.: páginas standalone em `pages/auth/`) → o form submete sem confirmação.
- `window.confirm(...)` ou `onclick="return confirm(...)"` → substituir pelo padrão declarativo.
- `<dialog>` de confirmação próprio numa página → usar `data-confirm-*` ou `confirmAction()`.
- Alteração ao modal feita num só layout.

## Referências

- [`layouts/admin.vto`](../../src/apps/panel/templates/layouts/admin.vto) e
  [`layouts/portal.vto`](../../src/apps/panel/templates/layouts/portal.vto) - bloco "MODAL de
  confirmação global".
- [`pages/portal/insurance/index.vto`](../../src/apps/panel/templates/pages/portal/insurance/index.vto) -
  uso declarativo canónico.
- [ADR 0025](./0025-danger-zone-pattern.md) (zona perigosa, typed-match) e
  [ADR 0022](./0022-list-action-icons.md) (botão "Apagar" em listagens).
