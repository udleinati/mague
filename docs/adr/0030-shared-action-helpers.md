# ADR 0030 - Action helpers partilhados: auth gate, WHERE canónicos, euros, forms e ação HTMX

## Contexto

Há padrões que se repetem em dezenas de handlers da API e controllers do Panel: o check "é admin
deste condomínio?", o WHERE "por id, neste condomínio, não apagado", os filtros de listagem, a
conversão de euros para cêntimos, o parsing de forms e o branching HTMX com toast. Escritos inline,
cada cópia é uma oportunidade de divergência: um typo, uma condição invertida, um edge-case tratado
de forma diferente, uma mensagem inconsistente.

## Decisão

Cada padrão tem **um** helper, com uma só responsabilidade. Código novo usa o helper; a forma inline
não se reintroduz.

### 1. `requireCondoAdmin(ctx, { action })` e `isCondoAdmin(ctx)` (API)

[`$api/libs/shared/require_condo_admin.ts`](../../src/apps/api/libs/shared/require_condo_admin.ts)

```ts
const cid = requireCondominiumId(ctx);
requireCondoAdmin(ctx, { action: "aprovar apólices" });
const actor = requireActor(ctx);
```

- `requireCondoAdmin` lança 403 `FORBIDDEN` se o pedido não for de `super` nem de um administrador
  do condomínio do path. `action` é opcional e só personaliza a mensagem ("Apenas admin pode
  {action}").
- `isCondoAdmin` é a versão que não lança: devolve `boolean`. Serve quando o handler adapta o
  comportamento (filtra em vez de bloquear), como em `charge/list.ts` e `settlement/list.ts`.

A regra é a do [ADR 0002](./0002-user-role-consolidation.md), com o `cid` do path
([ADR 0009](./0009-tenant-id-in-url-path.md)). Complementa, não substitui, `assertUserCanAccessUnit`
(anti-IDOR por fração): atuam em camadas diferentes da autorização.

### 2. `byIdInCondo(table, id, cid)` (API)

[`$api/libs/shared/by_id_in_condo.ts`](../../src/apps/api/libs/shared/by_id_in_condo.ts)

WHERE canónico `id = $1 AND condominium_id = $2 AND deleted_at IS NULL`: identificador, tenant
([ADR 0009](./0009-tenant-id-in-url-path.md)) e soft-delete
([ADR 0005](./0005-soft-delete-convention.md)) numa só expressão.

```ts
const existing = await postgres.query((db) =>
  db.query.assembly.findFirst({
    where: byIdInCondo(schema.assembly, assemblyId, condominiumId),
  })
);
const data = findEntityOrFail(existing, "Assembleia");

await postgres.query((db) =>
  db.update(schema.assembly)
    .set({ deletedAt: new Date(), deletedBy: actor })
    .where(byIdInCondo(schema.assembly, assemblyId, condominiumId))
);
```

Devolve uma `SQL` que serve `findFirst({ where })` e `update/delete().where(...)`.

**Restrição**: só se aplica a tabelas com `id` + `condominiumId` + `deletedAt`. Ficam com a query
manual as entidades sem `condominiumId` direto (por exemplo `unit_occupant`, que liga via
`unit_id`), as tabelas sem soft-delete e os WHERE com outra forma (por exemplo `chart_of_account`,
que aceita contas globais OU do condomínio).

### 3. `listWhere(table, cid, ...filtros)` (API)

[`$api/libs/shared/list_query.ts`](../../src/apps/api/libs/shared/list_query.ts)

WHERE de listagem com o mesmo racional do `byIdInCondo`: o tenant scope e o `deleted_at IS NULL`
(quando a tabela o tem) entram por construção, seguidos de filtros opcionais em que `undefined`
significa "sem filtro". Combinadores no mesmo ficheiro: `eqIf`, `inListIf`, `notInListIf`,
`dateRange`, `yearRange`, `searchILike`.

O resultado é **um** fragmento `SQL` que serve o `findMany({ where })` e o `countWhere(...)` da
paginação. Nunca reconstruir os filtros no `count()`: as duas cópias divergem. Os anos do dropdown
vêm de `listAvailableYears`.

### 4. `parseEurosToCents(input, opts?)` (shared)

[`$shared/money/parse_euros.ts`](../../src/shared/money/parse_euros.ts)

```ts
// criar: vazio = 0 é decisão local do caller
body.amountCents = parseEurosToCents(form.amount) ?? 0;

// atualizar: vazio = não tocar no campo
const cents = parseEurosToCents(form.amount);
if (cents !== null) body.amountCents = cents;

// saldo de abertura: pode ser negativo
body.openingBalance = parseEurosToCents(form.balance, { allowNegative: true }) ?? 0;
```

- Aceita `"1.234,56"` (PT-PT), `"1234.56"` (intl) ou um número.
- Vazio, só espaços, `NaN`, `null` ou `undefined` devolvem `null`: o caller decide se é erro.
- Negativos devolvem `null` por defeito; opt-in com `{ allowNegative: true }`.
- Arredonda à unidade de cêntimo (`Math.round`).
- Validação estrita: `"abc"`, `"1.2.3"` e múltiplas vírgulas devolvem `null`.

Implementa a regra global "cêntimos integer, nunca `float`". Um edge-case novo resolve-se com um
teste em [`parse_euros_test.ts`](../../src/shared/money/parse_euros_test.ts) e uma alteração ao
helper, não no caller.

### 5. `parseFormString`, `parseFormBool`, `parseFormInt` (Panel)

[`$panel/libs/form_parsing.ts`](../../src/apps/panel/libs/form_parsing.ts)

```ts
const name = parseFormString(form, "name"); // vazio -> ""
const note = parseFormString(form, "note", { emptyAsNull: true }); // vazio -> null
const cat = parseFormString(form, "category", { default: "other" }); // vazio -> "other"
const isActive = parseFormBool(form, "isActive");
const limit = parseFormInt(form, "limit", { default: 100 });
```

- `parseFormString` faz `trim` e distingue três modos para vazio: `""`, `null` (`emptyAsNull`) ou um
  valor por defeito (`default`).
- `parseFormBool` aceita `"on"` (o que o browser envia numa checkbox), `"true"` e `"1"` como
  verdadeiro; tudo o resto é falso.
- `parseFormInt` devolve o `default` (0 se omitido) para vazio ou `NaN`.

Só normalizam, não validam. A adoção é oportunista: controllers novos usam-nos; os existentes migram
quando forem tocados. Ficam de fora os casos com regras próprias (por exemplo, booleans restritos a
certos valores).

### 6. `htmxAction(c, opts)` (Panel)

[`$panel/routes/_htmx_response.ts`](../../src/apps/panel/routes/_htmx_response.ts)

```ts
return htmxAction(c, {
  action: () => approvePolicy(policyId),
  renderSuccess: async () =>
    unitId ? await renderUnitRowsHtmx(unitId, "Apólice aprovada.") : "<div></div>",
  redirectPath: "insurances",
  successMsg: "Apólice aprovada.",
  errorPrefix: "Erro a aprovar",
});
```

- **Pedido HTMX, sucesso**: devolve `renderSuccess(result)`, que é HTML com `hx-swap-oob` para os
  elementos a atualizar. O toast vai dentro desse HTML.
- **Pedido HTMX, erro**: devolve o toast de erro, com a mensagem extraída por
  `extractApiErrorMessage`.
- **Pedido normal**: delega em `runFormAction` (redirect com flash).
- `action` recebe o form já lido; `successMsg` pode ser uma função do resultado.
- Para um header extra (por exemplo `HX-Trigger`), chamar `c.header(...)` dentro de `renderSuccess`,
  antes de devolver o HTML.

No mesmo ficheiro, `htmxOrRedirect` só escolhe entre devolver um fragmento e redirecionar com flash:
não executa a ação nem apanha erros. Serve as rotas que re-renderizam a mesma região com a mensagem,
em sucesso e em erro. `runFormAction` continua a ser o helper dos POST sem HTMX.

### Módulos de helpers por subdomínio

Um `_helpers.ts` que passe das ~400 linhas divide-se em ficheiros por subdomínio, e os callers
importam do ficheiro específico, sem barrel de compatibilidade. Exemplos: `insurance/` (`upload.ts`,
`state.ts`, `edit.ts`, `reminder.ts`, `read_model.ts`) e `receipt/` (`emit_orchestrator.ts`,
`pdf.ts`, `notify.ts`, `format.ts`).

## Consequências

- **Um só sítio por regra**: introduzir uma terceira role, mudar a invariante de tenant ou a
  estrutura do toast edita um ficheiro, não dezenas.
- **Edge-cases testados uma vez**: vazio, `NaN`, negativo e separador de milhares PT-PT têm um
  destino único.
- Cada handler importa mais um helper. É ruído mínimo face à uniformidade.
- `htmxAction` fixa a forma da resposta (`renderSuccess` devolve só HTML); headers extra passam por
  `c.header(...)`.

## Sinais de alerta para code review

Rejeitar alterações que reintroduzam:

- `role !== "super" && !managed.includes(cid)` num handler. Usar `requireCondoAdmin` /
  `isCondoAdmin`.
- `ops.and(ops.eq(e.id, X), ops.eq(e.condominiumId, Y), ops.isNull(e.deletedAt))` inline. Usar
  `byIdInCondo`.
- Um `count()` de paginação com filtros reescritos à mão. Usar o mesmo `listWhere`.
- `Math.round(parseFloat(s.replace(",", ".")) * 100)`. Usar `parseEurosToCents`.
- `if (isHtmx) { try { ... } catch { ... } }` numa rota de mutação. Usar `htmxAction`.

Verificação rápida: `grep -rn 'role !== "super"' src/apps/api/modules/` devolve zero resultados.

Exceções legítimas, que não são para "corrigir":

- O check de role na camada de middleware da API (`api_auth.ts`, `require_super.ts`) e no Panel
  (`main.ts`, `condominium.ts`, `render.ts`), onde não existe o contexto de um handler da API.
- `parseFloat(...replace(",", "."))` em `unit_import/parser.ts`: é permilagem, não dinheiro.

## Referências

- [ADR 0002](./0002-user-role-consolidation.md) - a regra de autorização que `requireCondoAdmin`
  aplica.
- [ADR 0009](./0009-tenant-id-in-url-path.md) - o `cid` vem do path, não de um header.
- [ADR 0005](./0005-soft-delete-convention.md) - soft-delete.
- [ADR 0026](./0026-scroll-preservation-htmx.md) - convenção de swap HTMX que `htmxAction`
  complementa.
- Testes ao lado de cada helper (`*_test.ts`):
  [`require_condo_admin_test.ts`](../../src/apps/api/libs/shared/require_condo_admin_test.ts),
  [`list_query_test.ts`](../../src/apps/api/libs/shared/list_query_test.ts),
  [`parse_euros_test.ts`](../../src/shared/money/parse_euros_test.ts),
  [`form_parsing_test.ts`](../../src/apps/panel/libs/form_parsing_test.ts),
  [`_htmx_response_test.ts`](../../src/apps/panel/routes/_htmx_response_test.ts).
- Outros helpers partilhados, fora do âmbito deste ADR: `partials/kpi_card.vto`
  ([ADR 0029](./0029-kpi-card-responsive.md)) e o builder de fixtures `seedScenario` em
  `test_api/_helpers/fixtures.ts`.
