# ADR 0006 - Anexos numa única tabela polimórfica `core.attachment`

## Contexto

Várias entidades precisam de anexos (PDFs, imagens): charges, ocorrências, vistorias, assembleias,
seguros, documentos e patologias. Os metadados e as operações HTTP (upload, listar, servir bytes,
eliminar) são os mesmos em todas. Uma tabela e um conjunto de handlers por entidade multiplica o
mesmo código e deixa os schemas divergir.

## Decisão

**Uma só tabela, `core.attachment`, com as colunas discriminadoras `entity_type` + `entity_id` e uma
allow-list de tipos em CHECK constraint.** Nunca se cria `core.<entidade>_attachment`; uma tabela
própria só se justifica com necessidades drasticamente diferentes (blobs cifrados, por exemplo).

```sql
CREATE TABLE core.attachment (  -- resumo
  id              text PRIMARY KEY,
  condominium_id  text NOT NULL REFERENCES core.condominium(id),
  entity_type     varchar(30) NOT NULL,  -- allow-list no CHECK
  entity_id       text NOT NULL,         -- sem FK: a referência é polimórfica
  filename, mime_type, file_size, file_sha256, storage_etag,
  storage_key     text NOT NULL UNIQUE,
  created_by, updated_by, deleted_by, created_at, deleted_at,
  CONSTRAINT attachment_entity_type_check CHECK (entity_type IN
    ('charge','ticket','inspection','assembly','insurance','document','pathology'))
);
```

### `entity_id` não é FK

Não existe FK polimórfica em PostgreSQL. A integridade é garantida por três mecanismos:

- **Aplicação**: antes de qualquer operação valida-se que a entidade-pai existe e pertence ao
  condomínio (`ownershipQuery`, [ADR 0003](./0003-portal-visibility-scope.md)). Os helpers procuram
  um anexo sempre pelas quatro chaves `id` + `condominium_id` + `entity_type` + `entity_id`.
- **BD**: o trigger `trg_tenant_guard` (`core.fn_tenant_guard`, component
  `020_trg_tenant_guard.sql`) rejeita um anexo cujo `entity_id` aponte para uma entidade de outro
  condomínio. Só valida os tipos mapeados no argumento do trigger.
- **Eliminação do pai**: cascata explícita aos anexos, S3 primeiro
  ([ADR 0021](./0021-s3-delete-before-db.md)).

### Código partilhado

- `$api/libs/attachments/mod.ts` - helpers por `entityType` + `entityId` (upload, listar, obter,
  servir, soft-delete, cascata, cópia entre entidades).
- `$api/libs/attachments/manager.ts` - `makeAttachmentManager` concentra os quatro endpoints
  (`list`, `upload`, `serve`, `delete`). Cada entidade injeta `entityType`, `paramName`,
  `entityNamePT`, `ownershipQuery` e `serialize`. É a porta por omissão; vistorias e seguros têm
  handlers próprios (gates de domínio) sobre os mesmos helpers.
- `buildStorageKey` (`$api/libs/storage/storage_key.ts`) gera
  `<cid>/<pasta>/<shard>/<entity_id>/<attachment_id>-<filename>`. O `<cid>` no topo permite backup e
  restore por condomínio. O `<shard>` (dois primeiros caracteres do id do pai) é sempre em
  minúsculas: num sistema de ficheiros case-insensitive, `J/` e `j/` colapsam e desalinham a key.

### Adicionar um tipo de entidade

1. Migration nova que substitui o CHECK `attachment_entity_type_check` com o tipo novo.
2. `ATTACHMENT_ENTITY_TYPES` e o `check` em `libs/postgres/schemas/attachment.ts`.
3. `ENTITY_FOLDER` e `ENTITY_ID_PREFIX` em `libs/attachments/mod.ts`.
4. Mapear o tipo no trigger de `core.attachment` em `020_trg_tenant_guard.sql`.
5. `<entidade>/attachments.ts` com a configuração de `makeAttachmentManager`, e cabling no router
   admin (e no portal, com `ownershipQuery` própria, se houver regra de visibilidade).
6. Cascata na eliminação do pai (`softDeleteAttachmentsForEntity`) e entrada em
   `TABLES_WITH_ATTACHMENTS` de `cascade_guard_test.ts`.

## Consequências

- Uma entidade nova com anexos é configuração. Audit, soft-delete, multi-tenant e visibilidade
  aplicam-se uma vez, na tabela e na factory.
- Um erro de escrita em `entity_type` falha no INSERT (violação do CHECK). Em troca, o CHECK não é
  dinâmico: um tipo novo exige migration.
- Sem FK, um pai eliminado fora do fluxo normal deixa anexos órfãos. A cascata do ADR 0021 e o seu
  guard test existem para isso.
- A validação de ownership é por convenção: sem `ownershipQuery`, um anexo seria alcançável só pelo
  id. A factory obriga a declará-la.

## Alternativas rejeitadas

1. **Uma tabela por entidade.** Schemas quase iguais que divergem com o tempo; cada entidade nova
   pede tabela e handlers equivalentes; queries transversais obrigam a `UNION`.
2. **Herança de tabelas do PostgreSQL.** Constraints e FKs comportam-se mal com herança e não há
   ganho face à tabela polimórfica.
3. **EAV (entity-attribute-value).** Perde-se a estrutura: filtrar por `mime_type` ou `file_size`
   fica frágil e deixa de haver CHECK constraints.
4. **Base de dados documental só para os metadados.** Os ficheiros já vivem em S3; o que falta é
   metadata relacional. Seria uma segunda base de dados por causa de uma tabela.

## Sinais de alerta para code review

- Tabela nova `core.<entidade>_attachment`.
- Tipo novo adicionado só em alguns dos seis sítios da lista acima.
- Query a `core.attachment` só por `id`, sem `condominium_id` + `entity_type` + `entity_id`.
- Handler que serve ou elimina um anexo sem validar a entidade-pai.

## Referências

- Tabela, índice `idx_attachment_entity` e triggers:
  [`001_bootstrap.sql`](../../src/db/migrations/001_bootstrap.sql) e
  [`020_trg_tenant_guard.sql`](../../src/db/components/020_trg_tenant_guard.sql).
- Código: [`schemas/attachment.ts`](../../src/apps/api/libs/postgres/schemas/attachment.ts),
  [`attachments/mod.ts`](../../src/apps/api/libs/attachments/mod.ts),
  [`attachments/manager.ts`](../../src/apps/api/libs/attachments/manager.ts),
  [`storage/storage_key.ts`](../../src/apps/api/libs/storage/storage_key.ts),
  [`attachments/cascade_guard_test.ts`](../../src/apps/api/libs/attachments/cascade_guard_test.ts).
- [ADR 0003](./0003-portal-visibility-scope.md) (visibilidade no portal),
  [ADR 0021](./0021-s3-delete-before-db.md) (S3 antes da BD),
  [ADR 0011](./0011-actor-snapshot-convention.md) (colunas de actor).
- `CONTEXT.md`: Attachment, Document.
