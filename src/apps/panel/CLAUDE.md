# Panel (src/apps/panel) - regras

Carregado automaticamente quando trabalho em `src/apps/panel/**` (admin + portal). Complementa a
raiz `/CLAUDE.md`. Stack: SSR Vento+daisyUI/Tailwind CDN; consome a API via `Client` partilhado -
controllers NUNCA tocam na BD.

## Arquitectura

Middleware lê o cookie `token` (JWT), valida-o na API (`GET /v1/auth/me`) e injecta
`PanelRequestContext` em **AsyncLocalStorage** (`context.ts`). `:cid` da URL -> ALS -> `Client` via
`condominiumId: currentCondominiumId`. **Client partilhado**: importar `client` de
`$panel/client.ts` - NUNCA `new Client({...})` em controllers (instâncias próprias só onde a config
difere: auth pré-login, render.ts). Filtros Vento globais em `render.ts`: `formatMoney`,
`formatDate`, `formatPermillage`, `condoPath`. Templates `.vto` em
`templates/{layouts,pages,partials}`. Combobox: `<div data-combobox>` com
`data-combobox-{search,value,list,option,empty}`; dentro de `<dialog class="modal">` põe
`overflow-visible` no `modal-box`.

## Templates & UI

- **Cabeçalho de página via `partials/page_header.vto`** - NÃO escrever `<h1>` com classes à mão.
  `{{ include }}` sem ações; `{{ layout }}...{{ /layout }}` com corpo = botões. `scale: "list"`
  (default) | `"detail"`. Navegação SEMPRE por `breadcrumbs` (links "← Voltar" descontinuados).
  Badge de estado via `partials/status_badge.vto` (`{ label, tone, size? }`). GOTCHA: no modo
  layout, a última propriedade dos params não pode ter trailing comma. Contrato testado em
  `page_header_test.ts`. Ver [ADR 0036](../../../docs/adr/0036-page-header-canonical.md).
- **Cards de tabela via `partials/table_card.vto`** quando o header é título(+count)(+pesquisa) -
  corpo do `{{ layout }}` = a `<table>` (e só ela). Garante `.table-scroll` (ADR 0031) por
  construção. Headers com filtros/tabs/botões ficam hand-rolled. Ver
  [ADR 0038](../../../docs/adr/0038-table-card-canonical.md).
- **Estado de charge para display**: NUNCA `c.status === "overdue"` num template. Usar os globais
  `chargeStatusBadge(c, cutoff)` / `isChargeOverdue(c, cutoff)` (cutoff =
  `condominium.reconciledThroughDate`) ou o partial `charge_status.vto`. Status gravado só serve
  gates de editabilidade e filtros server-side. Ver
  [ADR 0037](../../../docs/adr/0037-charge-effective-status.md).
- **Flash messages** layout-only (renderizados em `admin.vto`/`portal.vto`); controllers não chamam
  `parseFlashFromQuery` nem passam `flash`. Ver
  [ADR 0012](../../../docs/adr/0012-flash-message-rendering.md).
- **`condominium` é global de layout** (mesmo movimento do flash): o `render()` injeta-o via
  `loadCurrentCondominium()` (`$panel/condominium.ts`, cache per-request via ALS). Controllers admin
  NÃO chamam `getMe()` nem passam `condominium` ao render; quando precisam do valor em lógica, usam
  `requireCurrentCondominium()` (mesma cache). Portal continua a passar o seu próprio `condominium`
  (precedência sobre o injetado).
- **Confirm modal** declarativo:
  `<form data-confirm-title="…" data-confirm-body="…"
  data-confirm-danger="true">`. Nunca
  `window.confirm()`. Replicado em `admin.vto` + `portal.vto`
  - quando alterares um, alinha o outro. Ver
    [ADR 0013](../../../docs/adr/0013-confirm-modal-global.md).
- **Designação de fração = link no admin**:
  `<a href="/admin/c/{cid}/units/{id}" class="link
  link-hover">` no formato canónico. Exceções:
  `units/list`/`units/show`, popups, `<option>`, PDFs, portal. Ver
  [ADR 0015](../../../docs/adr/0015-unit-link-everywhere.md).
