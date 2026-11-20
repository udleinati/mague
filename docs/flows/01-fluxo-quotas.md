# 01 - Fluxo de quotas (ordinárias e extraordinárias)

Como uma quota nasce de um orçamento aprovado, é lançada no ledger, é paga e dá origem a um recibo.
Uma quota não é uma entidade própria: é uma `finance.charge` (ver [CONTEXT.md](../../CONTEXT.md)). A
divisão de responsabilidades segue o [ADR 0001](../adr/0001-financial-cascade-split.md): os triggers
PL/pgSQL são o único caminho que escreve em `finance.ledger`; o cálculo, a geração, o offset de
créditos e a máquina de estados vivem em TypeScript na API. Enquadramento geral em
[00-overview-entradas-saidas.md](./00-overview-entradas-saidas.md).

## Modelo

### Tabelas e colunas

- **`core.budget`** - orçamento. `type` (`principal` | `suplementar`), `status` (`draft` |
  `approved` | `not_approved`), `year`, `fcr_percentage` (`numeric(5,2)`, default `10.00`),
  `parent_budget_id` (obrigatório no suplementar, nulo no principal - CHECK
  `budget_type_parent_check`), `installments` (1 a 120, só no suplementar),
  `first_competence_period`, `quotas_generated_at`, `approved_at`.
- **`core.budget_line`** - rubricas do orçamento: `account_id` (conta de `finance.chart_of_account`)
  e `annual_amount`.
- **`core.quota_generation_run`** - uma linha por execução da geração: `budget_id`, `through_date`,
  `charges_created`, `notes`, `created_by`.
- **`core.unit`** - fração: `permillage` (`numeric(7,3)`), `is_active`.
- **`core.condominium.quota_day_of_month`** - dia de vencimento das quotas (1 a 28, default 1).
- **`finance.charge`** - a quota: `kind='receivable'`, `nature='debit'`, `scope='unit'`,
  `charge_type` (`quota` | `extraordinary_quota`), `source_type='budget'`, `source_id` (id do
  orçamento), `competence_period` (dia 1 do mês), `issue_date`, `due_date`, `status`, `code`, e os
  montantes `original_amount`, `expected_amount`, `settled_amount`, `open_amount`, `amount`.
- **`finance.settlement`** - liga a quota a um movimento bancário (`bank_reconciliation`) ou a um
  crédito da mesma fração (`charge_offset`). Um depósito sem dívida a saldar é
  `bank_deposit_credit`.
- **`finance.ledger`** - partidas dobradas, append-only.
- **`finance.receipt`** e **`finance.receipt_skip`** - recibo por (movimento bancário, fração).

Todos os montantes são `integer` em cêntimos.

Views: `finance.v_unit_balance` (saldo da fração lido pela API), `finance.v_bank_balance` (bolsas
`121`/`122`), `finance.v_budget_quota_map` (esqueleto do mapa de quotas) e
`finance.vw_pending_receipts` (fila de recibos). A view `finance.balance_unit` (saldos
`current_*`/`future_*` por competência) existe na base de dados mas não é lida pela aplicação.

### Os dois tipos de quota

|                  | Ordinária                          | Extraordinária                    |
| ---------------- | ---------------------------------- | --------------------------------- |
| Orçamento        | `type='principal'`                 | `type='suplementar'`              |
| `charge_type`    | `quota`                            | `extraordinary_quota`             |
| Divisão no tempo | meses de Janeiro a Dezembro do ano | `installments` prestações mensais |
| FCR              | `fcr_percentage` do orçamento      | sempre 0 (forçado pela API)       |
| Conta a receber  | `2111`                             | `2112`                            |
| Conta de receita | `721` + `723` (parte FCR)          | `722`                             |
| Descrição gerada | `Quota ordinária MM/AAAA (FCR X%)` | `Quota suplementar i/N MM/AAAA`   |

### Contas do ledger

