# ADR 0008 - Migrations imutáveis para o schema; components re-aplicados para funções e views

## Contexto

A camada SQL tem dois tipos de artefacto com ciclos de vida diferentes:

1. **Forma do schema** - tabelas, colunas, índices, constraints, correções de dados. Cada alteração
   tem de ser aplicada exatamente uma vez em cada base de dados.
2. **Lógica em SQL** - funções PL/pgSQL, triggers, views. Só interessa a versão atual, e pode ser
   recriada por inteiro a qualquer momento.

Tratar tudo como migration imutável obriga a uma migration `DROP` + `CREATE` por cada ajuste a uma
função. Tratar tudo como idempotente perde o registo do que cada base de dados já recebeu.

## Decisão

**Dois diretórios, um loader** (`src/db/migrate.ts`, invocado por `deno task migrate`).

### Migrations - `src/db/migrations/`

- `001_bootstrap.sql` é o schema completo (gerado com `pg_dump --schema-only`) mais os dados de
  referência. Bases de dados novas partem daqui. Não se edita à mão.
- Cada alteração de schema é um ficheiro novo: `002_<descrição>.sql`, `003_<descrição>.sql`, ...
  Prefixo de 3 dígitos com zeros à esquerda; a ordem de execução é a alfabética.
- Cada migration corre numa transação, juntamente com o seu registo em `_migrations`.
- **Uma migration aplicada é imutável.** A tabela `_migrations (filename, applied_at)` regista só o
  nome do ficheiro: editar o conteúdo não tem efeito nas bases de dados que já a registaram (e os
  ambientes divergem em silêncio); mudar o nome fá-la correr outra vez. Um erro corrige-se com uma
  migration nova. Não há scripts `down`: reverter é outra migration.

### Components - `src/db/components/`

- Ficheiros idempotentes, **re-aplicados por inteiro em cada `deno task migrate`**, por ordem
  alfabética, cada um na sua transação. Não são registados em lado nenhum.
- Conteúdo: funções, triggers, views, event triggers. Forma completa, não patch: o ficheiro tem a
  definição atual inteira (`CREATE OR REPLACE FUNCTION`; `DROP TRIGGER IF EXISTS` seguido de
  `CREATE TRIGGER`; `DROP VIEW IF EXISTS` seguido de `CREATE VIEW`).
- Não criam tabelas. Qualificam sempre o schema (`core.fn_x`, `finance.fn_x`).
- Podem conter só `DROP ... IF EXISTS`, para garantir que um objeto não existe em nenhuma base de
  dados (`005_trg_budget_quotas.sql`, `009_trg_recurring.sql`).

### Ordem de execução

1. **Components pré-requisito** - os ficheiros `000_*` e `001_*` (nome inferior a `"002"`). São
   funções puras, sem dependência de tabelas, de que os `DEFAULT` das tabelas precisam
   (`000_nanoid.sql` define `nanoid()`).
2. Cria `_migrations` se não existir.
3. **Migrations pendentes** - as que não constam de `_migrations`, por ordem. A primeira que falha
   interrompe o run.
4. **Todos os components**, incluindo outra vez os pré-requisito.

Se `001_bootstrap.sql` estiver pendente numa base de dados cuja `_migrations` já tem registos, o
loader regista-o sem o executar - o schema já lá está.

### O bootstrap também traz funções, triggers e views

O dump inclui a versão que esses objetos tinham quando foi gerado.

- Para um objeto que **também está num component**, o component é a fonte de verdade: sobrepõe-se ao
  bootstrap no fim de cada run.
- Um objeto que **só existe no bootstrap** (ex.: `core.fn_format_base36`,
  `finance.fn_charge_code_format`, `audit.fn_reject_direct_insert`) altera-se com uma migration
  nova, ou passa a viver num component.

### Onde vai cada alteração

- **Schema** (tabela, coluna, índice, constraint) ou correção de dados → migration nova.
- **Função, trigger ou view** → editar o component existente.
- **Função dos triggers do ledger** ([ADR 0001](./0001-financial-cascade-split.md)) → editar o
  component **e** criar uma migration nova com o mesmo `CREATE OR REPLACE`, para a correção já estar
  em vigor antes de qualquer migration posterior do mesmo run.
- **Component novo** → numerado a seguir ao último, idempotente.
- **`DEFAULT` de tabela que chama uma função** → a função vive num component `000_*`/`001_*`.
- **Migration que depende de uma função** → define-a inline (`CREATE OR REPLACE`) na própria
  migration. As migrations correm antes dos components: a versão que encontram é a do bootstrap ou a
  do run anterior, não a do component atual.

## Consequências

- Depois de restaurar um dump, `deno task migrate` realinha funções, triggers e views com o código.
  **Corre-se sempre a seguir a um restore.**
- Um component que não seja idempotente parte todos os deploys, não só o primeiro.
- As migrations fazem commit uma a uma, antes dos components. Se um component falhar, as migrations
  desse run já ficaram aplicadas: corrige-se o component e volta-se a correr.

### Armadilhas

- **Remover num sítio, recriar no outro.** Se uma migration faz `DROP TRIGGER` e o component ainda
  tem o `CREATE TRIGGER`, o component repõe-no no fim do run. Para remover de vez, tira-se do
  component (ou o component passa a fazer só `DROP ... IF EXISTS`).
- **Renomear um objeto referenciado por uma função de component.** Entre o `RENAME` e a re-aplicação
  do component, a função aponta para um nome que já não existe; se uma migration seguinte a
  disparar, falha com `42P01`. A migration que renomeia inclui o `CREATE OR REPLACE` inline das
  funções afetadas.
- **Função sem schema qualificado.** O Postgres cria-a em `public`, e a original, noutro schema,
  continua ativa e desatualizada.
- **Prefixo sem zeros.** A ordenação é lexicográfica: `10_x.sql` corre antes de `9_x.sql`.
- **Pré-requisito que lê tabelas.** Um component `000_*`/`001_*` corre antes do bootstrap numa base
  de dados nova; se depender de uma tabela, falha.

## Alternativas rejeitadas

1. **Tudo em migrations imutáveis** (estilo Flyway ou migrations de ORM). Cada correção a um trigger
   é uma migration `DROP` + `CREATE`, e a definição atual de uma função fica espalhada por vários
   ficheiros.
2. **Tudo idempotente/declarativo.** Não fica registo das alterações de schema que cada base de
   dados recebeu, e DDL não idempotente ou correções de dados não cabem no modelo.
3. **Ferramenta de schema-as-code** (Atlas, Sqitch). Mais tooling para um ganho marginal.
4. **Uma só pasta com sufixos** (`*.migration.sql` / `*.component.sql`). O loader passa a filtrar
   por nome e a distinção fica menos visível do que com dois diretórios.

## Sinais de alerta para code review

- Alteração a `001_bootstrap.sql` ou a outra migration já aplicada, ou mudança do nome de uma.
- Migration que chama uma função definida num component sem a definir inline.
- Component com `CREATE TABLE`, ou com `CREATE TRIGGER`/`CREATE VIEW` sem o `DROP ... IF EXISTS`
  correspondente.

## Referências

- Loader: [`src/db/migrate.ts`](../../src/db/migrate.ts). Migrations:
  [`src/db/migrations/`](../../src/db/migrations/). Components:
  [`src/db/components/`](../../src/db/components/).
- Regras de área: [`src/db/CLAUDE.md`](../../src/db/CLAUDE.md). Restore e testes SQL:
  [`docs/agents/operations.md`](../agents/operations.md).
