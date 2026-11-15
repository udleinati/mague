# ADR 0024 - Patologia: entidade própria, registada só pelo admin, pública fora de `draft`

## Contexto

Três conceitos vizinhos que não se devem misturar:

- **Ticket** - pedido de intervenção: action-oriented, bottom-up (qualquer ocupante reporta),
  workflow `open -> in_progress -> resolved -> closed` de horas ou dias.
- **Inspection** - vistoria regulatória obrigatória.
- **Patologia** - registo técnico do estado físico observado na construção (fissura, infiltração,
  eflorescência, oxidação de armadura, humidade, fungos, deformação estrutural): state-oriented,
  top-down, com ciclo de semanas a anos e frequentemente com obra. Pode coexistir com vários tickets
  ao longo do tempo.

Meter a patologia dentro do Ticket contaminaria relatórios e UX com dois ciclos de vida
incompatíveis.

## Decisão

### Schema

`core.pathology` (definição em `src/db/migrations/001_bootstrap.sql`) tem soft-delete e colunas de
auditoria ([ADR 0011](./0011-actor-snapshot-convention.md)). Campos com regra própria:

- **`code`**: `P` + 3 ou mais dígitos base-36, por condomínio
  ([ADR 0023](./0023-entity-code-base36.md)). O trigger `trg_pathology_code_assign`
  (`src/db/components/017_trg_pathology_code.sql`) atribui-o no INSERT por UPSERT atómico em
  `core.pathology_code_counter`; fica reservado mesmo em `draft` e respeita um `code` já preenchido.
- **`category`**: `crack`, `infiltration`, `humidity`, `efflorescence`, `detachment`, `corrosion`,
  `mould`, `structural`, `other`.
- **`description`** inclui a localização física e as dimensões; **`resolution_notes`** diz o que foi
  feito, por quem, o custo e as referências de despesas.
- **`dismissed_reason`** e **`dismissed_at`** são obrigatórios em `dismissed` (CHECK
  `pathology_dismissed_reason_required`); **`resolved_at`** em `resolved` (CHECK
  `pathology_resolved_at_required`). As datas são `date`, não timestamp: as horas não importam.
- **Âmbito**: `affects_common_area` **e/ou** frações em `core.pathology_unit` (N:N, PK composta
  `(pathology_id, unit_id)`). Não são exclusivos, e pelo menos um é obrigatório. A regra é validada
  na API (`pathologyCreateSchema` na criação; 422 `EMPTY_SCOPE` na edição) - não há constraint na
  BD.
- **Anexos**: `core.attachment` com `entity_type='pathology'`
  ([ADR 0006](./0006-polymorphic-attachment-table.md)), sem FK dedicada.

### Ciclo de vida: 8 estados, transições livres

| Estado                  | Visibilidade | Significado                                   |
| ----------------------- | ------------ | --------------------------------------------- |
| `draft`                 | Só admin     | A redigir; fotos ou causa por confirmar       |
| `identified`            | Pública      | Documentada e visível ao condomínio           |
| `awaiting_quotes`       | Pública      | A recolher cotações de empreiteiros           |
| `quote_approved`        | Pública      | Cotação escolhida e aprovada                  |
| `awaiting_repair_start` | Pública      | Obra contratada, à espera de arranque         |
| `in_repair`             | Pública      | Obra em curso                                 |
| `resolved`              | Pública      | Reparação concluída (terminal)                |
| `dismissed`             | Pública      | Encerrada sem reparação, com razão (terminal) |

- **Sem máquina de estados estrita.** O admin move entre quaisquer estados, incluindo de volta a
  `draft`. Voltar atrás é correção administrativa (marcou `resolved` cedo demais).
- A edição preenche `resolved_at`/`dismissed_at` com a data de hoje ao entrar no estado terminal e
  limpa-as ao sair; um valor explícito no pedido vence.
- **Patologia que reaparece fisicamente depois de terminal é uma patologia nova.** Não há FK entre
  patologias nem contagem de ciclos.
- `awaiting_quotes`/`quote_approved` referem-se a **cotações** de empreiteiros, não ao orçamento
  anual do condomínio (`Budget`). Na UI diz-se "cotação".

### Visibilidade derivada do estado

Pública = `status != 'draft'` e `deleted_at IS NULL`. Não existe toggle `is_public`: sair de `draft`
publica, voltar a `draft` esconde de imediato.

- A lista de estados públicos é `PATHOLOGY_PUBLIC_STATUSES`; as queries partilhadas em
  `modules/admin/pathology/_query.ts` recebem `scope: "all"` (admin) ou `"public"` (portal). Em
  `"public"`, um filtro `status=draft` é ignorado em silêncio (anti-vazamento).
- O portal filtra por grupos (`active`, `resolved`, `dismissed`), nunca por `draft`.
- Os anexos do portal aplicam o mesmo filtro de estado **antes** de servir bytes: uma `draft` nunca
  expõe fotos.
- O detalhe do portal não inclui os tickets associados: vazaria tickets de outras frações.
- Listagens ordenam por `detected_at DESC`, depois `created_at DESC`.

### Registo só pelo admin

O portal é só de leitura (listar, ver, descarregar anexos). Os ocupantes reportam anomalias por
Ticket; se o admin confirmar carácter patológico, abre a patologia. Mantém os papéis distintos,
evita uma listagem cheia de falsas patologias por triar e deixa o admin registar proactivamente
depois de uma vistoria, sem ticket associado.

