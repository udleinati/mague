# ADR 0040 - Seguros: renovação com linhagem, congelamento pós-vencimento e autoridade de eliminação

## Contexto

Ciclo de vida das apólices por fração. Complementa o
[ADR 0016](./0016-insurance-evidence-from-source.md) (origem da evidência, máquina de estados) e o
[ADR 0017](./0017-insurance-no-holder-aggregate-status.md) (sem holder, estado agregado). Duas
restrições atravessam tudo:

- "Vencida" é sempre `classifyPolicy()` (`valid_to` vs hoje), nunca o `status` cru: uma apólice
  vencida tem `status = 'active'` na BD. As vencidas há pouco são as que mais precisam de tratamento
  e têm de continuar renováveis.
- O sistema nunca renova sozinho: `valid_to` é `NOT NULL`, toda a vigência tem fim e prolongá-la é
  sempre um "renovar" explícito.

## Decisão

### Regras como predicados puros

As decisões de gate vivem em `$shared/insurance/policy_status.ts`, sem BD nem HTTP, testadas em
tabela. Os handlers são finos: chamam o predicado e lançam o erro de domínio quando recusa.

| Predicado             | Permite                                                                       |
| --------------------- | ----------------------------------------------------------------------------- |
| `canRenew`            | `active`, `expiring_soon`, ou `expired` há <= `RENEW_MAX_OVERDUE_DAYS` (365)  |
| `canAddAttachment`    | Tudo exceto `expired` e `superseded`                                          |
| `canRemoveAttachment` | Fração: só `awaiting_confirmation` e `rejected_only`. Admin: tudo             |
| `canDeletePolicy`     | Fração: só a própria em `awaiting_confirmation`. Admin: exceto cobertura viva |
| `canRejectPolicy`     | `status` cru `pending_review` ou `active`                                     |
| `canReopen`           | `status` cru `active` ou `rejected`                                           |
| `approveRefusal`      | Recusa com `not_pending` ou `unconfirmed`; `null` = pode                      |
| `undoRenewalRefusal`  | Recusa com `not_a_renewal`, `not_presumed`, `not_current`, `has_evidence`     |

"Cobertura viva" = `active` ou `expiring_soon`. "A própria" = `uploaded_by.user_id` é quem pede.
`canRejectPolicy`, `canReopen` e `undoRenewalRefusal` leem o `status` cru de propósito: uma vencida
continua `active` na BD e tem de continuar rejeitável, reabrível e desfazível.

`policyCapabilities` junta os gates em `can.*`. A API projeta-os em cada apólice ao lado do `kind`
computado (`formatInsurancePolicyWithCapabilities`), e os templates consultam `can.*` e `kind` -
nunca o `status` cru nem janelas em dias escritas à mão. A janela de "a expirar" da audiência só
afeta `kind`; nenhum gate depende dela.

### O gate é obrigatório

Todas as transições de `state.ts` entram por
`requirePolicy(postgres, { policyId, condominiumId, gate })`, que carrega a apólice do condomínio
(404) e aplica o gate antes de qualquer escrita (422 `INVALID_STATE`). O `gate` é obrigatório por
assinatura: uma transição nova não compila sem decidir quem pode. Verificado à mão em cada
transição, um `UPDATE` esquecido rejeitaria uma `superseded` ou reescreveria a razão de uma já
rejeitada. Para não restringir à entrada passa-se `noGate`, que se lê no código em vez de ser uma
omissão; só o `undo` o usa, porque a decisão tem de acontecer dentro da transação, junto à contagem
de anexos. `edit.ts` (editar e eliminar) aplica `canEditPolicy` e `canDeletePolicy` diretamente.

### Renovação

Três caminhos, a mesma janela (`canRenew`), a mesma linhagem (quem usa cada um: ADR 0016).

