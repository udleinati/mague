# ADR 0007 - JWT envelope sobre session-id em Valkey (não JWT stateless)

## Contexto

Todos os endpoints `/v1/admin/*`, `/v1/portal/*` e `/v1/super/*` exigem autenticação. Requisitos:

1. **Logout instantâneo** e **revogação** de uma sessão sem esperar que o token expire.
2. **Permissões atualizadas a meio da sessão**: se um administrador perde o acesso a um condomínio,
   a request seguinte tem de falhar.
3. **Bearer token portátil** para clientes da API.
4. **Cookie no panel**, que é SSR e não manuseia tokens em JavaScript.

Os dois primeiros pedem estado no servidor; o terceiro pede um token transportável em header.

## Decisão

**O token é um JWT HS256 que serve só de envelope para um session-id. A sessão vive em Valkey. As
permissões não vivem em nenhum dos dois: são lidas da BD em cada request.**

### Token e sessão

```
Authorization: Bearer <jwt>      payload: { sid, exp }
session:<sid>  (Valkey)          { id, userId, createdAt, expiresAt, userAgent, ip }
```

- O JWT é assinado com `SESSION_SECRET`. O payload só tem `sid` e `exp`: sem claims de papel,
  condomínios ou email.
- A API só aceita `Authorization: Bearer`. Não lê cookies nem headers de identidade (`x-role`,
  `x-session-id`, `x-user-*`).
- `sid` é um `nanoid(32)` gerado em `createSession`. A sessão guarda identidade, não permissões.
- A validade real é o TTL da key em Valkey; o campo `expiresAt` do JSON é informativo. Prazos e
  renovação estão no [ADR 0020](./0020-session-idle-ttl-and-user-active-flag.md).

### Permissões

Em cada request, `apiAuth` chama `loadUserMembership(postgres, userId)`, que lê da BD o utilizador e
a sua vinculação ([ADR 0002](./0002-user-role-consolidation.md)). O resultado fica memoizado no
contexto da request (`membership`). Uma alteração de acessos produz efeito na request seguinte, sem
tocar na sessão.

### Fluxo

1. **Login** (`POST /v1/auth/login`): valida credenciais, `createSession` em Valkey,
   `signSessionToken(sid, ...)` e devolve o `token` no body. Aceitar um convite e repor a
   palavra-passe terminam da mesma forma.
2. **Request protegida**: `apiAuth` faz `extractSidFromBearer` (verifica assinatura e `exp`),
   `getSession(sid)`, `loadUserMembership`, renova o TTL e preenche o contexto (`role`,
   `condominiumId`, `managedCondominiumIds`, `actor`, `membership`). Qualquer passo que falhe
   responde 401.
3. **Logout** (`POST /v1/auth/logout`): `deleteSession(sid)`. O JWT continua criptograficamente
   válido, mas a request seguinte falha porque a sessão já não existe.

As rotas `/v1/auth/*` são montadas antes de `apiAuth`. As que exigem sessão (`me`,
`change-password`, `me/theme`, `me/terms-acknowledged`) extraem o `sid` do Bearer e chamam
`getSession` no próprio handler.

### Panel

O cookie `token` (HttpOnly, SameSite=Lax, path `/`) transporta o mesmo JWT. O panel não verifica o
JWT nem fala com Valkey: o primeiro middleware de `main.ts` lê o cookie e chama `GET /v1/auth/me`
com o Bearer; com a resposta constrói o `PanelUser` e injeta o `PanelRequestContext` em
AsyncLocalStorage (`context.ts`). Se a API rejeitar, o cookie é eliminado e o utilizador segue para
`/login`. As chamadas panel -> API levam `Authorization: Bearer <token>` (`defaultApiHeaders()`).

## Consequências

- Logout e revogação são imediatos: eliminar `session:<sid>` basta.
- Valkey é dependência crítica: sem ele ninguém autentica. Perder os dados de Valkey obriga apenas a
  novo login.
- Cada request paga um round-trip a Valkey e as leituras de `loadUserMembership` na BD. É o custo de
  as permissões nunca estarem desatualizadas.
- HS256 é simétrico: quem conhecer `SESSION_SECRET` forja envelopes, mas não sessões (o `sid` tem de
  existir em Valkey). O segredo vive em variável de ambiente e a rotação é manual.
- Não há índice de sessões por utilizador. Cortar o acesso de uma conta faz-se por `user.is_active`
  (ADR 0020), não a varrer sessões.
- Refresh tokens ou federação OAuth/OIDC cabem no modelo: o login passa a aceitar outra prova de
  identidade e continua a produzir uma sessão interna com envelope.

## Alternativas rejeitadas

1. **JWT stateless**, com as claims todas no token. Logout impossível antes do `exp`; revogar exige
   uma blacklist, que é estado no servidor com pior forma; as permissões ficam congeladas até o
   token expirar.
2. **Sessão só por cookie, sem JWT.** Clientes HTTP que não são browsers lidam mal com cookies, e a
   API passaria a precisar de proteção CSRF própria.
3. **Bearer opaco, sem assinatura, com lookup direto.** Qualquer string com o formato certo chega ao
   store; o envelope assinado descarta tokens inválidos antes de tocar em Valkey.
4. **Sessões na BD, com Valkey como cache.** As sessões são efémeras e não precisam de durabilidade:
   no pior caso, o utilizador volta a entrar.

## Sinais de alerta para code review

- Claims novas no JWT ("pôr o papel no token"): é regressão para stateless.
- Handler que decide acessos a partir do payload do JWT ou do JSON da sessão em vez de `role`,
  `managedCondominiumIds` ou `membership` do contexto.
- Permissões ou vinculação guardadas em `SessionData`: ficam desatualizadas até ao próximo login.
- Autenticação por header alternativo ou por cookie na API.
- Panel a validar o JWT ou a ligar-se a Valkey em vez de chamar `/v1/auth/me`.

## Referências

- API: [`api_auth.ts`](../../src/apps/api/middleware/api_auth.ts),
  [`session/jwt.ts`](../../src/apps/api/libs/session/jwt.ts),
  [`session/store.ts`](../../src/apps/api/libs/session/store.ts),
  [`membership/mod.ts`](../../src/apps/api/libs/membership/mod.ts),
  [`modules/auth/router.ts`](../../src/apps/api/modules/auth/router.ts),
  [`modules/router.ts`](../../src/apps/api/modules/router.ts) (ordem de montagem).
- Panel: [`main.ts`](../../src/apps/panel/main.ts), [`context.ts`](../../src/apps/panel/context.ts),
  [`routes/auth.ts`](../../src/apps/panel/routes/auth.ts) (cookie).
- [ADR 0020](./0020-session-idle-ttl-and-user-active-flag.md) (idle TTL, cap do JWT,
  `user.is_active`), [ADR 0009](./0009-tenant-id-in-url-path.md) (o condomínio vem do path, não do
  token), [ADR 0011](./0011-actor-snapshot-convention.md) (o `actor` que `apiAuth` preenche).
