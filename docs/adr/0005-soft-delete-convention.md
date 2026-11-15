# ADR 0005 - Soft-delete com `deleted_at` + `deleted_by` e índices únicos parciais

## Contexto

Num sistema multi-tenant com contabilidade e auditoria, eliminar dados destrói prova. Uma fração com
recibos emitidos não pode desaparecer da base de dados: o histórico financeiro e o registo de
auditoria dependem dela. Mas a administração precisa de uma operação "eliminar" que retire o item da
UI, dos filtros e das queries de negócio, sem partir FKs, constraints UNIQUE nem agregações.

## Decisão

**"Eliminar" na aplicação é um soft-delete.** A linha fica na tabela, marcada. A eliminação física
fica reservada às exceções listadas abaixo.

### Colunas

```
deleted_at  timestamptz  NULL
deleted_by  jsonb        NULL   -- ActorSnapshot, como created_by/updated_by (ADR 0011)
```

`deleted_at IS NULL` = linha ativa. Têm estas colunas as entidades que a UI deixa eliminar (frações,
ocupantes, fornecedores, orçamentos, assembleias, documentos, anexos, ocorrências, ...). A
referência é o schema, em `src/apps/api/libs/postgres/schemas/`.

### Eliminar e restaurar

- O handler faz um `UPDATE` que preenche `deleted_at` e `deleted_by` (`requireActor(ctx)`), filtrado
  por `byIdInCondo(...)`. Exemplo canónico: `supplier/delete.ts`.
- Linha com ficheiro no S3: apaga-se primeiro o objeto, depois faz-se o soft-delete
  ([ADR 0021](./0021-s3-delete-before-db.md)).
- O soft-delete não se propaga por FK. Quando os dependentes também devem sair, o handler marca-os
  explicitamente (ex.: `user/delete.ts` marca `manager`, `unit_occupant` e `occupant` do
  condomínio).
- Restaurar é repor `deleted_at = NULL` (ex.: `user/update.ts` reativa o registo `core.manager`
  eliminado quando o papel de administrador volta a ser atribuído).

### Queries

Toda a query de domínio sobre uma tabela com soft-delete filtra `deleted_at IS NULL`. Os helpers
partilhados aplicam o filtro por construção e são a forma preferida:

- `byIdInCondo(schema.X, id, cid)` - "esta entidade, neste condomínio, não eliminada";
- `listWhere(schema.X, cid, ...filtros)` - WHERE de listagem e do respetivo `count`.

Fora deles, `isNull(x.deletedAt)` explícito. Num JOIN, o filtro vai na condição de **cada** tabela
com soft-delete: filtrar só a tabela principal devolve linhas ligadas a registos eliminados. Só
ignoram o filtro as queries que querem o histórico de propósito (auditoria, restauro).

### UNIQUE e FKs

Uma coluna que só tem de ser única **entre linhas ativas** usa um índice único parcial, o que
permite recriar uma linha com o mesmo valor depois de eliminar a anterior:

```sql
CREATE UNIQUE INDEX users_email_active_uq
  ON core.user (email)
  WHERE deleted_at IS NULL;
```

Outros exemplos: `chart_of_account_custom_unique`, `assembly_attendee_unique_unit`,
`payment_plan_one_active_per_unit`.

As FKs apontam para a linha, esteja ou não eliminada: `finance.charge.unit_id` continua válido
depois de a fração ser eliminada na UI. Quem precisa da linha ativa filtra na query.

### Exceções

- **Registos financeiros não se eliminam, anulam-se por estado**: `finance.charge`
  (`status='cancelled'`), `finance.settlement` (`status='reversed'`), `finance.receipt`
  (`voided_at`). `finance.ledger` e `audit.cdc_log` são append-only. Nenhuma destas tabelas tem
  `deleted_at`.
- **Eliminação física na aplicação**, em tabelas sem histórico próprio: `core.pathology_unit`
  (junção), `core.ticket_comment`, `core.insurance_policy`
  ([ADR 0040](./0040-insurance-renewal-lineage-freeze-delete.md)) e `core.assembly_vote` (editar um
  ponto da ordem do dia substitui os votos todos). O `audit.cdc_log` guarda o snapshot anterior ao
  DELETE.
- **Soft-delete não é desativar.** `is_active` (em `core.user`, `core.manager`, `core.unit`) é um
  estado de negócio reversível; para utilizadores, ver
  [ADR 0020](./0020-session-idle-ttl-and-user-active-flag.md).

## Consequências

- O histórico de cada linha sobrevive à eliminação e as FKs mantêm-se estáveis.
- **Esquecer o filtro mostra linhas-fantasma na UI.** É o custo permanente da convenção; os helpers
  e a revisão de código são a mitigação.
- As linhas eliminadas acumulam-se; não existe job de limpeza.
- **Soft-delete não satisfaz um pedido de apagamento definitivo de dados pessoais.** Não há fluxo
  automático para isso, e o `audit.cdc_log` (append-only) continua a guardar os snapshots.

## Alternativas rejeitadas

1. **Eliminação física + log de auditoria à parte.** O log passa a apontar para linhas que não
   existem, restaurar exige reconstituir a partir do log, e as FKs obrigam a cascatas destrutivas.
2. **Linhas versionadas** (coluna `generation`). Todas as queries têm de escolher a versão mais
   recente e as FKs ficam ambíguas.
3. **Tabela de tombstones + eliminação física.** Duplica o schema e complica qualquer consulta de
   "linha + histórico".
4. **Enum de estado** (`active|archived|deleted`). Três estados onde dois chegam; "arquivado" é um
   conceito de domínio diferente e, quando existe, merece coluna própria.

## Sinais de alerta para code review

- Query ou JOIN sobre tabela com `deleted_at` sem o filtro `IS NULL`.
- `db.delete(...)` numa tabela que tem `deleted_at`, ou soft-delete que não preenche `deleted_by`.
- UNIQUE total numa coluna cujo valor deve poder ser reutilizado (ex.: email) numa tabela com
  soft-delete.
- Tabela que ganha "eliminar" na UI sem `deleted_at`/`deleted_by`: acrescentar por migration nova.

## Referências

- Helpers: [`by_id_in_condo.ts`](../../src/apps/api/libs/shared/by_id_in_condo.ts),
  [`list_query.ts`](../../src/apps/api/libs/shared/list_query.ts)
  ([ADR 0030](./0030-shared-action-helpers.md)).
- Handler canónico: [`supplier/delete.ts`](../../src/apps/api/modules/admin/supplier/delete.ts).
- Cascata pai → anexos: `softDeleteAttachment` em `src/apps/api/libs/attachments/mod.ts`;
  `softDeleteTicket` em `src/apps/api/modules/admin/ticket/_helpers.ts`.
- [ADR 0004](./0004-audit-cdc-trigger-driven.md), [ADR 0011](./0011-actor-snapshot-convention.md).
