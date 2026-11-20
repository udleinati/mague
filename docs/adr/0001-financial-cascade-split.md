# ADR 0001 - Ledger de charge/settlement por triggers; state machine e algoritmos em TypeScript

## Contexto

O modelo financeiro assenta em três tabelas: `finance.charge` (o evento financeiro),
`finance.settlement` (a linha que salda uma charge contra um `bank_transaction` ou contra outra
charge) e `finance.ledger` (partidas dobradas, fonte de verdade de saldos e relatórios). Cada
operação tem dois tipos de efeito, com exigências opostas:

- **Lançamentos no ledger** - têm de acontecer sempre, seja qual for o caminho que escreve na tabela
  (API, script, psql, migration). Um lançamento em falta é um erro contabilístico silencioso.
- **Estado derivado e decisões de domínio** - contadores da charge, estado do `bank_transaction`,
  ordem de imputação, geração de quotas. Mudam com as regras de negócio e precisam de erros
  legíveis, de tipos e de testes unitários sem base de dados.

## Decisão

**Os lançamentos de charges e settlements são emitidos por triggers PL/pgSQL; a state machine e os
algoritmos de domínio vivem em TypeScript.** Nenhum dos lados duplica o outro.

### Em PL/pgSQL - `src/db/components/004_trg_financial.sql`

Os triggers emitem **todos os lançamentos que decorrem de uma charge ou de um settlement**; nenhum
código TypeScript os escreve. Todas as funções vivem no schema `finance`, com chamadas qualificadas
e `EXECUTE FUNCTION finance.fn_x()` nos triggers.

- `fn_charge_ai` (AFTER INSERT em `finance.charge`) - emite Dr/Cr `charge_created` para charges
  `nature='debit'`. Em quotas, o crédito reparte-se entre a conta de quotas (`721`) e a conta FCR
  (`723`) pela `fcr_percentage` do orçamento de origem; em refaturações, vai para a conta da despesa
  de origem. Charges `nature='credit'` não lançam nada na criação.
- `fn_charge_bu` (BEFORE UPDATE) - recusa cancelar uma charge com settlements ativos; ao cancelar,
  zera `amount`, `open_amount` e `settled_amount`.
- `fn_charge_au` (AFTER UPDATE) - quando uma charge `nature='debit'` passa a `cancelled`, emite o
  lançamento inverso (`charge_cancelled`) pelo `open_amount` que tinha. Uma charge a crédito não
  lançou nada na criação e não tem nada a anular.
- `fn_charge_amount_adjust_ledger` (AFTER UPDATE OF `original_amount`) - emite o delta
  (`charge_amount_adjusted`) quando o valor de uma charge payable é editado. Não atua em
  refaturações nem em charges canceladas.
- `fn_settlement_bi` (BEFORE INSERT em `finance.settlement`) - rede de segurança: `amount` positivo,
  não superior ao `open_amount` das charges envolvidas, e coerência por tipo:
  - `charge_offset`: `debit_charge_id` e `credit_charge_id`, sem `bank_transaction_id`;
  - `bank_reconciliation`: `bank_transaction_id` e exatamente uma das duas charges;
  - `bank_deposit_credit`: `bank_transaction_id` e `credit_charge_id`, sem `debit_charge_id`.
- `fn_settlement_ai` (AFTER INSERT) - emite Dr/Cr do settlement. Em `bank_reconciliation`, o lado
  bancário reparte-se entre a bolsa ordinária (`121`) e a bolsa FCR (`122`), via
  `fn_charge_fcr_split`.
- `fn_settlement_au` (AFTER UPDATE) - na transição `active` → `reversed`, emite o lançamento inverso
  (`settlement_reversed`).
- Helpers de leitura: `fn_charge_account`, `fn_counterparty_account`, `fn_charge_fcr_split`.

O ledger é append-only: `014_ledger_immutability.sql` rejeita UPDATE, DELETE e TRUNCATE. Uma
correção é sempre um lançamento novo (cancelamento, reversão, ajuste de valor).

As validações do trigger são um backstop. O TypeScript valida primeiro, com erros legíveis.

### Lançamentos escritos em TypeScript

Duas operações não têm charge de débito nem settlement a que um trigger se possa ligar. Escrevem as
duas pernas diretamente em `finance.ledger`, na transação da linha que as origina:

- **Saldo inicial de uma conta** (`bank_account/set_opening_balance.ts`) - cria charges
  `nature='credit'`, que `fn_charge_ai` não lança, e escreve Dr `121` / Cr `59` (bolsa ordinária) e
  Dr `122` / Cr `581` (bolsa FCR), com `entry_type='openingBalance'`.
