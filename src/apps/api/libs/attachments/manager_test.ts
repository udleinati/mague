// Tests para o `makeAttachmentManager` factory: valida que propaga o config
// (entityType, paramName, serialize), valida ownership ANTES de tocar na lib
// (anti-leak), parsea multipart e formata as respostas. Deps injectadas via
// `depsOverride` - testamos o config-shape sem tocar S3/DB.

import { assertEquals, assertRejects } from "@std/assert";

import { type AttachmentLibDeps, makeAttachmentManager } from "./manager.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { HttpError } from "$api/middleware/error.ts";
import type { AttachmentSelect } from "$api/libs/postgres/schemas/attachment.ts";

// ── Helpers ──────────────────────────────────────────────────────────────

interface FakeCtxOpts {
  cid?: string;
  entityId?: string;
  attachmentId?: string;
  actor?: { user_id: string } | null;
  formData?: FormData;
  paramName?: string;
}

function fakeCtx(opts: FakeCtxOpts) {
  const paramName = opts.paramName ?? "chargeId";
  const params: Record<string, string | undefined> = {
    cid: opts.cid,
    [paramName]: opts.entityId,
    attachmentId: opts.attachmentId,
  };
  const variables: Record<string, unknown> = {
    actor: opts.actor === null ? null : (opts.actor ?? { user_id: "actor_1" }),
    condominiumId: opts.cid,
  };
  return {
    req: {
      param: (n: string) => params[n],
      formData: () => Promise.resolve(opts.formData ?? new FormData()),
    },
    get: (k: string) => variables[k],
    json: (data: unknown, status?: number) =>
      new Response(JSON.stringify(data), {
        status: status ?? 200,
        headers: { "content-type": "application/json" },
      }),
    // deno-lint-ignore no-explicit-any
  } as any;
}

const fakeAttachmentRow: AttachmentSelect = {
  id: "cat_abc",
  entityId: "ch_1",
  entityType: "charge",
  condominiumId: "co_1",
  filename: "test.pdf",
  mimeType: "application/pdf",
  fileSize: 1234,
  storageKey: "co_1/charge/ch_1/cat_abc/test.pdf",
  storageEtag: "etag",
  fileSha256: "sha",
  createdAt: new Date(),
  createdBy: { user_id: "actor_1", email: null, ip: null },
  updatedBy: {},
  deletedAt: null,
  deletedBy: null,
};

// deno-lint-ignore no-explicit-any
const fakePostgres = {} as any;

const baseConfig = {
  entityType: "charge" as const,
  paramName: "chargeId",
  entityNamePT: "Charge",
  ownershipQuery: () => Promise.resolve({ id: "ch_1" }),
  serialize: (a: AttachmentSelect) => ({ id: a.id, entityId: a.entityId }),
};

/** Cria deps com tracking - cada call regista args para asserts. */
function trackingDeps(overrides: Partial<AttachmentLibDeps> = {}): {
  deps: Partial<AttachmentLibDeps>;
  calls: Record<string, unknown[]>;
} {
  const calls: Record<string, unknown[]> = {
    upload: [],
    list: [],
    get: [],
    serve: [],
    headers: [],
    delete: [],
  };
  const deps: Partial<AttachmentLibDeps> = {
    uploadAttachment: (args) => {
      calls.upload.push(args);
      return Promise.resolve(fakeAttachmentRow);
    },
    listAttachmentsForEntity: (args) => {
      calls.list.push(args);
      return Promise.resolve([fakeAttachmentRow]);
    },
    getAttachmentById: (args) => {
      calls.get.push(args);
      return Promise.resolve(fakeAttachmentRow);
    },
    serveAttachmentBytes: (key) => {
      calls.serve.push(key);
      return Promise.resolve(new Uint8Array([1, 2, 3, 4]));
    },
    serveHeaders: (att, len) => {
      calls.headers.push({ att, len });
      return { "content-type": att.mimeType, "content-length": String(len) };
    },
    softDeleteAttachment: (args) => {
      calls.delete.push(args);
      return Promise.resolve(true);
    },
    ...overrides,
  };
  return { deps, calls };
}

// ── Tests ────────────────────────────────────────────────────────────────

