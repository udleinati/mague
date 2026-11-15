# ADR 0011 - Convenção do `ActorSnapshot` (created_by / updated_by / deleted_by)

## Contexto

O sistema tem de responder a "quem fez o quê" de forma uniforme: nas colunas de cada tabela e no
audit log. Sem uma regra única, cada tabela regista o actor à sua maneira (umas colunas, outras não;
texto numas, JSONB noutras) e os handlers validam o actor caso a caso.

## Decisão

O Actor é sempre um **User**, capturado como snapshot JSONB (`ActorSnapshot`) nas colunas
`created_by` / `updated_by` / `deleted_by` e no campo `actor` de `audit.cdc_log` e
`audit.email_log`. Não existe actor "sistema": uma operação sem utilizador (script, job, trigger)
regista `{}`.

### 1. Forma canónica

```ts
interface ActorSnapshot {
  user_id?: string;
  email?: string | null;
  ip?: string | null;
  user_agent?: string | null;
  request_id?: string | null;
}

interface RealActorSnapshot extends ActorSnapshot {
  user_id: string; // garantido numa request HTTP autenticada
}
```

- A chave é `user_id`, não `id`: evita confusão com o id da linha.
- Chaves em snake_case, como o resto do pipeline SQL (GUCs, trigger, JSONB).
- `request_id` correlaciona as linhas de `audit.cdc_log` escritas pela mesma request.
- É um snapshot, sem FK a `core.user`: sobrevive à eliminação do utilizador.

### 2. Cobertura por lifecycle da tabela

| Lifecycle da tabela          | Colunas de actor                         | Exemplo             |
| ---------------------------- | ---------------------------------------- | ------------------- |
| Append-only escrita pela API | `created_by`                             | `core.invite_token` |
| Mutável sem soft-delete      | `created_by`, `updated_by`               | `finance.receipt`   |
| Mutável com soft-delete      | `created_by`, `updated_by`, `deleted_by` | `core.unit`         |
| Populada só por trigger      | nenhuma                                  | `finance.ledger`    |
| Views                        | nenhuma                                  |                     |
| Audit logs                   | campo `actor` próprio (nullable)         | `audit.cdc_log`     |

`deleted_at` e `deleted_by` andam sempre em par: uma tabela com soft-delete tem as duas.

### 3. Constraints

- Tabela nova: `created_by` e `updated_by` são `NOT NULL DEFAULT '{}'::jsonb`; `deleted_by` é
  nullable (preenchido no soft-delete).
- Todas as colunas de actor têm `CHECK (jsonb_typeof(col) = 'object' OR col IS NULL)`: o conteúdo é
  sempre um objeto (`{}` ou `{...}`), nunca string, array ou número.
- Algumas tabelas têm `created_by` / `updated_by` nullable (por exemplo `core.unit` e
  `finance.charge`). Quem lê trata `NULL` e `{}` da mesma forma: sem actor.
- No schema Drizzle usa-se `actorColumn("created_by")` de `_audit.ts`.

### 4. `requireActor(ctx)`

Definido em `$api/middleware/api_auth.ts`:

```ts
export function requireActor(ctx: Context<ApiEnv>): RealActorSnapshot;
```

- Chama-se no topo de qualquer handler que escreve na BD.
- Devolve um actor com `user_id` garantido; lança 401 se `apiAuth` não tiver corrido.
- Writes fora de uma request autenticada passam `{}` literal.

### 5. O middleware preenche os cinco campos

`apiAuth` constrói o actor com `user_id` e `email` do utilizador da sessão, `ip` (primeiro valor de
`x-forwarded-for`), `user_agent` e `request_id`.

`request_id` é **sempre gerado no servidor** (`crypto.randomUUID()`). Um header `x-request-id`
recebido é ignorado de propósito: não se confia em input externo para o rasto de auditoria.

### 6. Propagação explícita

Os helpers que escrevem na BD recebem `actor: ActorSnapshot` como parâmetro, tal como recebem
`postgres`. Não há AsyncLocalStorage nem estado implícito na API:

```ts
async function softDeleteTicket(
  postgres: Postgres,
  args: { condominiumId: string; ticketId: string; actor: ActorSnapshot },
): Promise<boolean>;
```

### 7. Audit trigger

`audit.fn_log_change` (component `013_audit.sql`) escreve em `audit.cdc_log` e resolve o actor por
esta ordem:

1. Da própria linha: `created_by` no INSERT; `deleted_by`, senão `updated_by`, no UPDATE;
   `deleted_by` no DELETE.
