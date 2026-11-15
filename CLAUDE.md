# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this
repository.

> **Regras por área** vivem em `CLAUDE.md` aninhados que o Claude Code carrega sozinho ao tocar
> nessa pasta: `src/apps/panel/CLAUDE.md` (templates/UI/HTMX), `src/apps/api/CLAUDE.md`
> (auth/helpers/domínio), `src/db/CLAUDE.md` (migrations/triggers). Aqui ficam só as regras globais
> e o baseline.

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions
as needed.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant
clarification.

## 5. Read before you write

Before adding code in a file, read the file's exports, the immediate caller, and any obvious shared
utilities. If you don't understand why existing code is structured the way it is, ask before adding
to it. "Looks orthogonal to me" is the most dangerous phrase in this codebase.

## 6. Use the model only for judgment calls

Use AI for classification, drafting, summarization, extraction from unstructured text. Don't write
code that asks an LLM to do what deterministic code already answers (routing, retries, status-code
handling, plain transforms).

## 7. Surface conflicts, don't average them

If two existing patterns contradict, don't blend them. Pick one (the more recent / better tested),
say why, and flag the other for cleanup. "Average" code that satisfies both is the worst code.

## 8. Match the codebase's conventions, even if you disagree

If the codebase uses snake_case and you'd prefer camelCase: snake_case. If the codebase uses
class-based components and you'd prefer hooks: class-based. Disagreement is a separate conversation.
Inside the codebase, conformance > taste. If you genuinely think the convention is harmful, surface
it. Don't fork it silently.

## 9. Tests verify intent, not just behavior

Every test must encode WHY the behavior matters, not just WHAT it does. A test like
`expect(getUserName()).toBe('John')` is worthless if the function takes a hardcoded ID. If you can't
write a test that would fail when business logic changes, the function is wrong.

## 10. Checkpoint after every significant step

After completing each step in a multi-step task: summarize what was done, what's verified, what's
left. Don't continue from a state you can't describe back to me. If you lose track, stop and
restate.

## 11. Fail loud

If you can't be sure something worked, say so explicitly. "Migration completed" is wrong if 30
records were skipped silently. "Tests pass" is wrong if you skipped any. "Feature works" is wrong if
you didn't verify the edge case I asked about. Default to surfacing uncertainty, not hiding it.

## 12. Comment sparingly

Comments are **one short, objective line** - only when they add value.

- Skip the obvious (`// increment i`).
- A self-explanatory function name needs no comment at all - don't restate it. `ping()` does not
  need `// pings the server`; leave it bare. Comment the non-obvious guard inside, not the name.
- No multi-line comment blocks. If the WHY needs a paragraph, it belongs in an ADR/doc; the code
  carries a pointer (`Ver ADR 0007`), not the transcription.
- Prefer the lean label over the essay: `// Wrapper do globalThis.fetch`, not four lines explaining
  which clients it captures and why Redis is excluded.
- Load-bearing WHY can stay, but compress it to a max of 3 lines.

## 13. Use the right MCP for the job

**When a configured MCP server answers better than doing it by hand, use it first.**

- `fff` - **find/search** any string, file or path (`ffgrep` = content, `fffind` = filenames/paths).
  Replaces grep/find/ripgrep. Use for "where is X".
- `codebase-memory-mcp` - **explore** the codebase: who calls X, dependencies, call chains,
  architecture overview, blast-radius before a change. Use for "how does X connect". **Nome do
  projeto no MCP** = slug do caminho absoluto do clone, NÃO `mague` (ex. `/home/eu/mague` →
  `home-eu-mague`; passa este valor em `project`). Confirma com `list_projects`. Se parecer
  não-indexado, corre `index_repository` com `repo_path=<raiz do clone>`.
- `github` - **GitHub remote**: PRs, issues, CI runs, releases, cross-repo search. NOT local git
  (`status`/`diff`/`commit` stay in the shell).

## Regras globais (vinculativas)

- **Vocabulário canónico**: ler `CONTEXT.md` antes de qualquer trabalho. Termos vinculativos
  (charge, settlement, conciliação, imputação, fração, condómino, FCR). Regra PT-PT vs English.