- **HTMX swaps preservam scroll**. Todos os `hx-swap` que substituem conteúdo (não OOB) devem
  incluir o modifier `show:no` - `hx-swap="outerHTML show:no"`. Sem ele, um swap pode fazer a página
  saltar em forms no fundo (uploads, comentários). Exceções legítimas (wizards) explicitam
  `show:top` localmente. **Além disso, o target do swap deve ser o elemento mais pequeno que contém
  o que muda** - usa `hx-target` + `hx-select` apontando para o mesmo id pequeno (e.g.
  `#ticket-attachments`), em vez de swap do body todo. Se o handler retorna o template inteiro,
  `hx-select` extrai só a região no client. Ver
  [ADR 0026](../../../docs/adr/0026-scroll-preservation-htmx.md).
- **`<input class="sr-only">` dentro de `<label>` exige `position: relative` no parent.** O Tailwind
  `sr-only` é `position: absolute` sem `top/left` - sem `relative` no parent, o input ancora-se ao
  body e o clique provoca scroll para o canto top-left. Pattern canónico:
  `partials/file_dropzone.vto`. Ver [ADR 0026](../../../docs/adr/0026-scroll-preservation-htmx.md).
- **Uploads de ficheiros usam `partials/file_dropzone.vto`** (admin e portal). Dropzone com
  drag-and-drop, preview e contador. O botão de submit do form deve ter
  `data-upload-submit disabled` - o JS global liga/desliga consoante há ficheiros selecionados.
  Imports XLSX/CSV usam o mesmo partial com `multiple: false` + `accept=".xlsx,..."`. Ver
  [ADR 0026](../../../docs/adr/0026-scroll-preservation-htmx.md).
- **Loading indicator único - barra rose-500 no topo**. Requests HTMX activam-na automaticamente.
  Para fetch manual / form submits nativos lentos, usar `window.__progress.start()` + `.finish()`
  (exposto em admin.vto + portal.vto). NÃO criar barras locais exceto quando há progresso real X/N a
  comunicar (única exceção viva: `portal/insurance/confirm.vto`). Ver
  [ADR 0027](../../../docs/adr/0027-htmx-loading-indicator.md).
- **Tabelas largas vão dentro de `.table-scroll`**. Toda a `<table>` de dados no admin envolve-se em
  `<div class="table-scroll">` (classe global em `admin.vto`) para scroll horizontal + scroll-shadow
  em mobile. O card exterior mantém `overflow-hidden` (cantos arredondados); NÃO pôr
  `overflow-x-auto` no card (o header de pesquisa deslocava-se). Inerte quando a tabela cabe. Ver
  [ADR 0031](../../../docs/adr/0031-table-horizontal-scroll-mobile.md).
- **Filtros `|>` NÃO funcionam dentro dos params de `{{ include }}`/`{{ layout }}`.** O parser corta
  nas vírgulas e atira `Invalid filter: formatMoney,`. Pré-formatar antes com `{{ set }}` e passar a
  variável (`{{ set _v = x |> formatMoney }}` → `value: _v`). Padrão em `dashboard.vto` e
  `pages/reports/*.vto`.
- **Vento autoescape** - `{{ x }}` é HTML-escapado. JSON em atributos: usa apóstrofes
  `data-x='{{ JSON.stringify(x) }}'`.
- **Hard reload**: `.vto` recarrega automaticamente, mas pede **hard reload** (Shift+Cmd+R) após
  mudar `layouts/admin.vto` (JS em cache).

## Rotas & forms

- **Rotas panel com mutação HTMX**: usar
  `htmxAction(c, { action, renderSuccess,
  redirectPath, successMsg, errorPrefix })` de
  `_htmx_response.ts`. Compõe `runFormAction` (non-HTMX) + try/catch + toast (HTMX). NÃO
  reimplementar o branching `if (isHtmx) { try ... catch ... }` manual. Ver
  [ADR 0030](../../../docs/adr/0030-shared-action-helpers.md).
- **Form parsing no panel**: `parseFormString`/`parseFormBool`/`parseFormInt` de
  `$panel/libs/form_parsing.ts`. Substitui `String(form.x ?? "").trim()` + checkbox handling +
  `parseInt` ad-hoc. `parseFormBool` aceita `"on"` (default do browser para checkboxes), `"true"`,
  `"1"`. Adopção opportunistic. Ver [ADR 0030](../../../docs/adr/0030-shared-action-helpers.md).