Deno.test("manager.list - chama lib com entityType+entityId+condominiumId do ctx", async () => {
  const { deps, calls } = trackingDeps();
  const manager = makeAttachmentManager(baseConfig, deps);
  const res = await manager.list(fakeCtx({ cid: "co_1", entityId: "ch_1" }), fakePostgres);
  const body = await res.json();
  assertEquals(body, { data: [{ id: "cat_abc", entityId: "ch_1" }] });
  assertEquals(calls.list[0], {
    postgres: fakePostgres,
    condominiumId: "co_1",
    entityType: "charge",
    entityId: "ch_1",
  });
});

Deno.test("manager.list - ownership null → 404 com entityNamePT", async () => {
  const { deps, calls } = trackingDeps();
  const manager = makeAttachmentManager({
    ...baseConfig,
    ownershipQuery: () => Promise.resolve(null),
  }, deps);
  await assertRejects(
    () => manager.list(fakeCtx({ cid: "co_1", entityId: "ch_x" }), fakePostgres),
    AppError,
    "Charge",
  );
  // Ownership falhou → lib NÃO foi chamada (anti-leak).
  assertEquals(calls.list.length, 0);
});

Deno.test("manager.upload - multipart sem `file` → 400", async () => {
  const { deps, calls } = trackingDeps();
  const manager = makeAttachmentManager(baseConfig, deps);
  await assertRejects(
    () =>
      manager.upload(
        fakeCtx({ cid: "co_1", entityId: "ch_1", formData: new FormData() }),
        fakePostgres,
      ),
    AppError,
    "Campo `file` em falta",
  );
  assertEquals(calls.upload.length, 0);
});

Deno.test("manager.upload - actor null → 401 (requireActor)", async () => {
  const { deps } = trackingDeps();
  const manager = makeAttachmentManager(baseConfig, deps);
  const form = new FormData();
  form.append("file", new File(["data"], "test.pdf", { type: "application/pdf" }));
  await assertRejects(
    () =>
      manager.upload(
        fakeCtx({ cid: "co_1", entityId: "ch_1", actor: null, formData: form }),
        fakePostgres,
      ),
    HttpError,
    "AUTH_REQUIRED",
  );
});

Deno.test("manager.upload - sucesso passa filename + mime + bytes à lib", async () => {
  const { deps, calls } = trackingDeps();
  const manager = makeAttachmentManager(baseConfig, deps);
  const form = new FormData();
  const fileBytes = new Uint8Array([1, 2, 3]);
  form.append(
    "file",
    new File([fileBytes], "doc.pdf", { type: "application/pdf" }),
  );
  const res = await manager.upload(
    fakeCtx({ cid: "co_1", entityId: "ch_1", formData: form }),
    fakePostgres,
  );
  assertEquals(res.status, 201);
  const body = await res.json();
  assertEquals(body, { data: { id: "cat_abc", entityId: "ch_1" } });
  const uploadArg = calls.upload[0] as Record<string, unknown>;
  assertEquals(uploadArg.entityType, "charge");
  assertEquals(uploadArg.entityId, "ch_1");
  assertEquals(uploadArg.condominiumId, "co_1");
  assertEquals(uploadArg.filename, "doc.pdf");
  assertEquals(uploadArg.mimeType, "application/pdf");
});

Deno.test("manager.upload - file.name vazio usa defaultFilename", async () => {
  const { deps, calls } = trackingDeps();
  const manager = makeAttachmentManager(
    { ...baseConfig, defaultFilename: "fatura" },
    deps,
  );
  const form = new FormData();
  form.append("file", new File(["data"], "", { type: "application/pdf" }));
  await manager.upload(
    fakeCtx({ cid: "co_1", entityId: "ch_1", formData: form }),
    fakePostgres,
  );
  const uploadArg = calls.upload[0] as Record<string, unknown>;
  assertEquals(uploadArg.filename, "fatura");
});

Deno.test("manager.upload - sem defaultFilename usa 'anexo'", async () => {
  const { deps, calls } = trackingDeps();
  const manager = makeAttachmentManager(baseConfig, deps); // sem defaultFilename
  const form = new FormData();
  form.append("file", new File(["data"], "", { type: "application/pdf" }));
  await manager.upload(
    fakeCtx({ cid: "co_1", entityId: "ch_1", formData: form }),
    fakePostgres,
  );
  assertEquals((calls.upload[0] as Record<string, unknown>).filename, "anexo");
});

