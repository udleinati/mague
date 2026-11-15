# ADR 0002 - Papéis do User: `user.role` só distingue o Super; o resto deriva das relações

## Contexto

Um utilizador pode acumular papéis diferentes em condomínios diferentes: administrador de um,
condómino noutro, inquilino num terceiro. Um papel global guardado no próprio utilizador não
consegue exprimir isto. E, se coexistir com as tabelas de relação, passa a haver duas fontes de
verdade para a mesma pergunta, em que uma delas é só informativa e acaba desatualizada.

## Decisão

`core.user.role` tem um único valor não nulo: `'super'` (constraint `users_role_check`). Tudo o que
é per-condomínio ou per-fração vive nas tabelas de relação, que são a única fonte de verdade:

| Pergunta                             | Fonte de verdade                                      |
| ------------------------------------ | ----------------------------------------------------- |
| É Super?                             | `core.user.role = 'super'`                            |
| É administrador deste condomínio?    | registo ativo em `core.manager` para `(user_id, cid)` |
| É condómino, inquilino ou residente? | `core.unit_occupant.relationship_type`, ligação ativa |

- Registo ativo em `core.manager`: `deleted_at IS NULL` e `is_active = true`.
- `relationship_type` é `owner` (condómino), `tenant` (inquilino) ou `resident`. A ligação está
  ativa com `deleted_at IS NULL` e `end_date IS NULL`.
- Um User pode acumular qualquer combinação (Super e ocupante; administrador de um condomínio e
  ocupante noutro; só administrador).

### Leitura: um único caminho

`loadUserMembership` (`$api/libs/membership/mod.ts`) carrega a vinculação do utilizador e as regras
"administrador ativo" e "ocupante ativo" vivem em `compute.ts` (puro, testado sem BD). Nenhum
handler reconstrói estas regras inline.

O middleware `apiAuth` expõe no contexto `role` (`"super" | null`) e `managedCondominiumIds`. Os
gates são `requireSuperRole` (`/v1/super/*`), `requireAdminRole` (`/v1/admin/condominiums/:cid/*`)
e, dentro dos handlers, `requireCondoAdmin(ctx)` / `isCondoAdmin(ctx)`
([ADR 0030](./0030-shared-action-helpers.md)).

### Administrador é uma propriedade do utilizador no condomínio

Não existe recurso `/managers`. Ser administrador é o booleano `isManager` do recurso `users`:

- `GET /v1/admin/condominiums/:cid/users` - cada item traz `isManager`, derivado de `core.manager`
  para o `cid` do path.
- `PATCH /v1/admin/condominiums/:cid/users/:userId` aceita `{ isManager?: boolean }`. `true`
  restaura o registo eliminado (ou cria um novo); `false` faz soft-delete do registo. Idempotente.
- O toggle só se aplica a quem já tem vinculação ao condomínio (condómino de uma fração, ou com
  registo de administrador ativo ou histórico). Fora disso responde 404.
- `DELETE /v1/admin/condominiums/:cid/users/:userId` remove a vinculação a este condomínio
  (`manager`, `occupant` e `unit_occupant` ficam com `deleted_at`). Nunca toca em `core.user`: o
  utilizador é global e pode ter relações noutros condomínios.

Salvaguardas:

- `PATCH { isManager: false }` sobre o último administrador do condomínio responde
  `409 LAST_MANAGER`.
