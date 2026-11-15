# ADR 0033 - Assembleia: ponto da ordem do dia vs deliberação

## Contexto

O mesmo registo de uma assembleia guarda dois conceitos distintos do domínio: o **assunto a tratar**
(`subject`, `description`, `sequence`, `item_type`) e o **resultado de o votar** (`approved`,
`votes_in_favor/against/abstain` e as linhas individuais em `core.assembly_vote`).

A máquina de estados (`$shared/assembly/lifecycle.ts`) separa os dois momentos: `canEditAgenda` só
em `draft`, `canRecordMeeting` só em `scheduled`. Em rascunho monta-se a **ordem do dia** (os
pontos); a **deliberação** é o que se decide sobre cada ponto e só existe depois de a assembleia ser
convocada e votada. Chamar "deliberação" a tudo, em qualquer estado, confunde quem usa a aplicação e
quem lê o código.

## Decisão

### 1. A entidade é o ponto da ordem do dia: `assembly_agenda_item`

O nome é o mesmo em todas as camadas, sem seams:

- BD: tabela `core.assembly_agenda_item`, coluna `item_type`, FK
  `core.assembly_vote.assembly_agenda_item_id`.
- TS: export Drizzle `assemblyAgendaItem`, tipos `AssemblyAgendaItem*`, schemas zod
  `assemblyAgendaItem*Schema`, handlers `create/update/deleteAssemblyAgendaItem`, relação Drizzle e
  campo de resposta JSON `agendaItems`.
- Rotas da API e do Panel: segmento `/agenda-items`.

Valores de `item_type`: `approve_budget`, `accounts_approval`, `admin_election`,
`approve_fcr_usage`, `info`, `other`. Os campos de resultado (`approved`, `votes_*`) vivem na mesma
linha: a deliberação não é uma entidade à parte. Código novo nunca usa `decision`, `decisionType` ou
`assembly_decision` para o ponto.

### 2. UI: a secção chama-se sempre "Ordem do dia"; "deliberação" é só o resultado

No admin (`assembly/show.vto`, `assembly/_agenda_tbody.vto`) a secção chama-se "Ordem do dia" em
qualquer estado, porque os pontos são a agenda. O verbo muda com o estado:

- `draft`: "+ Adicionar ponto", "Editar ponto", "Remover ponto da ordem do dia".
- `scheduled` (convocada): o botão da linha é "Deliberar" e o modal "Deliberar sobre o ponto" /
  "Registar deliberação"; o toast diz "Deliberação registada". Pontos `info` não se votam: o botão é
  "Nota".

O resultado de cada ponto aparece na coluna "Resultado" (Aprovada / Rejeitada / Pendente). A
convocatória (`assembly_convocation.vto`, variável `agendaItems`) e o portal usam "Ordem do dia".

### 3. A acta recebe os pontos na variável `decisions`

`assembly_minutes.vto` (a acta) é a superfície onde os pontos já foram votados: aí são, de facto,
deliberações. Por isso a variável de render `decisions`, passada por `minutes_pdf.ts`, mantém-se de
propósito: é o termo de domínio correto depois do voto, não um resto por renomear. A secção da acta
intitula-se "Ordem do dia", com um bloco "Ponto N" por ponto e o resultado da votação em cada um.

### 4. Renomear a tabela ou as colunas obriga a recriar as funções PL/pgSQL que as referenciam

`core.fn_assembly_held_approve_budgets()` (definida só no bootstrap) e
`core.fn_assembly_vote_aggregate()` (componente `011_trg_assembly_vote_aggregate.sql`) referenciam
`core.assembly_agenda_item` pelo nome. Os componentes são re-aplicados depois das migrations: uma
migration que renomeie um objeto referenciado por estas funções inclui o `CREATE OR REPLACE` delas
na própria migration. Ver as armadilhas em [`src/db/CLAUDE.md`](../../src/db/CLAUDE.md).

## Consequências

- O nome da entidade reflete o que ela é durante a maior parte do ciclo de vida; "deliberação" fica
  reservada ao resultado.
- Em `001_bootstrap.sql`, alguns nomes de constraints da tabela têm o prefixo `assembly_decision_`.
  São só nomes de constraint, sem efeito em código.

## Sinais de alerta para code review

- `decision`, `decisionType`, `assembly_decision` ou `/decisions` em código novo para o ponto.
- "Deliberações" como título da secção no admin, ou "deliberação" para um ponto ainda não votado.
- Renomear `decisions` no template da acta "por coerência".

## Referências

- [`lifecycle.ts`](../../src/shared/assembly/lifecycle.ts) - `canEditAgenda`, `canRecordMeeting`.
- [`assembly_agenda_item.ts`](../../src/apps/api/libs/postgres/schemas/assembly_agenda_item.ts) -
  schema Drizzle; handlers em [`assembly/`](../../src/apps/api/modules/admin/assembly/).
- [`assembly_minutes.vto`](../../src/apps/api/templates/assembly_minutes.vto) e
  [`minutes_pdf.ts`](../../src/apps/api/modules/admin/assembly/minutes_pdf.ts) - acta.
- CONTEXT.md: "Ordem do dia / Deliberação".