| Conta  | Nome                                | Papel                                       |
| ------ | ----------------------------------- | ------------------------------------------- |
| `2111` | Condóminos - Quotas Ordinárias      | a receber de quotas ordinárias              |
| `2112` | Condóminos - Quotas Extraordinárias | a receber de quotas extraordinárias         |
| `721`  | Quotas Ordinárias                   | receita, parte ordinária                    |
| `722`  | Quotas Extraordinárias              | receita de quotas extraordinárias           |
| `723`  | Contribuições FCR                   | receita, parte FCR                          |
| `121`  | Depósitos à ordem - Conta Ordinária | bolsa ordinária                             |
| `122`  | Depósitos à ordem - Conta FCR       | bolsa FCR                                   |
| `2782` | Outros Credores                     | crédito da fração (charge `credit_balance`) |

A conta de cada charge é resolvida por `finance.fn_charge_account` e a contrapartida por
`finance.fn_counterparty_account`, em
[`004_trg_financial.sql`](../../src/db/components/004_trg_financial.sql).

### Estado gravado da charge

`status` aceita `open | partial | paid | overdue | cancelled | disputed` (CHECK
`charge_status_check`). A regra do estado gravado é `computeChargeStatus`
([`charge_status.ts`](../../src/apps/api/modules/admin/settlement/charge_status.ts)): `cancelled` e
`disputed` nunca são alterados; `open_amount <= 0` dá `paid`; `settled_amount > 0` dá `partial`;
`due_date` anterior a hoje dá `overdue`; caso contrário `open`. Depois da criação, só é recalculado
quando um settlement toca na charge.

## Fluxo

```
Administrador (Panel)     API (TypeScript)                   PostgreSQL (triggers)
---------------------     ----------------                   ---------------------
orçamento + rubricas  ->  budget/create.ts, budget_line/*
assembleia "held"     ->  assembly/update.ts             ->  core.fn_assembly_held_approve_budgets
                                                             (budget.status = 'approved')
gerar quotas          ->  budget/quota_generator.ts
                            distribuição por permilagem
                            INSERT finance.charge        ->  finance.fn_charge_assign_code (code)
                                                             finance.fn_charge_ai (ledger)
                            applyAutoOffset              ->  finance.fn_settlement_ai (ledger)
conciliar / imputar   ->  settlement/operation.ts
                            INSERT finance.settlement    ->  finance.fn_settlement_ai (ledger)
                            applySettlementEffects
                            (charge + bank_transaction)
emitir recibo         ->  receipt/emit_orchestrator.ts
```

Rotas da API sob `/v1/admin/condominiums/:cid`; ecrã do Panel em `/admin/c/:cid/budget`.

### 1. Orçamento em rascunho

- `POST /budgets` ([`create.ts`](../../src/apps/api/modules/admin/budget/create.ts)): com
  `parentBudgetId` o orçamento é `suplementar`, sem ele é `principal`. O suplementar exige um pai
  `principal` do mesmo ano e `installments >= 1`, e fica sempre com `fcr_percentage = 0` (o valor
  enviado é ignorado). O principal fica com 10% por defeito.
- Rubricas em `/budgets/:budgetId/lines`
  ([`budget_line/`](../../src/apps/api/modules/admin/budget_line/)).
- Orçamento e rubricas só são editáveis em `draft`. `POST /budgets/:id/reject` marca `not_approved`
  e `POST /budgets/:id/reopen` devolve a `draft`.
- `DELETE /budgets/:id` (soft delete) é recusado num orçamento `approved` e num principal com
  suplementares por eliminar.
- Podem coexistir vários principais em rascunho para o mesmo ano.

### 2. Aprovação em assembleia

Não há rota que ponha um orçamento em `approved`. A aprovação é feita pelo trigger
`core.fn_assembly_held_approve_budgets` (`AFTER UPDATE OF status ON core.assembly`, definido em
[`001_bootstrap.sql`](../../src/db/migrations/001_bootstrap.sql)) quando a assembleia passa a
`held`. Para cada ponto da ordem do dia com `item_type='approve_budget'`, `ref_type='budget'`,
`ref_id` preenchido e `approved=true`:

