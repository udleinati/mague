# Base de dados (src/db) - regras

Carregado automaticamente quando trabalho em `src/db/**`. Complementa a raiz `/CLAUDE.md`.

## Migrations vs components

`migrations/001_bootstrap.sql` é o schema completo (gerado com `pg_dump`, não editar à mão).
Mudanças de schema são migrations novas e imutáveis (`migrations/NNN_*.sql`, registadas em
`_migrations` pelo nome) + components `CREATE OR REPLACE` re-aplicados a cada `migrate`. Os
components `000_*` e `001_*` correm ANTES das migrations (DEFAULTs no bootstrap). SQL `snake_case`,
TS `camelCase`. Ver [ADR 0008](../../docs/adr/0008-migrations-vs-components.md); regenerar o
bootstrap em [docs/agents/operations.md](../../docs/agents/operations.md).

## Armadilhas

- **Component vs migration**: se migration faz `DROP TRIGGER` e component recria com
  `CREATE TRIGGER`, o component sobrescreve. Solução: component só faz `DROP IF EXISTS` ou tem a
  versão corrigida.
- **Migration que renomeia objeto referenciado por component**: o loader corre componentes DEPOIS
  das migrations - entre `RENAME` e re-apply do component, o helper continua stale. Se uma migration
  seguinte disparar essa função, parte com `42P01`. Solução: a migration que renomeia inclui
  `CREATE OR REPLACE` inline da função afetada (self-heal).
- **Schema de funções PL/pgSQL**: qualifica o schema (`core.fn_x`, não `fn_x`); senão PG cria em
  `public` e a função original noutro schema fica obsoleta-mas-ativa.
- **pgTAP volátil + backup de produção**: ver
  [docs/agents/operations.md](../../docs/agents/operations.md).

## Workflow

- Correção em função PL/pgSQL (apenas as que ficaram em trigger - ver ADR 0001): nova migration
  numerada **e** atualizar component correspondente (para `test:up` refletir).
- Migration que depende de função de component: define-a inline (`CREATE OR REPLACE`) na própria
  migration - fresh DBs/restores antigos quebram senão.

## Domínio financeiro

Triggers PL/pgSQL emitem `finance.ledger` (charge/settlement com FCR split). **Leitura obrigatória
antes de mexer**: [ADR 0001](../../docs/adr/0001-financial-cascade-split.md) + flows em
`docs/flows/`. State machine + algoritmos vivem em TS - ver `src/apps/api/CLAUDE.md`.
