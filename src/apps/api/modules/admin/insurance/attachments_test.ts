// WHY: estes quatro caminhos (admin/portal × principal/por-id) estavam escritos
// à mão em quatro handlers e nenhum tinha teste - importavam a lib de S3
// diretamente, por isso não havia como os correr sem rede. Com as deps
// injetadas, a composição verifica-se aqui.

import { assertEquals, assertRejects } from "@std/assert";
import type { Postgres } from "$api/libs/postgres/postgres.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import type { AttachmentSelect } from "$api/libs/postgres/schemas/attachment.ts";
import {
  listPolicyAttachments,
  policyAttachmentResponse,
  servePolicyAttachment,
} from "./attachments.ts";

const POSTGRES = {} as unknown as Postgres;

const att = (id: string, filename: string): AttachmentSelect =>
  ({
    id,
    filename,
    mimeType: "application/pdf",
    fileSize: 1234,
    storageKey: `key/${id}.pdf`,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    // Campos que a projeção NÃO pode deixar sair (ADR 0011).
    createdBy: { user_id: "u1", email: "a@b.pt" },
  }) as unknown as AttachmentSelect;

/** Fakes das 4 deps + registo do que foi pedido. */
function fakeDeps(atts: AttachmentSelect[]) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      listAttachmentsForEntity: (a: { entityId: string }) => {
        calls.push(`list:${a.entityId}`);
        return Promise.resolve(atts);
      },
      getAttachmentById: (a: { attachmentId: string; entityId: string }) => {
        calls.push(`getById:${a.attachmentId}`);
        return Promise.resolve(atts.find((x) => x.id === a.attachmentId) ?? null);
      },
      serveAttachmentBytes: (key: string) => {
        calls.push(`bytes:${key}`);
        return Promise.resolve(new Uint8Array([1, 2, 3]));
      },
      serveHeaders: (a: AttachmentSelect, size: number) => ({
        "content-type": a.mimeType,
        "content-length": String(size),
      }),
      // deno-lint-ignore no-explicit-any
    } as any,
  };
}

Deno.test("serve por id usa o lookup de 4 chaves, não list-then-find", () => {
  // O list-then-find trazia a lista toda para memória e comparava em JS; o
  // `getAttachmentById` faz o filtro anti-IDOR na query (condo+tipo+pai+anexo).
  const { calls, deps } = fakeDeps([att("a1", "apolice.pdf"), att("a2", "recibo.pdf")]);
  return servePolicyAttachment(
    POSTGRES,
    { condominiumId: "c1", policyId: "p1", attachmentId: "a2" },
    deps,
  ).then((r) => {
    assertEquals(r.status, 200);
    assertEquals(calls, ["getById:a2", "bytes:key/a2.pdf"]);
  });
});

Deno.test("sem attachmentId serve o principal (o primeiro da lista)", async () => {
  // É o link "PDF" histórico: não sabe ids, quer o ficheiro da apólice.
  const { calls, deps } = fakeDeps([att("a1", "apolice.pdf"), att("a2", "recibo.pdf")]);
  const r = await servePolicyAttachment(POSTGRES, { condominiumId: "c1", policyId: "p1" }, deps);
  assertEquals(r.status, 200);
  assertEquals(calls, ["list:p1", "bytes:key/a1.pdf"]);
  assertEquals(r.headers.get("content-length"), "3");
});

Deno.test("apólice sem ficheiros: 404 NO_ATTACHMENT, não NOT_FOUND", async () => {
  // Os dois 404 dizem coisas diferentes ao utilizador: "ainda não há evidência"
  // vs "esse ficheiro não existe". A UI distingue-os pelo `code`.
  const { deps } = fakeDeps([]);
  const e = await assertRejects(
    () => servePolicyAttachment(POSTGRES, { condominiumId: "c1", policyId: "p1" }, deps),
    AppError,
  );
  assertEquals(e.code, "NO_ATTACHMENT");
  assertEquals(e.statusCode, 404);
});

Deno.test("id que não pertence à apólice: 404 NOT_FOUND e nunca toca no S3", async () => {
  const { calls, deps } = fakeDeps([att("a1", "apolice.pdf")]);
  const e = await assertRejects(
    () =>
      servePolicyAttachment(
        POSTGRES,
        { condominiumId: "c1", policyId: "p1", attachmentId: "de-outra-apolice" },
        deps,
      ),
    AppError,
  );
  assertEquals(e.code, "NOT_FOUND");
  // O importante: recusa antes de ler bytes.
  assertEquals(calls, ["getById:de-outra-apolice"]);
});

Deno.test("a projeção não deixa sair storageKey nem ActorSnapshot (ADR 0011)", () => {
  const out = policyAttachmentResponse(att("a1", "apolice.pdf"));
  assertEquals(Object.keys(out).sort(), [
    "createdAt",
    "fileSize",
    "filename",
    "id",
    "mimeType",
  ]);
});

Deno.test("listar devolve os anexos da apólice pedida", async () => {
  const { calls, deps } = fakeDeps([att("a1", "apolice.pdf")]);
  const out = await listPolicyAttachments(POSTGRES, { condominiumId: "c1", policyId: "p9" }, deps);
  assertEquals(out.length, 1);
  assertEquals(calls, ["list:p9"]);
});