1. o orçamento tem de existir no mesmo condomínio e não estar eliminado;
2. se já está `approved`, é ignorado;
3. tem de ter pelo menos uma rubrica;
4. se é `principal`, não pode existir outro principal `approved` para o mesmo ano;
5. passa a `status='approved'` com `approved_at = now()`.

Qualquer falha levanta exceção e a assembleia não fica `held`. O `approved` do ponto é derivado dos
votos pela API (maioria simples), nunca enviado pelo cliente
([`create_agenda_item.ts`](../../src/apps/api/modules/admin/assembly/create_agenda_item.ts)).

### 3. Geração das quotas

`POST /budgets/:budgetId/generate_quotas` com corpo opcional `{ throughDate, firstMonth, notes }`. O
handler ([`generate_quotas.ts`](../../src/apps/api/modules/admin/budget/generate_quotas.ts)) chama
`runQuotaGeneration`
([`quota_generator.ts`](../../src/apps/api/modules/admin/budget/quota_generator.ts)), que corre numa
única transação. É uma ação explícita do administrador: não há tarefa agendada.

Pré-condições: orçamento existe (404), `status='approved'` (409 `INVALID_STATE`), soma das
permilagens das frações ativas maior que zero (422) e, no suplementar, `installments >= 1` (422). Se
a soma das rubricas for zero, regista a execução com 0 charges.

**Cálculo** (funções puras em
[`quota_distribution.ts`](../../src/apps/api/modules/admin/budget/quota_distribution.ts); entradas
carregadas por
[`_distribution_inputs.ts`](../../src/apps/api/modules/admin/budget/_distribution_inputs.ts)):

```
Principal
  mensal_com_fcr = SOMA(annual_amount) * (100 + fcr_percentage) / 100 / 12   (sem arredondar)
  alvo           = ROUND(mensal_com_fcr)
  quota_i        = ROUND(mensal_com_fcr * permillage_i / SOMA(permillage))
  quota_maior   += alvo - SOMA(quota_i)

Suplementar (N = installments)
  total_com_fcr  = ROUND(SOMA(annual_amount) * (100 + fcr_percentage) / 100)
  base           = ROUND(total_com_fcr / N)
  prestação_k    = base              para k < N
  prestação_N    = total_com_fcr - base * (N - 1)
  cada prestação é distribuída por permilagem como acima (alvo = valor da prestação)
```

A FCR entra no total antes da distribuição; não é calculada fração a fração. A diferença de
arredondamento é absorvida pela fração ativa de maior permilagem
([ADR 0010](../adr/0010-quota-rounding-big-unit.md)), escolhida com
`ORDER BY permillage DESC LIMIT
1`, sem critério de desempate.

**Períodos**:

- Principal: um mês por quota, de Janeiro até ao mês de `throughDate` (default 31 de Dezembro do ano
  do orçamento). `throughDate` anterior ao ano gera 0 meses; posterior gera os 12.
- Suplementar: `installments` meses consecutivos a partir do primeiro mês, podendo cruzar o ano (a
  resposta traz `crossesYear`). O primeiro mês é `budget.first_competence_period` se já estiver
  gravado; senão `firstMonth` do pedido; senão o mês seguinte ao atual.

**Inserção**: para cada (mês, fração) com valor maior que zero, se já existir uma charge com o mesmo
`source_type='budget'`, `source_id`, `unit_id` e `competence_period`, salta. Caso contrário insere:

| Coluna              | Valor                                                     |
| ------------------- | --------------------------------------------------------- |
| `charge_type`       | `quota` ou `extraordinary_quota`                          |
| `competence_period` | dia 1 do mês                                              |
| `due_date`          | dia `quota_day_of_month` desse mês                        |
| `issue_date`        | dia da geração                                            |
| `status`            | `overdue` se `due_date` for anterior a hoje, senão `open` |
| `original_amount`   | valor distribuído                                         |
| `expected_amount`   | igual a `original_amount`                                 |
| `open_amount`       | igual a `original_amount`                                 |
| `settled_amount`    | 0                                                         |

