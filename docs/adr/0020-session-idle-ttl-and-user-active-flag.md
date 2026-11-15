# ADR 0020 - Sessão com idle-TTL deslizante (3h) e `user.is_active` verificado em cada request

## Contexto

O modelo de sessão é o do [ADR 0007](./0007-jwt-envelope-valkey-session.md): JWT como envelope de um
session-id guardado em Valkey, com as permissões lidas da BD em cada request. Ficam por definir dois
comportamentos:

1. **Quanto dura uma sessão.** Uma sessão esquecida não deve ficar aberta durante dias, mas um
   administrador a meio de um trabalho longo não pode ser expulso.
2. **Como se corta o acesso a uma conta** de forma imediata e reversível, sem a eliminar.

## Decisão

### Dois prazos, de propósito diferentes

| Prazo        | Variável (default)        | Aplica-se a                      | Renovação       |
| ------------ | ------------------------- | -------------------------------- | --------------- |
| Idle TTL     | `SESSION_IDLE_HOURS` (3)  | TTL de `session:<sid>` em Valkey | em cada request |
| Cap absoluto | `SESSION_EXPIRY_DAYS` (7) | `exp` do JWT, `maxAge` do cookie | nunca           |

- **Idle TTL deslizante**: cada request autenticada faz `refreshSessionTtl(sid, idle)` (um `EXPIRE`
  em Valkey), repondo o prazo em "agora + idle". Sem uso durante esse período, a key desaparece e a
  request seguinte responde 401.
- **Cap absoluto**: o JWT é assinado no login com `exp = SESSION_EXPIRY_DAYS` e não é reemitido. Ao
  fim desse prazo é preciso novo login, mesmo com uso contínuo. Limita o cenário "token copiado por
  terceiros e mantido vivo indefinidamente".
- Valkey é a fonte de verdade da sessão; o JWT e o cookie são transporte.

Contrato com o utilizador: **3 horas sem uso obrigam a novo login**.

Onde a sessão nasce (`login.ts`, `accept_invite.ts`, `forgot_password.ts`), os dois valores são
sempre distintos:

```ts
const idleSeconds = env.sessionIdleHours * 3600;
const jwtExpirySeconds = env.sessionExpiryDays * 86400;
const session = await createSession({ userId: user.id, ttlSeconds: idleSeconds, userAgent, ip });
const token = await signSessionToken(session.id, jwtExpirySeconds);
```

Onde o TTL é renovado:

- `apiAuth`, para tudo o que está atrás do middleware.
- Cada handler de `/v1/auth/*` que exige sessão (`me`, `change-password`, `me/theme`,
  `me/terms-acknowledged`), porque essas rotas são montadas antes de `apiAuth`.

O campo `expiresAt` do JSON da sessão não é atualizado pela renovação: é informativo.

No panel, o cookie `token` tem `maxAge = SESSION_EXPIRY_DAYS`. Quando a sessão expira por
inatividade, `GET /v1/auth/me` falha, o panel elimina o cookie e redireciona para `/login`.

### `core.user.is_active` é verificado em runtime

- `loadUserMembership` exige `deleted_at IS NULL AND is_active = true`. Com a conta inativa devolve
  `null` e `apiAuth` responde 401. Como corre em cada request, o corte produz efeito na request
  seguinte.
- O login (por email e por NIF) e a recuperação de palavra-passe filtram por `is_active = true`.
- O corte é **reativo, não proativo**: mudar o flag não elimina as sessões em Valkey. Deixam de
  passar em `apiAuth` e em `GET /v1/auth/me`, e desaparecem pelo idle TTL.
- É um estado **recuperável**: reativar repõe o acesso sem perda de histórico. Distingue-se do
  soft-delete (`core.user.deleted_at`), que é definitivo.
- Só os handlers que **gerem** utilizadores passam `includeInactive: true` a `loadUserMembership`
  (`retrieve.ts`, `update.ts`, `delete.ts` e `reset_password.ts` de `admin/user/`, e
  `auth/invite_flow.ts`). A listagem de utilizadores do condomínio omite contas inativas, e repor a
  palavra-passe de uma conta inativa responde `409 USER_INACTIVE`.
- Alterar `is_active` é uma operação de identidade global: pertence ao Super, nunca a um
  administrador de condomínio. A API não expõe endpoint para o fazer.

