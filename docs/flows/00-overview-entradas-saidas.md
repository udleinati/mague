# 00 - Visão Geral: Entradas, Saídas e Ledger

Mapa do modelo financeiro: que tabelas guardam o quê, quem escreve em `finance.ledger` e que contas
cada evento movimenta. É o ponto de partida para os fluxos detalhados:
[01 - quotas](./01-fluxo-quotas.md), [02 - despesas](./02-fluxo-despesas.md),
[03 - suspense](./03-fluxo-suspense.md), [05 - FCR](./05-fluxo-fcr.md),
[06 - conciliação](./06-fluxo-reconciliacao.md) e [07 - imputação](./07-fluxo-imputacao.md).

## Modelo

### Camadas

| Camada         | Tabela                     | Papel                                                    |
| -------------- | -------------------------- | -------------------------------------------------------- |
| Operacional    | `finance.charge`           | O que é devido, a receber ou a pagar                     |
| Bancária       | `finance.bank_transaction` | Movimento real de uma `finance.bank_account`. Dado bruto |
| Ligação        | `finance.settlement`       | Liga `bank_transaction ↔ charge` ou `charge ↔ charge`    |
| Contabilística | `finance.ledger`           | Partidas dobradas, append-only                           |

```
finance.charge ──── INSERT / anulação ───► fn_charge_ai / fn_charge_au ───────┐
      ▲                                                                       │
      │ debit_charge_id / credit_charge_id                                    ▼
finance.settlement ─ INSERT / reversão ──► fn_settlement_ai / _au ───► finance.ledger
      │ bank_transaction_id                                                   ▲
      ▼                                                                       │
finance.bank_transaction   (sem trigger de ledger - D14)                      │
                                                                              │
handlers TS: saldo de abertura, transferência entre bolsas ───────────────────┘
```

Tabelas de apoio: `finance.chart_of_account` (plano de contas), `finance.fcr_transfer`,
`finance.fiscal_year`, `finance.bank_import_batch`, `finance.receipt` + `finance.receipt_skip`,
`finance.charge_code_counter`, `core.budget` + `core.budget_line`, `core.recurring_template`,
`core.quota_generation_run`, `core.recurring_generation_run`. O schema completo está em
[`001_bootstrap.sql`](../../src/db/migrations/001_bootstrap.sql).

### `finance.charge`

| Coluna                                        | Significado                                                   |
| --------------------------------------------- | ------------------------------------------------------------- |
| `kind`                                        | `receivable` ou `payable`                                     |
| `nature`                                      | `debit` (dívida) ou `credit` (crédito a favor da contraparte) |
| `charge_type`                                 | Origem da charge. `varchar(40)` sem CHECK (ver tabela abaixo) |
| `scope`                                       | `unit` quando há `unit_id`, senão `condominium`               |
| `status`                                      | `open`, `partial`, `paid`, `overdue`, `cancelled`, `disputed` |
| `competence_period`                           | Mês a que a charge pertence (`date`, primeiro dia do mês)     |
| `original_amount`, `expected_amount`          | Valor da charge em cêntimos                                   |
| `settled_amount`, `open_amount`, `amount`     | Liquidado, em aberto e conciliado com o banco (cêntimos)      |
| `account_id`                                  | Rubrica do plano de contas (despesas)                         |
| `source_type` + `source_id`                   | Origem: `budget`, `recurring_template`, `refacturation`, etc. |
| `unit_id`, `supplier_id`, `budget_id`, `code` | Fração, fornecedor, orçamento imputado, código humano         |

Origem das charges:

| Origem                         | `kind` / `nature`   | `charge_type`                 | Criada por                            |
| ------------------------------ | ------------------- | ----------------------------- | ------------------------------------- |
| Quota ordinária                | receivable / debit  | `quota`                       | `budget/quota_generator.ts`           |
| Quota extraordinária           | receivable / debit  | `extraordinary_quota`         | `budget/quota_generator.ts`           |
| Refaturação                    | receivable / debit  | `refacturation`               | `charge/create_refacturations.ts`     |
| Recorrente a receber           | receivable / debit  | `recurring_fee`               | `recurring_template/generator.ts`     |
| Saldo anterior em dívida       | receivable / debit  | `opening_balance_debit`       | `charge/create.ts`                    |
| Crédito manual à fração        | receivable / credit | `credit_adjustment`           | `charge/create.ts`                    |
| Excedente de um pagamento      | receivable / credit | `credit_balance`              | `allocation/execute.ts`               |
| Saldo de abertura de uma conta | receivable / credit | `openingBalance`              | `bank_account/set_opening_balance.ts` |
| Despesa avulsa                 | payable / debit     | `supplier_service`, `expense` | `charge/create.ts`                    |
| Despesa recorrente             | payable / debit     | `supplier_service`            | `recurring_template/generator.ts`     |
| Nota de crédito de fornecedor  | payable / credit    | `supplier_service`            | `bank_transaction/refund_supplier.ts` |

