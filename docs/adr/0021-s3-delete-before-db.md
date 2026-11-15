# ADR 0021 - Eliminar o ficheiro do S3 antes de eliminar na BD

## Contexto

Várias entidades têm ficheiros em S3 (bucket privado, acedido via `$api/libs/storage/s3.ts`), com a
coluna `storage_key` na BD a apontar para o objeto. Eliminar toca nos dois mundos:

- Eliminar um anexo (`core.attachment`): o objeto S3 e a linha da tabela.
- Eliminar uma entidade-pai com anexos (ocorrência, assembleia, documento, apólice, vistoria,
  patologia): cascata aos anexos e depois o pai.

Sem regra clara aparecem dois problemas:

1. **Leak de storage.** O soft-delete apaga a linha "logicamente" e deixa os bytes no bucket, sem
   limpeza.
2. **Direito ao esquecimento.** Uma ocorrência eliminada não pode deixar fotografias acessíveis pela
   `storage_key`. "Eliminar" tem de querer dizer eliminar.

## Decisão

**Quando se elimina algo que tem um ficheiro em S3, o objeto S3 é eliminado PRIMEIRO. Só depois se
toca na BD.** A ordem inversa é bug.

### Um anexo: `softDeleteAttachment`

Em `$api/libs/attachments/mod.ts`, por esta ordem:

1. Lê o anexo (precisa da `storage_key`). Se já estiver eliminado, devolve `false` sem mexer.
2. `deleteObject(storage_key)`. Se falhar, lança `S3_DELETE_FAILED` (500) e a BD fica intacta.
3. Soft-delete da linha (`deleted_at` + `deleted_by`); a linha fica para auditoria.

`deleteObject` é idempotente (o S3 aceita eliminar uma key que já não existe), por isso repetir o
pedido é seguro.

### Entidade-pai: `softDeleteAttachmentsForEntity`

A cascata pai -> anexos tem um único caminho:
`softDeleteAttachmentsForEntity({ postgres,
condominiumId, entityType, entityId, actor })`, também
em `mod.ts`. Elimina os bytes e as linhas de todos os anexos vivos da entidade e devolve quantos
eliminou. Chama-se **sempre antes** de tocar na linha do pai:

```ts
export async function softDeleteTicket(postgres, args) {
  // 1. Cascata S3 aos anexos vivos.
  await softDeleteAttachmentsForEntity({
    postgres,
    condominiumId: args.condominiumId,
    entityType: "ticket",
    entityId: args.ticketId,
    actor: args.actor,
  });
  // 2. Soft-delete do pai (a linha fica para auditoria).
  const rows = await postgres.query((db) =>
    db.update(schema.ticket)
      .set({ deletedAt: new Date(), deletedBy: args.actor, updatedAt: new Date() })
      .where(byIdInCondo(schema.ticket, args.ticketId, args.condominiumId))
      .returning()
  );
  return rows.length > 0;
}
```

### Fail-fast, sem exceções

Se o S3 falhar, a cascata lança, o pedido responde 500 e o pai fica vivo. O estado continua íntegro
e o administrador repete a operação. Não se captura o erro para "continuar à mesma": numa entidade
com hard-delete (a apólice de seguro), engolir a falha deixava a linha eliminada e os bytes vivos,
sem dono nenhum.

### O guard test

`attachments/cascade_guard_test.ts` percorre `src/apps/api/` e falha se algum ficheiro eliminar
(hard-delete, ou `update` com `deletedAt`) uma tabela com anexos sem chamar
`softDeleteAttachmentsForEntity`. A lista de tabelas é `TABLES_WITH_ATTACHMENTS`. A allowlist
`ALLOWED` exige uma razão escrita por entrada, e o próprio teste recusa entradas obsoletas. A única
entrada atual é a anulação de uma renovação de seguro, que só é permitida com zero anexos.

### Exceção: substituir no mesmo `storage_key`

Quando a operação é substituir o ficheiro, não o eliminar, usa-se `putObject` sobre a mesma key
(overwrite do lado do S3). É o caso do recibo anulado, cujo PDF é gerado de novo com a marca
"ANULADO": `receipt/void.ts` e `renderAndStorePdfFromSnapshots` em `receipt/pdf.ts`.

## Consequências

- Cada linha eliminada implica o ficheiro eliminado: não há leak de storage.
- O rasto de quem eliminou e quando fica em `deleted_at` / `deleted_by`.
- Em caso de falha do S3 a BD não muda; repetir é seguro.
- Eliminar tem latência extra: um round-trip ao S3 por anexo. Aceitável, porque eliminações não são
  um caminho quente.