- Retirar-se a si próprio pede uma confirmação extra no panel ("Vais perder o teu acesso de
  administrador a este condomínio").
- Um administrador pode retirar outro sem proteção adicional (confiança entre pares). O rasto fica
  em `updated_by` / `deleted_by` ([ADR 0011](./0011-actor-snapshot-convention.md)).

### Panel: uma só página

`/admin/c/:cid/users` gere todas as pessoas do condomínio: separadores "Todos", "Administradores" e
"Ocupantes" (`?filter=admin|occupant`), badge de administrador na lista, toggle "É administrador
deste condomínio" no formulário de edição. `/admin/c/:cid/managers` e subpaths respondem 308 para
`/admin/c/:cid/users?filter=admin`.

### Administrador interno e externo

A distinção é derivada, sem schema próprio: interno é quem tem registo em `core.manager` e pelo
menos um `unit_occupant` no mesmo condomínio; externo é quem tem `core.manager` sem `unit_occupant`.

### Papéis novos

- Per-condomínio (auditor, tesoureiro, ...): nunca em `user.role`. Tabela de junção própria, ou
  `core.manager` com uma coluna de tipo, como única fonte de verdade.
- Global: só se for mesmo diferente de Super. Uma restrição parcial ("vê vários condomínios, mas não
  todos") é per-condomínio.

## Consequências

- A autorização só conhece um papel global (`super`). Todos os outros acessos decidem-se pelas
  relações do utilizador com o `cid` do path ([ADR 0009](./0009-tenant-id-in-url-path.md)).
- O administrador externo é suportado pelo schema, mas não há fluxo para o criar: o toggle exige
  vinculação prévia ao condomínio.
- O soft-delete do registo em `core.manager` preserva o histórico: o utilizador continua consultável
  no condomínio depois de deixar de ser administrador, e reativar restaura o mesmo registo.

## Alternativas rejeitadas

1. **`user.role` como enum granular, sem `core.manager`.** Um papel global não distingue
   "administrador do condomínio A, mas não do B": perde-se o multi-tenant.
2. **Manter as duas fontes (enum no user e tabelas de relação).** A redundância é a origem dos bugs:
   um papel global "manager" sem registo em `core.manager` não daria acesso a nada.
3. **Generalizar `core.manager` para `core.user_condominium_role`** a pensar em vários papéis
   per-condomínio. YAGNI: faz-se quando existir um segundo papel.
4. **Entidade própria para "administrador interno".** A distinção interno/externo é derivável das
   relações existentes.

## Sinais de alerta para code review

- Valor novo em `user.role`, ou código que compara `role` com algo diferente de `"super"`.
- Check inline `role !== "super" && !managed.includes(cid)`: usar `requireCondoAdmin` /
  `isCondoAdmin`.
- Query que recalcula "é administrador" ou "é ocupante" em vez de usar `loadUserMembership`.
- Handler per-condomínio que escreve em `core.user` para alterar acessos.
- Duas páginas do panel a gerir o mesmo recurso: se a diferença é um booleano derivado, é uma
  coluna, um badge ou um filtro na lista única.

## Referências

- Constraint `users_role_check` e tabelas `core.user`, `core.manager`, `core.unit_occupant`:
  [`001_bootstrap.sql`](../../src/db/migrations/001_bootstrap.sql).
- Vinculação: [`membership/mod.ts`](../../src/apps/api/libs/membership/mod.ts) e
  [`membership/compute.ts`](../../src/apps/api/libs/membership/compute.ts).
- Gates: [`api_auth.ts`](../../src/apps/api/middleware/api_auth.ts),
  [`require_super.ts`](../../src/apps/api/middleware/require_super.ts),
  [`require_admin_role.ts`](../../src/apps/api/middleware/require_admin_role.ts),
  [`require_condo_admin.ts`](../../src/apps/api/libs/shared/require_condo_admin.ts).
- Recurso `users`: [`admin/user/`](../../src/apps/api/modules/admin/user/) (`list.ts`, `update.ts`,
  `delete.ts`, `_projection.ts`).
- Panel: [`routes/admin/managers.ts`](../../src/apps/panel/routes/admin/managers.ts) (redirect 308)
  e [`templates/pages/users/`](../../src/apps/panel/templates/pages/users/).
- Teste E2E: `test_api/api_admin_user_manager_toggle_test.ts`.
- [ADR 0018](./0018-occupant-type-removal.md) - a relação pessoa-fração é per-ligação.
- [ADR 0020](./0020-session-idle-ttl-and-user-active-flag.md) - `user.is_active` e sessão.
- `CONTEXT.md`: User, Super, Administrador, Vinculação.
