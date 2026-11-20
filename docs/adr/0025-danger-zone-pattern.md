# ADR 0025 - Zona perigosa: bloco único para ações destrutivas irreversíveis

## Contexto

Uma ação irreversível sobre uma entidade (eliminar, cancelar) não pode estar ao alcance de um clique
acidental nem variar de página para página. Um botão no cabeçalho está sempre debaixo do cursor; um
bloco escrito à mão em cada página diverge no texto, na estrutura e no nível de proteção.

## Decisão

Ações destrutivas irreversíveis sobre a entidade de uma página de detalhe ou de edição usam o
partial [`partials/danger_zone.vto`](../../src/apps/panel/templates/partials/danger_zone.vto), no
fim do conteúdo da página. O partial combina três guards, por ordem crescente de intenção.

### Guard 1 - `<details>` colapsado no fim da página

O bloco é um `<details data-danger-zone>` fechado, com o `<summary>` "Zona perigosa" em cinzento
discreto. Para chegar ao botão é preciso fazer scroll até ao fim e expandir o bloco.

- O chevron do summary roda com `group-open:rotate-90`. O triângulo nativo é suprimido por
  `summary.list-none::-webkit-details-marker { display: none }`, no `<style>` dos dois layouts.
- Aberto, o contentor é neutro; o vermelho fica só na etiqueta "Irreversível", no ícone e no botão
  (`btn btn-sm btn-error` com ícone). Ordem: etiqueta, título "`<verbo> <entityName>`",
  `confirmBody`, botão.

### Guard 2 - Atribuição ao utilizador autenticado (no modal)

O form do partial declara `data-confirm-danger="true"`, o que põe o modal de confirmação global
([ADR 0013](./0013-confirm-modal-global.md)) em modo danger:

1. Ícone circular vermelho no cabeçalho do modal.
2. Linha "Executado por `<email>`", renderizada pelo layout a partir de `currentUser.email`; o JS só
   alterna a visibilidade.
3. Botões "Eliminar / Cancelar" por omissão em vez de "Sim / Não", com o OK em `btn-error`. O
   partial define o texto do OK como "`<verbo> <entityName>`".

A atribuição lembra que a ação não é anónima: fica registada nas audit columns (`deleted_by`,
[ADR 0011](./0011-actor-snapshot-convention.md)). Vive no modal e não na página porque é no último
passo, ao escrever a palavra, que é lida; antes disso é ruído.

Confirmações sem `danger` nem typed-match não mostram nenhum destes elementos.

### Guard 3 - Typed-match no modal

O form declara `data-confirm-typed-match`: o modal pede "Para confirmar, escreve ELIMINAR" e só
submete com a palavra exata (sensível a maiúsculas). O campo é um `<input type="text">` de uma
linha; o `<textarea>` do modal fica reservado ao pedido de razão livre (`data-confirm-prompt`). A
palavra é um único token e um textarea sugeria que se espera mais texto.

### Palavra canónica

Eliminações usam sempre **ELIMINAR** (PT-PT, maiúsculas), nunca "APAGAR" nem "DELETE": é o verbo dos
botões e do título do modal. Quando a ação irreversível não é uma eliminação, a palavra acompanha o
verbo: os cancelamentos (cobrança, assembleia) passam `actionVerb: "Cancelar"`,
`typedWord: "CANCELAR"` e `dangerIcon: "ban"`.

### Como adotar

No fim do template da página (antes do `{{ /layout }}` do layout):

```vto
{{ include "partials/danger_zone.vto" {
  entityName: "documento",
  entityLabel: document.title,
  actionUrl: "/admin/c/" + currentCondominiumId + "/documents/" + document.id + "/delete",
  confirmBody: "Apaga o documento " + document.title + " e os anexos associados.",
  currentUser,
} }}
```

- `entityName` - singular em minúsculas ("fração", "patologia", "ocorrência").
- `entityLabel` - identificador humano (entity code, designação, título). Aparece no título do
  modal.
- `actionUrl` - URL do POST (`/:id/delete` ou `/:id/cancel`).
- `confirmBody` - uma frase curta com a consequência. Aparece no bloco expandido e no modal, onde o
  partial lhe acrescenta " Não é reversível.". Se precisa de mais de uma frase, falta contexto na
  página ou a operação não é mesmo destrutiva.