Deno.test("manager.serve - ownership null → 404 (não chega a consultar attachment)", async () => {
  const { deps, calls } = trackingDeps();
  const manager = makeAttachmentManager({
    ...baseConfig,
    ownershipQuery: () => Promise.resolve(null),
  }, deps);
  await assertRejects(
    () =>
      manager.serve(
        fakeCtx({ cid: "co_1", entityId: "ch_x", attachmentId: "cat_x" }),
        fakePostgres,
      ),
    AppError,
    "Charge",
  );
  // Ownership falhou → getAttachmentById NÃO foi chamado (anti-leak para
  // attachments cujo parent é privado/cross-tenant/inexistente).
  assertEquals(calls.get.length, 0);
});

Deno.test("manager.serve - getAttachmentById null → 404", async () => {
  const { deps } = trackingDeps({
    getAttachmentById: () => Promise.resolve(null),
  });
  const manager = makeAttachmentManager(baseConfig, deps);
  await assertRejects(
    () =>
      manager.serve(
        fakeCtx({ cid: "co_1", entityId: "ch_1", attachmentId: "cat_x" }),
        fakePostgres,
      ),
    AppError,
    "Anexo",
  );
});

Deno.test("manager.serve - sucesso devolve bytes + headers", async () => {
  const { deps, calls } = trackingDeps();
  const manager = makeAttachmentManager(baseConfig, deps);
  const res = await manager.serve(
    fakeCtx({ cid: "co_1", entityId: "ch_1", attachmentId: "cat_abc" }),
    fakePostgres,
  );
  assertEquals(res.status, 200);
  const body = new Uint8Array(await res.arrayBuffer());
  assertEquals(Array.from(body), [1, 2, 3, 4]);
  assertEquals((calls.headers[0] as { len: number }).len, 4);
});

Deno.test("manager.delete - softDeleteAttachment false → 404", async () => {
  const { deps } = trackingDeps({
    softDeleteAttachment: () => Promise.resolve(false),
  });
  const manager = makeAttachmentManager(baseConfig, deps);
  await assertRejects(
    () =>
      manager.delete(
        fakeCtx({ cid: "co_1", entityId: "ch_1", attachmentId: "cat_x" }),
        fakePostgres,
      ),
    AppError,
    "Anexo",
  );
});

Deno.test("manager.delete - sucesso devolve 204", async () => {
  const { deps, calls } = trackingDeps();
  const manager = makeAttachmentManager(baseConfig, deps);
  const res = await manager.delete(
    fakeCtx({ cid: "co_1", entityId: "ch_1", attachmentId: "cat_abc" }),
    fakePostgres,
  );
  assertEquals(res.status, 204);
  const delArg = calls.delete[0] as Record<string, unknown>;
  assertEquals(delArg.attachmentId, "cat_abc");
  assertEquals(delArg.entityType, "charge");
});

Deno.test("manager - entityType do config propaga (não há leak hardcoded)", async () => {
  const { deps, calls } = trackingDeps();
  const manager = makeAttachmentManager({
    ...baseConfig,
    entityType: "ticket",
    paramName: "ticketId",
    entityNamePT: "Ticket",
  }, deps);
  await manager.list(
    fakeCtx({ cid: "co_1", entityId: "tk_1", paramName: "ticketId" }),
    fakePostgres,
  );
  assertEquals((calls.list[0] as { entityType: string }).entityType, "ticket");
});

Deno.test("manager - paramName do config controla leitura do path", async () => {
  // Config com paramName custom - verifica que o manager NÃO assume "chargeId".
  const { deps, calls } = trackingDeps();
  const manager = makeAttachmentManager({
    ...baseConfig,
    paramName: "assemblyId",
    entityType: "assembly",
    entityNamePT: "Assembleia",
  }, deps);
  await manager.list(
    fakeCtx({ cid: "co_1", entityId: "as_1", paramName: "assemblyId" }),
    fakePostgres,
  );
  assertEquals((calls.list[0] as { entityId: string }).entityId, "as_1");
});

Deno.test("manager - serialize do config aplica ao output", async () => {
  const { deps } = trackingDeps();
  // Serialize que devolve shape diferente - confirma que o manager respeita.
  const manager = makeAttachmentManager({
    ...baseConfig,
    serialize: (a) => ({ customField: a.id, name: a.filename }),
  }, deps);
  const res = await manager.list(fakeCtx({ cid: "co_1", entityId: "ch_1" }), fakePostgres);
  const body = await res.json();
  assertEquals(body, { data: [{ customField: "cat_abc", name: "test.pdf" }] });
});
