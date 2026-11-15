# 05 - Fluxo do Fundo Comum de Reserva (FCR)

Como o FCR existe no sistema: a contribuição dentro de cada quota ordinária, a bolsa FCR no ledger,
a transferência entre bolsas e o que acontece quando o fundo é usado. O FCR é uma obrigação legal
com um mínimo de 10% **sobre** as contribuições ordinárias e só deve ser usado em conservação e
reparação das partes comuns. Regras de base em [00 - visão geral](./00-overview-entradas-saidas.md)
(D4, D6); a geração de quotas está em [01 - quotas](./01-fluxo-quotas.md).

## Modelo

- `core.budget.fcr_percentage` (`numeric(5,2)`, default `10.00`): percentagem de FCR, aditiva sobre
  o orçamento (D4).
- Conta `723` (rendimento): contribuição FCR, a parte FCR de cada quota.
- Conta `122` (ativo): bolsa FCR, o dinheiro reservado ao fundo. A conta `121` é a bolsa ordinária.
- Conta `581` (capital próprio): fundo FCR. Só recebe a parte FCR do saldo de abertura.
- `finance.v_bank_balance`: `ordinary_cents`, `fcr_cents` e `total_cents` por condomínio.
- `finance.fcr_transfer`: reclassificação entre bolsas (DF4). Colunas: `direction` (`to_fcr` ou
  `to_ordinary`), `amount_cents` (> 0), `transfer_date`, `reason` (obrigatório), `created_by`,
  `created_at`.
- `core.assembly_agenda_item.item_type='approve_fcr_usage'`: ponto da ordem do dia sobre o uso do
  fundo.

As bolsas são contabilísticas e agregadas por condomínio (D6): `finance.bank_account` não distingue
contas ordinárias de contas FCR.

## Fluxo

Os caminhos de ficheiros são relativos a
[`src/apps/api/modules/admin/`](../../src/apps/api/modules/admin/); os triggers estão em
[`004_trg_financial.sql`](../../src/db/components/004_trg_financial.sql).

### 1. Contribuição: dentro da quota ordinária

- **Geração** (`budget/quota_generator.ts`, `budget/quota_distribution.ts`). O valor mensal de um
  orçamento principal é `Σ budget_line.annual_amount × (100 + fcr%) / 100 / 12`, distribuído pelas
  frações por permilagem. Cada fração recebe uma só charge `quota` por mês, já com o FCR incluído.
- **Ledger na criação** (`fn_charge_ai`). O trigger lê o `fcr_percentage` do orçamento em
  `source_id` e separa a charge: `ordinário = ROUND(original_amount / (1 + fcr% / 100))` e
  `fcr = original_amount - ordinário`. Emite débito em `2111` pelo total, crédito em `721` pela
  parte ordinária e crédito em `723` pela parte FCR.

Exemplo: orçamento anual de 120000 cêntimos, FCR 10%, uma só fração. Quota mensal de 11000: débito
`2111` 11000, crédito `721` 10000, crédito `723` 1000.

Um orçamento suplementar tem sempre `fcr_percentage = 0.00` (`budget/create.ts`, `budget/update.ts`)
e gera charges `extraordinary_quota`, sem parte FCR.

### 2. Recebimento: a parte FCR vai para a bolsa `122`

Quando um settlement `bank_reconciliation` liga um movimento à quota, `fn_settlement_ai` chama
`fn_charge_fcr_split(charge_id, amount)`, que lê as linhas `charge_created` da charge e reparte o
valor recebido na mesma proporção: `fcr_part = ROUND(amount × Σ723 / (Σ723 + Σ721))` e
`ord_part = amount - fcr_part`.

| Recebimento da quota de 11000       | Débito                  | Crédito      |
| ----------------------------------- | ----------------------- | ------------ |
| Pagamento total (movimento +11000)  | `121` 10000, `122` 1000 | `2111` 11000 |
| Pagamento parcial (movimento +5500) | `121` 5000, `122` 500   | `2111` 5500  |

A reversão do settlement (`fn_settlement_au`) emite as linhas inversas com a mesma repartição.

### 3. Saldo das bolsas

- `finance.v_bank_balance` soma as linhas de ledger das contas `121` e `122`.
- `GET /bank-accounts/balances` (`bank_account/get_balances.ts`) devolve `ordinaryCents`, `fcrCents`
  e `totalCents`; o Panel mostra-os em Contas bancárias.
- Os relatórios Movimentos do ano (`report/cash_movements.ts`) e Previsão de tesouraria
  (`report/cashflow.ts`) apresentam as duas bolsas em separado.
- O saldo de abertura de uma conta (`POST /bank-accounts/:id/opening-balance`,
  `bank_account/set_opening_balance.ts`) entra repartido: débito `121` / crédito `59` pela parte
  ordinária e débito `122` / crédito `581` pela parte FCR.

### 4. Transferência entre bolsas (DF4)

Reclassifica quanto do saldo está reservado ao fundo. Nenhum dinheiro sai do banco.

```
Panel: Contas bancárias → "Transferir entre bolsas" (sentido, valor, data, motivo)
   │   POST /admin/c/:cid/bank-accounts/fcr-transfer
   ▼
API:   POST /v1/admin/condominiums/:cid/fcr-transfers  { direction, amountCents, date, reason }
   │   422 FCR_TRANSFER_INSUFFICIENT_BALANCE se a bolsa de origem não cobre o montante
   ▼
Transação (fcr_transfer/create.ts):
   INSERT finance.fcr_transfer         guarda o motivo e quem transferiu
   INSERT 2 linhas em finance.ledger   ref_type='fcr_transfer', entry_type='fcrTransfer'
        to_fcr       (reforço):       débito 122 / crédito 121
        to_ordinary  (levantamento):  débito 121 / crédito 122
```

