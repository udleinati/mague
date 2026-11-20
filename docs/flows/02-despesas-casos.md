# Despesas do condomínio - casos detalhados

Catálogo de casos de despesa com o estado da charge, do movimento bancário e do ledger depois de
cada passo. As regras estão em [02 - despesas](./02-fluxo-despesas.md) e
[06 - conciliação](./06-fluxo-reconciliacao.md); aqui ficam só os números.

## Convenções

- Valores em cêntimos inteiros (10000 = 100,00 EUR). Todos os dados são inventados.
- Caminhos de API relativos a `/v1/admin/condominiums/:cid`.
- Fornecedor "Limpezas Teste", rubrica `6267` (limpeza), fração A, uma conta bancária.
- "Fatura" é uma charge `kind='payable'`, `nature='debit'`, `charge_type='supplier_service'`, criada
  com `POST /charges` e `amountCents = 10000`, salvo indicação em contrário. Nasce com
  `status='open'`, `original_amount = expected_amount = open_amount = 10000` e
  `amount = settled_amount = 0`.
- Colunas das tabelas de ledger: `entry_type`, conta a débito, conta a crédito, valor. Cada linha da
  tabela corresponde a duas linhas em `finance.ledger`.
- Um settlement é sempre criado com `POST /settlements` (ou por um endpoint que o cria
  internamente); os montantes e estados da charge e do movimento são atualizados nesse pedido.

## D01 - Fatura paga pelo valor exato

1. `POST /charges` cria a fatura de 10000.
2. O extrato traz a saída `amount = -10000`, descritivo "TRF FORNECEDOR TESTE": movimento
   `unreconciled`, sem ledger.
3. `POST /settlements` com `settlementType='bank_reconciliation'`, `debitChargeId`,
   `bankTransactionId` e `amount = 10000`.

| Depois do passo | `status` da charge | `amount` | `settled_amount` | `open_amount` | `status` do movimento |
| --------------- | ------------------ | -------: | ---------------: | ------------: | --------------------- |
| 1               | `open`             |        0 |                0 |         10000 | -                     |
| 2               | `open`             |        0 |                0 |         10000 | `unreconciled`        |
| 3               | `paid`             |    10000 |            10000 |             0 | `reconciled`          |

| Passo | `entry_type`          | Débito | Crédito | Valor |
| ----- | --------------------- | ------ | ------- | ----: |
| 1     | `charge_created`      | `6267` | `2211`  | 10000 |
| 3     | `bank_reconciliation` | `6267` | `121`   | 10000 |

A conta `6267` é debitada na criação e outra vez no pagamento, e a `2211` fica com o crédito da
criação (ver a nota sobre contas em [02 - despesas](./02-fluxo-despesas.md)).

Verificação: `fn_charge_ai` e `fn_settlement_ai` em
[004_trg_financial.sql](../../src/db/components/004_trg_financial.sql);
[api_admin_reconciliation_flows_test.ts](../../test_api/api_admin_reconciliation_flows_test.ts)
(cenário 1).

## D02 - Fatura com valor diferente do previsto

A fatura está registada por 10000 e o movimento é de `-11000`.

1. `POST /settlements` com `amount = 11000` é rejeitado: `400 VALIDATION_ERROR`, porque excede o
   `open_amount`.
2. `PATCH /charges/:chargeId` com `amountCents = 11000`.
3. `POST /settlements` com `amount = 11000`.

| Depois do passo | `status` da charge | `original_amount` | `amount` | `settled_amount` | `open_amount` | `status` do movimento |
| --------------- | ------------------ | ----------------: | -------: | ---------------: | ------------: | --------------------- |
| 2               | `open`             |             11000 |        0 |                0 |         11000 | `unreconciled`        |
| 3               | `paid`             |             11000 |    11000 |            11000 |             0 | `reconciled`          |

| Passo | `entry_type`             | Débito | Crédito | Valor |
| ----- | ------------------------ | ------ | ------- | ----: |
| 2     | `charge_amount_adjusted` | `6267` | `2211`  |  1000 |
| 3     | `bank_reconciliation`    | `6267` | `121`   | 11000 |

Se o movimento for de `-9000`, o passo 2 grava 9000 e lança a diferença ao contrário
(`charge_amount_adjusted`, débito `2211`, crédito `6267`, valor 1000). No painel os passos 2 e 3 são
o botão "Ajustar + Conciliar".

Verificação: [api_admin_charge_test.ts](../../test_api/api_admin_charge_test.ts) ("adjust+reconcile
flow"); [api_admin_bank_test.ts](../../test_api/api_admin_bank_test.ts) (settlement acima do
`open_amount`);
[0015_charge_amount_adjust_ledger.sql](../../test_sql/tests/0015_charge_amount_adjust_ledger.sql).

## D03 - Pagamento parcial

Fatura de 10000, movimento de `-8000`, um settlement de 8000.

| `status` da charge | `amount` | `settled_amount` | `open_amount` | `status` do movimento |
| ------------------ | -------: | ---------------: | ------------: | --------------------- |
| `partial`          |     8000 |             8000 |          2000 | `reconciled`          |

