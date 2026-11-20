# 02 - Fluxo de despesas (avulsas, recorrentes, refaturação)

Ciclo de vida de uma despesa do condomínio: registo da fatura como charge `payable`, pagamento por
conciliação com um movimento bancário, geração a partir de modelos recorrentes, refaturação a
frações e devoluções do fornecedor. A charge é a única porta de entrada no ledger: um
`bank_transaction` nunca lança, só o `settlement` que o liga a uma charge. Não há passo de
aprovação: a charge fica ativa assim que é criada. O lado bancário (importação, estados do
movimento, reversão) está em [06-fluxo-reconciliacao.md](./06-fluxo-reconciliacao.md) e os exemplos
com valores em [02 - casos de despesa](./02-despesas-casos.md).

Caminhos de API relativos a `/v1/admin/condominiums/:cid`. Ficheiros TypeScript relativos a
`src/apps/api/modules/admin/`. Todos os valores são cêntimos inteiros.

## Modelo

| Tabela / view                     | Papel na despesa                                                                                            |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `finance.charge`                  | A despesa: `kind='payable'`. Fatura = `nature='debit'`; devolução ou nota de crédito = `nature='credit'`.   |
| `finance.settlement`              | Liquidação: `bank_reconciliation` (charge ↔ movimento) ou `charge_offset` (fatura ↔ nota de crédito).       |
| `finance.bank_transaction`        | Movimento bancário. Saída = `amount < 0`.                                                                   |
| `finance.ledger`                  | Lançamentos em partidas dobradas, escritos pelos triggers de `charge` e `settlement`. Append-only.          |
| `finance.chart_of_account`        | Rubrica de gasto (`charge.account_id`), global ou do condomínio.                                            |
| `core.supplier`                   | Fornecedor. `account_id` = rubrica por omissão nas devoluções; `match_keywords` = sugestões na conciliação. |
| `core.recurring_template`         | Modelo de despesa recorrente.                                                                               |
| `core.recurring_generation_run`   | Uma linha por execução da geração recorrente.                                                               |
| `finance.balance_supplier` (view) | Soma de `open_amount` dos payables com `supplier_id`, não cancelados, por fornecedor. Não é lida pela API.  |

Em `finance.balance_supplier` as faturas (`nature='debit'`) somam em `current_open_debit` e
`total_open_debit`; as colunas `overdue_*` só contam charges `nature='credit'`.

### Colunas de `finance.charge` numa despesa

| Coluna                     | Significado                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `code`                     | Código humano: `D` + 4 dígitos base-36 (`D0001`) em payables, `R` + 5 dígitos em receivables. Trigger `trg_charge_code_assign`. |
| `scope`                    | `condominium` quando `unit_id` é nulo, `unit` caso contrário (decidido no handler).                                             |
| `charge_type`              | Texto livre, sem CHECK. Valores escritos pelos handlers de despesa: ver abaixo.                                                 |
| `account_id`               | Rubrica. Opcional. Define a conta de gasto no ledger.                                                                           |
| `supplier_id`              | Fornecedor. Opcional.                                                                                                           |
| `original_amount`          | Valor da fatura (`> 0`).                                                                                                        |
| `expected_amount`          | Base de `open_amount` nas conciliações bancárias de charges débito. Acompanha `original_amount`.                                |
| `amount`                   | Acumulado liquidado por `bank_reconciliation`.                                                                                  |
| `settled_amount`           | Acumulado liquidado por todos os settlements ativos (banco e offsets).                                                          |
| `open_amount`              | Saldo por liquidar (`>= 0`).                                                                                                    |
| `issue_date`, `due_date`   | Data da fatura e vencimento.                                                                                                    |
| `competence_period`        | Mês de competência. A criação, a edição e a geração recorrente gravam o primeiro dia do mês.                                    |
| `source_type`, `source_id` | Origem: `recurring_template`, `refacturation` (despesa de origem) ou `supplier_refund` (despesa devolvida).                     |

Os handlers de despesa escrevem `charge_type` `supplier_service` (payable com fornecedor, payable
recorrente e devolução), `expense` (payable sem fornecedor) e `refacturation`.

