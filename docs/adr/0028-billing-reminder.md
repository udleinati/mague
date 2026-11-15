# ADR 0028 - Lembrete de cobrança: atraso face à conciliação, guard de 3 dias, cooldown de 14 dias

## Contexto

A administração precisa de uma forma uniforme de reclamar por email a dívida vencida de cada fração:
o **lembrete de cobrança** (`billing_reminder`). A página `/admin/c/:cid/billing-reminders` lista as
frações elegíveis, com envio por fração e em massa; o dashboard tem um cartão com a contagem de
frações em atraso há mais de 30 dias. Três riscos moldam as regras: acusar uma dívida já paga mas
ainda não conciliada, inundar o condómino com emails, e escrever a quem não responde pela dívida.

## Decisão

### 1. O atraso mede-se face a `reconciledThroughDate`, nunca a `today`

Os dias de atraso de uma charge são `condominium.reconciled_through_date - charge.due_date`
(`overdueDaysAgainst`). Entre o pagamento real e a conciliação bancária decorrem dias; medir contra
`today` contaria como atrasadas charges já pagas que ainda não foram conciliadas, e um falso
positivo aqui é um email injusto. Sem data de conciliação não há frações elegíveis.

### 2. Guard de conciliação: envio bloqueado acima de 3 dias

`canSendBillingReminder` bloqueia o envio quando `reconciled_through_date` é `NULL` ou está a mais
de `RECONCILIATION_GUARD_DAYS` (3) dias de hoje. A API responde 422 (`RECONCILIATION_NEVER` /
`RECONCILIATION_STALE`); a página desativa os botões e mostra um aviso com link para
`/reconciliation`. Os 3 dias toleram um fim de semana ou feriado em que o extrato ainda não saiu. É
uma constante, não uma configuração por condomínio.

### 3. Destinatários: proprietários e residentes, nunca inquilinos

Recebem o lembrete os ocupantes com ligação ativa à fração, `relationship_type` `owner` ou
`resident`, e email preenchido (`resolveBillingRecipients`); sem nenhum, a API responde 422
`MISSING_EMAIL`. O proprietário é quem responde pela dívida (Art. 1424.º CC). O inquilino tem
contrato com o senhorio, não com a administração: reclamar-lhe uma dívida que não é dele é confuso e
juridicamente desadequado. Os residentes ficam incluídos porque, em muitas frações, são quem trata
da correspondência com a administração.

### 4. Dívida é qualquer débito por saldar, sem allowlist de `charge_type`

Uma charge conta como dívida em atraso (`isChargeOverdueForBilling`) quando é receivable da fração,
não está cancelada, tem `nature = 'debit'`, tem valor por saldar e está vencida além do limiar.
Quota, quota extraordinária, refaturação e saldo inicial em dívida contam todas. É a mesma noção de
dívida de `finance.v_unit_balance.overdue_debt_cents`, que alimenta o resto do Panel.

O guard `nature = 'debit'` é load-bearing: sem allowlist de tipos, é ele que impede uma nota de
crédito ou um saldo credor de contar como dívida. `computeBillingEmailTotals` tem o mesmo guard.

### 5. Limiar do gatilho: mais de 30 dias; o bloco +1d baixa-o para 1 dia

Uma fração é elegível quando tem pelo menos uma dívida vencida há mais de `OVERDUE_THRESHOLD_DAYS`
(30) dias, com comparador estrito (30 dias exatos não contam). É o default da página e a contagem do
cartão do dashboard. O bloco +1d baixa o gatilho para "vencida há 1 ou mais dias" (`> 0`), com o
mesmo lembrete, o mesmo guard e o mesmo cooldown. Os blocos +60d e +90d não mudam o gatilho:
restringem a lista ([ADR 0039](./0039-payment-plan.md)).

### 6. Cooldown de 14 dias por fração

Um novo envio à mesma fração fica bloqueado durante `BILLING_REMINDER_COOLDOWN_DAYS` (14) a contar
do último `billing_reminder.sent_at` em que pelo menos um destinatário ficou `sent`. Tentativas em
que todos falharam não contam: pode repetir-se logo depois de corrigir o email. Dentro da janela a
API responde 422 `COOLDOWN_ACTIVE` e a página mostra o badge "em cooldown"
([ADR 0032](./0032-invite-resend-cooldown.md)).