- **Transferência entre bolsas** (`fcr_transfer/create.ts`) - não há charge nem `bank_transaction`.
  Insere `finance.fcr_transfer` e escreve Dr/Cr entre `121` e `122`, com `entry_type='fcrTransfer'`
  e `ref_type='fcr_transfer'`.

São as únicas escritas diretas no ledger fora dos triggers.

### Em TypeScript - `src/apps/api/modules/admin/`

**Seam de settlements.** `createSettlementInTx` (`settlement/operation.ts`, exposto por
`settlement/mod.ts`) é o único sítio que insere em `finance.settlement`. Na mesma transação:
validação com `SELECT ... FOR UPDATE` das charges e do `bank_transaction`, que têm de ser do
condomínio do pedido → INSERT (o trigger emite o ledger) → `applySettlementEffects`. Todos os
produtores passam por aqui: conciliação manual, imputação, excedente, auto-offset e reembolso de
fornecedor. `reverseSettlement` é o equivalente para reverter. Os outros módulos importam de
`settlement/mod.ts`, nunca dos ficheiros internos.

**State machine** (`settlement/effects.ts`; transições puras em `settlement/effects_math.ts`).
Depois de cada settlement, atualiza `settled_amount`, `open_amount`, `amount` e `status` da charge e
o `status` do `bank_transaction`, nos dois sentidos. Regras que não são simplificáveis:

- `charge_offset` mexe em `settled_amount` e `open_amount`, nunca em `charge.amount`.
- `bank_reconciliation` altera `charge.amount` e recalcula `open_amount` a partir de
  `expected_amount` (charge do lado débito) ou `original_amount` (lado crédito) menos o liquidado.
  Não usa `open - amount`, para não acumular desvios depois de refaturações e ajustes.
- `bank_deposit_credit`: a criação deixa a charge de crédito intacta (o `open_amount` fica
  disponível para offsets futuros). A reversão cancela essa charge, e é recusada com 409 se o
  crédito já tiver sido consumido por offsets ativos - esses revertem-se primeiro.
- `computeBankTxStatus`: numa reversão, um `bank_transaction` já `reversed` mantém-se `reversed`; na
  criação não há essa guarda, para que um `bank_transaction` revertido possa voltar a ser
  conciliado.
- `computeChargeStatus` (`settlement/charge_status.ts`) é a única definição do estado da charge
  depois de um settlement. Não existe equivalente em SQL e não se cria um. Na criação, os geradores
  de quotas e de recorrentes gravam `overdue` se o vencimento já passou e `open` caso contrário. O
  "vencido" mostrado na UI segue outra regra - ver [ADR 0037](./0037-charge-effective-status.md).

**Auto-offset** (`charge/auto_offset.ts`, `applyAutoOffset`). Salda uma charge receivable nova
contra charges de natureza oposta em aberto na mesma fração, criando settlements `charge_offset`.
Nenhum trigger o faz: é uma chamada explícita, na transação que cria a charge. Chamam-no
`charge/create.ts`, `budget/quota_generator.ts` e `recurring_template/generator.ts`;
`charge/create_refacturations.ts` não o chama. `charge/cancel.ts` também o chama, para as charges
que a charge cancelada deixou livres. Ordem do offset:
[ADR 0035](./0035-auto-offset-ordering-distinct-from-allocation.md).

**Algoritmos e orquestradores**

- Imputação: `allocation/plan.ts` (`planAllocation`, pura, prioridade do Art. 784.º CC);
  `allocation/execute.ts` executa o plano em transação; `allocation/preview.ts` reutiliza a mesma
  elegibilidade e ordem no dry-run.
- Geração de quotas: `budget/quota_generator.ts` (`runQuotaGeneration`, chamado por
  `POST /budgets/:budgetId/generate_quotas`). É incremental até `throughDate` e idempotente por
  orçamento, fração e competência. A distribuição por permilagem vive em
  `budget/quota_distribution.ts` ([ADR 0010](./0010-quota-rounding-big-unit.md)).
- Geração recorrente: `recurring_template/generator.ts` (`runRecurringGeneration`) e
  `recurring_template/date_helpers.ts`.
- Estorno de um `bank_transaction`: `bank_transaction/reverse.ts`. Numa transação, marca-o como
  `reversed`, chama `reverseSettlement` para cada settlement ativo e anula os recibos emitidos
  contra ele.
- Cancelamento de charge: `charge/cancel.ts`, numa transação, reverte os offsets da charge
  (`reverseSettlement`), muda o `status` para `cancelled` com a justificação (`cancellation_reason`)
  e volta a aplicar o auto-offset às charges que ficaram livres; os triggers zeram os montantes e
  emitem o lançamento inverso. Um settlement com movimento bancário bloqueia (reverte-se o
  movimento).

### Onde colocar uma regra nova

