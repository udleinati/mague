# ADR 0032 - Reenvio de convite: cooldown anti-spam numa única constante

## Contexto

A listagem `/admin/c/:cid/users` tem um botão "convidar" / "reenviar" por utilizador que ainda não
fez login (`firstLoginAt` nulo). O endpoint
`POST /v1/admin/condominiums/:cid/occupants/:occupantId/invite` gera um novo `invite_token` (TTL de
14 dias) e envia o email com o link de acesso. Cada envio invalida o token anterior e manda um email
novo: sem travão, cliques repetidos (ou um duplo-clique) inundam o condómino com convites.

Os lembretes de cobrança ([ADR 0028](./0028-billing-reminder.md)) e de seguro usam o mesmo padrão de
cooldown: janela desde o último envio, badge "em cooldown" na UI, 422 `COOLDOWN_ACTIVE` na API.

## Decisão

### 1. Cooldown puramente anti-spam, numa única constante

Um novo convite ao mesmo utilizador fica bloqueado durante `INVITE_RESEND_COOLDOWN_DAYS` (7 dias) a
contar do `invite_token.created_at` mais recente com `purpose = 'invite'`.

A janela é **independente do TTL do token**. `createInviteToken` invalida sempre os tokens
anteriores do utilizador (`used_at = now` onde `used_at IS NULL`) antes de criar o novo, logo nunca
há dois links válidos em simultâneo, qualquer que seja o cooldown. A janela só serve para não
inundar o condómino e travar o duplo-clique; não tem de coincidir com os 14 dias do token.

Afinar o número é mudar a constante: as mensagens e os testes derivam dela, não do literal.

### 2. UI e enforcement derivam da mesma pure function e da mesma fonte

`isInInviteResendCooldown(lastInvitedAt, now)`, em `$shared/auth/invite_eligibility.ts`, é a única
decisão:

- A API (`invite_by_occupant.ts`) chama-a antes de enviar; em cooldown responde 422
  `COOLDOWN_ACTIVE`.
- A projeção do utilizador (`user/_projection.ts`) chama-a para expor `inviteInCooldown` e
  `inviteCooldownUntil` (ISO do fim da janela, via `inviteCooldownEndsAt`); o partial
  `user_invite_button.vto` troca o botão por um badge "em cooldown".

O `lastInvitedAt` vem de um só sítio: `loadLastInvitedAt` (`auth/invite_history.ts`), usado pela
listagem (em lote), pelo `retrieve` e pelo guard de reenvio. O filtro `purpose = 'invite'` é
load-bearing: sem ele, os tokens de reposição de password contam para o cooldown. Com a mesma query
e a mesma pure function, o que a UI mostra desativado e o que a API recusa nunca divergem.

### 3. "Quanto falta" no tooltip daisyUI, sem timer JS

O badge fica compacto ("em cooldown"); o tooltip dá "faltam N dias - reenvio a partir de
{instante}". O cálculo é server-side: a API expõe o fim da janela e o filtro Vento `formatRemaining`
(`$shared/time/remaining.ts`) devolve a frase PT-PT no render. É uma fotografia, não uma contagem
decrescente.

O tooltip usa o componente daisyUI (`class="tooltip" data-tip="..."`, CSS puro) e não o atributo
`title` nativo, que é lento e que o browser muitas vezes não mostra. A classe `tooltip-quick`, no
`<style>` de `layouts/admin.vto`, zera o atraso de abertura do daisyUI e reduz o texto; o seletor
`.tooltip.tooltip-quick` ganha ao CSS do CDN sem depender da ordem de injeção e não toca nos
restantes tooltips. `formatRemaining` e `tooltip-quick` são partilhados por todos os badges de
cooldown (utilizadores, lembretes de cobrança, seguros, destinatários da convocatória).

### 4. A aritmética da janela vive num primitivo partilhado

`cooldown(lastAt, windowDays, now) -> { active, endsAt, remainingMs }` e
`cooldownEndsAt(lastAt, windowDays)`, em `$shared/time/cooldown.ts`, concentram a matemática. Cada
domínio mantém o seu **nome** e a sua **constante** por cima (seam fino) e só cede a aritmética:
convite (`$shared/auth/invite_eligibility.ts`, 7 dias), lembrete de cobrança
(`$shared/billing/reminder_eligibility.ts`, 14 dias), lembrete de seguro
(`$shared/insurance/policy_status.ts`, 14 dias) e convocatória
(`$shared/assembly/convocation_eligibility.ts`, 1 dia).

Isto não acopla domínios: é extrair um primitivo, no mesmo estilo de `parseEurosToCents` e
`byIdInCondo` ([ADR 0030](./0030-shared-action-helpers.md)). O primitivo é puro e não chama
`new Date()`: o caller passa `now`.

### Outras regras

- Sem coluna nova na BD: o cooldown deriva-se de `invite_token`, que já regista cada envio.
- O primeiro convite nunca está em cooldown (`lastInvitedAt === null`).
- Ocupante sem utilizador (`occupant.user_id IS NULL`) nunca foi convidado: o guard é saltado.

## Consequências

- Impede spam de convites e duplo-clique sem alterar o schema.
- A administração não consegue reenviar de imediato a quem perdeu ou não recebeu o email: espera o
  fim da janela. O tooltip diz quando.

## Alternativas rejeitadas

- **Janela igual ao TTL do token (14 dias)**: desnecessário, porque reenviar já invalida os tokens
  anteriores.
- **Cooldown configurável por condomínio**: não há sinal de que precise de variar.
- **"Faltam N dias" inline no badge**: ocupa demasiado espaço na linha.
- **Uma cópia da aritmética por domínio** ("duplicação < acoplamento"): com vários cooldowns, as
  funções-irmãs divergem na forma (umas devolvem `Date`, outras `number`); o primitivo resolve sem
  acoplar domínios.

## Sinais de alerta para code review

- Query própria a `invite_token` para saber "quando foi convidado". Usar `loadLastInvitedAt`.
- O literal `7` (ou "7 dias") em mensagens ou testes de convite. Derivar da constante.
- Aritmética de janela inline (`Date.now() - x > N * 86_400_000`). Usar `cooldown`.
- `title="..."` para a informação de cooldown. Usar `tooltip tooltip-quick` + `data-tip`.

## Referências

- [`cooldown.ts`](../../src/shared/time/cooldown.ts) - primitivo de janela;
  [`invite_eligibility.ts`](../../src/shared/auth/invite_eligibility.ts) - constante e pure
  functions do convite.
- [`invite_history.ts`](../../src/apps/api/modules/auth/invite_history.ts) - `loadLastInvitedAt`;
  [`invite_by_occupant.ts`](../../src/apps/api/modules/auth/invite_by_occupant.ts) - guard na API;
  [`_invite_helpers.ts`](../../src/apps/api/modules/auth/_invite_helpers.ts) - `createInviteToken`.
- [`user/_projection.ts`](../../src/apps/api/modules/admin/user/_projection.ts) - campos
  `inviteInCooldown` / `inviteCooldownUntil`.
- [`user_invite_button.vto`](../../src/apps/panel/templates/partials/user_invite_button.vto) - botão
  e badge; rota em [`users.ts`](../../src/apps/panel/routes/admin/users.ts), via `htmxAction`
  ([ADR 0030](./0030-shared-action-helpers.md)).
- [`remaining.ts`](../../src/shared/time/remaining.ts) - `formatRemaining`; `.tooltip-quick` em
  [`admin.vto`](../../src/apps/panel/templates/layouts/admin.vto).
- [ADR 0028](./0028-billing-reminder.md) - cooldown do lembrete de cobrança.