Os caminhos são relativos a [`src/apps/api/modules/admin/`](../../src/apps/api/modules/admin/).
`POST /charges` aceita qualquer `chargeType`; se vier omitido, `charge/defaults.ts` infere
`supplier_service` (payable com fornecedor), `expense` (payable sem fornecedor) ou `quota`
(receivable).

### `finance.settlement`

| `settlement_type`     | Pontas                                            | Uso                             |
| --------------------- | ------------------------------------------------- | ------------------------------- |
| `bank_reconciliation` | movimento + uma charge (a débito ou a crédito)    | Conciliação / imputação         |
| `charge_offset`       | charge a débito + charge a crédito, sem movimento | Offset de crédito da fração     |
| `bank_deposit_credit` | movimento + charge a crédito                      | Excedente guardado como crédito |

`status` é `active` ou `reversed`. A API não apaga settlements: reverte-os.

### `finance.bank_transaction`

Movimento de uma `finance.bank_account` (`kind='bank'` ou `'cash'`), importado de extrato
(`bank_account/import_commit.ts`, deduplicado por `import_hash`) ou inserido à mão
(`bank_transaction/create.ts`). `amount` positivo é entrada, negativo é saída. `status`:
`unreconciled`, `partial`, `reconciled`, `ignored`, `reversed`.

### Plano de contas (D12)

`finance.chart_of_account` é híbrido: contas globais (`condominium_id IS NULL`, semeadas por
[`000a_chart_of_account_global.sql`](../../src/db/seeds/000a_chart_of_account_global.sql), padrão
SNC) e contas próprias de cada condomínio. A API (`chart_of_account/`) lista as duas e só deixa
criar, editar e eliminar as do condomínio. O ledger guarda o `code`, não o `id`.

Contas que os triggers e handlers movimentam:

| Código                 | Conta                                                                |
| ---------------------- | -------------------------------------------------------------------- |
| `121`                  | Depósitos à ordem - bolsa ordinária                                  |
| `122`                  | Depósitos à ordem - bolsa FCR                                        |
| `2111`, `2112`, `2113` | Condóminos - quotas ordinárias, quotas extraordinárias, refaturações |
| `2211`                 | Fornecedores a pagar                                                 |
| `2782`                 | Outros credores (créditos de frações)                                |
| `2789`                 | Valores a classificar                                                |
| `581`                  | Fundo Comum de Reserva (capital próprio)                             |
| `59`                   | Resultados transitados                                               |
| `6...`                 | Gastos: a rubrica (`account_id`) da despesa                          |
| `721`, `722`, `723`    | Quotas ordinárias, quotas extraordinárias, contribuições FCR         |
| `7888`                 | Outras receitas                                                      |

### Views

- `finance.v_unit_balance` (sobre `finance.charge`): por fração, `open_debt_cents`,
  `open_credit_cents`, `overdue_debt_cents` e `net_cents` (positivo = a fração deve). Uma dívida
  conta como vencida quando `due_date <= core.condominium.reconciled_through_date`.
- `finance.v_bank_balance` (sobre `finance.ledger`): por condomínio, `ordinary_cents` (conta `121`),
  `fcr_cents` (conta `122`) e `total_cents`.
- `finance.balance_unit` e `finance.balance_supplier` (sobre `finance.charge`): valor em aberto por
  fração e por fornecedor, corrente vs futuro.
- `finance.v_budget_quota_map`: quota por fração e por orçamento, a partir da permilagem.

A API usa `v_unit_balance` para o saldo de cada fração e `v_bank_balance` para o saldo das bolsas;
ambas estão em [`016_vw_receipt_pending.sql`](../../src/db/components/016_vw_receipt_pending.sql).
As restantes estão em [`006_views_balance.sql`](../../src/db/components/006_views_balance.sql) e
[`012_view_budget_quota_map.sql`](../../src/db/components/012_view_budget_quota_map.sql).

## Fluxo

### Quem escreve o ledger