### 7. Email, registo e envio em massa

- O gatilho decide **se** a fração é elegível; o email mostra **tudo** o que está vencido: todos os
  débitos por saldar com `due_date <= reconciledThroughDate`. Charges futuras nunca entram.
- O crédito da fração (pagamentos adiantados não imputados) é mencionado, não subtraído ao total.
- A nota da administração (`condominium.billing_reminder_note`, editada na página) aparece no topo.
  O texto manda ignorar o aviso se o pagamento já foi feito, e o rodapé diz que o email foi gerado a
  partir do estado da conciliação.
- Frações com plano de pagamento ativo recebem a variante de plano do email (ADR 0039).
- A pré-visualização usa o mesmo contexto do envio (`loadBillingEmailContext`), para ser fiel ao
  email real. Não envia nem regista, e não aplica o cooldown nem o limite de 3 dias: só exige que
  exista data de conciliação.
- Cada envio grava uma linha em `core.billing_reminder` por (condomínio, fração, envio), com
  `trigger` (`individual` | `bulk`) e `recipients[]` em JSONB (estado por destinatário), mesmo
  quando todos falham. A falha de um destinatário não interrompe os restantes.
- A API só envia por fração (`POST .../billing-reminders/units/:unitId`). O envio em massa é a rota
  `send-all` do Panel, que percorre em sequência as frações da lista filtrada que não estão em
  cooldown nem em plano de pagamento e chama esse endpoint com `trigger: "bulk"`.

## Consequências

- Os emails só saem quando a conciliação está fresca o suficiente para a dívida ser real. Quem não
  concilia regularmente fica bloqueado de enviar; o aviso na página explica porquê.
- Os inquilinos não recebem o aviso, mesmo vivendo na fração. É intencional.
- O cooldown é partilhado entre blocos: enviar no bloco +1d adia o próximo envio 14 dias.
- No bloco +1d pode haver falsos positivos (pagamento feito depois da data de conciliação). O guard
  de 3 dias e a frase do email cobrem o caso.

## Alternativas rejeitadas

- **Medir o atraso contra `today`**: mais simples, mas acusa charges pagas e ainda não conciliadas.
- **Enviar a todos os ocupantes** (regra do lembrete de seguro): incluiria inquilinos.
- **Allowlist de `charge_type` no gatilho** (só quotas): uma fração que só deve uma refaturação ou
  uma quota extraordinária ficaria fora da lista e do total, que deixaria de bater com o Panel.
- **Um "aviso precoce" próprio**, com email e cooldown separados: complexidade sem necessidade; o
  bloco +1d reutiliza o mesmo lembrete.
- **Guard mais apertado só para o bloco +1d** (conciliação diária obrigatória): desnecessário.

## Sinais de alerta para code review

- `new Date()` / `today` para decidir se uma charge está em atraso.
- Lista de `charge_type` no gatilho, ou remoção do guard `nature === "debit"`.
- `tenant` em `relationshipTypes` do lembrete de cobrança.
- Guard ou cooldown recalculados fora de `canSendBillingReminder` / `isInBillingReminderCooldown`.

## Referências

- [`reminder_eligibility.ts`](../../src/shared/billing/reminder_eligibility.ts) - constantes, guard
  e cooldown; [`overdue.ts`](../../src/shared/billing/overdue.ts) - dívida em atraso e totais.
- [`billing_reminder/`](../../src/apps/api/modules/admin/billing_reminder/) - `findOverdueUnits`
  (`_helpers.ts`), envio e registo (`_reminder.ts`), endpoints (`handlers.ts`).
- [`billing_reminders.ts`](../../src/apps/panel/routes/admin/billing_reminders.ts) - rotas do Panel.
- `finance.v_unit_balance` em
  [`016_vw_receipt_pending.sql`](../../src/db/components/016_vw_receipt_pending.sql).
- [ADR 0039](./0039-payment-plan.md) - blocos, filtros, colunas e plano de pagamento.
- [ADR 0032](./0032-invite-resend-cooldown.md) - primitivo de cooldown e badge "quanto falta".
- CONTEXT.md: "Lembrete de cobrança", "Conciliação".