No fim grava `quotas_generated_at` (e `first_competence_period` no suplementar) se ainda estava nulo
e foram criadas charges, e insere a linha em `core.quota_generation_run`.

**Ledger** - `finance.fn_charge_ai` (`AFTER INSERT ON finance.charge`), com
`entry_type =
'charge_created'` e `entry_date = issue_date`:

```
quota                 Dr 2111  original_amount
                      Cr 721   ROUND(original_amount / (1 + fcr_percentage / 100))
                      Cr 723   original_amount - parte ordinária      (omitida se for 0)

extraordinary_quota   Dr 2112  original_amount
                      Cr 722   original_amount
```

A `fcr_percentage` é lida de `core.budget` pelo `source_id` da charge.

**Offset automático de créditos** - depois de cada inserção, `applyAutoOffset`
([`auto_offset.ts`](../../src/apps/api/modules/admin/charge/auto_offset.ts)) procura charges
`nature='credit'` da mesma fração com `status` em `open`/`partial`/`overdue` e `open_amount > 0`,
por `due_date`, `competence_period`, `created_at` ascendentes, e cria settlements `charge_offset`
até esgotar a quota ou os créditos. A quota pode por isso nascer `partial` ou `paid`. Ledger de cada
offset (`entry_type='settlement_applied'`): Dr conta do crédito (`2782` para `credit_balance`) / Cr
`2111`. Esta ordem é distinta da prioridade de imputação
([ADR 0035](../adr/0035-auto-offset-ordering-distinct-from-allocation.md)). A mesma função é chamada
na criação manual de charges (`charge/create.ts`), na geração de recorrentes
(`recurring_template/generator.ts`) e no cancelamento, para as charges que ficaram livres
(`charge/cancel.ts`).

**Mapa de quotas** - `GET /budgets/:budgetId/quota_map`
([`quota_map.ts`](../../src/apps/api/modules/admin/budget/quota_map.ts)) devolve os valores por
fração: antes da geração, a previsão calculada com as mesmas funções e entradas
(`quota_preview.ts`); depois, a soma real das charges (`_billed_by_unit.ts`). Da view
`finance.v_budget_quota_map` vêm só a lista de frações e os metadados do orçamento; os valores por
fração da view (`monthly_*_cents`, `annual_total_cents`) não são usados.

### 4. Pagamento

O movimento bancário (`finance.bank_transaction`) não gera ledger por si. O pagamento só existe
quando um settlement liga o movimento à quota:

- conciliação manual, charge a charge: `POST /settlements` (ver
  [06-fluxo-reconciliacao.md](./06-fluxo-reconciliacao.md));
- imputação por fração, pela ordem legal: ver [07-fluxo-imputacao.md](./07-fluxo-imputacao.md).

Ambos passam por `createSettlementInTx`
([`operation.ts`](../../src/apps/api/modules/admin/settlement/operation.ts)): validação com
`SELECT ... FOR UPDATE`, `INSERT`, e `applySettlementEffects`
([`effects.ts`](../../src/apps/api/modules/admin/settlement/effects.ts)).

Ledger de um `bank_reconciliation` de entrada - `finance.fn_settlement_ai`, com
`entry_type =
'bank_reconciliation'` e `entry_date = settlement_date`:

```
Dr 121   parte ordinária do valor pago
Dr 122   parte FCR do valor pago                (omitida se for 0)
Cr 2111  valor pago                             (2112 na quota extraordinária)
```

A divisão é feita por `finance.fn_charge_fcr_split`, na proporção das linhas `721`/`722`/`723` do
`charge_created` da quota: `fcr = ROUND(valor * 723 / (721 + 722 + 723))`,
`ordinária = valor -
fcr`.

Efeitos na charge (TypeScript): `settled_amount` e `amount` sobem o valor pago,
`open_amount =
MAX(expected_amount - settled_amount, 0)` e `status` é recalculado. O movimento
bancário fica `reconciled` quando os settlements ativos cobrem o seu valor, `partial` se cobrem
parte.

