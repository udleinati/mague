# 07 - Fluxo de imputação por fração / fornecedor

Imputação é o algoritmo que distribui o valor por conciliar de um movimento bancário pelas charges
em aberto de uma fração ou de um fornecedor, seguindo a ordem legal de prioridade (Art. 784.º CC). O
administrador escolhe só o destino; o sistema cria os settlements necessários num único ato. É a
alternativa à conciliação manual, charge a charge, descrita em
[06-fluxo-reconciliacao.md](./06-fluxo-reconciliacao.md). Vocabulário em
[CONTEXT.md](../../CONTEXT.md); na API os endpoints usam o termo `allocate`.

## Modelo

- **`finance.bank_transaction`** - `amount` com sinal (positivo é entrada, negativo é saída),
  `transaction_date`, `status` (`unreconciled` | `partial` | `reconciled` | `ignored` | `reversed`),
  `reversal_reason`.
- **`finance.charge`** - candidatas à imputação: `nature='debit'`, `status` em
  `open`/`partial`/`overdue` e `open_amount > 0`. Para fração: `unit_id` e `kind='receivable'`. Para
  fornecedor: `supplier_id` e `kind='payable'`.
- **`finance.settlement`** - a imputação produz um `bank_reconciliation` por charge tocada
  (`debit_charge_id`, `bank_transaction_id`, `settlement_date` igual à data do movimento). O
  excedente de uma fração produz um `bank_deposit_credit` contra uma charge `credit_balance` nova.
- **`finance.ledger`** - escrito por `finance.fn_settlement_ai`
  ([`004_trg_financial.sql`](../../src/db/components/004_trg_financial.sql)).

Todos os montantes são `integer` em cêntimos.

## Ordem de prioridade

Definida em `priorityGroup` e `sortChargesByPriority`
([`plan.ts`](../../src/apps/api/modules/admin/allocation/plan.ts)).

| Grupo | Fração                                          | Fornecedor           |
| ----- | ----------------------------------------------- | -------------------- |
| 1     | `charge_type='interest'`                        | vencidas ou parciais |
| 2     | vencidas ou parciais                            | restantes            |
| 3     | `quota` e `extraordinary_quota` dentro do prazo |                      |
| 4     | `refacturation`                                 |                      |
| 5     | restantes                                       |                      |

- "Vencida ou parcial" é `status` `partial` ou `overdue`, ou `due_date` anterior a hoje.
- Na fração, os juros vêm sempre primeiro e o grupo 2 prevalece sobre o tipo: uma refaturação
  vencida é paga antes de uma quota dentro do prazo.
- Dentro de cada grupo, por ordem ascendente com nulos no fim: fração - `competence_period`,
  `due_date`, `created_at`; fornecedor - `competence_period`, `issue_date`, `due_date`,
  `created_at`.
- `chargeTypes` (opcional, só para fração) é uma lista de `charge_type` elegíveis, aplicada antes da
  ordenação. O Panel usa-a para imputar só quotas ordinárias ou só extraordinárias.

Esta ordem é distinta da ordem do offset automático de créditos (`applyAutoOffset`); as duas não
devem ser fundidas - ver [ADR 0035](../adr/0035-auto-offset-ordering-distinct-from-allocation.md).

## Fluxo

Rotas da API sob `/v1/admin/condominiums/:cid`, em
[`bank_transaction/allocate.ts`](../../src/apps/api/modules/admin/bank_transaction/allocate.ts):

| Rota                                               | Corpo / query                      |
| -------------------------------------------------- | ---------------------------------- |
| `POST /bank_transactions/:id/allocate_to_unit`     | `{ unitId, notes?, chargeTypes? }` |
| `POST /bank_transactions/:id/allocate_to_supplier` | `{ supplierId, notes? }`           |
| `GET /bank_transactions/:id/allocation_preview`    | `?unitId=...&chargeTypes=a,b`      |

A imputação é sempre uma ação explícita do administrador, feita no ecrã
`/admin/c/:cid/reconciliation`; a importação do extrato não imputa nada. Quando o pagador indica a
que charge se refere o pagamento, usa-se a conciliação manual (`POST /settlements`).

```
executeAllocation  (allocation/execute.ts)
  1. loadAndValidate    movimento, destino e soma já conciliada do movimento
  2. loadOpenCharges    charges candidatas do destino
  3. planAllocation     função pura (allocation/plan.ts) -> { entries, surplus }
  4. transação
       applyPlanEntries                um bank_reconciliation por entry
       createCreditBalanceForSurplus   só fração, com surplus > 0
```