| `entry_type`          | Débito | Crédito | Valor |
| --------------------- | ------ | ------- | ----: |
| `bank_reconciliation` | `6267` | `121`   |  8000 |

Os 2000 ficam em aberto até outro settlement. Uma charge `partial` não pode ser editada nem
cancelada.

Verificação: `computeBankReconciliationTransition` em
[effects_math_test.ts](../../src/apps/api/modules/admin/settlement/effects_math_test.ts).

## D04 - Um movimento paga duas faturas

Fatura A de 6000, fatura B de 4000, um movimento de `-10000`.

| Settlement | Charge   | Valor | `status` da charge | `status` do movimento |
| ---------- | -------- | ----: | ------------------ | --------------------- |
| 1          | Fatura A |  6000 | `paid`             | `partial`             |
| 2          | Fatura B |  4000 | `paid`             | `reconciled`          |

| Settlement | `entry_type`          | Débito | Crédito | Valor |
| ---------- | --------------------- | ------ | ------- | ----: |
| 1          | `bank_reconciliation` | `6267` | `121`   |  6000 |
| 2          | `bank_reconciliation` | `6267` | `121`   |  4000 |

No painel selecionam-se as duas charges no separador "Fornecedor" e o controller cria os dois
settlements pela ordem da lista.

Verificação: `computeBankTxStatus` em
[effects_math_test.ts](../../src/apps/api/modules/admin/settlement/effects_math_test.ts);
[api_admin_bank_test.ts](../../test_api/api_admin_bank_test.ts) (movimento de saída `partial`).

## D05 - Uma fatura paga por dois movimentos

Fatura de 10000, movimento 1 de `-6000`, movimento 2 de `-4000`.

| Settlement | Movimento | Valor | `status` da charge | `amount` | `settled_amount` | `open_amount` | `status` do movimento |
| ---------- | --------- | ----: | ------------------ | -------: | ---------------: | ------------: | --------------------- |
| 1          | 1         |  6000 | `partial`          |     6000 |             6000 |          4000 | `reconciled`          |
| 2          | 2         |  4000 | `paid`             |    10000 |            10000 |             0 | `reconciled`          |

Cada settlement lança `bank_reconciliation` com débito `6267` e crédito `121` pelo seu valor.

Verificação: `computeBankReconciliationTransition` em
[effects_math_test.ts](../../src/apps/api/modules/admin/settlement/effects_math_test.ts);
[api_admin_ledger_invariants_test.ts](../../test_api/api_admin_ledger_invariants_test.ts) (sequência
`open`, `partial`, `paid` em três pagamentos).

## D06 - Saída sem despesa correspondente

Movimento de `-5000` sem charge em aberto que o explique. Fica `unreconciled`, sem ledger. Opções:

- registar a despesa (`POST /charges`) e conciliar como em D01;
- `POST /bank_transactions/:id/ignore`: o movimento passa a `ignored` (transferência entre contas,
  por exemplo). `POST /bank_transactions/:id/unignore` devolve-o a `unreconciled`.

Verificação:
[api_admin_reconciliation_flows_test.ts](../../test_api/api_admin_reconciliation_flows_test.ts)
(cenário 3).

## D07 - Fatura cancelada antes do pagamento

Fatura de 10000 em `open`, sem settlements. `POST /charges/:chargeId/cancel` com a justificação.

| `status` da charge | `original_amount` | `amount` | `settled_amount` | `open_amount` |
| ------------------ | ----------------: | -------: | ---------------: | ------------: |
| `cancelled`        |             10000 |        0 |                0 |             0 |

| Momento      | `entry_type`       | Débito | Crédito | Valor |
| ------------ | ------------------ | ------ | ------- | ----: |
| Criação      | `charge_created`   | `6267` | `2211`  | 10000 |
| Cancelamento | `charge_cancelled` | `2211` | `6267`  | 10000 |

As quatro linhas anulam-se conta a conta. Com um settlement ativo, o cancelamento devolve `409`.

Verificação: [api_admin_charge_cancel_test.ts](../../test_api/api_admin_charge_cancel_test.ts).

## D08 - Reverter uma conciliação

Ponto de partida: o fim de D01 (fatura `paid`, movimento `reconciled`).
`POST /bank_transactions/:id/reverse` com `reason` de pelo menos 10 caracteres.

| Entidade   | Depois da reversão                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------- |
| Movimento  | `status='reversed'`, `reversal_reason` preenchido.                                                                  |
| Settlement | `status='reversed'`.                                                                                                |
| Charge     | `amount = 0`, `settled_amount = 0`, `open_amount = 10000`; `status='open'`, ou `overdue` se o vencimento já passou. |

| `entry_type`          | Débito | Crédito | Valor |
| --------------------- | ------ | ------- | ----: |
| `settlement_reversed` | `121`  | `6267`  | 10000 |

O lançamento inverso tem a data corrente. O movimento pode ser conciliado de novo.