### 5. Cancelamento

`POST /charges/:chargeId/cancel { reason }`
([`cancel.ts`](../../src/apps/api/modules/admin/charge/cancel.ts)) exige uma justificação (10 a 500
caracteres, gravada em `cancellation_reason`) e aceita charges `open`, `partial`, `paid` ou
`overdue` cujos settlements ativos sejam todos `charge_offset`; um settlement com movimento bancário
devolve `409 CHARGE_HAS_BANK_SETTLEMENTS` (reverte-se o movimento na conciliação). Numa transação, o
handler reverte os offsets da charge (a outra ponta volta a ficar em aberto), cancela a charge e
volta a aplicar o auto-offset às charges que ficaram livres. `finance.fn_charge_bu` põe os montantes
a zero; `finance.fn_charge_au` emite `charge_cancelled` pelo valor que estava em aberto: Dr `721` /
Cr `2111` na quota ordinária (sem linha `723`), Dr `722` / Cr `2112` na extraordinária. Uma charge a
crédito (`credit_adjustment`) não lançou nada ao nascer e o cancelamento também não lança.

## Recibo

Um recibo corresponde às conciliações de um par (movimento bancário, fração), não a uma quota.
Código em [`receipt/`](../../src/apps/api/modules/admin/receipt/); ecrã em `/admin/c/:cid/receipts`.

- **Elegibilidade** - view `finance.vw_pending_receipts`
  ([`016_vw_receipt_pending.sql`](../../src/db/components/016_vw_receipt_pending.sql)): movimento
  com `amount > 0` e `status` fora de `reversed`/`ignored`, com settlements ativos
  `bank_reconciliation` ou `bank_deposit_credit` dessa fração ainda sem recibo não anulado e sem
  `receipt_skip` ativo no par. Um `charge_offset` não dá recibo.
- **Valor** - soma dos settlements ativos dessa fração nesse movimento que ainda não têm recibo
  (`finance.vw_receipted_settlements`). O recibo grava-os em `settlement_ids`; uma conciliação nova
  no mesmo par volta a pôr o par nos pendentes, só com o valor novo. Recibos anteriores à regra
  (array vazio) cobrem as conciliações do par feitas até à emissão. Anular um recibo devolve só as
  conciliações dele à fila.
- **Emissão** - manual: `POST /receipts` (um par) ou `POST /receipts/bulk` (até 100 por chamada). A
  conciliação não emite recibos. `POST /receipts/preview` (mesmo body) devolve o HTML do recibo tal
  como sairia, sem número e sem gravar nada ("Ver" e "Pré-visualizar" nos pendentes).
- **Numeração** - `AAAA/NNNNN` (coluna gerada `number`), sequencial por condomínio e ano; o ano é o
  da data do movimento. Atribuída sob `pg_advisory_xact_lock(hashtext(condominium_id), year)` com
  `MAX(sequence) + 1`; UNIQUE `(condominium_id, year, sequence)`.
- **Destinatários** - por defeito, ocupantes com `relationship_type` `owner` ou `resident` ativos na
  fração à data do movimento; inquilinos ficam de fora. Sem nenhum, a emissão falha (422). No
  "Emitir para…" o admin escolhe um único destinatário (`recipient` no body): qualquer ocupante da
  fração nessa data, inquilino incluído (`GET /receipts/recipient-options`), ou um nome/NIF/email
  inserido à mão. Fica marcado `chosen` no snapshot; o manual tem `occupantId` nulo. Código em
  [`recipients.ts`](../../src/apps/api/modules/admin/receipt/recipients.ts).
- **Imutabilidade** - condomínio, fração, destinatários, linhas e movimento ficam congelados em
  colunas `*_snapshot`. O PDF é gerado e guardado no S3 dentro da transação de emissão.
- **Email** - depois da transação, a cada destinatário com email e `receive_receipt_emails` ativo (o
  escolhido recebe sempre, também no re-envio); falhas de envio não desfazem a emissão. O
  destinatário manual não ganha convite nem link do portal, só o PDF anexo.