Não há `bank_transaction` (não é um movimento bancário) nem charge (não é dívida de ninguém).
`GET /fcr-transfers` devolve o histórico, mais recente primeiro. A API só tem criar e listar: um
engano corrige-se com a transferência no sentido contrário.

### 5. Utilização do fundo

Não existe um tipo de charge nem uma marca que diga que uma despesa foi paga pelo FCR. O pagamento
de uma despesa credita sempre a bolsa ordinária, porque `fn_charge_fcr_split` só devolve parte FCR
para charges com linhas `723`. Usar o fundo é, por isso, uma sequência de dois passos:

1. transferência `to_ordinary` pelo valor a usar, com o motivo a identificar a deliberação;
2. despesa normal ([02 - despesas](./02-fluxo-despesas.md)), paga a partir da bolsa ordinária.

A deliberação regista-se como ponto da ordem do dia com `item_type='approve_fcr_usage'`, que exige
maioria de 2/3 da permilagem presente
([`quorum_majority.ts`](../../src/apps/api/libs/assembly/quorum_majority.ts)). O ponto não fica
ligado à transferência nem à despesa: `assembly_agenda_item.ref_type` só aceita `budget`.

## Invariantes

1. Na criação da quota, `721 + 723 = original_amount`.
2. Em cada settlement, `ord_part + fcr_part = amount`: não se perdem cêntimos.
3. Uma transferência não altera `v_bank_balance.total_cents`.
4. A bolsa de origem tem de cobrir a transferência; a verificação é do handler, não da BD.
5. **DF2** - a deliberação de assembleia não é imposta pelo schema. O que torna a transferência
   auditável é o motivo obrigatório (`reason NOT NULL`, validado sem espaços em branco) e o
   `created_by`.
6. `amount_cents > 0` e `direction` em `to_fcr`/`to_ordinary` (CHECK).
7. As linhas de ledger da transferência são imutáveis, como todo o `finance.ledger`.

## Casos limite

- **Arredondamento.** A criação e o settlement usam fórmulas diferentes, por isso a soma em `122`
  pode desviar-se da soma em `723` até 1 cêntimo por settlement.
- **Quota sem orçamento de origem.** Se `source_id` não aponta para um orçamento, o trigger assume
  FCR 0 e credita tudo em `721`; os recebimentos vão inteiros para `121`.
- **Quota liquidada por offset.** Um settlement `charge_offset` (crédito da fração contra a quota)
  move só `2782` e `2111`, sem perna bancária: a parte FCR dessa quota não passa para `122`. O
  excedente que deu origem a um `credit_balance` entrou todo em `121`.
- **Quota anulada.** `fn_charge_au` debita `721` pelo valor em aberto e credita `2111`; a linha
  `723` da criação não é revertida.
- **Condomínio sem lançamentos.** Não tem linha em `v_bank_balance`; o handler trata as duas bolsas
  como zero.
- **Ano fiscal fechado.** Uma transferência com data num ano `closed` em `finance.fiscal_year` é
  rejeitada pelo trigger de
  [`007_trg_fiscal_year.sql`](../../src/db/components/007_trg_fiscal_year.sql).

## Limites conhecidos

- Não há conta bancária dedicada ao FCR: as bolsas são do condomínio, não de uma conta.
- Não há registo de utilizações do fundo: o que existe é o saldo e os movimentos da bolsa `122`.
- A conta `581` só recebe a parte FCR do saldo de abertura. As contribuições ficam em `723` e as
  transferências só mexem em `121` e `122`.
- O mínimo de 10% não é validado: `fcr_percentage` aceita qualquer valor não negativo.
- Uma transferência não tem anulação nem referência à deliberação que a autorizou, além do texto do
  motivo.

## Referências

- [`fcr_transfer/`](../../src/apps/api/modules/admin/fcr_transfer/) e
  [`libs/model/fcr_transfer.ts`](../../src/apps/api/libs/model/fcr_transfer.ts).
- [`004_trg_financial.sql`](../../src/db/components/004_trg_financial.sql) - `fn_charge_ai`,
  `fn_charge_fcr_split`, `fn_settlement_ai`, `fn_settlement_au`.
- [`016_vw_receipt_pending.sql`](../../src/db/components/016_vw_receipt_pending.sql) -
  `v_bank_balance`.
- [ADR 0010](../adr/0010-quota-rounding-big-unit.md) - arredondamento na distribuição das quotas.
- Testes pgTAP em [`test_sql/tests/`](../../test_sql/tests/): `0002_quota_double_entry.sql`,
  `0044_settlement_fcr_split.sql`, `0046_fcr_split_edge_cases.sql`, `0047_fcr_rounding_drift.sql`,
  `0064_fcr_transfer.sql`.
- Outros testes: [`api_bank_balance_fcr_test.ts`](../../test_api/api_bank_balance_fcr_test.ts),
  [`fcr_transfer_test.ts`](../../src/apps/api/libs/model/fcr_transfer_test.ts),
  [`fcr_transfer_views_test.ts`](../../src/apps/panel/fcr_transfer_views_test.ts).