1. **Validação** - o movimento tem de pertencer ao condomínio do path (404). Fração exige
   `amount >
   0` e fornecedor exige `amount < 0` (400 `WRONG_SIGN`). Um movimento `ignored` é
   recusado (400). A fração tem de existir no condomínio (404) e ter `is_active = true` (400); o
   fornecedor tem de existir no condomínio (404).
2. **Valor a distribuir** - `ABS(amount)` menos a soma dos settlements ativos do movimento. Um
   movimento parcialmente conciliado pode por isso ser imputado sem duplicar.
3. **Plano** - `planAllocation` percorre as charges pela ordem de prioridade e atribui a cada uma
   `MIN(valor restante, open_amount)`, até esgotar o valor. O que sobra é o `surplus`.
4. **Execução** - os passos 1 a 3 correm fora da transação, por isso, para cada entry,
   `applyPlanEntries` relê o `open_amount` (salta a charge se já for zero) e cria o settlement por
   `createSettlementInTx`
   ([`settlement/operation.ts`](../../src/apps/api/modules/admin/settlement/operation.ts)) com
   `MIN(entry, open_amount atual, valor restante)`. Esse núcleo valida com `SELECT ... FOR UPDATE`,
   insere o settlement (o trigger emite o ledger) e chama `applySettlementEffects`, que atualiza
   `settled_amount`, `amount`, `open_amount` e `status` da charge e o `status` do movimento.
5. **Excedente** - para fração, `createCreditBalanceForSurplus` insere uma charge `credit_balance`
   (`kind='receivable'`, `nature='credit'`, `status='open'`, `source_type='bank_transaction'`,
   `competence_period` no dia 1 do mês do movimento) e um settlement `bank_deposit_credit` do mesmo
   valor. Para fornecedor não é criada nenhuma charge: o excedente fica por conciliar.

A pré-visualização (`previewAllocation`,
[`preview.ts`](../../src/apps/api/modules/admin/allocation/preview.ts)) corre os passos 1 a 3 sem
escrever nada, com as mesmas funções da execução. Existe só para fração.

Ledger emitido por `finance.fn_settlement_ai`:

```
bank_reconciliation, entrada   Dr 121 (+ Dr 122 pela parte FCR) / Cr conta da charge
bank_reconciliation, saída     Dr conta da charge / Cr 121
bank_deposit_credit            Dr 121 / Cr 2782
```

A inserção da charge `credit_balance` não lança ledger (`finance.fn_charge_ai` só lança charges de
débito). A divisão ordinária/FCR das quotas está em [01-fluxo-quotas.md](./01-fluxo-quotas.md).

Depois de uma imputação a uma fração, o par (movimento, fração) entra na fila de recibos
(`finance.vw_pending_receipts`); a emissão é um passo separado - ver
[01-fluxo-quotas.md](./01-fluxo-quotas.md), secção Recibo.

## Exemplo

Fração A, hoje é dia 20 de Maio. Charges em aberto:

| Charge        | `charge_type`   | `open_amount` | Situação               | Grupo |
| ------------- | --------------- | ------------- | ---------------------- | ----- |
| Juros de mora | `interest`      | 500           | vence em Junho         | 1     |
| Quota Março   | `quota`         | 11 000        | `overdue`              | 2     |
| Quota Abril   | `quota`         | 11 000        | `overdue`              | 2     |
| Quota Maio    | `quota`         | 11 000        | `open`, vence em Junho | 3     |
| Refaturação   | `refacturation` | 3 000         | `open`, vence em Junho | 4     |

Movimento de +25 000 (250,00 EUR) - quatro settlements `bank_reconciliation`:

| Ordem | Charge        | Valor  | Resultado                      |
| ----- | ------------- | ------ | ------------------------------ |
| 1     | Juros de mora | 500    | `paid`                         |
| 2     | Quota Março   | 11 000 | `paid`                         |
| 3     | Quota Abril   | 11 000 | `paid`                         |
| 4     | Quota Maio    | 2 500  | `partial`, `open_amount` 8 500 |

A refaturação não é tocada, não há excedente e o movimento fica `reconciled`.

Movimento de +40 000 (400,00 EUR) - as cinco charges ficam `paid` (36 500) e os 3 500 restantes dão
uma charge `credit_balance` de 3 500 e um settlement `bank_deposit_credit` de 3 500. O movimento
fica `reconciled`.

## Estorno bancário