- **Anulação** - manual (`POST /receipts/:receiptId/void`, com motivo) ou automática no estorno do
  movimento (`voided_reason='bank_tx_reversed'`, ver
  [07-fluxo-imputacao.md](./07-fluxo-imputacao.md)). O número mantém-se e o PDF é substituído, na
  mesma `storage_key`, por uma versão com a tarja "ANULADO".
- **Ignorar** - `POST /receipts/skip` retira um par da fila sem emitir; `unskip` devolve-o.

## Exemplo

Condomínio com três frações ativas: A (permilagem 500), B (300) e C (200). `quota_day_of_month =
8`.

**Orçamento principal**, rubricas a somar 240 000 (2 400,00 EUR), FCR 10%, gerado para o ano
inteiro: 36 charges (12 meses x 3 frações).

```
mensal_com_fcr = 240 000 * 110 / 100 / 12 = 22 000

Fração   quota mensal   ledger na criação
A        11 000         Dr 2111 11 000 / Cr 721 10 000 / Cr 723 1 000
B         6 600         Dr 2111  6 600 / Cr 721  6 000 / Cr 723   600
C         4 400         Dr 2111  4 400 / Cr 721  4 000 / Cr 723   400
```

Pagamento integral da quota de Janeiro da fração A (movimento de +11 000):

```
Dr 121 10 000 / Dr 122 1 000 / Cr 2111 11 000
charge: settled_amount 11 000, open_amount 0, status paid
movimento bancário: reconciled
```

Pagamento parcial de 5 500 da mesma quota: Dr `121` 5 000 / Dr `122` 500 / Cr `2111` 5 500; a charge
fica `partial` com `open_amount` 5 500.

Crédito pré-existente: se a fração B tiver uma `credit_balance` em aberto de 5 000 quando nasce a
quota de 6 600, é criado um `charge_offset` de 5 000 (Dr `2782` / Cr `2111`). A quota fica `partial`
com `open_amount` 1 600 e o crédito fica `paid`.

**Arredondamento** - rubricas a somar 100 000 (1 000,00 EUR), FCR 10%: `mensal_com_fcr` = 9 166,67,
alvo 9 167. A distribuição arredondada dá 4 583 + 2 750 + 1 833 = 9 166; a fração A absorve a
diferença e fica com 4 584.

**Orçamento suplementar** de 100 000 (1 000,00 EUR) em 3 prestações: os valores são 33 333, 33 333 e
33 334.

```
Prestação   A        B        C       soma
1/3         16 666   10 000   6 667   33 333
2/3         16 666   10 000   6 667   33 333
3/3         16 667   10 000   6 667   33 334
```

Cada charge é `extraordinary_quota` e lança Dr `2112` / Cr `722` pelo seu valor.

## Invariantes

- A soma das quotas de um mês é exatamente `ROUND(mensal_com_fcr)`; a soma das prestações de um
  suplementar é exatamente `ROUND(total * (100 + fcr) / 100)`. Coberto pelos
  [testes unitários](../../src/apps/api/modules/admin/budget/quota_distribution_test.ts).
- Índice único `uq_charge_quota_unit_period_source`: uma só charge `quota` não cancelada por
  (`unit_id`, `competence_period`, `source_id`). Não abrange `extraordinary_quota`.
- Só um orçamento principal `approved` por condomínio e ano (trigger de aprovação).
- `finance.ledger` é escrito só por triggers e é append-only
  ([`014_ledger_immutability.sql`](../../src/db/components/014_ledger_immutability.sql)); cada
  evento lança débitos e créditos de soma igual.
- CHECKs em `finance.charge`: `original_amount > 0`, `open_amount >= 0`, `settled_amount >= 0`.
- Um settlement nunca excede o `open_amount` da charge nem o valor por conciliar do movimento:
  `validateSettlement` em TypeScript, com `finance.fn_settlement_bi` como rede de segurança.
- Nenhum settlement é inserido fora de `createSettlementInTx`: o estado da charge e do movimento não
  é mantido por trigger.
