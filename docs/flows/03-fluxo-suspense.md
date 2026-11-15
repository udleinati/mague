# 03 - Fluxo de Entradas/Saídas Não Identificadas (Suspense)

O que acontece a um movimento bancário cuja origem ou destino ainda não se conhece. Enquanto não é
identificado, o movimento fica na fila de conciliação e não toca no ledger; não existe uma conta de
suspense a acumular o valor. Este documento descreve esse estado de espera, as saídas possíveis e o
suporte parcial que os triggers têm para `charge_type='unclassified'`. Regras de base em
[00 - visão geral](./00-overview-entradas-saidas.md) (D1, D14).

## Modelo

- `finance.bank_transaction.status`: `unreconciled` (default), `partial`, `reconciled`, `ignored`,
  `reversed`.
- `finance.settlement`: liga o movimento a uma charge; é o que o tira da fila.
- Conta `2789` Valores a Classificar: passivo do plano de contas global.
- `finance.fn_charge_account` devolve `2789` para `charge_type='unclassified'`;
  `finance.fn_counterparty_account` devolve a sentinela `BANK_ONLY` para o mesmo tipo.
- `match_keywords` em `core.unit` e `core.supplier`: palavras-chave que sugerem a fração ou o
  fornecedor de um movimento.

## Fluxo

```
bank_transaction (extrato importado ou inserção manual)
      │  status='unreconciled', nenhuma linha em finance.ledger (D14)
      │
      ├─ origem identificada ───► conciliação ou imputação ─► settlement ─► ledger
      ├─ não é para conciliar ──► ignore ─► status='ignored' (unignore repõe 'unreconciled')
      └─ origem desconhecida ───► continua 'unreconciled' na fila até ser identificada
```

1. **Entrada do movimento.** `bank_account/import_commit.ts` (extrato) ou
   `bank_transaction/create.ts` (manual) inserem a linha com `status='unreconciled'`. Nenhum trigger
   emite ledger.
2. **Espera.** O movimento aparece na página de conciliação (`/admin/c/:cid/reconciliation`) e em
   `GET /bank_transactions?status=unreconciled`. Entra no saldo por conta
   (`bank_account/list_with_stats.ts`: `opening_balance + Σ amount`, com `pendingCount`), mas não
   nas bolsas `121`/`122` de `finance.v_bank_balance`, que só leem o ledger.
3. **Sugestão.** `bank_transaction/suggest_match.ts` compara a descrição com as `match_keywords` das
   frações (entradas) ou dos fornecedores (saídas): uma correspondência sugere, várias assinalam
   conflito, nenhuma deixa o movimento sem sugestão. Não tem efeito contabilístico.
4. **Identificação.** Quando se sabe de quem é o dinheiro, o movimento segue um dos caminhos
   normais:
   - entrada de uma fração: imputação (`POST /bank_transactions/:id/allocate_to_unit`,
     [07](./07-fluxo-imputacao.md)) ou conciliação manual charge a charge (`POST /settlements`,
     [06](./06-fluxo-reconciliacao.md));
   - saída para um fornecedor: `POST /bank_transactions/:id/allocate_to_supplier` ou conciliação
     manual;
   - entrada vinda de um fornecedor: `POST /bank_transactions/:id/refund_supplier`
     ([02](./02-fluxo-despesas.md));
   - se a charge ainda não existe, cria-se primeiro (`POST /charges`) e concilia-se depois.
5. **Ignorar.** `POST /bank_transactions/:id/ignore` (`bank_transaction/set_ignored.ts`) marca o
   movimento como `ignored`. Serve para movimentos que não precisam de charge, como transferências
   entre contas do próprio condomínio. `POST .../unignore` devolve-o a `unreconciled`.

Os caminhos de ficheiros são relativos a
[`src/apps/api/modules/admin/`](../../src/apps/api/modules/admin/).

### Pagamento em excesso não é suspense

Quando a fração é conhecida mas o valor recebido excede a dívida em aberto, a imputação cria uma
charge `credit_balance` (`receivable`, `nature='credit'`) e um settlement `bank_deposit_credit`
(débito em `121`, crédito em `2782`). O crédito fica atribuído à fração e é consumido por
`applyAutoOffset` (`charge/auto_offset.ts`) nas charges seguintes. Ver
`createCreditBalanceForSurplus` em `allocation/execute.ts`.

