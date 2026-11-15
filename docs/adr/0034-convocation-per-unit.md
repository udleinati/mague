# ADR 0034 - Convocatória enviada por fração: um despacho por (pessoa, fração)

## Contexto

O email da convocatória de uma assembleia leva em anexo uma procuração, que é por natureza **por
fração**: delega o voto associado à permilagem daquela fração (Art. 1431.º n.º 5 CC). A mesma pessoa
pode estar ligada a várias frações com papéis diferentes (proprietária numas, residente noutras), e
um residente não-proprietário não vota, logo não pode dar procuração em seu nome.

## Decisão

### 1. Um destinatário por ligação ativa (ocupante × fração), sem dedup por pessoa

Cada ligação ativa de `owner` ou `resident` gera um destinatário e um email dedicado a essa fração.
O inquilino fica excluído, como nos lembretes de cobrança ([ADR 0028](./0028-billing-reminder.md)):
a regra de **quem** é notificado é a mesma, a **granularidade** é uma entrada por fração.
`classifyConvocationRecipients` (puro) devolve um destinatário por ligação;
`resolveConvocationRecipients` faz o I/O e ordena pela ordem natural das frações
([ADR 0014](./0014-unit-natural-order.md)). Um destinatário sem email não é saltado: o envio em
massa regista-o como `failed` e o reenvio individual responde 422 `NO_EMAIL`.

### 2. Tudo é indexado por `(occupantId, unitId)`

- **Chave lógica**: `recipientKey(occupantId, unitId)`.
- **Registo** (`core.assembly_convocation.recipients`, JSONB): cada item tem `unitId`. Um item sem
  `unitId` não corresponde a nenhum par e conta como nunca enviado.
- **Cooldown e reenvio individual**: a janela é por (pessoa, fração); reenviar a fração A não mexe
  na fração B. A duração está no [ADR 0032](./0032-invite-resend-cooldown.md).
- **Rotas**: reenvio e pré-visualização terminam em `/:occupantId/:unitId`.
- **Email**: o assunto identifica a fração; a procuração recebe-a já formatada em `unitLabel`
  ("designação - identificador").

### 3. Proprietário e residente recebem procurações diferentes

`planConvocationDispatch` (`convocation_dispatch.ts`, puro) é o ponto único de decisão por
destinatário; `convocation_send.ts` só renderiza e despacha o que ele resolve.

- **Proprietário** (tem voto): procuração personalizada com nome, NIF/NIPC e fração.
- **Residente** (não vota): procuração **em branco**, para um proprietário assinar; pré-preenchê-la
  em nome do residente seria juridicamente inválido. O email identifica o(s) proprietário(s) da
  fração só pelo nome (todos, em compropriedade), por isso o envio nunca aborta por faltar o email
  de um proprietário.

Os dois emails levam uma nota de correção com o contacto da administração (`replyToEmail ?? email`
do condomínio), ou sem endereço se o condomínio não tiver nenhum.

### 4. Natureza jurídica do condómino: pessoa singular ou coletiva

`core.occupant.person_type` (`singular` | `collective`, default `singular`) controla a redação e o
rótulo fiscal da procuração: "Eu, [Nome], NIF [...], relativo à fração [label] ..." ou "A [Empresa],
NIPC [...], na qualidade de proprietária da fração [label], declara nomear como sua representante
...". Sem NIF registado, a linha fica em branco para preencher à mão. O modelo genérico
(`proxy.pdf`) é renderizado sem destinatário: placeholders e redação singular.

## Consequências

O mesmo endereço pode receber vários emails (quem tem várias frações). É aceite: são documentos
distintos, e na maioria dos condomínios cada fração tem um proprietário (envio quase 1:1).

## Alternativas rejeitadas

- **Dedup por pessoa** (um email por condómino, com uma procuração a listar todas as suas frações):
  mistura num só documento frações e papéis diferentes, quando a procuração é por fração.
- **Procuração pré-preenchida em nome do residente**: quem não vota não pode ser representado.

## Sinais de alerta para code review

- `Map` ou `Set` indexado só por `occupantId` (ou por email) no caminho da convocatória.
- Ramificação "proprietário vs residente" fora de `planConvocationDispatch`.

## Referências

- Em [`assembly/`](../../src/apps/api/modules/admin/assembly/): `convocation_recipients.ts`
  (destinatários e `recipientKey`), `convocation_dispatch.ts` (planeador), `convocation_send.ts`
  (envio) e `convocation_history.ts` (último envio por par).
- [`assembly_proxy.vto`](../../src/apps/api/templates/assembly_proxy.vto) - procuração.
- CONTEXT.md: "Condómino", "Procuração (assembleia)".
