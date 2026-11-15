# API (src/apps/api) - regras

Carregado automaticamente quando trabalho em `src/apps/api/**`. Complementa a raiz `/CLAUDE.md`.
Stack: REST/JSON com JWT Bearer (`:3000`).

## Arquitectura

Auth Bearer JWT (envelope HS256 + Valkey session, ver
[ADR 0007](../../../docs/adr/0007-jwt-envelope-valkey-session.md); sessão idle-TTL 3h sliding +
`user.is_active` enforced em runtime via
[ADR 0020](../../../docs/adr/0020-session-idle-ttl-and-user-active-flag.md)). Sem
`x-role`/`x-session-id`/`x-user-*`. Recurso admin (`modules/admin/<resource>/`):
`list/retrieve/create/update/delete/router.ts`, schema Drizzle em `libs/postgres/schemas/`,
serializer em `libs/serializer/`. Handlers retornam `Result<T, AppError>` via `httpResolver` +
`neverthrow`. Router em `modules/router.ts`: `/v1/auth/*` (público), `/v1/super/*`
(requireSuperRole), `/v1/admin/condominiums/:cid/*` (requireAdminRole), `/v1/portal/*`.

## Helpers partilhados

- **Auth gate "admin OU super deste condo"**: usar `requireCondoAdmin(ctx, { action: "..." })`
  (lança 403) ou `isCondoAdmin(ctx)` (boolean). NUNCA escrever inline
  `if (role !== "super" && !managed.includes(cid))`. Vive em
  `$api/libs/shared/require_condo_admin.ts`. Ver
  [ADR 0030](../../../docs/adr/0030-shared-action-helpers.md).
- **Query "esta entidade por id, neste condo, não apagada"**: usar `byIdInCondo(schema.X, id, cid)`
  de `$api/libs/shared/by_id_in_condo.ts`. Devolve `SQL` que serve `findFirst({ where })` e
  `update/delete().where(...)`. NÃO escrever inline
  `ops.and(ops.eq(e.id, ...), ops.eq(e.condominiumId, ...), ops.isNull(e.deletedAt))`. Para
  entidades sem `condominiumId` directo (e.g. `unit_occupant`), manter manual. Ver
  [ADR 0030](../../../docs/adr/0030-shared-action-helpers.md).
- **WHERE de listagem**: usar `listWhere(schema.X, cid, ...filtros)` de
  `$api/libs/shared/list_query.ts` (+ combinadores `eqIf`/`inListIf`/`dateRange`/ `yearRange`;
  `undefined` = sem filtro). Devolve `SQL` ÚNICO que serve `findMany({ where })` E `countWhere(...)`
  da paginação - NUNCA reconstruir os filtros no `count()` (as cópias divergem). Tenant scope +
  `deleted_at IS NULL` (quando a tabela tem) entram por construção. Meta de anos via
  `listAvailableYears`. Mesmo racional do `byIdInCondo`
  ([ADR 0030](../../../docs/adr/0030-shared-action-helpers.md)).
- **Ordem natural de frações** via `unitNaturalOrder` (`length` ASC, depois `asc(col)`); nunca
  `asc(designation)` puro. Ver [ADR 0014](../../../docs/adr/0014-unit-natural-order.md).

## Domínio

- **Seguros: evidência vem da fração ou não vem**. Admin não tem caminho de confirmação em nome do
  condómino. Operações admin: approve/reject/reminder/edit (só em `pending_review`)/renew (cria
  linha `presumed_at` sem evidência)/upload do documento entregue fora do portal (marcado
  `evidence_source='admin'`). **Renovar não é exclusivo do admin**: a fração renova a sua apólice em
  `POST /portal/.../insurance/:policyId/renew`, com recibo obrigatório, dados herdados do
  predecessor e linhagem gravada - o que a distingue é presumir (admin, sem prova) vs. entregar o
  recibo (fração). Gates `renew` e `submitRenewal` em `policyCapabilities`, exclusivos e derivados
  do mesmo `canRenew`. Ver [ADR 0016](../../../docs/adr/0016-insurance-evidence-from-source.md).
- **Seguros: sem holder, agregação por ≥1 active**. `insurance_policy` não tem FK a occupant. Status
  agregado da fração = `∃ active dentro de vigência`. Múltiplas apólices podem coexistir. Ver
  [ADR 0017](../../../docs/adr/0017-insurance-no-holder-aggregate-status.md).
- **Assembleia: ordem do dia vs deliberação**. O registo é um **ponto da ordem do dia**
  (`core.assembly_agenda_item`, campo `item_type`, relação/resposta `agendaItems`, rota
  `/agenda-items`); a **deliberação** é só o _resultado_ de o votar (`approved` + `votes_*` +
  `assembly_vote`). Nunca usar `decision`/ `decisionType`/`assembly_decision` em código novo. UI: a
  secção no admin e na acta chama-se sempre "Ordem do dia"; "Deliberação" só aparece como resultado
  (na acta, a variável de template `decisions` mantém-se de propósito). Ver
  [ADR 0033](../../../docs/adr/0033-assembly-agenda-item-vs-deliberation.md) e CONTEXT.md.
- **Domínio financeiro** - fonte de verdade `finance.ledger` (partidas dobradas). **Leitura
  obrigatória antes de mexer**:
  [ADR 0001 - Financial cascade split](../../../docs/adr/0001-financial-cascade-split.md)
  - flows em `docs/flows/00-overview-entradas-saidas.md` … `07-fluxo-imputacao.md`. Resumo: triggers
    PL/pgSQL (ver `src/db/CLAUDE.md`) emitem ledger (charge/settlement com FCR split); state
    machine + algoritmos (auto-offset, geração de quotas/recurring, reverse cascade) vivem em TS em
    `$api/modules/admin/`. Views: `v_unit_balance`, `v_bank_balance`.
