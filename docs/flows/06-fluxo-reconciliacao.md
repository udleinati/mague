# 06 - Fluxo de conciliação bancária

Como um movimento bancário entra no sistema e é ligado a charges. Conciliar é criar settlements para
um movimento pendente; é o settlement, e não o movimento, que lança no ledger. A imputação
automática por fração ou fornecedor está em [07-fluxo-imputacao.md](./07-fluxo-imputacao.md), as
despesas em [02-fluxo-despesas.md](./02-fluxo-despesas.md) e as quotas em
[01-fluxo-quotas.md](./01-fluxo-quotas.md).

Caminhos de API relativos a `/v1/admin/condominiums/:cid`; ficheiros TypeScript relativos a
`src/apps/api/modules/admin/`; valores em cêntimos inteiros.

## Modelo

**`finance.bank_transaction`** é um movimento de um `finance.bank_account` (`kind` `bank` ou
`cash`). `amount` tem sinal: positivo = entrada, negativo = saída. `import_hash` deduplica
importações (nulo nos movimentos manuais) e `import_batch_id` aponta para o lote em
`finance.bank_import_batch`. As colunas `match_status`, `match_unit_ids`, `match_expense_ids`,
`is_reconciled`, `operation_date` e `reversed_by_transaction_id` existem mas nenhum handler as
escreve.

| `status`       | Significado                                                                 | Como se chega                                     |
| -------------- | --------------------------------------------------------------------------- | ------------------------------------------------- |
| `unreconciled` | Sem settlements ativos.                                                     | Estado inicial; `unignore`.                       |
| `partial`      | Soma dos settlements ativos maior que zero e abaixo de `abs(amount)`.       | Settlement.                                       |
| `reconciled`   | Soma dos settlements ativos cobre `abs(amount)`.                            | Settlement.                                       |
| `ignored`      | Não conciliável (transferência entre contas).                               | `ignore`, só a partir de `unreconciled`.          |
| `reversed`     | Conciliação anulada. Um novo settlement leva-o a `partial` ou `reconciled`. | `reverse`, a partir de `partial` ou `reconciled`. |

A regra está em `computeBankTxStatus`
([settlement/effects_math.ts](../../src/apps/api/modules/admin/settlement/effects_math.ts)).

**`finance.settlement`** liga duas pontas; o CHECK `settlement_credit_check` fixa as combinações:

| `settlement_type`     | Pontas                                                                   | Uso                                                           |
| --------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `bank_reconciliation` | `bank_transaction_id` + uma só de `debit_charge_id` / `credit_charge_id` | Recebimento ou pagamento; com charge de crédito, devolução.   |
| `charge_offset`       | `debit_charge_id` + `credit_charge_id`, sem movimento                    | Compensação entre uma charge de crédito e uma de débito.      |
| `bank_deposit_credit` | `bank_transaction_id` + `credit_charge_id`                               | Excedente de uma imputação por fração, guardado como crédito. |

`amount > 0`; `status` é `active` ou `reversed`. A API não edita nem elimina settlements. Um
movimento pode ter vários settlements (paga várias charges) e uma charge também (é paga por vários
movimentos).

## Fluxo

### 1. Entrada de movimentos

Importação de extrato, em dois passos, na página da conta (`/admin/c/:cid/bank-accounts/:id`):

1. `POST /bank-accounts/:bankAccountId/import/preview` (multipart, campo `file`): lê o XLSX com
   [libs/bank_import/novo_banco.ts](../../src/apps/api/libs/bank_import/novo_banco.ts) e devolve as
   linhas com `import_hash` e `is_duplicate`. Não grava nada.
2. `POST /bank-accounts/:bankAccountId/import/commit` com `{ rows, filename? }`: recalcula os
   hashes, exclui os que já existem na conta e insere, numa transação, um `bank_import_batch` e os
   movimentos novos (`unreconciled`). Sem linhas novas não cria lote.

O hash é o SHA-256 de `bank_account_id|transaction_date|amount|description|balance_after`, com `-`
no lugar de um saldo nulo ([libs/bank_import/hash.ts](../../src/apps/api/libs/bank_import/hash.ts));
o saldo distingue dois movimentos iguais no mesmo dia. A constraint `bank_tx_import_hash_unique`
(`bank_account_id`, `import_hash`) é a garantia na base de dados.

Registo manual, o caminho das contas `cash`: `POST /bank_transactions` com `bankAccountId`,
`transactionDate` e `amount` com sinal. Nenhum dos dois caminhos lança no ledger nem cria
settlements.

### 2. Sugestões por palavras-chave