- `core.fn_block_closed_fiscal_year`
  ([`007_trg_fiscal_year.sql`](../../src/db/components/007_trg_fiscal_year.sql)) rejeita `INSERT` e
  `UPDATE` em `finance.charge` cujo `competence_period` caia num ano com
  `finance.fiscal_year.status
  = 'closed'`, e `INSERT` em `finance.ledger` cujo `entry_date` caia
  num ano fechado.
- A charge recebe `code` (`R` + 5 dígitos base 36) por `finance.fn_charge_assign_code`.

## Casos limite

- **Geração incremental** - repetir o pedido com `throughDate` maior cria só os meses em falta;
  repetir com a mesma data cria 0 charges.
- **Quota cancelada** - a verificação de existência não olha ao `status`: uma quota cancelada conta
  como existente e não volta a ser gerada.
- **Frações ou permilagens alteradas entre execuções** - só as charges em falta são criadas, com a
  distribuição atual; as já existentes não são recalculadas.
- **Fração eliminada** - a geração seleciona frações por `is_active = true` e não filtra
  `core.unit.deleted_at`; eliminar uma fração não altera `is_active`.
- **Vencimento já passado** - a quota nasce `overdue`.
- **Estado `overdue` gravado** - não é atualizado com a passagem do tempo. O "vencido" mostrado ao
  utilizador é outra regra: saldo em aberto e
  `due_date <=
  core.condominium.reconciled_through_date`
  ([ADR 0037](../adr/0037-charge-effective-status.md),
  [`charge_status.ts`](../../src/apps/panel/libs/charge_status.ts)).
- **Quota criada à mão sem orçamento** (`POST /charges` com `charge_type='quota'` e sem
  `source_id`) - sem FCR: Dr `2111` / Cr `721`.
- **Quota paga por crédito** - o `charge_offset` só move `2782` para `2111`. O dinheiro desse
  crédito entrou todo em `121` no `bank_deposit_credit`, por isso a parte FCR da quota não chega a
  `122` (ver [05-fluxo-fcr.md](./05-fluxo-fcr.md)).
- **Mudança de condómino** - a charge pertence à fração e não muda; os destinatários do recibo são
  os ocupantes ativos à data do movimento bancário.

## Limites conhecidos

- A única periodicidade é mensal: 12 meses no principal, N prestações consecutivas no suplementar.
- `core.budget_line.excluded_unit_categories` existe no schema mas não é lida: todas as frações
  ativas pagam todas as rubricas por permilagem.
- Não há cálculo automático de juros de mora.
- Não há API nem ecrã para criar ou fechar `finance.fiscal_year`.
- Não há rota para reverter um settlement isolado; um `charge_offset` não pode ser desfeito pela
  API.

## Referências

- [CONTEXT.md](../../CONTEXT.md) - glossário (charge, quota, settlement, offset, FCR, recibo).
- [ADR 0001](../adr/0001-financial-cascade-split.md) - triggers emitem ledger, TypeScript faz o
  resto.
- [ADR 0010](../adr/0010-quota-rounding-big-unit.md) - arredondamento absorvido pela maior fração.
- [ADR 0035](../adr/0035-auto-offset-ordering-distinct-from-allocation.md) - ordem do offset.
- [ADR 0037](../adr/0037-charge-effective-status.md) - estado efetivo da charge.
- Fluxos relacionados: [05 - FCR](./05-fluxo-fcr.md),
  [06 - conciliação](./06-fluxo-reconciliacao.md), [07 - imputação](./07-fluxo-imputacao.md).
- Testes: `test_api/api_admin_budget_generate_quotas_test.ts`, `test_api/api_admin_budget_test.ts`,
  `test_api/api_bank_balance_fcr_test.ts`, `test_sql/tests/0002_quota_double_entry.sql`,
  `0010_quota_unique.sql`, `0014_assembly_held_approve_budget.sql`, `0044_settlement_fcr_split.sql`,
  `0046_fcr_split_edge_cases.sql`.