- `extraNote` - segundo parágrafo opcional. Evitar.
- `actionVerb`, `typedWord`, `dangerIcon` - opcionais; por omissão "Eliminar", "ELIMINAR" e
  `"trash"`.
- `currentUser` - todos os chamadores o passam, mas o partial não o lê: a linha de atribuição vem do
  `currentUser` que o `render()` injeta no layout.
- `dialogId` - opcional, para a ação que pede justificação. O modal global tem um só campo (a
  palavra ou a razão), por isso o botão abre um `<dialog>` próprio com a justificação, a lista do
  que se desfaz, a linha "Executado por" e o typed-match, como o de reverter uma conciliação
  (`reconciliation/_reverse_modal.vto`). Uso: cancelar cobrança (`charges/_cancel_modal.vto`).

Em páginas cujo corpo é trocado por HTMX, o include fica no template exterior, fora do alvo do swap
(ex.: `ticket/show.vto`, não `ticket/_ticket_body.vto`).

## Exceções

Ficam fora da Zona perigosa, com os atributos `data-confirm-*` no próprio form
([ADR 0013](./0013-confirm-modal-global.md)):

- **Operações reversíveis** (ex.: desativar uma inspeção): botão direto + confirmação simples.
- **Sub-itens da entidade** (anexos, comentários, linhas de orçamento, presenças de assembleia):
  `data-confirm-danger="true"`, sem typed-match nem `<details>`.
- **Eliminação a partir de uma linha de listagem**, em entidades sem bloco próprio na página de
  detalhe (fornecedores, modelos recorrentes, orçamentos): `data-confirm-danger="true"`. A linha de
  apólice em `insurance/_rows.vto` acrescenta typed-match "ELIMINAR".

O typed-match fora da Zona perigosa é uma funcionalidade geral do modal: a palavra nomeia a ação
(ex.: "CONFIRMO" ao repor uma password). A regra da palavra canónica só obriga as eliminações.

## Consequências

- Um padrão visual único: aprende-se uma vez e reconhece-se em todas as entidades.
- Triplo guard contra cliques acidentais; mudar o texto, o ícone ou a cor é editar um ficheiro.
- Eliminar custa três cliques e uma palavra escrita. É intencional: o padrão é para ações
  irreversíveis, não para operações correntes.

## Alternativas rejeitadas

1. **Botão direto + modal, sem `<details>`.** Perde o guard "sair do fluxo normal da página".
2. **Checkbox "Compreendo que é irreversível"** em vez de typed-match. Menos fricção, mas marca-se
   sem ler.
3. **Reautenticação (password) antes de eliminar.** Hostil para o utilizador legítimo, para um
   cenário (sessão esquecida aberta) que o idle-TTL já limita
   ([ADR 0020](./0020-session-idle-ttl-and-user-active-flag.md)). A linha de atribuição é o
   meio-termo: avisa sem bloquear.
4. **Typed-match opcional por chamador.** Um padrão uniforme elimina a ambiguidade na revisão: todas
   as zonas perigosas pedem a palavra.

## Sinais de alerta para code review

- Form de eliminar ou cancelar a entidade no cabeçalho de uma página de detalhe. → mover para o
  partial.
- `<details>` "Zona perigosa" escrito à mão. → usar o partial.
- Typed-match de uma eliminação com palavra diferente de "ELIMINAR", ou `typedWord` que não
  corresponde ao `actionVerb`. → alinhar.
- Include do partial dentro de um fragmento que é alvo de swap HTMX. → mover para o template
  exterior.

## Referências

- [`partials/danger_zone.vto`](../../src/apps/panel/templates/partials/danger_zone.vto) - partial
  canónico.
- [`pages/documents/show.vto`](../../src/apps/panel/templates/pages/documents/show.vto) -
  eliminação; [`pages/charges/show.vto`](../../src/apps/panel/templates/pages/charges/show.vto) -
  cancelamento.
- [`layouts/admin.vto`](../../src/apps/panel/templates/layouts/admin.vto) - modal de confirmação
  (modo danger, atribuição, typed-match).
- [ADR 0011](./0011-actor-snapshot-convention.md) - audit columns que recebem o snapshot do ator.
- [ADR 0013](./0013-confirm-modal-global.md) - modal de confirmação e atributos `data-confirm-*`.
- [ADR 0021](./0021-s3-delete-before-db.md) - ordem S3 antes da BD ao eliminar entidades com anexos
  (lado do servidor).