2. Se a linha não tiver actor (`NULL` ou `{}`), dos GUCs `app.user_id`, `app.user_email`, `app.ip`,
   `app.user_agent` e `app.request_id`.

A API não define estes GUCs: as colunas chegam. Um script que queira ficar identificado no audit faz
`SET LOCAL app.user_id = '...'` antes dos writes.

### 8. As respostas da API nunca expõem o actor

Nenhuma resposta JSON contém `created_by` / `updated_by` / `deleted_by`, nem as colunas de actor
específicas de domínio (`uploaded_by`, `confirmed_by`, `approved_by`, `rejected_by`), em snake_case
ou camelCase. O serializer de cada recurso omite-as. Razão: não expor ids internos, emails e IPs de
administradores a condóminos no portal.

O teste `test_api/api_actor_leak_guard_test.ts` percorre respostas de endpoints representativos e
falha se encontrar alguma destas chaves.

### 9. Testes consultam a BD

Como a API não devolve o actor, os testes E2E validam-no com query direta:
`assertActor({ table, id, column, expectedUserId })` e `assertEmptyActor(...)` em
`test_api/_helpers/actor_assertions.ts`. `test_api/api_actor_coverage_test.ts` percorre as tabelas
auditáveis escritas pela API admin e verifica as três colunas.

## Consequências

- A regra escala com o lifecycle da tabela, sem exceções caso a caso.
- `{}` é um valor válido. Um script ad-hoc que não defina o GUC passa sem rasto de autor. Nos
  handlers da API, `requireActor` garante um actor real.
- Um helper novo que escreve na BD obriga a alterar a assinatura (mais um parâmetro) em toda a
  cadeia de chamadas. É o custo de não haver dependência invisível.
- O contrato das respostas não inclui autoria: quem precisa dela consulta `audit.cdc_log`.

## Alternativas rejeitadas

1. **Actor genérico (utilizador ou "sistema") com chave `id`.** Contraria o modelo de domínio, em
   que quem age é sempre um User, e `id` confunde-se com o id da linha.
2. **`NOT NULL` sem default.** Writes sem request (scripts, triggers) ficavam sem caminho.
3. **Colunas nullable como regra.** Invariante fraco: linhas sem rasto por esquecimento.
4. **camelCase no JSONB** (`userId`, `userAgent`). Todo o pipeline SQL é snake_case.
5. **Definir os GUCs `app.*` em todas as requests.** Redundante com as colunas; o fallback só
   interessa a writes fora da API.
6. **Deixar `request_id` de fora.** A correlação entre linhas do audit log custa um campo opcional e
   paga-se a si própria em debugging.
7. **AsyncLocalStorage para o actor na API.** Dependência invisível e testes com mocking pesado; o
   padrão do projeto é explícito, como com `postgres`.

## Sinais de alerta para code review

- Handler que escreve na BD sem `const actor = requireActor(ctx);` no topo.
- Helper que escreve na BD sem parâmetro `actor`, ou que o aceita como `string` (só o id).
- `actor.id` em vez de `actor.user_id`.
- Serializer ou projeção que devolve `createdBy` / `updatedBy` / `deletedBy` (ou `uploadedBy`,
  `confirmedBy`, `approvedBy`, `rejectedBy`).
- Tabela nova sem as colunas da sua linha na tabela de cobertura, sem o CHECK de objeto, ou com
  `deleted_at` sem `deleted_by`.
- Soft-delete que preenche `deleted_at` e não `deleted_by`.
- `request_id` lido de um header do cliente.

## Referências

- Tipos e `actorColumn`: [`schemas/_audit.ts`](../../src/apps/api/libs/postgres/schemas/_audit.ts).
- `apiAuth` e `requireActor`: [`api_auth.ts`](../../src/apps/api/middleware/api_auth.ts).
- Trigger de audit: [`013_audit.sql`](../../src/db/components/013_audit.sql).
- Colunas e CHECKs por tabela: [`001_bootstrap.sql`](../../src/db/migrations/001_bootstrap.sql).
- Testes: `test_api/api_actor_coverage_test.ts`, `test_api/api_actor_leak_guard_test.ts`,
  `test_api/_helpers/actor_assertions.ts`.
- [ADR 0004](./0004-audit-cdc-trigger-driven.md) - audit CDC por trigger.
- [ADR 0005](./0005-soft-delete-convention.md) - soft-delete e `deleted_by`.
- [ADR 0002](./0002-user-role-consolidation.md) - User como identidade.
- `CONTEXT.md`: Actor, Audit log.