- **PT-PT** (não BR) em UI, templates, comentários, docs.
- **Nunca usar travessões em-dash `—` (U+2014)** em texto, código ou docs. Usar sempre hífen normal
  `-` (U+002D). Aplica-se a `.vto`, `.ts`, `.md`, `.sql` e qualquer output gerado para o utilizador.
  Razão: preferência do utilizador, consistência visual e facilidade de pesquisa/escrita.
- **Trabalhar em `main`**, não worktree. Caminhos absolutos a partir da raiz do clone
  (`<raiz>/src/...`).
- **Cêntimos integer** para dinheiro (nunca `float`); filtros `|> formatMoney`, `|> formatDate`.
  Euros → cêntimos: usar sempre `parseEurosToCents(input)` de `$shared/money/parse_euros.ts` (aceita
  PT-PT `"1.234,56"` e intl `"1234.56"`; devolve `null` para vazio/NaN/negativo, opt-in
  `allowNegative` para saldos). NÃO `Math.round(parseFloat(s.replace(",", ".")) * 100)` inline. API
  espera `amountCents` (integer). Ver [ADR 0030](docs/adr/0030-shared-action-helpers.md).
- **Multi-tenant**: `condominium_id` do path (Panel: `/admin/c/:cid/...`; API:
  `/v1/admin/condominiums/:cid/...`), nunca de cookie/header. `/c/:cid/...` → 308 (atalho do Panel).
  Ver [ADR 0009](docs/adr/0009-tenant-id-in-url-path.md).
- **Audit columns**: popular `created_by/updated_by/deleted_by` JSONB via `requireActor(ctx)` em
  `$api/middleware/api_auth.ts`. API responses NUNCA expõem estes campos. Ver
  [ADR 0011](docs/adr/0011-actor-snapshot-convention.md).
- **Apagar ficheiro S3 SEMPRE antes da BD**. Quando apagas uma row com `storage_key` associado
  (anexo, ou cascade ao apagar entidade-pai), apaga o objeto S3 PRIMEIRO via `deleteObject`
  (idempotente), só depois faz `UPDATE deleted_at`. Ordem inversa = leak de storage + violação de
  "direito ao esquecimento". Helper canónico para anexos: `softDeleteAttachment` em
  `$api/libs/attachments/mod.ts`. Pattern de cascade pai→anexos: `softDeleteTicket` em
  `ticket/_helpers.ts`. Ver [ADR 0021](docs/adr/0021-s3-delete-before-db.md).

## Stack & layout

Deno · Hono · Vento.js · PostgreSQL · Valkey · Drizzle ORM · pgTAP · Docker Compose · HTMX. **API**
(`:3000`) REST/JSON JWT Bearer · **Panel** (`:3400`) SSR Vento+daisyUI/Tailwind CDN, consome a API
via `Client` partilhado (`src/shared/client/mod.ts`) - controllers nunca tocam na BD.

```
src/{apps,shared,config,db}/      docs/{adr,agents,flows}/
test_sql/tests/  test_api/        deploy/  docker-compose.yml
```

Import maps (`deno.json`): `$api/`, `$panel/`, `$shared/` (= `$libs/`), `$apps/`, `$config/`.

## Workflow & documentação

- Usa `deno task` (não `deno run` à mão exceto para um teste isolado). Containers ficam de pé entre
  sessões; antes de restart, vê logs (watcher Deno costuma resolver).
- GitHub Issues via `gh` CLI no repo deste clone (o `gh` deteta-o pelo `origin`). Triage labels
  canónicas: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`.
- `CONTEXT.md` - glossário canónico do domínio (vinculativo). `docs/adr/` - ADRs = decisões em
  vigor, escritas no estado atual (índice em `docs/adr/README.md`; lê-o antes de propor refactors
  estruturais). Quando uma decisão muda, reescreve o ADR para a regra nova: sem histórico, datas nem
  follow-ups. `docs/flows/` - flows de domínio (quotas, despesas e casos de despesa, FCR,
  reconciliação, imputação). `docs/agents/operations.md` - testes, bootstrap do schema,
  backup/restore, rate-limit, pgTAP.