Com `?withSuggestions=1`, `GET /bank_transactions` compara o descritivo de cada entrada com
`core.unit.match_keywords` e o de cada saída com `core.supplier.match_keywords`
([match_keywords.ts](../../src/shared/match_keywords.ts)): há correspondência quando uma
palavra-chave é substring do descritivo, ambos em minúsculas e sem acentos. Uma só correspondência
devolve `suggestedUnitId` ou `suggestedSupplierId`; várias devolvem `matchConflictCount`. A sugestão
é calculada na leitura, não é gravada e só pré-seleciona a fração ou o fornecedor no modal. Exemplo:
a palavra-chave `fracao a teste` sugere a fração A para a entrada "TRF FRACAO A TESTE".

### 3. Conciliar

Na página `/admin/c/:cid/reconciliation`, uma entrada pode ser imputada a uma fração (fluxo 07),
registada como devolução de fornecedor (fluxo 02) ou conciliada com charges receivable escolhidas à
mão; uma saída é conciliada com charges payable escolhidas à mão. Na escolha manual, o controller
([controllers/reconciliation.ts](../../src/apps/panel/controllers/reconciliation.ts)) cria um
settlement por charge, pela ordem da lista, cada um com `min(open_amount, valor por alocar)`, em
pedidos separados: se um falhar, os anteriores mantêm-se.

Todos os caminhos acabam em `createSettlementInTx`
([settlement/operation.ts](../../src/apps/api/modules/admin/settlement/operation.ts)):

```
POST /settlements   |  imputação  |  devolução  |  auto-offset
                           |
                           v
createSettlementInTx (TypeScript, uma transação)
  1. validação
       - SELECT ... FOR UPDATE das charges e do movimento, filtrados pelo condomínio
       - validateSettlement (settlement/validate.ts)
  2. INSERT finance.settlement
       - trg_settlement_bi   validações mínimas (rede de segurança)       trigger
       - trg_settlement_ai   INSERT finance.ledger                        trigger
  3. applySettlementEffects (settlement/effects.ts)
       - UPDATE finance.charge: settled_amount, open_amount, amount, status
       - UPDATE finance.bank_transaction.status
```

`POST /settlements` aceita `bank_reconciliation` e `charge_offset`; `bank_deposit_credit` só é
criado pela imputação. `validateSettlement` exige `amount > 0`, as pontas certas para o tipo,
`amount` até ao `open_amount` de cada charge (em `bank_reconciliation` e `charge_offset`) e até ao
valor por alocar do movimento, que é `abs(amount)` menos a soma dos settlements ativos; as falhas
devolvem `400 VALIDATION_ERROR`. Charges ou movimento de outro condomínio contam como inexistentes
(`404 NOT_FOUND`).

Lançamentos de `fn_settlement_ai`
([004_trg_financial.sql](../../src/db/components/004_trg_financial.sql)); "conta da charge" é o
resultado de `finance.fn_charge_account`:

| Settlement                     | `entry_type`          | Débito                     | Crédito                    |
| ------------------------------ | --------------------- | -------------------------- | -------------------------- |
| `bank_reconciliation`, entrada | `bank_reconciliation` | `121` (e `122`)            | conta da charge            |
| `bank_reconciliation`, saída   | `bank_reconciliation` | conta da charge            | `121` (e `122`)            |
| `charge_offset`                | `settlement_applied`  | conta da charge de crédito | conta da charge de débito  |
| `bank_deposit_credit`          | `bank_deposit_credit` | `121`                      | conta da charge de crédito |

O lado bancário de um `bank_reconciliation` reparte-se entre `121` e `122` na proporção FCR da
charge (`finance.fn_charge_fcr_split`, ver [05-fluxo-fcr.md](./05-fluxo-fcr.md)); sem componente FCR
vai inteiro para a `121`.

Efeitos de `applySettlementEffects`, com o estado da charge recalculado em todos os casos:

- `bank_reconciliation`: `settled_amount += v`, `amount += v` e `open_amount` = base menos
  `settled_amount`. A base é `expected_amount` quando a charge entra como `debit_charge_id` e
  `original_amount` quando entra como `credit_charge_id`. O estado do movimento é recalculado.
- `charge_offset`: nas duas charges, `settled_amount += v` e `open_amount -= v`.
- `bank_deposit_credit`: a charge de crédito não muda (o `open_amount` fica disponível para
  compensações); o estado do movimento é recalculado.

### 4. Ignorar e retomar

`POST /bank_transactions/:id/ignore` passa um movimento `unreconciled` a `ignored` e
`POST /bank_transactions/:id/unignore` faz o inverso. Fora do estado de partida devolvem
`409 WRONG_STATUS`; com settlements ativos, `409 HAS_ACTIVE_SETTLEMENTS`. As imputações rejeitam
movimentos `ignored`.

### 5. Reverter