| Caminho                 | Nova apólice                         | Predecessor                     |
| ----------------------- | ------------------------------------ | ------------------------------- |
| Presumida (admin, JSON) | `active` + `presumed_at`, sem anexos | `superseded` na mesma transação |
| Com documento (admin)   | `pending_review`, origem `'admin'`   | Fica `active` até à aprovação   |
| Com recibo (fração)     | `pending_review`, origem `'unit'`    | Fica `active` até à aprovação   |

- **Janela**: vencida há mais de 365 dias recusa-se com 422, no domínio e não só na UI. A
  continuidade nasceria já vencida: submete-se ou regista-se uma apólice nova de raiz.
- **Datas**: na presumida, `valid_from` = `valid_to` da anterior e `valid_to` = +1 ano (no limite da
  janela nasce com a vigência quase esgotada; aceita-se). Com documento vêm do formulário.
- **Presumida atómica**: supersede e insert numa transação, com `status = 'active'` no WHERE do
  supersede. Em dois passos soltos uma falha a meio deixaria a fração com duas apólices ativas ou
  nenhuma; o WHERE serializa duplo-clique e retry.
- **Com documento, quem fecha é o `approve`**: ativa a nova e passa o predecessor a `superseded` na
  mesma transação. Substituir ao submeter faria a fração cair para `awaiting_approval`, e o painel
  daria por descoberta uma fração com cobertura válida.
- **Mecânica partilhada** (`insertDocumentedRenewal`): 409 se o predecessor já tem uma renovação
  `pending_review`; se o anexo falhar, a linha é apagada - uma apólice documentada sem documento
  seria uma mentira gravada. A guarda de 409 lê antes de inserir e, sob READ COMMITTED, estreita a
  janela do duplo-clique sem a fechar (ver _Alternativas rejeitadas_).

### Desfazer uma renovação presumida

`POST insurance/:policyId/undo-renewal` (admin) apaga a presumida e devolve o predecessor a
`active`, limpando `superseded_at`, numa transação. Sem isto, renovar por engano deixaria uma
`superseded` órfã que o agregado não conta, e a cobertura documentada desapareceria.

Só a última renovação (`status = 'active'`), ainda presumida e com zero anexos. Com comprovativo
anexado o undo apagaria a evidência: recusa-se. A contagem de anexos corre dentro da transação
(entre o gate e o commit a fração pode carregar o comprovativo), e o restauro leva
`status = 'superseded'` no WHERE para não pisar um predecessor que outro caminho já mexeu.

### Linhagem

`core.insurance_policy.renewed_from_id`: `text`, NULL, auto-referência `ON DELETE RESTRICT`. Aponta
para o predecessor imediato e é preenchida pelos três caminhos de renovação; submissões e registos
de raiz ficam `NULL`. A raiz da cadeia deriva-se percorrendo-a.

Apagar uma apólice com sucessora dá 409 (a API traduz o RESTRICT): apaga-se da mais recente para a
mais antiga. A projeção resolve `renewedFrom` (id, número e vigência do predecessor): o admin mostra
"Renovação de" com âncora para o cartão anterior, e o portal agrupa a cadeia no histórico
(`groupByRenewalChain`) em vez de listar submissões soltas.

### Perseguir a renovação presumida

- `presumedEvidenceGap` mede há quantos dias uma presumida está sem comprovativo (`overdue` passados
  `PRESUMED_EVIDENCE_GRACE_DAYS` = 30). Fonte única do badge, do KPI, do filtro
  `?status=presumed_pending` e dos alvos do bulk.
- `reminderTriggerFor(unit)` escolhe o email pelo estado da fração: `individual` quando falta o
  seguro (ADR 0017), `renewal_evidence` quando está coberta mas a renovação continua por documentar,
  `null` quando não há nada a pedir. O cliente não escolhe o trigger; a mesma decisão dá a legenda
  ao botão, o copy e o cooldown.
