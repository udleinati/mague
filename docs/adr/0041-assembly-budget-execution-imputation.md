# ADR 0041 - Imputação de despesa a uma Ata: etiqueta manual ganha à inferência por rubrica e ano

## Contexto

O relatório "Execução por Ata" responde a três perguntas sobre uma assembleia: quanto aprovou,
quanto já se gastou e se as quotas correspondentes já entraram. Precisa de três ligações, e só duas
existem no schema:

- **Ata → orçamento**: `core.assembly_agenda_item` com `ref_type='budget'` + `ref_id`, o ponto da
  ordem do dia "aprovação do orçamento"
  ([ADR 0033](./0033-assembly-agenda-item-vs-deliberation.md)).
- **Orçamento → quotas**: `finance.charge.source_type='budget'` + `source_id`. Ligação exata.
- **Orçamento → despesa**: não há ligação nativa. Uma charge payable tem `account_id` (rubrica) e
  `competence_period`, mas nada que diga a que orçamento pertence. Filtrar "despesas
  extraordinárias" não resolve: pode haver dois orçamentos suplementares no mesmo ano.

## Decisão

A despesa é imputada a um orçamento em duas camadas, com precedência explícita. A regra é pura e
vive em `report/_impute.ts` (`imputePayable`): é onde um erro muda o número que vai à assembleia.

1. **Etiqueta manual** - `finance.charge.budget_id` (nullable, FK a `core.budget`), preenchida na
   página da despesa. Ganha sempre, desde que o orçamento esteja no relatório.
2. **Inferência** - sem etiqueta, a despesa conta para o orçamento que tem uma `budget_line` com a
   mesma `account_id` **e** cujo `year` é o ano do `competence_period` da despesa.
3. **Empate declarado** - se a rubrica pertence a mais do que um orçamento do relatório nesse ano, a
   inferência não decide: a despesa fica `ambiguous`, aparece nos dois orçamentos, **não conta em
   nenhum** (vai num total à parte), e a UI pede a etiqueta. Somar aos dois duplicava o gasto;
   escolher um mentia.

"Orçamento do relatório" é o que é referido por um ponto da ordem do dia.

### Endpoint próprio para a etiqueta

`PATCH /v1/admin/condominiums/:cid/charges/:chargeId/budget`, com `{ "budgetId": string | null }`
(`charge/set_budget.ts`) - e não o `PATCH /charges/:chargeId` geral.

- O update geral só aceita charges `open`/`overdue` com `settled_amount = 0`, e **etiquetar despesas
  já pagas é o caso normal**: o relatório olha para trás. `budget_id` é metadado de imputação - não
  toca em valor, estado nem ledger - e por isso não leva esses guards.
- Só despesas: `kind='receivable'` é recusado com 422. As quotas já apontam ao seu orçamento por
  `source_type`/`source_id`.
- Gate de tenant no handler: o orçamento tem de ser do condomínio do path, senão 404. A FK só
  verifica que existe; o trigger `trg_tenant_guard` é a última barreira na base de dados.
- `budgetId: null` remove a etiqueta e devolve a despesa à inferência.

## Consequências

- O histórico funciona sem trabalho manual: as despesas de uma rubrica que só um orçamento usa
  entram por inferência.
- Uma despesa etiquetada para um orçamento que não está no relatório cai na inferência, em vez de
  desaparecer do total.
- Uma despesa sem rubrica, ou com competência num ano diferente do `year` do orçamento, não é
  inferida. Só conta se for etiquetada.
- Uma Ata sem ponto da ordem do dia ligado a um orçamento não aparece no relatório. A página explica
  o passo em falta em vez de mostrar um ecrã vazio.

## Alternativas rejeitadas

- **Só inferência, sem coluna nova.** Não tem saída para o empate - que é precisamente o caso do
  condomínio com duas obras no mesmo ano.
- **Só etiqueta manual.** É exata, mas todo o histórico nasce a zero: alguém teria de etiquetar
  todas as despesas antes de o relatório dizer alguma coisa.
- **Filtrar por `charge_type='extraordinary_quota'` do lado da despesa.** Não existe: esse
  `charge_type` é das quotas, não das despesas que a obra gera.

## Referências

- Regra: [`_impute.ts`](../../src/apps/api/modules/admin/report/_impute.ts), com testes em
  `report/_impute_test.ts`. Relatório: `report/assembly_execution.ts`
  (`GET /reports/assembly-execution`; no Panel, `/admin/c/:cid/reports/assemblies`).
- Etiqueta: [`charge/set_budget.ts`](../../src/apps/api/modules/admin/charge/set_budget.ts); testes
  em `test_api/api_charge_budget_tag_test.ts` e `test_sql/tests/0066_charge_budget_id.sql`.
- `CONTEXT.md`: "Execução por Ata", "Imputação (de despesa a orçamento)".
