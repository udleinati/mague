# Decisões de arquitetura (ADR)

Cada ADR descreve uma decisão **em vigor**, no estado atual do código. Não é um diário: quando uma
decisão muda, o ADR é reescrito para a regra nova, sem histórico, datas nem notas de seguimento. O
número identifica o ADR e não muda (o código e os `CLAUDE.md` citam-no como `ADR 00NN`).

Lê o ADR da área antes de propor um refactor estrutural. Os "Sinais de alerta para code review" de
cada um dizem o que procurar num diff.

## Dados, schema e auditoria

| ADR                                          | Decisão                                                                          |
| -------------------------------------------- | -------------------------------------------------------------------------------- |
| [0004](0004-audit-cdc-trigger-driven.md)     | Auditoria CDC por trigger único na BD, com auto-attach e actor em JSONB          |
| [0005](0005-soft-delete-convention.md)       | Soft-delete com `deleted_at` + `deleted_by` e índices únicos parciais            |
| [0006](0006-polymorphic-attachment-table.md) | Anexos numa única tabela polimórfica `core.attachment`                           |
| [0008](0008-migrations-vs-components.md)     | Migrations imutáveis para o schema; components re-aplicados para funções e views |
| [0011](0011-actor-snapshot-convention.md)    | Convenção do `ActorSnapshot` (`created_by` / `updated_by` / `deleted_by`)        |
| [0018](0018-occupant-type-removal.md)        | Ocupante sem tipo global: a relação vive em `unit_occupant.relationship_type`    |
| [0021](0021-s3-delete-before-db.md)          | Eliminar o ficheiro do S3 antes de eliminar na BD                                |
| [0023](0023-entity-code-base36.md)           | Identificadores humanos em base-36 (`<prefixo><dígitos>`)                        |
| [0024](0024-pathology-entity-design.md)      | Patologia: entidade própria, registada só pelo admin, pública fora de `draft`    |

## Autenticação, papéis e multi-tenant

| ADR                                                   | Decisão                                                                           |
| ----------------------------------------------------- | --------------------------------------------------------------------------------- |
| [0002](0002-user-role-consolidation.md)               | `user.role` só distingue o Super; os outros papéis derivam das relações           |
| [0003](0003-portal-visibility-scope.md)               | Visibilidade no portal: `scope` no query builder + `ownershipQuery` nos anexos    |
| [0007](0007-jwt-envelope-valkey-session.md)           | JWT envelope sobre session-id em Valkey (não JWT stateless)                       |
| [0009](0009-tenant-id-in-url-path.md)                 | `condominium_id` no path da URL (não em cookie/header)                            |
| [0020](0020-session-idle-ttl-and-user-active-flag.md) | Sessão com idle-TTL deslizante (3h) e `user.is_active` verificado em cada request |
| [0030](0030-shared-action-helpers.md)                 | Action helpers partilhados: auth gate, WHERE canónicos, euros, forms e ação HTMX  |
| [0032](0032-invite-resend-cooldown.md)                | Reenvio de convite: cooldown anti-spam numa única constante                       |

## Domínio financeiro

| ADR                                                           | Decisão                                                                            |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [0001](0001-financial-cascade-split.md)                       | Ledger de charge/settlement por triggers; state machine e algoritmos em TypeScript |
| [0010](0010-quota-rounding-big-unit.md)                       | Quotas por permilagem: a big unit absorve o diff de arredondamento                 |
| [0028](0028-billing-reminder.md)                              | Lembrete de cobrança: atraso face à conciliação, guard de 3 dias, cooldown de 14   |
| [0035](0035-auto-offset-ordering-distinct-from-allocation.md) | Ordem do auto-offset é distinta da prioridade de imputação                         |
| [0037](0037-charge-effective-status.md)                       | Estado efetivo da charge: fonte única da regra do "Vencido"                        |
| [0039](0039-payment-plan.md)                                  | Plano de pagamento: anotação informativa, com filtros e colunas nos lembretes      |
| [0041](0041-assembly-budget-execution-imputation.md)          | Imputação de despesa a uma Ata: etiqueta manual ganha à inferência                 |

Os fluxos passo a passo (quotas, despesas, FCR, conciliação, imputação) estão em
[`docs/flows/`](../flows/).

## Assembleias

| ADR                                                  | Decisão                                                           |
| ---------------------------------------------------- | ----------------------------------------------------------------- |
| [0033](0033-assembly-agenda-item-vs-deliberation.md) | Ponto da ordem do dia vs deliberação                              |
| [0034](0034-convocation-per-unit.md)                 | Convocatória enviada por fração: um despacho por (pessoa, fração) |

## Seguros

| ADR                                                     | Decisão                                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [0016](0016-insurance-evidence-from-source.md)          | A evidência vem da fração; o que a administração regista fica marcado como seu |
| [0017](0017-insurance-no-holder-aggregate-status.md)    | Sem holder; a fração está coberta com pelo menos uma apólice ativa em vigor    |
| [0040](0040-insurance-renewal-lineage-freeze-delete.md) | Renovação com linhagem, congelamento pós-vencimento e autoridade de eliminação |

## Painel: templates, UI e HTMX

| ADR                                            | Decisão                                                               |
| ---------------------------------------------- | --------------------------------------------------------------------- |
| [0012](0012-flash-message-rendering.md)        | Flash messages: render único via layout                               |
| [0013](0013-confirm-modal-global.md)           | Modal de confirmação: replicado em ambos os layouts                   |
| [0014](0014-unit-natural-order.md)             | Ordem natural das designações de frações                              |
| [0015](0015-unit-link-everywhere.md)           | Designação de fração: link clicável em todo o admin                   |
| [0019](0019-create-edit-modals-pattern.md)     | Formulários de criar/editar/assinar renderizam como `<dialog>` modal  |
| [0022](0022-list-action-icons.md)              | Coluna de ações em listagens: SVG + label + hierarquia de cor         |
| [0025](0025-danger-zone-pattern.md)            | Zona perigosa: bloco único para ações destrutivas irreversíveis       |
| [0026](0026-scroll-preservation-htmx.md)       | HTMX swaps preservam scroll; uploads usam dropzone canónica           |
| [0027](0027-htmx-loading-indicator.md)         | Indicador de loading único: barra no topo para todos os pedidos       |
| [0029](0029-kpi-card-responsive.md)            | KPI cards responsivos: grid e fonte fluida                            |
| [0031](0031-table-horizontal-scroll-mobile.md) | Scroll horizontal de tabelas em mobile (`.table-scroll`)              |
| [0036](0036-page-header-canonical.md)          | Cabeçalho de página canónico (`page_header.vto` + `status_badge.vto`) |
| [0038](0038-table-card-canonical.md)           | Card de tabela canónico (`table_card.vto`)                            |

## Escrever ou alterar um ADR

- Um ADR por decisão que restringe código futuro. Detalhe de implementação fica no código.
- Secções: Contexto, Decisão, Consequências, Alternativas rejeitadas, Sinais de alerta para code
  review, Referências.
- Escreve no presente e verifica cada caminho, função e rota citados contra o código.
- Decisão nova: próximo número livre e uma linha neste índice. Decisão alterada: reescreve o ADR
  existente.
