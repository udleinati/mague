# ADR 0039 - Plano de pagamento: anotação informativa, com filtros e colunas nos lembretes

## Contexto

A administração precisa de sinalizar que uma fração tem um **plano de pagamento** (acordo de
regularização de dívida), descrever como se vai dar e, opcionalmente, indicar uma data final. Em
paralelo, a página `/admin/c/:cid/billing-reminders` ([ADR 0028](./0028-billing-reminder.md))
precisa de filtrar as frações por antiguidade da dívida e por presença de plano, e de mostrar quanto
da dívida vencida ultrapassa a antiguidade escolhida.

## Decisão

### 1. O plano é uma anotação informativa, não um subsistema financeiro

`core.payment_plan` não gera charges, não regista prestações pagas ou em falta e não toca no
`ledger`. Guarda notas e uma `end_date` opcional, visíveis na fração e usadas como filtro. A dívida
real vem sempre das charges; os valores do acordo escrevem-se em texto livre.

### 2. Estados gravados, transições manuais, `status` é a verdade

- Estados: `active`, `completed`, `broken`, `cancelled`. Na UI: "ativo", "cumprido", "em
  incumprimento", "cancelado" (nunca "quebrado").
- No máximo um plano `active` por fração: índice único parcial `payment_plan_one_active_per_unit` e
  verificação no handler (422 `PAYMENT_PLAN_ALREADY_ACTIVE`). Os fechados continuam na fração.
- As transições são sempre manuais. `end_date` é só a meta planeada e **não expira nada**: quando
  passa com o plano ainda `active`, a página da fração mostra a dica "terminou - rever" sem alterar
  o estado. `ended_at` só está preenchido fora de `active` (CHECK
  `payment_plan_ended_at_consistency`).
- O Panel só oferece fechar o plano ativo. O `PATCH` da API aceita também reabrir um plano fechado,
  desde que a fração não tenha outro ativo. Renegociar é fechar o plano atual e criar um novo.

Cumpriu ou incumpriu é um juízo da administração, porque o plano não segue pagamentos. O estado
gravado torna filtros e contagens determinísticos e evita meter `today` na query (ADR 0028).

### 3. Duas notas: partilhada e interna

`notes` é a **nota partilhada**: sai no email de lembrete enviado à fração. `internal_notes` é a
**nota interna**: só a administração a vê. Basta uma das duas (CHECK `payment_plan_has_note` e
`hasPaymentPlanNote` na API). Os modais de criar e editar avisam, junto ao campo, que a nota
partilhada e a data final são visíveis ao condómino.

A separação é load-bearing: o código que compõe o email carrega só `notes` e `end_date` do plano e
nunca seleciona `internal_notes`.

### 4. Na lista de lembretes, o plano é uma anotação suave, não uma supressão

- Frações com plano ativo aparecem na lista por defeito, com o badge "Em plano" e um filtro `Todas`
  / `Só sem plano` / `Só com plano` (`?plan=all|without|with`).
- O envio em massa **exclui** as frações em plano: `elegível = !inCooldown && !hasActivePlan`. A
  exclusão vive na rota `send-all` do Panel; o endpoint de envio por fração não bloqueia planos.
- O envio individual a uma fração em plano é permitido; a confirmação avisa que segue o email de
  plano.
- O cartão do dashboard conta as frações em plano como as outras.

Cobrar em massa quem tem um acordo em curso é injusto. Esconder a dívida da lista e do cartão
perderia transparência e arriscava esquecer planos em incumprimento. O envio individual cobre os
casos legítimos, como lembrar um plano que não está a ser cumprido.

### 5. Frações em plano recebem a variante de plano do email

A presença de um plano `active` escolhe a variante: assunto "Plano de pagamento: valores pendentes",
introdução a dizer que o plano está em curso, caixa "Plano de pagamento" com a nota partilhada e/ou
a data final (omitida se não houver nenhuma) e "Valores pendentes" em âmbar no lugar de "Total em
dívida" em vermelho. Linhas, total, IBAN e nota da administração são os do email normal, tal como a
categoria (`billing_reminder`), o registo e o cooldown de 14 dias.