| Evento                                         | Emissor                                       | `entry_type`             |
| ---------------------------------------------- | --------------------------------------------- | ------------------------ |
| INSERT de charge com `nature='debit'`          | trigger `fn_charge_ai`                        | `charge_created`         |
| Charge `nature='debit'` passa a `cancelled`    | trigger `fn_charge_au`                        | `charge_cancelled`       |
| UPDATE de `original_amount` (payable a débito) | trigger `fn_charge_amount_adjust_ledger`      | `charge_amount_adjusted` |
| INSERT de settlement `bank_reconciliation`     | trigger `fn_settlement_ai`                    | `bank_reconciliation`    |
| INSERT de settlement `bank_deposit_credit`     | trigger `fn_settlement_ai`                    | `bank_deposit_credit`    |
| INSERT de settlement `charge_offset`           | trigger `fn_settlement_ai`                    | `settlement_applied`     |
| Settlement passa a `reversed`                  | trigger `fn_settlement_au`                    | `settlement_reversed`    |
| Saldo de abertura de uma conta                 | handler `bank_account/set_opening_balance.ts` | `openingBalance`         |
| Transferência entre bolsas                     | handler `fcr_transfer/create.ts`              | `fcrTransfer`            |

Os triggers vivem em [`004_trg_financial.sql`](../../src/db/components/004_trg_financial.sql). Só
emitem ledger e validam o mínimo (`fn_settlement_bi`, `fn_charge_bu`). A máquina de estados e os
algoritmos são TypeScript ([ADR 0001](../adr/0001-financial-cascade-split.md)):

- `settlement/operation.ts` (`createSettlementInTx`) é o único caminho para criar settlements:
  valida (`settlement/validate.ts`), insere (o trigger emite o ledger) e aplica os efeitos
  (`settlement/effects.ts`): `settled_amount`, `open_amount`, `amount` e `status` da charge, e
  `status` do movimento.
- `settlement/charge_status.ts` (`computeChargeStatus`) é a regra do `status` gravado: `paid` quando
  `open_amount <= 0`, `partial` quando já há valor liquidado, `overdue` quando `due_date` é anterior
  a hoje, senão `open`. `cancelled` e `disputed` não mudam.
- `charge/auto_offset.ts` (`applyAutoOffset`) corre depois de cada charge receivable com fração e
  liga-a a charges de natureza oposta em aberto (`charge_offset`).
- `allocation/` faz a imputação de um movimento a uma fração ou fornecedor;
  `bank_transaction/reverse.ts` faz o estorno em cascata.
- `budget/quota_generator.ts` e `recurring_template/generator.ts` geram as charges de quotas e de
  modelos recorrentes.

### Que contas cada charge usa

`finance.fn_charge_account(kind, nature, charge_type, account_id)` dá a conta principal:

| Condição                                                     | Conta                    |
| ------------------------------------------------------------ | ------------------------ |
| `charge_type='unclassified'`                                 | `2789`                   |
| receivable `quota` / `extraordinary_quota` / `refacturation` | `2111` / `2112` / `2113` |
| receivable de outro tipo, `nature='credit'`                  | `2782`                   |
| receivable de outro tipo, `nature='debit'`                   | `2111`                   |
| payable com `account_id`                                     | `code` dessa conta       |
| payable sem `account_id`                                     | `2211`                   |

`finance.fn_counterparty_account(kind, charge_type)` dá a contrapartida da criação:

| Condição                  | Contrapartida                                                 |
| ------------------------- | ------------------------------------------------------------- |
| `quota`                   | `721`, com a parte FCR em `723` (ver [05](./05-fluxo-fcr.md)) |
| `extraordinary_quota`     | `722`                                                         |
| `opening_balance_debit`   | `59`                                                          |
| `refacturation`           | Conta principal da despesa de origem                          |
| `unclassified`            | Sentinela `BANK_ONLY` (ver [03](./03-fluxo-suspense.md))      |
| qualquer outro payable    | `2211`                                                        |
| qualquer outro receivable | `unknown`                                                     |

Nos settlements, a perna da charge usa sempre a conta principal; a perna bancária usa `121`, com a
parte FCR em `122` quando a charge é uma quota com FCR (`fn_charge_fcr_split`).

### Lançamentos por evento

Valores em cêntimos. Orçamento com FCR de 10%, despesa com a rubrica `6241`.