### Estados da charge

`status` aceita `open`, `partial`, `paid`, `overdue`, `cancelled` e `disputed`. A regra vive em
`computeChargeStatus`
([settlement/charge_status.ts](../../src/apps/api/modules/admin/settlement/charge_status.ts)) e
corre sempre que um settlement é criado ou revertido, por esta ordem:

1. `cancelled` e `disputed` não mudam.
2. `open_amount <= 0` dá `paid`.
3. `settled_amount > 0` dá `partial`.
4. `due_date` anterior a hoje dá `overdue`.
5. Caso contrário, `open`.

Nenhum handler escreve `disputed`. O `overdue` gravado só é escrito nesses momentos e, na criação,
pela geração recorrente; o "vencida" mostrado no ecrã é derivado
([ADR 0037](../adr/0037-charge-effective-status.md)).

### Contas e lançamentos no ledger

As contas são resolvidas por `finance.fn_charge_account` e `finance.fn_counterparty_account` em
[004_trg_financial.sql](../../src/db/components/004_trg_financial.sql):

- **Conta da despesa**: o `code` da rubrica (`account_id`); sem rubrica, `2211`.
- **Contrapartida da despesa**: `2211` (Fornecedores a Pagar).
- **Refaturação**: `2113`, a conta a receber de refaturações.
- **Banco**: `121`. Uma despesa não tem parte FCR, por isso nunca toca na `122`.

| Evento                                 | `entry_type`             | Débito                   | Crédito                    | Valor                           |
| -------------------------------------- | ------------------------ | ------------------------ | -------------------------- | ------------------------------- |
| Criar despesa (`nature='debit'`)       | `charge_created`         | conta da despesa         | `2211`                     | `original_amount`               |
| Editar o valor (subida)                | `charge_amount_adjusted` | conta da despesa         | `2211`                     | diferença                       |
| Editar o valor (descida)               | `charge_amount_adjusted` | `2211`                   | conta da despesa           | diferença                       |
| Cancelar despesa                       | `charge_cancelled`       | `2211`                   | conta da despesa           | `open_amount` antes de cancelar |
| Pagar (movimento de saída)             | `bank_reconciliation`    | conta da despesa         | `121`                      | valor do settlement             |
| Reverter o pagamento                   | `settlement_reversed`    | `121`                    | conta da despesa           | valor do settlement             |
| Criar refaturação                      | `charge_created`         | `2113`                   | conta da despesa de origem | valor refaturado                |
| Fração paga a refaturação              | `bank_reconciliation`    | `121`                    | `2113`                     | valor do settlement             |
| Cancelar refaturação                   | `charge_cancelled`       | `7888`                   | `2113`                     | `open_amount` antes de cancelar |
| Devolução do fornecedor (entrada)      | `bank_reconciliation`    | `121`                    | conta da charge de crédito | valor do settlement             |
| Compensar nota de crédito com a fatura | `settlement_applied`     | conta da nota de crédito | conta da fatura            | valor do settlement             |

Charges `nature='credit'` não lançam na criação (`fn_charge_ai` sai logo). `charge_created` usa
`issue_date` como `entry_date`; os lançamentos de settlement usam `settlement_date`; edições,
cancelamentos e reversões usam a data corrente.

O pagamento debita a conta da despesa, não a `2211`. Uma despesa com rubrica, criada e paga, fica
com dois débitos do valor da fatura na conta de gasto e com o crédito da criação por saldar na
`2211`. Somar uma conta de gasto no ledger sem filtrar por `entry_type` conta a despesa duas vezes.

## Fluxo

### Despesa avulsa

