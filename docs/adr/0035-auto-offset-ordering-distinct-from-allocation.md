# ADR 0035 - Ordem do auto-offset é distinta da prioridade de imputação

## Contexto

Há dois sítios em TypeScript que ordenam charges em aberto antes de as saldar. Ambos põem juros à
frente, e por isso parecem a mesma regra escrita duas vezes:

- **Imputação** (`allocation/plan.ts`, `priorityGroup` + `sortChargesByPriority`) - distribui o
  valor de um `bank_tx` pelas charges em aberto de uma fração ou de um fornecedor, pela ordem legal
  do Art. 784.º CC. Ordena em memória, com um comparador puro.
- **Auto-offset** (`charge/auto_offset.ts`, `selectMatches`) - ao criar uma charge receivable,
  procura charges de natureza oposta na mesma fração e salda-as com settlements `charge_offset`.
  Ordena na query, com `ORDER BY`.

## Decisão

**As duas ordenações não se fundem.** São regras distintas, de propósito.

**Imputação** - hierarquia completa do Art. 784.º CC.

- Fração: (1) juros (`interest`); (2) vencidas ou parciais (`status` `overdue`/`partial`, ou
  `due_date` anterior a hoje); (3) quotas (`quota`, `extraordinary_quota`); (4) refaturações; (5) as
  restantes. Fornecedor: (1) vencidas ou parciais; (2) as restantes.
- Dentro de cada grupo: `competence_period` → `due_date` → `created_at`, ascendente, nulos no fim.
  No fornecedor, `issue_date` entra antes de `due_date`.

**Auto-offset** - regra mais simples, cronológica por vencimento.

- Candidatas: charges da mesma fração, de natureza oposta, com `status` `open`, `partial` ou
  `overdue` e `open_amount > 0`.
- Ordem: `due_date` → `competence_period` → `created_at`, ascendente, nulos no fim. Quando a charge
  nova é um **crédito**, os juros (`interest`) passam à frente; quando é um débito, não há grupos.

Os grupos diferem (cinco contra, no máximo, dois) e o desempate está trocado (competência primeiro
contra vencimento primeiro). Fazer o auto-offset reutilizar `priorityGroup` mudaria **que charges
são saldadas primeiro**: é uma alteração de comportamento financeiro - e uma questão jurídica, a de
saber se o offset deve seguir a prioridade legal da imputação - e não um refactor que preserva
comportamento.

Uma unificação parte dessa decisão de domínio, com validação e testes de API próprios, e substitui
este ADR. Não se contorna pela semelhança superficial do código.

## Consequências

- Há duas ordenações no código; cada ficheiro tem um comentário a apontar para aqui.
- O `ORDER BY` do auto-offset não tem teste unitário próprio (é SQL). É validado pelos testes de API
  da criação de charges.

## Alternativas rejeitadas

1. **Um módulo único de prioridade, com dois consumidores.** Parte da premissa de que as duas ordens
   são iguais; não são, e fundi-las altera o resultado financeiro.
2. **Extrair a ordem do auto-offset para um comparador puro**, para a testar sem base de dados.
   Obriga a carregar todas as candidatas e a ordenar em memória, em vez de deixar a query ordenar. O
   ganho não o justifica enquanto a regra for estável.

## Referências

- [`allocation/plan.ts`](../../src/apps/api/modules/admin/allocation/plan.ts), com testes em
  `allocation/plan_test.ts`.
- [`charge/auto_offset.ts`](../../src/apps/api/modules/admin/charge/auto_offset.ts).
- Testes de API: `test_api/api_admin_allocation_priority_test.ts`,
  `test_api/api_admin_ledger_invariants_test.ts`.
- [ADR 0001](./0001-financial-cascade-split.md) - o auto-offset é uma chamada explícita em
  TypeScript.
