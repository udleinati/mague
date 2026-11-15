# ADR 0019 - Formulários de criar/editar/assinar renderizam como `<dialog>` modal

## Contexto

Há forms de mutação que não justificam uma página própria: criar uma entidade a partir da listagem,
editar alguns campos, assinar, marcar como realizada. Precisam de uma apresentação única em todo o
panel: ou um `<details>` inline no topo da página, ou um `<dialog class="modal">` aberto por botão.

## Decisão

**Forms de criar/editar/assinar/marcar (operações modais sobre uma única entidade) renderizam sempre
como `<dialog class="modal">` aberto por um botão.** Não se usa `<details>` inline para este fim.

```vto
<button type="button" class="btn btn-sm btn-primary"
        onclick="document.getElementById('modal_X').showModal()">
  + Ação
</button>

<dialog id="modal_X" class="modal">
  <div class="modal-box max-w-2xl">
    <form method="dialog">
      <button class="btn btn-sm btn-circle btn-ghost absolute right-2 top-2">✕</button>
    </form>
    <h3 class="font-bold text-lg mb-1">Título da ação</h3>
    <p class="text-xs text-base-content/60 mb-4">Sub-texto opcional.</p>
    <form method="post" action="..." class="space-y-4">
      {{# campos... #}}
      <div class="flex justify-end gap-2 pt-4 border-t border-base-200">
        <button type="button" class="btn btn-sm btn-ghost"
                onclick="document.getElementById('modal_X').close()">Cancelar</button>
        <button type="submit" class="btn btn-sm btn-primary">Ação</button>
      </div>
    </form>
  </div>
  <form method="dialog" class="modal-backdrop"><button>close</button></form>
</dialog>
```

- Largura do `modal-box` conforme a densidade do form: de `max-w-md` a `max-w-2xl` (`max-w-4xl` só
  aparece nos modais de pré-visualização de email, que não são forms).
- Comboboxes dentro do modal: acrescentar `overflow-visible` ao `modal-box`, senão o dropdown é
  cortado.
- Rodapé: **Cancelar (`btn-ghost`) à esquerda, ação primária (`btn-primary`) à direita**.
- O botão fechar (`✕`) e o `modal-backdrop` são `<form method="dialog">`: o browser fecha o modal
  nativamente, pelo botão ou ao clicar fora.
- Um modal extenso pode viver num fragmento `_form_modal.vto` na pasta da página (ex.:
  `pages/units/_form_modal.vto`, incluído por `pages/units/list.vto`).

Os `<details>` com form de mutação em `pages/chart_of_accounts/list.vto` ("+ Nova conta") e
`pages/units/edit.vto` ("+ Associar ocupante existente") não são modelo: convertem-se quando se
mexer nessas páginas, sem conversão em massa.

## Exceções

- **Filtros e barras de pesquisa.** Não são forms de mutação.
- **Páginas em que editar é o próprio conteúdo.** Detalhe com edição inline
  (`pages/documents/show.vto`, `pages/pathology/show.vto`) e página de gestão
  (`pages/units/edit.vto`). Nestas entidades o modal serve só para criar.
- **Confirmações** de ações destrutivas seguem o [ADR 0013](./0013-confirm-modal-global.md).

## Consequências

- Consistência visual e de comportamento; acessibilidade do `<dialog>` nativo (foco, ESC, leitores
  de ecrã).
- As listagens ficam limpas: a ação é um botão pequeno, e o backdrop sinaliza que há um fluxo a
  concluir ou cancelar.
- Custo: cerca de 10 linhas extra de markup por modal.

## Alternativas rejeitadas

1. **`<details>` inline no topo da página.** Ocupa espaço vertical mesmo colapsado; o estado
   colapsado não é evidente; a largura fica presa à da página; quando a validação falha, o
   utilizador perde a posição de scroll na listagem.

## Sinais de alerta para code review

- Um `<details>` novo a envolver um `<form method="post">`.
- Combobox dentro de um `modal-box` sem `overflow-visible`.

## Referências

- [`pages/assembly/list.vto`](../../src/apps/panel/templates/pages/assembly/list.vto) - uso canónico
  (modal "Agendar nova assembleia").
- [`pages/occupants/show.vto`](../../src/apps/panel/templates/pages/occupants/show.vto) - modal com
  combobox e `overflow-visible`.
- [ADR 0022](./0022-list-action-icons.md) - botão "Editar" em listagens.
