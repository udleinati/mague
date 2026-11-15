# ADR 0037 - Estado efetivo da charge: fonte única da regra do "Vencido"

## Contexto

`finance.charge.status` é gravado na criação e atualizado por settlements (`open` -> `partial` ->
`paid`), mas **não é recalculado com o passar do tempo**. O valor `overdue` gravado mente nos dois
sentidos: uma charge criada `open` que entretanto venceu continua `open`; uma criada `overdue` que a
conciliação ainda não cobre não devia ser acusada.

A regra correta é a da view `finance.v_unit_balance`:

> Uma charge está **vencida** quando tem saldo aberto E `due_date <= reconciledThroughDate` E a data
> de conciliação (cutoff) está definida. Sem cutoff, **nada** é vencido: não se acusa atraso sem a
> administração afirmar até onde conciliou (a quota pode já estar paga no banco sem o sistema
> saber).

Admin e portal mostram a mesma charge. Se cada ecrã decidir o "Vencido" à sua maneira, mostram
estados diferentes e o badge contradiz o KPI "Em atraso", que segue o cutoff através da view.

## Decisão

### A regra vive em TypeScript: `$panel/libs/charge_status.ts`

- `isChargeOverdue(c, cutoff): boolean` - a regra canónica.
- `chargeStatusBadge(c, cutoff, opts?): { label, tone }` - estado efetivo pronto para
  `partials/status_badge.vto` ou para o param `status` do `page_header.vto`. Precedência: `paid` ->
  `cancelled` -> vencida (regra) -> `partial` -> aberta. `opts.paidLabel` / `opts.openLabel` cobrem
  o contexto de créditos ("Aplicado" / "Por aplicar").

Ambos são **globais de template**, injetados em `render.ts`: qualquer `.vto` os chama diretamente,
sem import nem duplicação.

### Os templates consomem, nunca reimplementam

- `partials/charge_status.vto` recebe `{ c, cutoff, size? }` e delega no helper e em
  `status_badge.vto`.
- O `cutoff` é sempre `condominium.reconciledThroughDate`.
- Usam a regra: o header de `charges/show.vto`, a coluna de estado e o contador de vencidas de
  `charges/_list_fragment.vto`, a tabela de cobranças de `units/show.vto` e, no portal, os
  contadores e a lista de `portal/charges.vto`.

### Usos legítimos do status gravado (não mudar)

- **Gates de editabilidade**: `canEdit = status IN (open, overdue) && settledAmount == 0`
  (`charges/show.vto`). O `overdue` gravado é um estado não liquidado válido para permitir edição.
- **Filtros server-side**: o filtro "Vencido" da listagem (`?status=overdue`) filtra pelo status
  gravado na API.
- `paid`, `partial` e `cancelled` gravados são fiáveis: são atualizados por settlements e pelo
  cancelamento.

## Consequências

- Portal e admin mostram o mesmo estado para a mesma charge, e o badge é coerente com o KPI "Em
  atraso".
- A regra é testável em TS puro; um erro corrige-se num só sítio.
- Charges de um condomínio sem data de conciliação nunca aparecem como vencidas, mesmo com
  `status = 'overdue'` gravado. É deliberado.
- **Limitação conhecida**: o filtro "Vencido" da listagem pode devolver um conjunto diferente do que
  o badge mostra. Corrigir exige levar a regra para a query da API.
- Helpers injetados como globais de template aumentam a "API implícita" dos `.vto`; o comentário no
  ponto de injeção em `render.ts` documenta-os.

## Sinais de alerta para code review

- `c.status === "overdue"` num template para **display**. Usar `chargeStatusBadge` /
  `isChargeOverdue`, ou o partial `charge_status.vto`.
- Reimplementação inline da regra do cutoff. Chamar o helper.

## Referências

- [`charge_status.ts`](../../src/apps/panel/libs/charge_status.ts) - implementação;
  [`charge_status_test.ts`](../../src/apps/panel/libs/charge_status_test.ts) - testes, incluindo o
  wiring template -> helper.
- [`charge_status.vto`](../../src/apps/panel/templates/partials/charge_status.vto) - partial.
- `finance.v_unit_balance` em
  [`016_vw_receipt_pending.sql`](../../src/db/components/016_vw_receipt_pending.sql) - a mesma regra
  em SQL.
- [ADR 0036](./0036-page-header-canonical.md) - `page_header` / `status_badge`.