`POST /bank_transactions/:id/reverse` com `{ reason }` (10 a 500 caracteres) desfaz toda a
conciliação de um movimento `reconciled` ou `partial`; noutro estado devolve `409`
([bank_transaction/reverse.ts](../../src/apps/api/modules/admin/bank_transaction/reverse.ts)). Numa
transação:

1. O movimento passa a `reversed` e guarda `reversal_reason`.
2. Cada settlement ativo passa a `reversed`; `fn_settlement_au` lança as linhas inversas
   (`entry_type='settlement_reversed'`, data corrente).
3. `applyReverseEffects` repõe cada charge: `settled_amount` e `amount` descem, `open_amount` e
   estado são recalculados.
4. Os recibos emitidos contra o movimento são anulados; os PDF são regenerados depois da transação.

Num `bank_deposit_credit`, a reversão cancela a charge de crédito do excedente; se esse crédito já
foi consumido por compensações ativas, falha com `409 RESTRICT_VIOLATION` e nada é alterado.

### 6. Data de corte

A página de conciliação grava em `core.condominium.reconciled_through_date` a data até à qual o
extrato está tratado (`PATCH /condominiums/me`). `finance.v_unit_balance` só conta como vencida uma
dívida com `due_date` até essa data; sem data de corte, nada é vencido
([ADR 0037](../adr/0037-charge-effective-status.md)).

## Invariantes

1. Um movimento não lança no ledger: `finance.bank_transaction` só tem os triggers de auditoria e de
   tenant. Nestes fluxos, as contas `121` e `122` só se movem com settlements.
2. A soma dos settlements ativos de um movimento nunca excede `abs(amount)` e `settlement.amount`
   nunca excede o `open_amount` das charges envolvidas. A validação corre com as linhas bloqueadas
   (`FOR UPDATE`); `fn_settlement_bi` repete o limite da charge.
3. Todo o settlement nasce em `createSettlementInTx`. Um `INSERT` direto em `finance.settlement`
   lança no ledger mas não atualiza a charge nem o movimento.
4. Cada settlement lança débito e crédito do mesmo valor e a reversão lança o inverso;
   `finance.ledger` é append-only.
5. Não há dois movimentos com o mesmo `import_hash` não nulo na mesma conta.
6. Charges, movimento e settlement pertencem ao mesmo condomínio (`createSettlementInTx` e
   `trg_tenant_guard`).

## Casos limite

- **Movimento que não bate com as charges.** Se sobra valor, fica por alocar e o movimento fica
  `partial`; só a imputação por fração transforma o excedente em crédito. Sem nenhuma charge que o
  explique, fica `unreconciled` ou é marcado `ignored`. Entradas por identificar:
  [03-fluxo-suspense.md](./03-fluxo-suspense.md).
- **Sinal e estado em `POST /settlements`.** O endpoint não confronta o sinal do movimento com o
  `kind` da charge nem verifica o `status` do movimento; o sinal só decide o lado do lançamento
  bancário. O painel filtra as charges pelo sinal.
- **Linhas repetidas num ficheiro.** O commit não deduplica linhas entre si: duas com o mesmo hash
  no mesmo pedido violam `bank_tx_import_hash_unique` e nada é importado.

## Limites conhecidos

- Não há conciliação automática: as palavras-chave só sugerem.
- A importação aceita um único formato (o XLSX lido por `novo_banco.ts`); `bank_account.csv_config`
  é guardado mas não é usado.
- Não existe endpoint para editar ou eliminar um movimento, nem para reverter um settlement isolado:
  a reversão é sempre do movimento inteiro.

## Referências

- [CONTEXT.md](../../CONTEXT.md): conciliação, settlement, bank transaction, bank reversal, match
  keywords. [ADR 0001](../adr/0001-financial-cascade-split.md): triggers lançam o ledger, TypeScript
  gere estados e algoritmos.
- Código: [settlement/](../../src/apps/api/modules/admin/settlement/),
  [bank_transaction/](../../src/apps/api/modules/admin/bank_transaction/),
  [bank_account/](../../src/apps/api/modules/admin/bank_account/),
  [pages/reconciliation/](../../src/apps/panel/templates/pages/reconciliation/).
- Testes: [api_admin_bank_test.ts](../../test_api/api_admin_bank_test.ts),
  [api_admin_bank_import_test.ts](../../test_api/api_admin_bank_import_test.ts),
  [api_admin_bank_reverse_test.ts](../../test_api/api_admin_bank_reverse_test.ts),
  [api_admin_reconciliation_flows_test.ts](../../test_api/api_admin_reconciliation_flows_test.ts),
  [effects_math_test.ts](../../src/apps/api/modules/admin/settlement/effects_math_test.ts).