- **Cooldown por família de trigger** (`REMINDER_COOLDOWN_DAYS` = 14,
  [ADR 0032](./0032-invite-resend-cooldown.md)): `core.vw_unit_insurance_status` expõe
  `last_reminder_at` (individual e bulk) e `last_renewal_evidence_at` em separado. Num cooldown
  único, renovar cegaria o botão "Lembrar" por causa de um email sobre outro assunto. Em cooldown, o
  envio individual devolve 422 `COOLDOWN_ACTIVE` e o bulk salta a fração.

### Congelamento pós-vencimento e autoridade de eliminação

- **Anexar** (portal): 422 em `expired`/`superseded` - renova-se em vez de mexer no registo morto.
- **Remover anexo** (portal): 403 fora de `awaiting_confirmation`/`rejected_only` - a fração não
  despe a evidência de uma apólice já confirmada ou aprovada. O admin não tem rota de anexar nem de
  remover.
- **Apagar apólice** (portal): só a própria submissão por confirmar (403 se não é o uploader, 422
  nos outros estados).
- **Apagar apólice** (admin): `expired`, `superseded`, `rejected` e `pending_review`. Cobertura viva
  dá 422 e exige **rejeitar primeiro** (daí `canRejectPolicy` aceitar `active`): protege contra
  perda de cobertura por engano. A lista de seguros pede typed-match "ELIMINAR"
  ([ADR 0025](./0025-danger-zone-pattern.md)).
- Eliminar é hard-delete (a tabela não tem `deleted_at`; o rasto fica em `audit.cdc_log`). Os anexos
  saem do S3 **antes** da linha ([ADR 0021](./0021-s3-delete-before-db.md)), em fail-fast: engolir a
  falha deixaria o ficheiro sem dono nenhum.

## Consequências

- A regra é a mesma na API, no admin e no portal, porque todos leem os mesmos predicados.
- A página de seguros não pode afirmar que o sistema renova sozinho (guarda de copy em
  `insurance_views_test.ts`).

## Alternativas rejeitadas

1. **Índice único parcial** `(renewed_from_id) WHERE status = 'pending_review'` para fechar o
   duplo-clique na renovação com documento. O custo de não o ter são dois rascunhos visíveis, que se
   apagam; se um dia incomodar, é esse índice mais a tradução do `23505` no 409 da guarda.
2. **Etiqueta `auto_renew` na apólice.** Não decide nada, promete um automatismo que o sistema não
   tem e não serve de sinal de triagem; o sinal verificável é `presumedEvidenceGap`.

## Sinais de alerta para code review

- `status === "active"` usado para decidir "em vigor" ou esconder ações, em handler ou template.
- Transição nova em `state.ts` que não passa por `requirePolicy`, ou `noGate` sem a razão escrita.
- Regra de gate ou janela em dias copiada para um handler ou template em vez de chamar o predicado,
  ler `can.*` ou usar as constantes de `policy_status.ts`.
- Renovação que não grava `renewed_from_id`, que substitui o predecessor antes da aprovação quando
  há documento, ou que faz supersede/undo fora de transação.

## Referências

- [`$shared/insurance/policy_status.ts`](../../src/shared/insurance/policy_status.ts) - predicados,
  constantes e testes em tabela (`policy_status_test.ts`).
- [`modules/admin/insurance/`](../../src/apps/api/modules/admin/insurance/) - `state.ts`
  (`requirePolicy`, renovação, undo), `edit.ts` (eliminar), `_projection.ts` (`kind`, `can.*`).
- [`modules/portal/insurance.ts`](../../src/apps/api/modules/portal/insurance.ts) - rotas da fração.
- Testes: `test_api/api_insurance_gates_test.ts`, `test_api/api_insurance_renewal_test.ts`,
  `test_sql/tests/0032_insurance.sql` (FK da linhagem).
- [ADR 0016](./0016-insurance-evidence-from-source.md) (origem da evidência, máquina de estados) e
  [ADR 0017](./0017-insurance-no-holder-aggregate-status.md) (sem holder, estado agregado).
