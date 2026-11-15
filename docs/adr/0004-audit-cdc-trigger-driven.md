# ADR 0004 - Auditoria CDC por trigger único na BD, com auto-attach e actor em JSONB

## Contexto

Cada mutação em tabelas de domínio (`core.*`, `finance.*`) fica registada com **quem**, **quando**,
**o que mudou** e **em que condomínio**. O registo serve para investigar disputas, saber quem
aprovou um orçamento, recuperar o estado anterior a uma alteração destrutiva e dar rastreabilidade
aos atos da administração. Tem de haver uma resposta única para onde se capta a mutação, como se
identifica o actor e como se cobrem tabelas novas sem depender de alguém se lembrar.

## Decisão

**A auditoria é responsabilidade da base de dados.** Uma única função, `audit.fn_log_change()`, é
ligada automaticamente a todas as tabelas de `core` e `finance` e escreve em `audit.cdc_log`.

### Captura

A função corre como trigger `AFTER INSERT OR UPDATE OR DELETE ... FOR EACH ROW`, com o nome
`trg_audit_<schema>_<tabela>`. Por cada mutação grava uma linha com:

- `table_schema`, `table_name`, `row_id` (o valor da coluna `id`) e `action`
  (`insert`/`update`/`delete`);
- `snapshot` - a linha completa depois da operação; num DELETE, o estado anterior à eliminação;
- `diff` - só em UPDATE: `{ "before": {...}, "after": {...} }` com as colunas que mudaram;
- `condominium_id` - da própria linha; se a tabela não o tiver, da GUC `app.condominium_id`;
- `actor` - ver abaixo.

Tabelas sem coluna `id` (chave composta, como `core.pathology_unit` ou os contadores de códigos) não
geram registos. A função é `SECURITY DEFINER`: escreve no log seja qual for o role que fez a
mutação.

### Actor - snapshot JSONB, não FK

O actor é lido da própria linha, das colunas `created_by` / `updated_by` / `deleted_by` (JSONB no
formato `ActorSnapshot`: `user_id`, `email`, `ip`, `user_agent`, `request_id` - ver
[ADR 0011](./0011-actor-snapshot-convention.md)):

| Operação | Actor                                                  |
| -------- | ------------------------------------------------------ |
| INSERT   | `NEW.created_by`                                       |
| UPDATE   | `NEW.deleted_by` se preenchido; senão `NEW.updated_by` |
| DELETE   | `OLD.deleted_by`                                       |

Se a coluna não existir ou vier vazia (`NULL` ou `{}`), o actor é construído a partir das GUCs de
sessão `app.user_id`, `app.user_email`, `app.ip`, `app.user_agent` e `app.request_id`. É o caminho
para psql, scripts e migrations: `SET LOCAL app.user_id = '...'` antes de alterar dados.

### Auto-attach

- O event trigger `audit_attach_on_create` (`ddl_command_end`, tag `CREATE TABLE`) chama
  `audit.fn_attach_to_table(schema, tabela)` para cada tabela nova em `core` ou `finance`. O
  component percorre também as tabelas existentes desses schemas em cada `deno task migrate`.
- `audit.fn_attach_to_table` é idempotente e ignora partições filhas (o trigger da tabela-mãe
  cobre-as).
- **Opt-out**: uma linha em `audit.cdc_skip_list (schema_name, table_name, reason)`, para tabelas
  cujo registo é redundante (cache, log próprio). A lista é respeitada no attach e de novo em
  runtime.
- Tabelas noutros schemas não são cobertas: chama-se `audit.fn_attach_to_table` explicitamente, ou
  alarga-se a lista de schemas do event trigger.

### Imutabilidade do log

- `trg_audit_log_no_update`, `trg_audit_log_no_delete` e `trg_audit_log_no_truncate` rejeitam
  UPDATE, DELETE e TRUNCATE em `audit.cdc_log`.
- `trg_audit_cdc_log_no_direct_insert` rejeita qualquer INSERT que não venha de dentro de outro
  trigger (`pg_trigger_depth() < 2`), para que ninguém forje entradas - nem o owner da tabela.
- A tabela é particionada por ano em `created_at` (`audit.cdc_log_<ano>`), sem partição default.

Um evento de domínio que não é a mutação de uma linha (um email enviado, um acesso) tem tabela
própria, como `audit.email_log`. A aplicação nunca escreve em `audit.cdc_log`.

## Consequências

- Uma tabela nova em `core`/`finance` ganha auditoria sem código, e nenhum caminho de escrita a
  contorna. Basta declarar as colunas de actor com `actorColumn(...)` e preenchê-las com
  `requireActor(ctx)`.
- O actor sobrevive ao soft-delete do utilizador e leva email, IP e user agent, que também são parte
  do "quem". Pesquisar por utilizador usa `actor->>'user_id'`, não um join por FK.
- **Um UPDATE que não escreve `updated_by` fica atribuído ao actor anterior da linha.** O trigger lê
  o que está na linha; não sabe quem fez o pedido.
- **Sem partição para o ano corrente, os INSERTs em `audit.cdc_log` falham**, e com eles as mutações
  nas tabelas auditadas. O bootstrap cria as partições de 2026 a 2028; cada ano seguinte precisa de
  uma migration nova antes de começar.
- O log guarda um snapshot por mutação e cresce sem limite; não existe política de retenção.

## Alternativas rejeitadas

1. **Captura na aplicação** (cada handler regista). Esquece-se num refactor; escritas por psql,
   migrations ou ferramentas externas escapam; cada handler ganha um efeito lateral que não é regra
   de negócio.
2. **CDC externo por leitura do WAL** (Debezium ou semelhante). Complexidade operacional
   desproporcionada, e a auditoria deixa de ser síncrona com a transação.
3. **FK do actor para `core.user`.** Os utilizadores são soft-deleted e o log tem de sobreviver a
   uma eliminação física; email, IP e user agent ficariam de fora.
4. **Lista manual de tabelas auditadas.** Fica desatualizada na primeira tabela nova.

## Sinais de alerta para code review

- Handler que faz UPDATE ou soft-delete sem preencher `updated_by` / `deleted_by`.
- Tabela nova em `core`/`finance` sem as colunas de actor, ou sem coluna `id`.
- Código da aplicação a inserir em `audit.cdc_log`, ou um log paralelo para mutações de linhas.
- Migration que altera dados sem `SET LOCAL app.user_id`.

## Referências

- Função, auto-attach e imutabilidade: [`013_audit.sql`](../../src/db/components/013_audit.sql).
- Tabelas, partições e trigger de INSERT direto:
  [`001_bootstrap.sql`](../../src/db/migrations/001_bootstrap.sql).
- `ActorSnapshot` e `actorColumn`:
  [`_audit.ts`](../../src/apps/api/libs/postgres/schemas/_audit.ts); `requireActor`:
  `src/apps/api/middleware/api_auth.ts`.
- pgTAP: `test_sql/tests/0030_audit.sql`, `0031_audit_edge_cases.sql`,
  `0041_audit_log_insert_protection.sql`.
- [ADR 0005](./0005-soft-delete-convention.md), [ADR 0011](./0011-actor-snapshot-convention.md).
