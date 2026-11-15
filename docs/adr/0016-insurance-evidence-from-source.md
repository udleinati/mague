# ADR 0016 - Seguros: a evidência vem da fração; o que a administração regista fica marcado como seu

## Contexto

Âmbito: seguros **por fração** (`core.insurance_policy`). O multirriscos do edifício não é modelado
(ver `CONTEXT.md`, _Flagged ambiguities_).

A pergunta deste ADR: **quem pode produzir evidência de seguro no sistema, e com que estatuto?**

- Um documento carregado por terceiros não é, concetualmente, prova produzida pela fração. Numa
  disputa ou num sinistro tem de ser inequívoco quem o entregou.
- A administração recebe documentos fora do portal (email, em mão), sobretudo de condóminos pouco
  digitais. Sem forma de os registar, a fração ficaria `never_submitted` com cobertura real, e o
  sistema pedir-lhe-ia por email um documento que a administração já tem.
- Numa renovação tácita a seguradora não emite apólice nova: emite um recibo de prémio, e quem o
  recebe é o condómino.

Renovação, linhagem, congelamento e eliminação estão no
[ADR 0040](./0040-insurance-renewal-lineage-freeze-delete.md); a ausência de holder e o estado
agregado da fração, no [ADR 0017](./0017-insurance-no-holder-aggregate-status.md).

## Decisão

### A origem fica sempre marcada

`core.insurance_policy.evidence_source` (CHECK `insurance_policy_evidence_source_check`) é gravada
na criação da linha e não muda depois.

| Valor     | Significado                                       | Caminho que a cria                       |
| --------- | ------------------------------------------------- | ---------------------------------------- |
| `'unit'`  | Comprovativo submetido pela fração no portal      | Submissão de raiz, renovação com recibo  |
| `'admin'` | Documento entregue à administração fora do portal | Registo de raiz, renovação com documento |
| `NULL`    | Nasceu sem documento (`presumed_at` definido)     | `renew` do admin sem ficheiro            |

O sistema nunca confunde as três. `'admin'` não é "prova da fração com uma flag de auditoria": é
prova **da administração**, com predicado próprio (`isAdminDocumented`), badge próprio, filtro
`?status=admin_documented` na lista e notificação à fração.

`presumed_at` nunca se limpa (é facto histórico) e `evidence_source` continua `NULL` mesmo depois de
a fração anexar o recibo a uma presumida: o que cala o pedido de comprovativo é existir anexo
(`presumedEvidenceGap`). `uploadInsurancePolicy` recebe `evidenceSource` sem valor por omissão -
herdá-lo por distração poria o badge a mentir.

### Máquina de estados

`status` é um de `pending_review`, `active`, `rejected`, `superseded` (CHECK
`insurance_policy_status_check`).

| Transição              | De -> para                                                  | Quem          |
| ---------------------- | ----------------------------------------------------------- | ------------- |
| Submeter com documento | -> `pending_review`                                         | Fração, admin |
| `confirm`              | `pending_review` -> `pending_review` (grava `confirmed_at`) | Só a fração   |
| `approve`              | `pending_review` -> `active` (predecessor -> `superseded`)  | Admin         |
| `reject` (com razão)   | `pending_review` ou `active` -> `rejected`                  | Admin         |
| `reopen`               | `active` ou `rejected` -> `pending_review`                  | Admin         |
| `renew` presumido      | Nova linha `active`; predecessor -> `superseded`            | Admin         |
| `undo-renewal`         | Apaga a presumida; predecessor -> `active`                  | Admin         |

`superseded` é histórico fechado: não se rejeita, não se reabre, não se renova.

**Janela de mutabilidade**: os campos da apólice só mudam em `pending_review` (`canEditPolicy`),
tanto no `edit` do admin como no `confirm` da fração. Para corrigir uma `active` ou `rejected`,
faz-se `reopen` primeiro. Sem este gate, reescreviam-se as datas de uma apólice já aprovada e
prolongava-se a cobertura sem nova revisão.

### O que a fração faz (portal)

Rotas em `/v1/portal/condominiums/:cid/units/:unitId/insurance`:

- **Submeter de raiz** (`POST`, multipart): nasce `pending_review` com `evidence_source='unit'`. O
  OCR é best-effort e só corre sobre PDF; a vigência sai dos candidatos do OCR (na falta deles,
  hoje + 1 ano) e a fração corrige-a ao confirmar. Re-submeter apaga apenas o rascunho
  `pending_review` anterior **do mesmo uploader**
  ([ADR 0017](./0017-insurance-no-holder-aggregate-status.md)).
