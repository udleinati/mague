# ADR 0003 - Visibilidade no portal: `scope` no query builder + `ownershipQuery` na factory de anexos

## Contexto

Alguns recursos são totalmente visíveis no admin mas só em parte no portal: um documento só aparece
ao condómino com `is_public = true`; uma assembleia ou uma patologia em `draft` é trabalho interno
da administração.

Dois riscos a evitar:

- **Forks de leitura.** Um handler de portal que copia a query do admin e lhe junta um filtro
  diverge do original na primeira alteração de colunas ou de ordenação.
- **IDOR nos anexos.** Conhecer o id de um recurso privado não pode bastar para descarregar os seus
  anexos. O gate de visibilidade tem de correr antes de se tocar nos bytes.

## Decisão

A regra de visibilidade aplica-se em duas camadas, ambas com um seam explícito. Admin e portal
partilham o código; o que muda é um dado injetado por quem chama.

### 1. Leituras: `scope` no query builder

Cada recurso com regra de visibilidade tem um `_query.ts` no seu módulo admin, com builders puros
(sem HTTP nem BD) parametrizados por `scope: "all" | "public"`:

| Recurso    | Builders                    | `scope: "public"` força                               |
| ---------- | --------------------------- | ----------------------------------------------------- |
| Documento  | `admin/document/_query.ts`  | `is_public = true`                                    |
| Assembleia | `admin/assembly/_query.ts`  | `status` em `ASSEMBLY_PUBLIC_STATUSES` (sem `draft`)  |
| Patologia  | `admin/pathology/_query.ts` | `status` em `PATHOLOGY_PUBLIC_STATUSES` (sem `draft`) |

Regras:

- `scope` é o único interruptor de visibilidade e faz parte da assinatura. É injetado pelo caller
  (router ou handler de portal), nunca lido da query string nem de estado do contexto.
- `scope: "all"` (admin) aplica multi-tenant e soft-delete, e respeita os filtros opcionais do admin
  (`isPublic`, `status`, `category`).
- `scope: "public"` (portal) força a regra de visibilidade e **ignora em silêncio** qualquer filtro
  que a contrarie (`isPublic=false`, `status=draft`). É deliberado: um filtro de admin que escape
  para o handler de portal não pode vazar dados.
- Os handlers ficam wrappers HTTP finos: ler a query string, chamar o builder, formatar a resposta.

### 2. Anexos: `ownershipQuery` na factory

`makeAttachmentManager` (`$api/libs/attachments/manager.ts`) recebe uma `ownershipQuery` por
configuração. `list`, `upload` e `serve` chamam `readAndCheckOwnership` antes de consultar o anexo:
se a query não devolver a entidade-pai, a resposta é 404 e os bytes nunca são lidos. `delete` usa o
scope de quatro chaves do helper (`id` + `condominium_id` + `entity_type` + `entity_id`).

Num recurso com regra de visibilidade, o portal declara a sua própria configuração da factory, com
uma `ownershipQuery` que junta a regra, e exporta só as operações de leitura:

```ts
const portalDocumentAttachments = makeAttachmentManager({
  entityType: "document",
  paramName: "documentId",
  entityNamePT: "Documento",
  ownershipQuery: (postgres, documentId, condominiumId) =>
    postgres.query((db) =>
      db.query.document.findFirst({
        where: (d, ops) =>
          ops.and(
            ops.eq(d.id, documentId),
            ops.eq(d.condominiumId, condominiumId),
            ops.eq(d.isPublic, true),
            ops.isNull(d.deletedAt),
          ),
      })
    ),
  serialize: (a: AttachmentSelect) => formatDocumentAttachment(a),
});

export const portalServeDocumentAttachmentHandler = portalDocumentAttachments.serve;
```

A mesma forma existe para assembleias (`portal/assembly_attachments.ts`, `list` + `serve`) e
patologias (`portal/pathology_attachments.ts`, `serve`).

### Aplicar a um recurso novo

1. Definir a regra de visibilidade no schema (flag ou conjunto de estados públicos).
2. Criar `_query.ts` no módulo admin do recurso, com builders parametrizados por `scope`, e os
   respetivos testes unitários.