### 6. Blocos de antiguidade: limiares cumulativos sobre a dívida vencida mais antiga

Quatro blocos, `?overdue=1|30|60|90` (default 30; qualquer outro valor cai em 30), sempre com
comparador estrito `> N` face à conciliação:

- **+1d**: frações com dívida vencida há 1 ou mais dias (baixa o gatilho, ADR 0028).
- **+30d**: frações com dívida vencida há mais de 30 dias (o gatilho normal).
- **+60d / +90d**: as do +30d cuja **dívida vencida mais antiga** (`oldestOverdueDueDate`, coluna
  "Dívida mais antiga") passa 60 / 90 dias.

Os limiares são cumulativos ("tudo o que passa de N dias"), não faixas exclusivas. Gatilho, filtro e
coluna usam a mesma noção de idade (qualquer dívida, ADR 0028). A filtragem é server-side: os
filtros viajam por query string em todos os pedidos, por isso o fragmento HTMX e o envio em massa
trabalham sempre sobre o conjunto filtrado. O cartão do dashboard usa o bloco +30d sem filtro de
plano.

### 7. Duas colunas: "Vencido +Nd" e "Total vencido"

- **Vencido +Nd** (`overdueBeyondThresholdCents`): soma do valor por saldar das dívidas com
  `reconciledThroughDate - due_date > limiar`, em que o limiar é o do bloco (0 no +1d).
- **Total vencido** (`totalOwedCents`): todas as dívidas com `due_date <= reconciledThroughDate`.

Ambas se referem à conciliação e excluem charges futuras. O limiar acompanha o bloco porque, ao
escolher +60d, a administração quer ver quanto está vencido há mais de 60 dias, não há mais de 30.

## Consequências

- O plano não valida nem segue pagamentos reais: fechá-lo no estado certo é responsabilidade da
  administração.
- Um plano deixado `active` depois de terminar continua a tirar a fração do envio em massa até ser
  fechado. A dica "terminou - rever" mitiga.
- Tudo o que se escreve na nota partilhada chega ao condómino no próximo lembrete enviado à fração.

## Alternativas rejeitadas

- **Motor de prestações** (gerar charges, seguir pagamentos, imputar): um subsistema com triggers e
  ledger, desproporcionado para quem só precisa de informar.
- **Expiração automática por `end_date`**: tira o juízo à administração e mete `today` nas queries.
- **Suprimir da lista e do cartão as frações em plano**: perde transparência.
- **Email normal de "valores em atraso" para frações em plano**: tom errado para quem tem um acordo
  em curso.
- **Uma só nota, visível ao condómino**: a administração precisa de escrever o que o condómino não
  deve ler.
- **Faixas exclusivas** (por exemplo 60 a 89 dias): a operação típica é a cobrança escalada.
- **Limiar fixo de 30 dias na coluna "Vencido"**: deixaria de responder à pergunta que o bloco faz.

## Sinais de alerta para code review

- `internal_notes` / `internalNotes` lido no caminho que compõe um email.
- Estado do plano derivado de `end_date` ou de `today`.
- Envio em massa que não filtra `hasActivePlan`.
- "quebrado" na UI para o estado `broken`.

## Referências

- [ADR 0028](./0028-billing-reminder.md) - elegibilidade, guard de conciliação, cooldown, email.
- `core.payment_plan` em [`001_bootstrap.sql`](../../src/db/migrations/001_bootstrap.sql); schema em
  [`payment_plan.ts`](../../src/apps/api/libs/postgres/schemas/payment_plan.ts).
- [`payment_plan/`](../../src/apps/api/modules/admin/payment_plan/) - endpoints
  `.../units/:unitId/payment-plans`.
- [`billing_reminder/_helpers.ts`](../../src/apps/api/modules/admin/billing_reminder/_helpers.ts) -
  `findOverdueUnits` (blocos, colunas, plano por fração).
- [`payment_plan_views_test.ts`](../../src/apps/panel/payment_plan_views_test.ts) - testes de vista.
- CONTEXT.md: "Plano de pagamento".
