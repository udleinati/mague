# ADR 0009 - `condominium_id` no path da URL (não em cookie/header)

## Contexto

O condomínio é a unidade multi-tenant: um utilizador pode aceder a vários, cada um tem o seu silo de
dados, e nenhuma query de domínio pode atravessar condomínios por engano. Onde vive o "condomínio
ativo" durante uma request condiciona a validação de tenancy, a geração de links, as operações
cross-tenant do Super, a auditoria e a exposição a CSRF/IDOR.

## Decisão

**O `condominium_id` faz parte do path em todas as rotas de admin e de portal. Nunca vem de cookie,
header, token ou sessão.**

| Superfície   | Forma                                            |
| ------------ | ------------------------------------------------ |
| Panel admin  | `/admin/c/:cid/<recurso>/...`                    |
| Panel portal | `/portal/c/:cid/u/:unitId/...`                   |
| API admin    | `/v1/admin/condominiums/:cid/<recurso>/...`      |
| API portal   | `/v1/portal/condominiums/:cid/units/:unitId/...` |
| API super    | `/v1/super/...` (sem `cid`: opera cross-tenant)  |

No portal, a fração ativa segue a mesma regra: o `unitId` vem do path, nunca de query string nem do
body. Os recursos do portal ao nível do condomínio (documentos, assembleias, orçamentos) não levam
`units/:unitId`.

### API

1. `apiAuth` extrai o `cid` do path e responde 403 se o utilizador não for Super, administrador
   desse condomínio ou ocupante nele. Guarda o valor em `condominiumId` no contexto.
2. `requireAdminRole` fecha `/v1/admin/condominiums/:cid/*` a Super e administradores do `cid`.
3. `requirePortalAccessToCondo` e `requirePortalAccessToUnit` fecham o portal a quem tem ligação
   ativa a uma fração do condomínio (ou àquela `:unitId`). Respondem 404, não 403, para não permitir
   enumeração.
4. `requireUnitInCondo` confirma, nas rotas admin onde está montado, que a `:unitId` do path
   pertence ao `cid`.
5. Os handlers leem o condomínio com `requireCondominiumId(ctx)`.

Toda a query de domínio filtra por `condominium_id` com o `cid` do path. Para não depender de
memória:

- `byIdInCondo(schema.X, id, cid)` e `listWhere(schema.X, cid, ...)` trazem o tenant scope por
  construção ([ADR 0030](./0030-shared-action-helpers.md)).
- Ids de outras entidades vindos do body validam-se com `assertOwnership` antes do INSERT: as FKs só
  garantem que a linha existe, não que é do mesmo condomínio.
- Última barreira na BD: o trigger `core.fn_tenant_guard` (component `020_trg_tenant_guard.sql`)
  rejeita uma linha que aponte para uma entidade de outro condomínio.

### Panel

- O primeiro middleware de `main.ts` extrai o `cid` (e, no portal, o `unitId`) do path para o
  `PanelRequestContext` (AsyncLocalStorage, `context.ts`). Usa o path descodificado, tal como o
  router o vê: no path cru, um segmento percent-encoded passa ao lado do gate.
- O segundo middleware valida o acesso: administrador ou Super em `/admin/c/:cid/...`; no portal, a
  fração tem de ser do utilizador **e** daquele `cid`. Sem acesso, responde uma página 404 neutra.
- O `Client` partilhado (`$panel/client.ts`) compõe os URLs da API com `currentCondominiumId`.
- Links: `condoUrl()` / `portalUrl()` (`urls.ts`) e o filtro Vento `condoPath` prefixam o `cid`
  ativo.
- Mudar de condomínio é navegar: `/choose-condominium` lista os condomínios acessíveis e segue para
  `/admin/c/<cid>/dashboard`. Não existe "cookie de tenant".
- `/c/:cid/...` (sem `/admin`) responde 308 para `/admin/c/:cid/...`, preservando o método.

Emails e notificações levam o `cid` no link (e o `unitId`, se for portal), por exemplo
`/portal/c/<cid>/u/<unitId>/receipts/<receiptId>`.

## Consequências

- **URL autossuficiente**: um link partilhado ou guardado leva ao mesmo sítio, sujeito a permissões.
  Dois separadores em condomínios diferentes não interferem.
- **Auditoria direta**: o `cid` está no path de cada request e, portanto, nos logs.
- **Tenancy por construção**: o middleware valida o `cid` do path e as queries usam esse mesmo
  valor; não há contexto lateral que possa ficar dessincronizado.
- URLs mais compridos, e cada link (no panel ou num email) tem de ser composto com o `cid`.

## Alternativas rejeitadas

1. **Cookie ou header `x-condominium-id`.** O URL deixa de ser autossuficiente; dois separadores em
   condomínios diferentes interferem (o cookie é por domínio); a auditoria perde o condomínio do
   path; e um contexto lateral é mais fácil de forjar ou de deixar desalinhado do que o path.
2. **Claim `cid` no JWT.** Mudar de condomínio obrigaria a reemitir o token, e a sessão ficaria
   presa a um condomínio (ver [ADR 0007](./0007-jwt-envelope-valkey-session.md)).
3. **Path no panel e cookie na API.** Duas convenções para o mesmo dado, com bugs de sincronização
   entre o estado do panel e o da API.

## Sinais de alerta para code review

- Rota nova de admin ou de portal sem `:cid` no path. Só `/v1/super/*` fica de fora.
- `cid` (ou `unitId` no portal) lido de cookie, header, query string, body ou sessão.
- Query de domínio sem filtro por `condominium_id`, ou lookup por `id` sem `byIdInCondo`.
- Id de outra entidade aceite do body sem `assertOwnership`.
- Link no panel ou num email com path sem `cid`.
- Proposta de "pôr o `cid` na sessão para limpar os URLs": se o motivo é cosmético, rejeitar. Se há
  um problema real (links a levar ao sítio errado), a causa está em auth ou permissões e um cookie
  não o resolve.

## Referências

- API: [`api_auth.ts`](../../src/apps/api/middleware/api_auth.ts),
  [`require_admin_role.ts`](../../src/apps/api/middleware/require_admin_role.ts),
  [`require_portal_access.ts`](../../src/apps/api/middleware/require_portal_access.ts),
  [`require_unit_in_condo.ts`](../../src/apps/api/middleware/require_unit_in_condo.ts),
  [`require_condominium.ts`](../../src/apps/api/libs/shared/require_condominium.ts),
  [`assert_ownership.ts`](../../src/apps/api/libs/shared/assert_ownership.ts),
  [`modules/router.ts`](../../src/apps/api/modules/router.ts).
- BD: [`020_trg_tenant_guard.sql`](../../src/db/components/020_trg_tenant_guard.sql), teste em
  `test_sql/tests/0067_tenant_guard.sql`.
- Panel: [`main.ts`](../../src/apps/panel/main.ts), [`context.ts`](../../src/apps/panel/context.ts),
  [`client.ts`](../../src/apps/panel/client.ts), [`urls.ts`](../../src/apps/panel/urls.ts),
  [`render.ts`](../../src/apps/panel/render.ts) (`condoPath`).
- Testes E2E: `test_api/api_tenant_isolation_test.ts`, `test_api/api_cross_tenant_ids_test.ts`.
- [ADR 0002](./0002-user-role-consolidation.md) (quem administra que condomínio),
  [ADR 0030](./0030-shared-action-helpers.md) (`byIdInCondo`, `listWhere`, `requireCondoAdmin`).