- Lançamento que decorre de uma charge ou de um settlement → `004_trg_financial.sql`.
- Calcula, decide ou agenda → TypeScript, com os helpers puros extraídos e testados
  (`quota_distribution.ts` é o modelo).
- Cria um settlement → `createSettlementInTx` (ou `createSettlement`, que abre a transação).
- Cria charges receivable com fração → decide explicitamente se chama `applyAutoOffset` na mesma
  transação.
- Cascata entre tabelas que não envolve o ledger → orquestrador em TypeScript, não trigger.

## Consequências

- **Um INSERT direto em `finance.settlement`** (psql, script, migration) emite o ledger mas não
  atualiza a charge nem o `bank_transaction`: o estado fica dessincronizado. Do mesmo modo, um
  INSERT direto de charge não corre o auto-offset.
- **pgTAP cobre só o que existe na base de dados** (`test_sql/tests/`): emissão do ledger, split
  FCR, imutabilidade, constraints, views. Os fluxos que atravessam a cascata em TypeScript são
  validados por `test_api/`, contra a API real.
- **Uma migration não pode contar com a versão das funções que está nos components** - ver
  [ADR 0008](./0008-migrations-vs-components.md).
- Há mais round-trips por operação (o UPDATE da charge é separado do INSERT do settlement).
- `005_trg_budget_quotas.sql` e `009_trg_recurring.sql` contêm apenas `DROP ... IF EXISTS`: garantem
  que nenhuma base de dados mantém geradores em trigger.

## Alternativas rejeitadas

1. **Tudo em PL/pgSQL** (ledger, contadores, auto-offset, geradores, imputação). Os algoritmos ficam
   opacos (a prioridade de imputação num `ORDER BY CASE`), as validações chegam ao handler como
   erros genéricos de base de dados, cada handler tem de conhecer os efeitos laterais dos triggers
   para os desfazer, e nada é testável sem base de dados.
2. **Tudo em TypeScript, incluindo o ledger de charges e settlements.** Esses lançamentos passam a
   depender de cada caller estar correto; um INSERT direto de charge ou settlement salta-os sem
   erro.
3. **Triggers condicionados por flag de sessão, ou helpers SQL de teste que replicam a cascata.**
   São duas implementações da mesma regra: a versão SQL deixa de acompanhar a TypeScript e os testes
   passam a validar código que não corre em produção.

## Sinais de alerta para code review

- `insert(schema.settlement)` fora de `settlement/operation.ts` (falha em
  `settlement/seam_guard_test.ts`), ou import de ficheiros internos de `settlement/`.
- `insert(schema.ledger)` em TypeScript fora de `bank_account/set_opening_balance.ts` e
  `fcr_transfer/create.ts`; lançamento de charge ou settlement emitido fora de
  `004_trg_financial.sql`; UPDATE ou DELETE no ledger.
- Trigger novo que atualiza contadores de charge ou o estado de `bank_transaction`, ou que cria
  settlements ou charges.
- Função financeira PL/pgSQL sem o prefixo `finance.`.
- Transição de estado da charge após um settlement reimplementada fora de `computeChargeStatus`.
- Teste pgTAP que recria em SQL lógica que vive em TypeScript.

## Referências

- Triggers: [`004_trg_financial.sql`](../../src/db/components/004_trg_financial.sql),
  [`014_ledger_immutability.sql`](../../src/db/components/014_ledger_immutability.sql).
- Settlements: [`settlement/`](../../src/apps/api/modules/admin/settlement/) (`mod.ts`,
  `operation.ts`, `validate.ts`, `effects.ts`, `effects_math.ts`, `charge_status.ts`).
- Lançamentos em TypeScript:
  [`set_opening_balance.ts`](../../src/apps/api/modules/admin/bank_account/set_opening_balance.ts),
  [`fcr_transfer/create.ts`](../../src/apps/api/modules/admin/fcr_transfer/create.ts); testes em
  `test_sql/tests/0064_fcr_transfer.sql` e `test_api/api_bank_balance_fcr_test.ts`.
- Testes unitários: `settlement/effects_math_test.ts`, `settlement/charge_status_test.ts`,
  `settlement/validate_test.ts`, `allocation/plan_test.ts`, `budget/quota_distribution_test.ts`.
- Testes de API: `test_api/api_admin_ledger_invariants_test.ts`,
  `api_admin_allocation_priority_test.ts`, `api_admin_bank_reverse_test.ts`,
  `api_admin_reconciliation_flows_test.ts`, `api_admin_budget_generate_quotas_test.ts`,
  `api_admin_recurring_generation_test.ts`.
- pgTAP: `test_sql/tests/0002_quota_double_entry.sql`, `0015_charge_amount_adjust_ledger.sql`,
  `0044_settlement_fcr_split.sql`, `0045_ledger_immutability.sql`.
- Flows de domínio: [`docs/flows/`](../flows/).