O que **não** é `user.is_active`:

- Retirar o acesso de administrador a um condomínio: é o toggle `isManager` do
  [ADR 0002](./0002-user-role-consolidation.md), que atua em `core.manager`.
- Suspender um condómino por falta de pagamento: o condómino mantém o acesso enquanto for ocupante.

## Consequências

- Utilizadores ativos não são interrompidos pelo idle TTL; sessões abandonadas desaparecem sozinhas.
- Cada request paga um `EXPIRE` adicional em Valkey.
- `SESSION_EXPIRY_DAYS` controla só o cap do JWT e do cookie, não o TTL em Valkey. Tem de ser maior
  ou igual ao idle pretendido. O panel lê a mesma variável (`panelConfig.sessionExpiryDays`).
- Ajustar a tolerância à inatividade é mudar `SESSION_IDLE_HOURS`; não afeta JWT nem cookie.
- Uma rota em `/v1/auth/*` que exija sessão não herda nada de `apiAuth`: tem de validar a sessão,
  renovar o TTL e, se depender de a conta estar ativa, chamar `loadUserMembership` (das atuais, só
  `me` o faz).

## Alternativas rejeitadas

1. **Sessão absoluta de algumas horas, sem renovação.** Expulsa utilizadores a meio do trabalho.
2. **Modal "Renovar sessão?" com extensão sem palavra-passe.** Em segurança equivale ao TTL
   deslizante (quem está ao computador clica em "Renovar"); acrescenta código sem mudar o modelo.
3. **Modal com reautenticação por palavra-passe.** É a única opção que protege um computador deixado
   aberto, mas penaliza todos os utilizadores legítimos por um cenário pouco provável no contexto de
   uso.
4. **Timeout de inatividade no cliente (JavaScript).** Mesma proteção sem pedir palavra-passe, com
   complexidade adicional para o mesmo cenário pouco provável.
5. **Expulsão proativa**, com um índice `user_sessions:<userId>` em Valkey para eliminar as sessões
   ao mudar o flag. Complexidade sem ganho: a verificação por request já bloqueia a conta.
6. **Usar `deleted_at` para desativar.** `deleted_at` significa "nunca mais entra"; um estado
   recuperável precisa de um flag próprio.
7. **Reemitir o JWT em cada request** (com `exp` igual ao idle). Custa uma assinatura HS256 e um
   `Set-Cookie` em todas as respostas, sem ganho real quando Valkey é a fonte de verdade.

## Sinais de alerta para code review

- `signSessionToken(sid, x)` e `createSession({ ttlSeconds: x })` com o **mesmo** `x`: acabou a
  separação entre cap do JWT e idle TTL.
- Rota em `/v1/auth/*` que exige sessão e não chama `refreshSessionTtl`.
- Autenticação ou autorização que consulta `core.user` sem `is_active = true`, ou que passa
  `includeInactive: true`.
- `user.is_active` usado para restringir o acesso a um só condomínio ou para suspender por dívida.
- Handler per-condomínio que altera `core.user.is_active`.

## Referências

- [ADR 0007](./0007-jwt-envelope-valkey-session.md) - envelope JWT e forma da sessão em Valkey.
- Variáveis: [`config/env.ts`](../../src/config/env.ts) (`sessionIdleHours`, `sessionExpiryDays`) e
  [`panel/config.ts`](../../src/apps/panel/config.ts).
- Renovação do TTL: [`session/store.ts`](../../src/apps/api/libs/session/store.ts)
  (`refreshSessionTtl`) e [`api_auth.ts`](../../src/apps/api/middleware/api_auth.ts).
- Criação da sessão: [`auth/login.ts`](../../src/apps/api/modules/auth/login.ts),
  [`auth/accept_invite.ts`](../../src/apps/api/modules/auth/accept_invite.ts),
  [`auth/forgot_password.ts`](../../src/apps/api/modules/auth/forgot_password.ts).
- Filtro `is_active`: [`membership/mod.ts`](../../src/apps/api/libs/membership/mod.ts).
- Cookie do panel: [`routes/auth.ts`](../../src/apps/panel/routes/auth.ts) e
  [`main.ts`](../../src/apps/panel/main.ts).
- `CONTEXT.md`: User ativo, Manager ativo num condomínio.