```
1. Registar a fatura                              POST /charges
   charge/create.ts (TypeScript)
     - valida que unitId, supplierId e accountId pertencem ao condomínio
     - defaults (charge/defaults.ts): nature = debit;
       charge_type = supplier_service (com fornecedor) ou expense (sem);
       competence_period = primeiro dia do mês de issue_date
     - INSERT finance.charge
       (original_amount = expected_amount = open_amount = amountCents; amount = settled_amount = 0)
   triggers
     - trg_charge_code_assign     code = D0001, D0002, ...
     - trg_charge_ai              ledger: Dr conta da despesa / Cr 2211
        |
        v
2. Chega o movimento de saída                     importação ou registo manual (ver 06)
     - INSERT finance.bank_transaction (amount < 0, status = unreconciled)
     - sem ledger
        |
        v
3. Conciliar                                      POST /settlements
   createSettlementInTx, settlement/operation.ts (TypeScript)
     - valida: amount <= open_amount da charge e <= valor por alocar do movimento
     - INSERT finance.settlement (bank_reconciliation, debit_charge_id, bank_transaction_id)
   trigger trg_settlement_ai
     - ledger: Dr conta da despesa / Cr 121
   applySettlementEffects, settlement/effects.ts (TypeScript)
     - charge: settled_amount += v; amount += v;
               open_amount = expected_amount - settled_amount; status = paid ou partial
     - bank_transaction.status = reconciled ou partial
```

No painel, a fatura regista-se em `/admin/c/:cid/charges` e o passo 3 faz-se no modal de
conciliação: nas saídas o separador "Fornecedor" lista as charges payable em aberto e o
administrador escolhe quais liquidar. Em alternativa, a API tem
`POST /bank_transactions/:id/allocate_to_supplier`, que distribui o movimento pelas faturas em
aberto de um fornecedor ([07-fluxo-imputacao.md](./07-fluxo-imputacao.md)).

O handler de criação não aplica auto-offset a payables: `applyAutoOffset` só atua em receivables com
fração.

### Edição e cancelamento

- **Editar**: `PATCH /charges/:chargeId`
  ([charge/update.ts](../../src/apps/api/modules/admin/charge/update.ts)). Só com `status` `open` ou
  `overdue` e `settled_amount = 0`; caso contrário `409 CHARGE_LOCKED`. O valor (`amountCents`) só
  muda em charges `payable` + `debit`, e nunca em `quota`, `extraordinary_quota` ou `refacturation`;
  caso contrário `409 AMOUNT_EDIT_LOCKED`. Ao mudar o valor, o handler grava `original_amount`,
  `expected_amount` e `open_amount` com o novo valor e o trigger `trg_charge_amount_adjust_ledger`
  lança a diferença.
- **Cancelar**: `POST /charges/:chargeId/cancel { reason }`
  ([charge/cancel.ts](../../src/apps/api/modules/admin/charge/cancel.ts)). Justificação obrigatória
  (`400` sem ela). Numa despesa, só sem pagamentos: um settlement ativo devolve
  `409 CHARGE_HAS_BANK_SETTLEMENTS` (ou `409 CHARGE_ALREADY_CANCELLED`). O trigger `fn_charge_bu`
  põe `amount`, `settled_amount` e `open_amount` a zero (mantém `original_amount` e
  `expected_amount`) e `fn_charge_au` lança o inverso da criação.

A edição repete as condições no `WHERE` do `UPDATE`; se o estado mudar a meio, devolve
`409 CHARGE_STATE_CHANGED`. O cancelamento tranca a charge (`FOR UPDATE`) na transação.
`finance.charge` não tem soft-delete nem endpoint de eliminação: anular é passar a `cancelled`.

### Despesa recorrente

Um `core.recurring_template` descreve uma despesa que se repete: `kind` (`payable` ou `receivable`),
`description`, `amount`, `account_id`, `supplier_id`, `unit_id`, `interval_type` (`monthly`,
`bimonthly`, `quarterly`, `semiannual` ou `annual`), `day_of_month` (1 a 28; nulo = dia 1),
`end_date` (nulo = sem fim), `next_run_date` (próxima ocorrência por gerar), `is_active` e
`payment_method`. Tem soft-delete por `deleted_at`.

Endpoints: `GET` e `POST /recurring_templates`, `PATCH` e `DELETE /recurring_templates/:templateId`,
e a geração em `POST /recurring_templates/generate` com `{ throughDate, notes? }`. No painel:
`/admin/c/:cid/recurring`, botão "Gerar despesas". A geração só corre quando o administrador a
invoca.

`runRecurringGeneration`
([recurring_template/generator.ts](../../src/apps/api/modules/admin/recurring_template/generator.ts))
faz tudo numa transação:

