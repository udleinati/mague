# ADR 0017 - Seguros: sem holder; a fração está coberta com pelo menos uma apólice ativa em vigor

## Contexto

Uma fração pode ter várias apólices em simultâneo. Exemplo: na fração A, a proprietária Maria Silva
tem a apólice POL-1 (estrutura e recheio) e o inquilino João Costa tem a POL-2 (recheio), de
seguradoras e com vigências diferentes. Escolher "a" apólice da fração silencia a outra.

Daí duas perguntas: **quem é o titular (holder) de cada apólice?** e **como se decide se a fração
está coberta quando há várias?**

## Decisão

### Sem holder

`core.insurance_policy` não tem FK a `core.occupant` nem coluna de titular. Cada linha é
auto-contida (seguradora, número, vigência, capital segurado, anexos) e várias coexistem na mesma
fração, sem regra de unicidade além do `id`. `uploaded_by` (ator,
[ADR 0011](./0011-actor-snapshot-convention.md)) regista quem submeteu; não é holder, serve a
auditoria e o gate "a própria submissão" do ADR 0040. Por isso re-submeter no portal apaga apenas o
rascunho `pending_review` do mesmo uploader; os de outros ocupantes ficam intactos.

### Estado agregado da fração

```
fração coberta <=> existe apólice com status = 'active' e valid_to >= hoje
```

Cada apólice é classificada por `classifyPolicy` e a fração herda o estado de maior prioridade
presente (`computeAggregateStatus`):

`active` > `expiring_soon` > `awaiting_approval` > `awaiting_confirmation` > `expired` >
`rejected_only` > `never_submitted`

- Uma ativa em vigor vence tudo o resto: a rejeitada mais recente do inquilino não tira a cobertura
  que a apólice da proprietária dá.
- `superseded` não conta: uma fração só com apólices substituídas é `never_submitted` (histórico não
  é cobertura).
- O estado sai sempre **junto com a apólice que o justifica** (`aggregateUnitStatus`), para o badge
  não ficar ao lado das datas de outra apólice. Desempate dentro do mesmo estado:
  `selectPolicyForDisplay` (`valid_to` mais distante, depois a criada mais recentemente).

### Um único caminho, duas audiências

`unitInsuranceView(policies, today, audience)` é o único caminho para o estado agregado, usado pelo
read-model do admin (`listUnitsStatus`) e pelo portal (`GET .../insurance/status`). Se cada
superfície escolhesse a sua apólice (por exemplo a mais recente), uma mostraria "Ativo" e a outra
"Rejeitada" para a mesma fração.

A audiência fixa **em conjunto** a janela de "a expirar" (`ADMIN_NOTICE_DAYS` = 30,
`OCCUPANT_NOTICE_DAYS` = 15) e o contexto dos gates; nunca um número literal no call site. A
divergência das janelas é intencional: quem persegue o documento precisa de ver o problema antes de
quem o tem de arranjar.

`core.vw_unit_insurance_status` expõe **todas** as apólices da fração num array JSONB. Qual mostrar
e qual o estado decide-se em TS, puro e testável. Não mover a regra para SQL: aí uma
`pending_review` fica escondida sob uma `active` e o admin nunca vê a renovação por rever.

### Lembretes por fração

Sem holder, os lembretes são da fração: vão para todos os ocupantes ativos com email, sem filtro de
`relationship_type`. `needsReminder` recebe o estado **agregado** (`expired`, `expiring_soon`,
`never_submitted`, `rejected_only`), não o de uma apólice escolhida: com uma ativa e uma pendente a
fração está coberta e não leva email. Os emails são por isso genéricos: o sistema não se dirige ao
titular de uma apólice concreta. Assunto e cooldown de cada envio estão no ADR 0040.

## Consequências

- Não se distingue "a fração só tem a apólice do inquilino" de "tem a do proprietário": ambas contam
  como coberta. Um regulamento que exija a do proprietário não é suportado.
- Se surgir um requisito real de granularidade por ocupante, o caminho é uma coluna aditiva com
  opt-in nas queries, sem tocar na regra do agregado.

## Alternativas rejeitadas

1. **`holder_occupant_id` (FK anulável).** Nada na lógica de domínio o usaria: os lembretes vão para
   todos os ocupantes e "coberta" só conta vigência.
2. **Junction N:N `policy_holder`** (apólice a meias). Complexidade desproporcionada (ciclo de vida
   quando alguém sai da fração, cascata ao apagar o ocupante) para um caso raro.
3. **`holder_label` em texto livre.** Ninguém o consulta; quem precisa abre o documento.
4. **Agregado = "todos os ocupantes têm apólice ativa".** Obriga a recolher o holder e amarra a
   cobertura à composição atual dos ocupantes; parte-se quando entra um inquilino sem apólice.

## Sinais de alerta para code review

- `holder_occupant_id`, `holder_label`, `policy_holder` ou afins em `insurance_policy`.
- Estado da fração calculado fora de `unitInsuranceView`, movido para a view SQL, ou com variante da
  regra ("tem de ser do proprietário", "todos os ocupantes", "a apólice mais recente").
- `needsReminder` chamado com o estado de uma apólice em vez do agregado.
- Limpeza de rascunhos ou unicidade que trate a fração como tendo uma só apólice.

## Referências

- [`$shared/insurance/policy_status.ts`](../../src/shared/insurance/policy_status.ts) -
  classificação, agregação e seleção.
- [`unit_view.ts`](../../src/apps/api/modules/admin/insurance/unit_view.ts) (`unitInsuranceView`,
  audiências), [`read_model.ts`](../../src/apps/api/modules/admin/insurance/read_model.ts)
  (`listUnitsStatus`) e a view em `src/db/components/015_vw_unit_insurance_status.sql`. Paridade
  admin/portal testada em `src/apps/panel/insurance_aggregate_parity_test.ts`.
- [ADR 0016](./0016-insurance-evidence-from-source.md) (origem da evidência, máquina de estados) e
  [ADR 0040](./0040-insurance-renewal-lineage-freeze-delete.md) (renovação, gates, lembretes).
- `CONTEXT.md` - entradas **Insurance** e **Audiência (do seguro)**.