3. Handlers admin chamam o builder com `scope: "all"`.
4. O portal chama com `scope: "public"`: em `portal/<recurso>.ts` se precisar de cabling próprio, ou
   em `portal/wrappers.ts` se for só um shim sobre o handler admin.
5. Anexos: configuração própria da factory em `portal/<recurso>_attachments.ts`, com
   `ownershipQuery` que aplica a regra, exportando só leitura.

Recursos sem regra de visibilidade (orçamentos, contas bancárias) reutilizam o handler admin tal
como está, via `portal/wrappers.ts`.

## Consequências

- A regra de visibilidade de cada recurso vive em dois sítios conhecidos: o `_query.ts` e a
  `ownershipQuery` do portal. Mudar a regra obriga a alterar ambos.
- `serve` custa uma query extra por download (a `ownershipQuery`, um point-lookup por id e
  condomínio).
- A proteção dos anexos no portal é por convenção: se uma configuração de portal não incluir a regra
  na `ownershipQuery`, ela não se aplica. Um recurso novo precisa do seu próprio teste E2E (anexo de
  recurso privado pedido pelo portal responde 404).
- O portal não pode reutilizar o handler de anexos do admin num recurso com regra de visibilidade: o
  admin não filtra.
- O facto de `scope: "public"` ignorar filtros contraditórios não se vê no tipo. Está comentado em
  cada `_query.ts` e coberto por testes ("anti-vazamento").

## Alternativas rejeitadas

1. **Parâmetro `scope` diretamente no handler admin, sem builder.** A query continua embutida no
   handler e só é testável por E2E.
2. **`scope` implícito no contexto, posto por um middleware do portal.** Estado invisível na
   assinatura: quem lê o handler não sabe que a visibilidade depende de quem o montou.
3. **Helper paralelo só para servir bytes**, fora da factory. Cria dois caminhos para a mesma
   operação; a factory é o ponto de entrada conhecido.
4. **Manter handlers de portal como cópias dos de admin.** Alterações em duplicado e o gate dos
   anexos dependente de alguém se lembrar dele.

## Sinais de alerta para code review

- Handler de portal que reimplementa uma query do admin com um filtro a mais: é um seam para
  `_query.ts` + `scope`. Só fica em módulo separado se a lógica de domínio for mesmo diferente.
- `scope` lido da query string, de um header ou de `ctx.get(...)`.
- Rota de portal ligada ao handler de anexos do admin de um recurso com regra de visibilidade.
- Operação que lê bytes do S3 sem validar primeiro a entidade-pai.
- Factory com comportamento assimétrico entre operações (umas validam ownership, outras não):
  corrige-se a factory, não se contorna com um handler manual.

## Referências

- Builders: [`document/_query.ts`](../../src/apps/api/modules/admin/document/_query.ts),
  [`assembly/_query.ts`](../../src/apps/api/modules/admin/assembly/_query.ts),
  [`pathology/_query.ts`](../../src/apps/api/modules/admin/pathology/_query.ts), cada um com o seu
  `_query_test.ts`.
- Factory: [`attachments/manager.ts`](../../src/apps/api/libs/attachments/manager.ts) e
  `manager_test.ts` ("manager.serve - ownership null → 404").
- Portal: [`portal/document.ts`](../../src/apps/api/modules/portal/document.ts),
  [`portal/document_attachments.ts`](../../src/apps/api/modules/portal/document_attachments.ts),
  [`portal/assembly_attachments.ts`](../../src/apps/api/modules/portal/assembly_attachments.ts),
  [`portal/pathology_attachments.ts`](../../src/apps/api/modules/portal/pathology_attachments.ts),
  [`portal/wrappers.ts`](../../src/apps/api/modules/portal/wrappers.ts).
- Testes E2E: `test_api/api_portal_document_test.ts`,
  `test_api/api_admin_document_attachments_test.ts`, `test_api/api_actor_leak_guard_test.ts` (anexos
  de assembleia em `draft`).
- [ADR 0006](./0006-polymorphic-attachment-table.md) - tabela polimórfica de anexos.
- [ADR 0024](./0024-pathology-entity-design.md) - visibilidade da patologia derivada do estado.
- `CONTEXT.md`: Visibility, Document, Portal.