1. Seleciona os modelos do condomínio ativos, não eliminados, com `next_run_date <= throughDate` e
   `end_date` nulo ou `>= next_run_date`.
2. Para cada modelo, enquanto `next_run_date <= throughDate` e dentro de `end_date`:
   - competência = primeiro dia do mês de `next_run_date`; vencimento = `day_of_month` desse mês;
   - se já existe uma charge com o mesmo `recurring_template_id` e `competence_period`, salta;
   - senão insere a charge: `nature='debit'`, `charge_type='supplier_service'` (payable) ou
     `recurring_fee` (receivable), `issue_date` = hoje, `status` = `overdue` se o vencimento já
     passou e `open` caso contrário, descrição `<descrição> - MM/AAAA`,
     `source_type='recurring_template'`, `source_id` e `recurring_template_id` = modelo;
   - avança `next_run_date` um intervalo (`advanceByInterval` em
     [date_helpers.ts](../../src/apps/api/modules/admin/recurring_template/date_helpers.ts)).
3. Grava `next_run_date` e `last_generated_at` no modelo.
4. Insere uma linha em `core.recurring_generation_run` com `through_date`, `templates_generated`,
   `charges_created`, `notes` e `created_by`.

Cada charge inserida passa pelos mesmos triggers da despesa avulsa (código e ledger) e segue depois
o fluxo normal de conciliação. Modelos receivable com fração aplicam ainda `applyAutoOffset`.

Exemplo: modelo "Limpeza mensal", fornecedor "Limpezas Teste", `amount = 10000`,
`interval_type = monthly`, `day_of_month = 5`, `next_run_date = 2030-01-05`. Gerar com
`throughDate = 2030-03-31` cria três charges de 10000 (competências `2030-01-01`, `2030-02-01` e
`2030-03-01`; vencimentos nos dias 5; descrição com o sufixo `01/2030`, `02/2030` e `03/2030`) e
deixa `next_run_date = 2030-04-05`. Repetir a geração com a mesma data não cria charges.

### Refaturação

Refaturar é cobrar a uma ou mais frações parte de uma despesa do condomínio. Cada refaturação é uma
charge `kind='receivable'`, `nature='debit'`, `charge_type='refacturation'`, ligada à despesa por
`source_type='refacturation'` e `source_id`.

`POST /charges/:chargeId/refacturations`
([charge/create_refacturations.ts](../../src/apps/api/modules/admin/charge/create_refacturations.ts)),
com `{ allocations: [{ unitId, amountCents, description? }], issueDate?, dueDate }`:

1. A despesa de origem tem de existir no condomínio e ser `payable` (`400 INVALID_KIND`). O estado
   não conta: pode estar em aberto, parcial ou paga.
2. Disponível = `original_amount` da origem (não o `open_amount`) menos a soma de `original_amount`
   das refaturações já criadas para essa origem. Se a soma do pedido excede o disponível:
   `400 REFACTURATION_EXCEEDS_TOTAL`.
3. `dueDate` é obrigatório. As frações têm de pertencer ao condomínio.
4. Numa transação, insere uma charge por fração com `account_id` e `competence_period` iguais aos da
   origem. Descrição por omissão: `Refaturação: <descrição da origem>`.

Na inserção correm dois triggers:

- `trg_refacturation_validate`
  ([008_trg_refacturation.sql](../../src/db/components/008_trg_refacturation.sql)) rejeita a charge
  se `source_type` não for `refacturation`, se `source_id` for nulo ou não existir, se a origem não
  for `payable`, se for de outro condomínio ou se o `account_id` for diferente do da origem.
- `trg_charge_ai` lança Dr `2113` / Cr conta da despesa de origem: no ledger, a refaturação abate o
  gasto da rubrica da despesa.

A refaturação é depois recebida como qualquer dívida da fração: conciliação manual ou imputação,
onde as refaturações não vencidas formam o quarto grupo de prioridade (ver
[07-fluxo-imputacao.md](./07-fluxo-imputacao.md)). O recebimento lança Dr `121` / Cr `2113`.