### Ligação a Ticket (1:N inverso)

`core.ticket.pathology_id` (FK `ON DELETE SET NULL`): cada ticket pertence a zero ou uma patologia;
a patologia vê os seus tickets pela query inversa, por ordem cronológica.

- Os dois ciclos de vida são independentes: associar ou promover não muda o estado do ticket.
- **Soft-delete da patologia limpa a ligação à mão.** `softDeletePathology` faz
  `UPDATE ticket SET pathology_id = NULL` antes de marcar `deleted_at`: o `ON DELETE SET NULL` só
  dispara num DELETE real. A ordem completa é anexos no S3
  ([ADR 0021](./0021-s3-delete-before-db.md)), tickets, patologia; as linhas de `pathology_unit`
  ficam.
- O ticket projeta a patologia associada com filtro `deleted_at IS NULL` explícito, para não mostrar
  o chip de uma patologia apagada.
- Associar, mudar e desassociar fazem-se por `PATCH` do ticket (`pathologyId`, `null` para
  desassociar); a patologia tem de ser do mesmo condomínio (422 `INVALID_PATHOLOGY`).
- **Promover ticket a patologia** (`POST /admin/c/:cid/tickets/:ticketId/promote-to-pathology`, no
  Panel): cria a patologia a partir do formulário pré-preenchido, **copia** (não move) os anexos do
  ticket e associa o ticket. A cópia não é idempotente e a sua falha não desfaz a promoção.

### Deliberadamente ausente

- **`severity`/`priority`**: o admin avalia a urgência pela descrição e pelas fotos. O Ticket tem
  `priority` porque o seu workflow exige triagem rápida; a patologia não.
- **Localização estruturada** (`block`/`floor`/`element_type`): descreve-se na `description` e nas
  fotos.
- **`is_recurring`**: redundante face a "patologia que volta = patologia nova".
- **FK a fornecedor ou a despesas**: empreiteiro, custo e referências vão em texto em
  `resolution_notes`.

## Consequências

- Sem severidade, listagens longas são mais difíceis de triar visualmente.
- Sem FK a fornecedor e despesas, não há estatísticas cruzadas (custo por categoria, obras por
  empreiteiro).
- "Volta = nova" perde a ligação automática no histórico: o admin escreve a referência à anterior
  (por exemplo "ver P00A") na descrição.
- Com transições livres e sem tabela de histórico de estados, o percurso de uma patologia só se
  reconstitui pelo `audit.cdc_log`.

## Alternativas rejeitadas

1. **Flag `is_pathology` no Ticket.** Ciclos de vida incompatíveis (horas ou dias vs semanas ou
   meses); misturá-los contamina relatórios e UX.
2. **Reabrir uma patologia `resolved` quando reaparece.** Exige histórico de transições e custo e
   fotos por ciclo; o modelo simples ganha.
3. **Máquina de estados estrita** (só avanço sequencial). A realidade é mais irregular: o admin
   descobre que precisa de mais cotações depois de aprovar a primeira.
4. **Enum de severidade.** Sem requisito real de filtro por urgência.
5. **Localização estruturada.** Fricção de classificação em cada registo, sem caso de uso para
   filtros geográficos.
6. **Submissão pelo portal.** Confunde os papéis com o Ticket; a patologia é registo técnico
   top-down.
7. **Âmbito opcional** (patologia que não afeta nem parte comum nem fração). Sem caso de uso.

## Sinais de alerta para code review

- Endpoint do portal que cria ou altera patologias.
- Query ou rota de portal que devolva `draft`, sirva anexos sem o filtro de estado, ou inclua os
  tickets da patologia.
- Toggle de visibilidade separado do `status`.
- FK ou fluxo que ligue uma patologia à "anterior", ou que conte reaberturas.
- FK de `pathology` a `supplier`/`charge`, ou campo `severity`, sem caso de uso documentado.
- Apagar a patologia sem a cascata S3 dos anexos ou sem limpar `ticket.pathology_id`.
- Restrição de transições entre estados.

## Referências

- [`modules/admin/pathology/`](../../src/apps/api/modules/admin/pathology/) - `_query.ts` (scopes),
  `_helpers.ts` (`softDeletePathology`, `syncPathologyUnits`), `update.ts` (âmbito e datas
  terminais), `copy_from_ticket.ts`.
- [`modules/portal/pathology.ts`](../../src/apps/api/modules/portal/pathology.ts) e
  [`pathology_attachments.ts`](../../src/apps/api/modules/portal/pathology_attachments.ts) - leitura
  pública.
- [`libs/postgres/schemas/pathology.ts`](../../src/apps/api/libs/postgres/schemas/pathology.ts) -
  enums e `PATHOLOGY_PUBLIC_STATUSES`.
- `test_sql/tests/0059_pathology_lifecycle.sql` - código e CHECKs.
- [ADR 0003](./0003-portal-visibility-scope.md) - queries partilhadas por scope.
- [ADR 0019](./0019-create-edit-modals-pattern.md), [ADR 0022](./0022-list-action-icons.md) e
  [ADR 0025](./0025-danger-zone-pattern.md) - padrões de UI usados nas páginas de patologia.
- `CONTEXT.md` - entradas **Pathology**, **Pathology code**, **Pathology category**.