- **Confirmar** (`POST /:policyId/confirm`): confirma ou corrige os dados extraídos e grava
  `confirmed_at`. Não ativa. Recusa `valid_to` no passado e `valid_from > valid_to`.
- **Renovar com recibo** (`POST /:policyId/renew`, multipart): o recibo é obrigatório (400 sem
  ficheiro) e a vigência vem do formulário. Herda `policy_number`, `insurer` e
  `coverage_amount_cents` do predecessor (o que o formulário reenviar vence) e grava
  `renewed_from_id`. É passo único: os dados são herdados e não extraídos, logo o formulário É a
  confirmação e grava `confirmed_at` (sem isso `approveRefusal` recusaria com `unconfirmed`). Não
  corre OCR: um recibo de prémio não tem estrutura de apólice. Nasce `pending_review`,
  `evidence_source='unit'`, sem `presumed_at`, e não substitui a anterior (isso é do `approve`).

A fração nunca presume: sem recibo não há renovação pelo portal.

### O que o admin pode fazer

Rotas em `/v1/admin/condominiums/:cid/`: `approve`, `reject`, `reopen`, `renew`, `undo-renewal`
(todas `POST insurance/:policyId/<ação>`), editar (`PATCH insurance/:policyId`, só em
`pending_review`), eliminar (`DELETE insurance/:policyId`), registar de raiz
(`POST units/:unitId/insurance`) e lembretes (`POST insurance/reminders[/:unitId]`). Os gates de
cada uma estão no [ADR 0040](./0040-insurance-renewal-lineage-freeze-delete.md).

**Não existe `confirm` no admin.** A administração nunca confirma dados em nome da fração.

O `renew` tem dois caminhos na mesma rota: corpo JSON presume (ver abaixo); multipart traz o
documento que chegou à administração.

### Documento entregue à administração (`evidence_source='admin'`)

- **Ficheiro obrigatório** nos dois caminhos (registo de raiz e `renew` multipart) e vigência
  decidida no formulário (`requireCoverageDates`): quem regista tem o papel à frente, e gravar
  aritmética que ninguém conferiu é pior do que recusar. Sem predecessor não há continuidade de onde
  presumir, por isso o registo de raiz não tem variante sem documento.
- Nasce `pending_review`, para o admin rever o que transcreveu e o que o OCR extraiu.
- **Não espera confirmação da fração.** `classifyPolicy` devolve `awaiting_approval` mesmo sem
  `confirmed_at`; `approveRefusal` não exige confirmação; ao aprovar, `confirmed_by`/`confirmed_at`
  ficam com o admin se ninguém confirmou antes. No portal lê-se "Em revisão"; a fração não lhe
  remove anexos nem a apaga.
- **Ao aprovar, a fração é avisada** (`sendAdminEvidenceNotice`): email informativo, que não pede
  nada, com a vigência registada e a indicação de contactar a administração se não reconhecer o
  registo. Fica fora da família dos lembretes: sem cooldown, não entra em `core.insurance_reminder`;
  o rasto está em `audit.email_log` (categoria `insurance_admin_evidence`). Avisa-se na aprovação e
  não na criação: só se notifica o que ficou firme.
- Renovar com documento não dispara o pedido `renewal_evidence`: seria pedir à fração o papel que o
  admin acabou de registar.
- A limpeza de rascunhos do mesmo uploader só corre para `'unit'`: do lado do admin "o mesmo
  uploader" é a conta de gestão e apagaria a renovação por rever que ela própria submeteu.

### Renovação presumida (`evidence_source` NULL)

O `renew` do admin sem ficheiro cria uma linha `active` com `presumed_at` e zero anexos. Não é
evidência: é assunção de continuação contratual, visivelmente marcada (badge "presumida há N dias",
email `renewal_evidence` best-effort a pedir o recibo, KPI e filtro próprios, e desfazer enquanto
não há comprovativo).

Presumir é exclusivo do admin, que tem autoridade para aprovar e um lembrete para perseguir o
documento; do lado de quem não aprova produziria um `pending_review` sem nada para rever.
`policyCapabilities` expõe os dois caminhos como gates exclusivos derivados do mesmo `canRenew`:
`renew` (admin) e `submitRenewal` (fração).

### "Atualizar" a partir da lista de seguros (admin)

Um botão por fração, cuja ação vem de `unitUpdateAction(policies, today)`, calculada no read-model
com o mesmo `today` dos `can.*`:

1. há apólice `pending_review` -> `review` (renovar por cima daria 409 e registar duplicaria);
2. há apólice renovável -> `renew` dessa apólice (preserva a linhagem);
3. caso contrário -> `register` (sem submissão, só rejeitadas, ou vencida fora da janela).

O registo de raiz tem o mesmo gate na API (409 quando a ação não é `register`): a regra "havendo
predecessor renova-se" não pode viver só no template.

## Consequências

- **A notificação à fração é o controlo real** sobre o que o admin regista: a pessoa afetada por um
  registo que não passou por ela fica a saber dele.
- **A auto-aprovação NÃO é controlo.** O admin regista e aprova, e é a mesma pessoa nos dois lados;
  o valor do `pending_review` está em rever dados, não em separar responsabilidades. Ninguém a deve
  invocar como salvaguarda.
- A origem é auditável: `audit.cdc_log` guarda `evidence_source` no snapshot do INSERT.
- A renovação pela fração tem uma guarda mais fraca do que confrontar o papel com dados extraídos:
  os campos herdados podem arrastar valores desatualizados. O contrapeso é humano - o formulário
  mostra-os editáveis e assinalados como copiados, e o admin tem o recibo à frente na revisão.
- Não existe registo de "a fração não fornece evidência": quem nada entrega fica `never_submitted`
  indefinidamente - honesto, mas pode parecer falha do sistema.

## Alternativas rejeitadas

1. **Admin carrega "pela fração" com uma flag de auditoria.** O ator em `uploaded_by` já distingue
   quem fez o quê; o problema é semântico e resolve-se com uma categoria distinta, não com uma flag
   sobre a mesma categoria.
2. **Admin carrega, mas a apólice espera a confirmação da fração no portal.** Workflow que nunca
   fecha: quem não usa o portal nunca confirma, e o `pending_review` fica para sempre.
3. **Admin carrega só em frações "geridas por si".** Introduz "administração por proxy", conceito
   que não existe no resto do sistema.
4. **Admin sem nenhum caminho de registo** (resolver por suporte humano). A fração com cobertura
   real ficava por cobrir no sistema, e a renovação presumida pedia-lhe o documento que a
   administração já tinha.
5. **Renovação da fração como flag no upload de raiz.** O gate corre sobre o predecessor, e um gate
   condicional escrito dentro de um handler contraria o ADR 0040 (predicado puro, à entrada).
6. **A fração presumir sem recibo.** Produz `pending_review` sem nada para rever.

## Sinais de alerta para code review

- Handler ou rota `confirm` em `modules/admin/insurance/`, ou proposta de "o admin confirma pelo
  condómino que não usa o portal": o caminho é o documento da administração, marcado e notificado.
- Caminho de escrita que cria apólice sem decidir explicitamente `evidence_source`, ou que marca
  `'admin'` numa linha sem ficheiro.
- Exigir `confirmed_at` para aprovar uma `'admin'`, ou classificá-la como `awaiting_confirmation`.
- Enviar `renewal_evidence` depois de renovar com documento, ou remover o aviso à fração na
  aprovação de uma `'admin'`.
- Editar campos de uma apólice fora de `pending_review`.
- Template ou filtro a recompor `adminDocumented` a partir de `evidenceSource` e contagem de anexos
  em vez de ler o que a API projeta.
- Registo de raiz pelo admin sem passar por `unitUpdateAction`.

## Referências

- [`$shared/insurance/policy_status.ts`](../../src/shared/insurance/policy_status.ts) - predicados
  (`classifyPolicy`, `approveRefusal`, `isAdminDocumented`, `unitUpdateAction`) e testes em tabela.
- [`modules/admin/insurance/`](../../src/apps/api/modules/admin/insurance/) - `state.ts`
  (transições), `upload.ts` (submissão, OCR), `handlers.ts`/`router.ts` (rotas do admin),
  `_reminder.ts` (`sendAdminEvidenceNotice`).
- [`modules/portal/insurance.ts`](../../src/apps/api/modules/portal/insurance.ts) - rotas da fração.
- `test_sql/tests/0065_insurance_admin_evidence.sql` - CHECK de `evidence_source`, fecho da
  renovação na aprovação e origem no `cdc_log`.
- [ADR 0003](./0003-portal-visibility-scope.md) (o portal como fronteira entre admin e fração),
  [ADR 0017](./0017-insurance-no-holder-aggregate-status.md) e
  [ADR 0040](./0040-insurance-renewal-lineage-freeze-delete.md).
- `CONTEXT.md` - entrada **Insurance**.