Este handler não chama `applyAutoOffset`: um crédito em aberto da fração não é consumido quando a
refaturação é criada. O valor de uma refaturação não é editável; corrige-se cancelando e criando
outra.

### Nota de crédito do fornecedor

**Devolução com entrada bancária.** O fornecedor devolve dinheiro e a entrada aparece no extrato.
`POST /bank_transactions/:id/refund_supplier`
([bank_transaction/refund_supplier.ts](../../src/apps/api/modules/admin/bank_transaction/refund_supplier.ts)),
com `{ supplierId, amount, sourceChargeId?, description?, settlementDate? }`. No painel é o
separador "Devolução" do modal de conciliação, visível nas entradas. Numa transação:

1. Valida o movimento: do condomínio, `amount > 0` (`400 WRONG_SIGN`), `status` `unreconciled` ou
   `partial` (`409 WRONG_STATUS`).
2. Valida o fornecedor e, se indicada, a despesa de origem: `payable` e do mesmo fornecedor.
3. Insere uma charge `kind='payable'`, `nature='credit'`, `charge_type='supplier_service'`, com
   `issue_date`, `due_date` e `competence_period` iguais à data do movimento, `account_id` = rubrica
   da origem, senão a do fornecedor, e `source_type='supplier_refund'` + `source_id` quando há
   origem. Não lança no ledger.
4. Cria o settlement `bank_reconciliation` com `credit_charge_id`: ledger Dr `121` / Cr conta da
   charge de crédito. A charge de crédito fica `paid` e o movimento `reconciled` (ou `partial`).

A despesa de origem não é alterada. Reverter o movimento repõe o saldo em aberto da charge de
crédito; não a cancela.

**Nota de crédito sem movimento bancário.** Abate uma fatura ainda por pagar. Faz-se só pela API, em
dois pedidos: `POST /charges` com `kind='payable'` e `nature='credit'`, depois `POST /settlements`
com `settlementType='charge_offset'`, `debitChargeId` = fatura e `creditChargeId` = nota. Efeito nas
duas charges: `settled_amount += v` e `open_amount -= v`, com o estado recalculado; `amount` não
muda. O ledger recebe `settlement_applied` com Dr conta da nota / Cr conta da fatura, que se anula
quando as duas têm a mesma rubrica. O resto da fatura paga-se depois pelo fluxo normal.

## Invariantes

1. Um movimento bancário não lança no ledger: `finance.bank_transaction` tem apenas os triggers de
   auditoria e de tenant.
2. Nestes fluxos, as linhas do ledger vêm dos triggers `trg_charge_ai`, `trg_charge_au`,
   `trg_charge_amount_adjust_ledger`, `trg_settlement_ai` e `trg_settlement_au`. Cada evento lança
   débito e crédito do mesmo valor. `finance.ledger` rejeita `UPDATE`, `DELETE` e `TRUNCATE`
   ([014_ledger_immutability.sql](../../src/db/components/014_ledger_immutability.sql)).
3. Os montantes e o estado da charge são atualizados em TypeScript, nunca por trigger. Todo o
   settlement nasce em `createSettlementInTx`, que valida os limites (ver
   [06-fluxo-reconciliacao.md](./06-fluxo-reconciliacao.md)); um `INSERT` direto em
   `finance.settlement` lança no ledger mas deixa a charge e o movimento por atualizar.
4. Uma charge com settlements ativos não pode ser cancelada (`fn_charge_bu` e handler).
5. Uma refaturação aponta sempre para uma despesa `payable` do mesmo condomínio e com a mesma
   rubrica.
6. Ano fiscal `closed` bloqueia `INSERT` e `UPDATE` em `finance.charge` (pelo `competence_period`) e
   em `finance.ledger` (pela `entry_date`)
   ([007_trg_fiscal_year.sql](../../src/db/components/007_trg_fiscal_year.sql)).
7. Dinheiro em cêntimos inteiros, com `original_amount > 0`, `settled_amount >= 0`,
   `open_amount >= 0`, `settlement.amount > 0` e `ledger.amount > 0`.
8. Referências entre linhas respeitam o condomínio: o handler valida primeiro e `trg_tenant_guard`
   ([020_trg_tenant_guard.sql](../../src/db/components/020_trg_tenant_guard.sql)) é a última
   barreira.