### Corrigir uma identificação errada

Não há reclassificação de um settlement. Corrige-se com o estorno do movimento
(`POST /bank_transactions/:id/reverse`, `bank_transaction/reverse.ts`): os settlements ativos passam
a `reversed`, o trigger emite as linhas inversas, as charges voltam a ficar em aberto e os recibos
emitidos são anulados. O movimento fica `reversed` e pode ser conciliado de novo com a charge certa.

### `charge_type='unclassified'` nos triggers

As funções de mapeamento reconhecem o tipo `unclassified`, mas nenhum handler nem ecrã do Panel cria
charges desse tipo e nenhum teste as cobre. `POST /charges` aceita-o porque `chargeType` é texto
livre. Criada assim, a charge produz estas linhas (cêntimos, charge de 5000):

| Passo                                                | Débito      | Crédito          |
| ---------------------------------------------------- | ----------- | ---------------- |
| INSERT da charge (`nature='debit'`, qualquer `kind`) | `2789` 5000 | `BANK_ONLY` 5000 |
| `bank_reconciliation` com um movimento de entrada    | `121` 5000  | `2789` 5000      |
| `bank_reconciliation` com um movimento de saída      | `2789` 5000 | `121` 5000       |
| Anulação da charge ainda em aberto                   | `7888` 5000 | `2789` 5000      |

`BANK_ONLY` é escrito tal e qual em `finance.ledger.account_code`; não é uma conta do plano.

## Invariantes

1. Um movimento só chega ao ledger através dos seus settlements. Sem settlements ativos, o efeito
   líquido no ledger é zero.
2. `ignore` exige `status='unreconciled'` e zero settlements ativos; `unignore` exige
   `status='ignored'`.
3. A imputação recusa movimentos `ignored`.
4. O `status` do movimento deriva da soma dos settlements ativos: `unreconciled` (zero), `partial`
   (abaixo de `|amount|`) ou `reconciled` (`computeBankTxStatus` em `settlement/effects_math.ts`).
5. Nenhum settlement excede o que falta alocar do movimento (`settlement/validate.ts`).
6. O estorno só aceita movimentos `reconciled` ou `partial` e exige um motivo com pelo menos 10
   caracteres.

## Casos limite

- **Identificação parcial.** Conciliar só uma parte deixa o movimento `partial`; o resto continua
  por alocar e pode ser conciliado mais tarde.
- **Fração conhecida, charge desconhecida.** A imputação distribui o valor pelas charges em aberto
  da fração pela ordem legal; o que sobrar fica como `credit_balance`.
- **Fornecedor sem faturas em aberto.** A imputação a fornecedor responde 400 `NO_OPEN_CHARGES`; não
  cria crédito. O excedente de uma imputação a fornecedor fica por alocar.
- **Movimento estornado.** Um movimento `reversed` aceita nova imputação e passa a `reconciled`.

## Limites conhecidos

- O valor por identificar não aparece em nenhuma conta do ledger. Só é visível como movimentos
  `unreconciled` ou `partial`.
- Não há fluxo de suspense: nem endpoint, nem ecrã, nem view para charges `unclassified`, e a
  contrapartida `BANK_ONLY` que os triggers escrevem não existe no plano de contas.
- Não há prazo nem tratamento automático para movimentos que ficam por identificar.

## Referências

- [`004_trg_financial.sql`](../../src/db/components/004_trg_financial.sql) - `fn_charge_account`,
  `fn_counterparty_account`, `fn_charge_ai`, `fn_charge_au`, `fn_settlement_ai`.
- [`000a_chart_of_account_global.sql`](../../src/db/seeds/000a_chart_of_account_global.sql) - conta
  `2789`.
- [`bank_transaction/`](../../src/apps/api/modules/admin/bank_transaction/) e
  [`allocation/`](../../src/apps/api/modules/admin/allocation/).
- Testes:
  [`api_admin_reconciliation_flows_test.ts`](../../test_api/api_admin_reconciliation_flows_test.ts)
  (ignorar, retomar, estorno e nova conciliação) e
  [`api_admin_bank_reverse_test.ts`](../../test_api/api_admin_bank_reverse_test.ts) (excedente em
  `credit_balance` e respetivo estorno).