- **O soft-delete deixa de ser reversível na prática**: repor `deleted_at = NULL` em SQL não
  recupera os bytes. Restaurar o pai não devolve os anexos.
- **Eliminar uma fração ou um condomínio não faz cascata.** `admin/unit/delete.ts`,
  `super/unit/delete.ts` e `super/condominium/delete.ts` fazem soft-delete só da própria linha: não
  eliminam os anexos nem as entidades que os possuem (apólices, charges, ocorrências). Não é um
  órfão de storage, porque as linhas continuam a referenciar os bytes. É uma decisão de domínio em
  aberto (o que cai, o que fica para auditoria, como se cumpre o direito ao esquecimento sem perder
  o histórico contabilístico) e pede ADR própria. O guard test não o assinala: `unit` e
  `condominium` não são `entity_type` de anexo.

## Alternativas rejeitadas

1. **Soft-delete só na BD e job periódico a limpar o S3.** Janela de horas com os bytes vivos, mais
   um job com fila, idempotência e métricas, e sem direito ao esquecimento imediato.
2. **Hard-delete da linha e do objeto numa transação distribuída.** Perde-se o rasto (`deleted_at` /
   `deleted_by`), e não há transação nativa entre PostgreSQL e S3.
3. **BD primeiro, S3 depois.** Se o S3 falhar, fica uma linha eliminada a apontar para um ficheiro
   vivo: o direito ao esquecimento é violado em silêncio.
4. **Best-effort na cascata** (registar o erro do S3 e continuar). É o que produz o ficheiro órfão:
   linha fora, bytes lá.

## Sinais de alerta para code review

- `UPDATE ... SET deleted_at` ou `DELETE` numa entidade com anexos (ou com `storage_key` direto) sem
  a cascata antes.
- `deleteObject(...)` chamado **depois** do UPDATE ou DELETE na BD.
- `.catch()` ou `try/catch` a engolir a falha de `deleteObject` ou da cascata num fluxo de
  eliminação.
- Loop manual sobre anexos em vez de `softDeleteAttachmentsForEntity`.
- Helper novo que recebe uma `storage_key` e faz soft-delete sem tocar no S3: ou usa
  `softDeleteAttachment`, ou justifica em comentário.
- Entrada nova em `ALLOWED` do guard test sem uma razão que se consiga escrever.
- Helper local chamado `softDeleteAttachment` a sombrear o canónico: usar um nome próprio (por
  exemplo `softDeleteInspectionAttachment`).

## Referências

- [`attachments/mod.ts`](../../src/apps/api/libs/attachments/mod.ts) - `softDeleteAttachment` (um
  anexo) e `softDeleteAttachmentsForEntity` (cascata).
- [`attachments/cascade_guard_test.ts`](../../src/apps/api/libs/attachments/cascade_guard_test.ts)
  - guard estático. Mesmo modelo de `settlement/seam_guard_test.ts`
    ([ADR 0001](./0001-financial-cascade-split.md)).
- [`storage/s3.ts`](../../src/apps/api/libs/storage/s3.ts) - `deleteObject`, `putObject`.
- Cascata aplicada em: [`ticket/_helpers.ts`](../../src/apps/api/modules/admin/ticket/_helpers.ts),
  [`assembly/delete.ts`](../../src/apps/api/modules/admin/assembly/delete.ts),
  [`document/delete.ts`](../../src/apps/api/modules/admin/document/delete.ts),
  [`inspection/_helpers.ts`](../../src/apps/api/modules/admin/inspection/_helpers.ts),
  [`pathology/_helpers.ts`](../../src/apps/api/modules/admin/pathology/_helpers.ts),
  [`insurance/edit.ts`](../../src/apps/api/modules/admin/insurance/edit.ts) e
  [`insurance/upload.ts`](../../src/apps/api/modules/admin/insurance/upload.ts).
- Overwrite: [`receipt/void.ts`](../../src/apps/api/modules/admin/receipt/void.ts),
  [`receipt/pdf.ts`](../../src/apps/api/modules/admin/receipt/pdf.ts).
- Verificação ponta a ponta:
  [`scripts/verify_attachment_cascade.ts`](../../scripts/verify_attachment_cascade.ts) (cria a
  entidade, carrega anexos, elimina e confirma que os objetos deixaram de existir no S3).
- [ADR 0006](./0006-polymorphic-attachment-table.md) - tabela polimórfica de anexos.
- [ADR 0005](./0005-soft-delete-convention.md) - soft-delete.
- [ADR 0011](./0011-actor-snapshot-convention.md) - `deleted_by`.