## Casos limite

- **Movimento com valor diferente da fatura.** Um settlement acima do `open_amount` é rejeitado com
  `400 VALIDATION_ERROR`. Corrige-se primeiro o valor da charge (`PATCH`) e concilia-se depois; no
  painel é o botão "Ajustar + Conciliar", disponível quando está selecionada uma única charge
  payable débito, não refaturação, com valor diferente do movimento.
- **Pagamento parcial.** Um settlement inferior ao `open_amount` deixa a charge `partial`. A partir
  daí não pode ser editada nem cancelada: só muda com novos settlements (outro movimento ou uma nota
  de crédito) ou com a reversão do movimento que a pagou.
- **Reversão.** Não há endpoint para reverter um settlement isolado: reverte-se o movimento bancário
  inteiro (`POST /bank_transactions/:id/reverse`), o que repõe todas as charges que ele pagou.
- **Despesa sem fornecedor.** `supplier_id` nulo é válido (`charge_type` inferido `expense`). Fica
  fora de `finance.balance_supplier` e da imputação por fornecedor; concilia-se escolhendo a charge.
- **Despesa sem rubrica.** `account_id` nulo é válido. No ledger a conta da despesa passa a ser a
  `2211`: a criação lança Dr `2211` / Cr `2211` e o pagamento Dr `2211` / Cr `121`.
- **Ocorrências recorrentes em atraso.** Uma só geração cria todas as ocorrências entre
  `next_run_date` e `throughDate`. Uma charge cancelada de um modelo continua a contar para a
  verificação de duplicados: essa competência não volta a ser gerada, mesmo recuando
  `next_run_date`.

## Limites conhecidos

- Não existe entidade de contrato de fornecedor: `contract_id` está em `finance.charge` e em
  `core.recurring_template` como texto sem chave estrangeira.
- A geração recorrente não é agendada; depende de o administrador a invocar.
- Nenhum relatório abate as refaturações à despesa de origem. O abatimento existe só no ledger.
- Cancelar uma refaturação lança Dr `7888` / Cr `2113`, sem repor a conta de gasto creditada na
  criação, e o valor cancelado continua a contar como já refaturado no cálculo do disponível.
- A nota de crédito sem movimento bancário não tem ecrã no painel nem compensação automática.

## Referências

- [CONTEXT.md](../../CONTEXT.md): charge, settlement, offset, refaturação, fornecedor, recurring
  template.
- [ADR 0001](../adr/0001-financial-cascade-split.md): triggers lançam o ledger, TypeScript gere
  estados e algoritmos. [ADR 0035](../adr/0035-auto-offset-ordering-distinct-from-allocation.md):
  ordem do auto-offset e ordem da imputação.
- Fluxos: [00-overview-entradas-saidas.md](./00-overview-entradas-saidas.md),
  [05-fluxo-fcr.md](./05-fluxo-fcr.md), [06-fluxo-reconciliacao.md](./06-fluxo-reconciliacao.md),
  [07-fluxo-imputacao.md](./07-fluxo-imputacao.md).
- Código: [charge/](../../src/apps/api/modules/admin/charge/),
  [settlement/](../../src/apps/api/modules/admin/settlement/),
  [recurring_template/](../../src/apps/api/modules/admin/recurring_template/),
  [010_trg_charge_code.sql](../../src/db/components/010_trg_charge_code.sql).
- Testes: [api_admin_charge_test.ts](../../test_api/api_admin_charge_test.ts),
  [api_admin_charge_cancel_test.ts](../../test_api/api_admin_charge_cancel_test.ts),
  [api_admin_recurring_generation_test.ts](../../test_api/api_admin_recurring_generation_test.ts),
  [api_admin_bank_transaction_refund_supplier_test.ts](../../test_api/api_admin_bank_transaction_refund_supplier_test.ts),
  [0004_refacturation_constraint.sql](../../test_sql/tests/0004_refacturation_constraint.sql),
  [0015_charge_amount_adjust_ledger.sql](../../test_sql/tests/0015_charge_amount_adjust_ledger.sql).