| #  | Evento                                    | `entry_type`          | Débito                   | Crédito                 |
| -- | ----------------------------------------- | --------------------- | ------------------------ | ----------------------- |
| 1  | Quota ordinária de 11000                  | `charge_created`      | `2111` 11000             | `721` 10000, `723` 1000 |
| 2  | Pagamento da quota (movimento +11000)     | `bank_reconciliation` | `121` 10000, `122` 1000  | `2111` 11000            |
| 3  | Quota extraordinária de 12500             | `charge_created`      | `2112` 12500             | `722` 12500             |
| 4  | Despesa de 30000                          | `charge_created`      | `6241` 30000             | `2211` 30000            |
| 5  | Refaturação de 10000 da despesa 4         | `charge_created`      | `2113` 10000             | `6241` 10000            |
| 6  | Pagamento da despesa 4 (movimento -30000) | `bank_reconciliation` | `6241` 30000             | `121` 30000             |
| 7  | Excedente de 5000 num pagamento           | `bank_deposit_credit` | `121` 5000               | `2782` 5000             |
| 8  | Offset desse crédito com uma quota        | `settlement_applied`  | `2782` 5000              | `2111` 5000             |
| 9  | Devolução de 5000 do fornecedor           | `bank_reconciliation` | `121` 5000               | `6241` 5000             |
| 10 | Anulação de despesa de 30000 por pagar    | `charge_cancelled`    | `2211` 30000             | `6241` 30000            |
| 11 | Saldo de abertura (30000 + 10000 FCR)     | `openingBalance`      | `121` 30000, `122` 10000 | `59` 30000, `581` 10000 |
| 12 | Transferência de 5000 para a bolsa FCR    | `fcrTransfer`         | `122` 5000               | `121` 5000              |

As charges com `nature='credit'` (linhas 7 e 9, e os créditos manuais) não emitem ledger quando são
criadas; só os settlements que as envolvem. As datas do ledger são `issue_date` na criação da
charge, `settlement_date` no settlement e a data corrente em anulações, reversões e ajustes.

## Regras-base

Os identificadores são citados noutros documentos de fluxo e em comentários do código.

- **D8 - A charge é a porta de entrada.** Um valor só chega ao ledger através de uma
  `finance.charge` e dos settlements que a liquidam; as linhas são emitidas pelos triggers sobre
  `charge` e `settlement`. As exceções são duas escritas feitas por handlers TypeScript: o saldo de
  abertura (ancorado numa charge `openingBalance`) e a transferência entre bolsas (sem charge).
- **D14 - `bank_transaction` não gera ledger.** Importar ou inserir um movimento só cria a linha com
  `status='unreconciled'`. As contas `121` e `122` só se movem quando um settlement liga o movimento
  a uma charge.
- **D1 - Valores a classificar não têm tabela própria.** O único suporte é a conta `2789` e o
  `charge_type='unclassified'` nas funções de mapeamento. Ver [03](./03-fluxo-suspense.md).
- **D4 - FCR aditivo.** A quota ordinária cobrada é `ordinário + ordinário × fcr%`, com
  `core.budget.fcr_percentage` (default `10.00`). A charge é uma só; o ledger separa `721` e `723`.
- **D6 - Bolsas, não contas bancárias.** A separação ordinário/FCR é contabilística (`121` vs `122`)
  e agregada por condomínio. Ver [05](./05-fluxo-fcr.md).
- **D12 - Plano de contas híbrido.** Contas globais mais contas do condomínio (acima).

Outras regras transversais:

- **Quotas extraordinárias em prestações.** Um orçamento suplementar (`type='suplementar'`, com
  `parent_budget_id`) é cobrado em `installments` prestações mensais consecutivas (1 a 120) a partir
  de `first_competence_period`, sem FCR. Ver [01](./01-fluxo-quotas.md).
- **Cêntimos.** Todos os montantes são `integer` em cêntimos de euro. Não há coluna de moeda.
- **Multi-tenant.** Tudo é filtrado por `condominium_id`, vindo do path. O trigger
  `core.fn_tenant_guard`
  ([`020_trg_tenant_guard.sql`](../../src/db/components/020_trg_tenant_guard.sql)) rejeita
  referências a entidades de outro condomínio.
- **Competência.** O rendimento e o gasto são lançados quando a charge é criada, e o mês a que
  pertencem fica em `competence_period`. O pagamento só move banco contra a conta da charge: receber
  hoje uma quota de um ano anterior não toca em contas de rendimento.
- **Despesa acima do orçamentado não é bloqueada.** O relatório Execução por Ata
  (`report/assembly_execution.ts`) mostra a percentagem executada e assinala quando passa de 100%.

## Orçamento e ano fiscal

- `core.budget.status` é `draft`, `approved` ou `not_approved`. Só se edita em `draft`. Passa a
  `approved` pelo trigger `core.fn_assembly_held_approve_budgets` quando a assembleia fica `held` e
  tem um ponto `item_type='approve_budget'`, `approved=true`, `ref_type='budget'`; o orçamento tem
  de ter linhas e só pode haver um principal aprovado por ano. `draft ⇄ not_approved` é manual
  (`budget/reject.ts`, `budget/reopen.ts`). Só um orçamento `approved` gera quotas.