Verificação:
[api_admin_reconciliation_flows_test.ts](../../test_api/api_admin_reconciliation_flows_test.ts)
(cenários 1 e 2); `fn_settlement_au` em
[004_trg_financial.sql](../../src/db/components/004_trg_financial.sql).

## D09 - Refaturação a uma fração

Fatura de eletricidade de 10000 na rubrica `6241`. Parte do consumo, 4000, é da fração A.

1. `POST /charges/:chargeId/refacturations` com
   `{ allocations: [{ unitId: <fração A>, amountCents: 4000 }], dueDate: "2030-03-31" }`. A resposta
   traz `remaining_cents = 6000`.
2. A fração A paga: entrada de `+4000`, descritivo "TRF FRACAO A TESTE", conciliada com a
   refaturação.

Charge criada no passo 1:

| `kind`       | `nature` | `charge_type`   | `source_type`   | `source_id` | `account_id`      | `original_amount` | `open_amount` | `status` |
| ------------ | -------- | --------------- | --------------- | ----------- | ----------------- | ----------------: | ------------: | -------- |
| `receivable` | `debit`  | `refacturation` | `refacturation` | a fatura    | o mesmo da fatura |              4000 |          4000 | `open`   |

| Passo | `entry_type`          | Débito | Crédito | Valor |
| ----- | --------------------- | ------ | ------- | ----: |
| 1     | `charge_created`      | `2113` | `6241`  |  4000 |
| 2     | `bank_reconciliation` | `121`  | `2113`  |  4000 |

Depois do passo 2 a refaturação fica `paid` e o movimento `reconciled`. A fatura de origem não muda.
Pedir a seguir uma refaturação de 7000 sobre a mesma fatura devolve
`400 REFACTURATION_EXCEEDS_TOTAL` (disponível: 6000).

Verificação: [api_admin_charge_test.ts](../../test_api/api_admin_charge_test.ts)
(`createRefacturations`);
[0004_refacturation_constraint.sql](../../test_sql/tests/0004_refacturation_constraint.sql).

## D10 - Devolução do fornecedor

Ponto de partida: o fim de D01. O fornecedor devolve 2000: entrada de `+2000`, descritivo "TRF DE
FORNECEDOR TESTE". `POST /bank_transactions/:id/refund_supplier` com
`{ supplierId, sourceChargeId: <fatura>, amount: 2000 }`.

Charge criada:

| `kind`    | `nature` | `source_type`     | `original_amount` | `amount` | `settled_amount` | `open_amount` | `status` |
| --------- | -------- | ----------------- | ----------------: | -------: | ---------------: | ------------: | -------- |
| `payable` | `credit` | `supplier_refund` |              2000 |     2000 |             2000 |             0 | `paid`   |

| `entry_type`          | Débito | Crédito | Valor |
| --------------------- | ------ | ------- | ----: |
| `bank_reconciliation` | `121`  | `6267`  |  2000 |

A criação da charge de crédito não lança nada; o único lançamento é o do settlement. O movimento
fica `reconciled` e a fatura de origem não muda.

Verificação:
[api_admin_bank_transaction_refund_supplier_test.ts](../../test_api/api_admin_bank_transaction_refund_supplier_test.ts).

## D11 - Nota de crédito sem movimento bancário

Fatura de 10000 em `open`. O fornecedor emite uma nota de crédito de 3000 antes do pagamento.

1. `POST /charges` com `kind='payable'`, `nature='credit'`, o mesmo fornecedor e rubrica,
   `amountCents = 3000`. Sem ledger.
2. `POST /settlements` com `settlementType='charge_offset'`, `debitChargeId` = fatura,
   `creditChargeId` = nota, `amount = 3000`.
3. Movimento de `-7000`; `POST /settlements` com `bank_reconciliation` e `amount = 7000`.

| Depois do passo | Fatura: `status` | Fatura: `amount` | Fatura: `settled_amount` | Fatura: `open_amount` | Nota: `status` | Nota: `open_amount` |
| --------------- | ---------------- | ---------------: | -----------------------: | --------------------: | -------------- | ------------------: |
| 1               | `open`           |                0 |                        0 |                 10000 | `open`         |                3000 |
| 2               | `partial`        |                0 |                     3000 |                  7000 | `paid`         |                   0 |
| 3               | `paid`           |             7000 |                    10000 |                     0 | `paid`         |                   0 |

| Passo | `entry_type`          | Débito | Crédito | Valor |
| ----- | --------------------- | ------ | ------- | ----: |
| 2     | `settlement_applied`  | `6267` | `6267`  |  3000 |
| 3     | `bank_reconciliation` | `6267` | `121`   |  7000 |

Verificação: regras de `charge_offset` em
[validate_test.ts](../../src/apps/api/modules/admin/settlement/validate_test.ts);
`computeOffsetSideTransition` em
[effects_math_test.ts](../../src/apps/api/modules/admin/settlement/effects_math_test.ts);
`fn_settlement_ai` em [004_trg_financial.sql](../../src/db/components/004_trg_financial.sql). Não há
teste de API para este caso em payables.