`POST /bank_transactions/:id/reverse` com `{ reason }` (10 a 500 caracteres), em
[`bank_transaction/reverse.ts`](../../src/apps/api/modules/admin/bank_transaction/reverse.ts). Só
aceita movimentos `reconciled` ou `partial` (409 nos outros casos). Numa única transação:

1. o movimento passa a `status='reversed'` com `reversal_reason`;
2. cada settlement ativo do movimento é revertido por `reverseSettlement`: fica `status='reversed'`
   com `reversed_at` e `reversal_reason`, o trigger `finance.fn_settlement_au` lança o ledger
   inverso (`entry_type='settlement_reversed'`, com a data do dia) e `applyReverseEffects` repõe
   `settled_amount`, `amount`, `open_amount` e `status` da charge;
3. num `bank_deposit_credit`, a charge `credit_balance` é cancelada. Se esse crédito já tiver sido
   consumido por um `charge_offset` ativo, o estorno inteiro é recusado (409 `RESTRICT_VIOLATION`);
4. os recibos não anulados do movimento são anulados com `voided_reason='bank_tx_reversed'`. Os PDF
   são regenerados com a tarja "ANULADO" depois da transação.

O movimento mantém-se `reversed`. Pode voltar a ser imputado: os novos settlements põem-no outra vez
em `reconciled` ou `partial`.

## Invariantes

- A soma dos settlements ativos de um movimento nunca excede `ABS(amount)`, e nenhum settlement
  excede o `open_amount` da charge: `createSettlementInTx` valida ambos com as linhas bloqueadas.
- A pré-visualização e a execução usam a mesma elegibilidade, a mesma ordem e o mesmo filtro
  (`eligibleSortedCharges` e `planAllocation`).
- O excedente de um fornecedor nunca cria charges.
- Todos os settlements passam por `createSettlementInTx`; nenhum código insere em
  `finance.settlement` por outro caminho ([ADR 0001](../adr/0001-financial-cascade-split.md)).

## Casos limite

- **Fração sem charges em aberto** - todo o valor vira `credit_balance`.
- **Fornecedor sem charges em aberto** - 400 `NO_OPEN_CHARGES`.
- **Fornecedor com valor acima das charges em aberto** - as charges ficam pagas, o resto fica por
  conciliar e o movimento fica `partial`.
- **Movimento já totalmente conciliado** - plano vazio, nenhuma escrita.
- **Filtro `chargeTypes` sem charges elegíveis** - o valor vira `credit_balance`, mesmo havendo
  outras charges em aberto na fração.
- **Crédito criado pela imputação** - não gera offset contra débitos já existentes (a imputação não
  chama `applyAutoOffset`); é consumido quando nascer uma nova charge de débito da fração (ver
  [01-fluxo-quotas.md](./01-fluxo-quotas.md)).
- **Fração eliminada** - a validação verifica `is_active` e não `core.unit.deleted_at`.
- **Fornecedor** - só é verificada a existência no condomínio.

## Limites conhecidos

- Não há rota para reverter um settlement isolado: a reversão é sempre a do movimento bancário
  inteiro. Um `charge_offset` não pode ser revertido pela API, pelo que um depósito cujo crédito já
  foi consumido por um offset não pode ser estornado.
- O sistema não gera juros de mora: o grupo 1 só tem charges criadas com `charge_type='interest'`.

## Referências

- [CONTEXT.md](../../CONTEXT.md) - imputação, settlement, offset, conciliação, bank reversal.
- [ADR 0001](../adr/0001-financial-cascade-split.md) - triggers emitem ledger, TypeScript faz o
  resto.
- [ADR 0035](../adr/0035-auto-offset-ordering-distinct-from-allocation.md) - imputação e offset têm
  ordens distintas.
- Fluxos relacionados: [00 - visão geral](./00-overview-entradas-saidas.md),
  [01 - quotas](./01-fluxo-quotas.md), [06 - conciliação](./06-fluxo-reconciliacao.md).
- Código: [`allocation/`](../../src/apps/api/modules/admin/allocation/),
  [`settlement/`](../../src/apps/api/modules/admin/settlement/),
  [`bank_transaction/`](../../src/apps/api/modules/admin/bank_transaction/).
- Testes: `src/apps/api/modules/admin/allocation/plan_test.ts`,
  `src/apps/api/modules/admin/settlement/effects_math_test.ts`,
  `test_api/api_admin_allocation_priority_test.ts`, `test_api/api_admin_bank_reverse_test.ts`,
  `test_api/api_admin_reconciliation_flows_test.ts`.