- `finance.fiscal_year.status` é `open`, `closing` ou `closed`. O trigger
  `core.fn_block_closed_fiscal_year`
  ([`007_trg_fiscal_year.sql`](../../src/db/components/007_trg_fiscal_year.sql)) rejeita INSERT e
  UPDATE em `finance.charge` (pelo ano de `competence_period`) e em `finance.ledger` (pelo ano de
  `entry_date`) quando o ano tem linha `closed`. Sem linha para o ano, nada é bloqueado: uma charge
  pode ter `competence_period` num ano anterior enquanto esse ano não estiver fechado.

## Invariantes

1. Cada evento emite linhas com Σ débitos = Σ créditos para o mesmo `ref_type` + `ref_id`.
2. `finance.ledger` é append-only: UPDATE, DELETE e TRUNCATE são rejeitados
   ([`014_ledger_immutability.sql`](../../src/db/components/014_ledger_immutability.sql)). Corrigir
   é lançar de novo (`charge_cancelled`, `settlement_reversed`, `charge_amount_adjusted`).
3. Settlements criam-se só por `createSettlementInTx`. Um INSERT direto emite ledger mas deixa a
   charge e o movimento com o estado por atualizar.
4. O valor de um settlement nunca excede o que falta alocar do movimento nem, em
   `bank_reconciliation` e `charge_offset`, o `open_amount` das charges envolvidas.
5. Uma charge com settlements ativos não pode ser anulada (`fn_charge_bu`). `charge/cancel.ts` exige
   justificação, reverte primeiro os offsets da charge e recusa se houver um settlement com
   movimento bancário.
6. O valor de uma charge só é editável em payables a débito, sem refaturação e sem valor liquidado
   (`charge/update.ts`).
7. Uma refaturação aponta para uma charge payable do mesmo condomínio e com a mesma rubrica
   ([`008_trg_refacturation.sql`](../../src/db/components/008_trg_refacturation.sql)).
8. `original_amount`, `settlement.amount` e `ledger.amount` são sempre positivos (CHECK).

## Limites conhecidos

- **Contrapartidas por mapear.** Uma charge receivable a débito de tipo diferente de `quota`,
  `extraordinary_quota`, `refacturation` e `opening_balance_debit` (por exemplo `recurring_fee` ou
  `interest`) é lançada a crédito de `account_code='unknown'`; uma `unclassified`, a crédito de
  `'BANK_ONLY'`. Nenhum dos dois existe no plano de contas. As contas de rendas, juros bancários,
  subsídios e indemnizações do plano global não são usadas por nenhum trigger.
- **Pagamento de despesas.** O settlement debita a conta principal da charge. Numa despesa com
  rubrica, é a conta de gasto que volta a ser debitada (linha 6 da tabela) e a `2211` creditada na
  criação fica por saldar.
- **Juros de mora.** Não há geração automática. O tipo `interest` só é reconhecido na ordem de
  prioridade da imputação e do auto-offset.
- **Incobráveis.** Não há lançamento de perda. Anular a charge reverte o lançamento original.
- **Devolução a condómino.** Não há endpoint dedicado nem ecrã no Panel para devolver dinheiro a uma
  fração.
- **Ano fiscal.** Não há API nem ecrã para criar ou fechar `finance.fiscal_year`.

## Referências

- [ADR 0001](../adr/0001-financial-cascade-split.md) - triggers emitem o ledger, TypeScript faz o
  resto.
- [ADR 0010](../adr/0010-quota-rounding-big-unit.md) - arredondamento das quotas.
- [ADR 0035](../adr/0035-auto-offset-ordering-distinct-from-allocation.md) - ordem do auto-offset vs
  imputação.
- [`CONTEXT.md`](../../CONTEXT.md) - vocabulário (charge, settlement, conciliação, imputação).
- Testes: [`test_sql/tests/`](../../test_sql/tests/) (`0002_quota_double_entry.sql`,
  `0015_charge_amount_adjust_ledger.sql`, `0044_settlement_fcr_split.sql`,
  `0045_ledger_immutability.sql`, `0006_fiscal_year_block.sql`) e [`test_api/`](../../test_api/)
  (`api_admin_ledger_invariants_test.ts`, `api_admin_reconciliation_flows_test.ts`,
  `api_admin_charge_cancel_test.ts`).
