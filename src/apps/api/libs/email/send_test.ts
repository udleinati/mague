// Tests do `sendEmail` - pinning a regra de negócio do auto-resolve de BCC +
// Reply-To: undefined resolve do condominium, null suprime, string usa direto.
// password_reset ignora ambos sempre (system email).

import { assertEquals } from "@std/assert";
import { type EmailMessage, sendEmail } from "./send.ts";
import { resetEmailTransport, setEmailTransport } from "./transport.ts";
import type { Postgres } from "$api/libs/postgres/postgres.ts";

// Capture transport - guarda a última message enviada para asserts.
function captureTransport() {
  let last: EmailMessage | null = null;
  setEmailTransport({
    // deno-lint-ignore require-await
    send: async (msg) => {
      last = msg;
    },
  });
  return {
    last: () => last,
    cleanup: () => resetEmailTransport(),
  };
}

// Fake postgres: distingue o lookup do condominium (devolve `condoRow`) do
// INSERT em audit.email_log (no-op), as 2 queries que `sendEmail` faz.
interface FakePg {
  pg: Postgres;
  lookupHits: () => number;
  lastInsert: () => Record<string, unknown> | null;
}

function fakePostgres(
  condoRow: { bccEmail: string | null; replyToEmail: string | null } | null,
): FakePg {
  let lookupHits = 0;
  let lastInsert: Record<string, unknown> | null = null;
  // deno-lint-ignore no-explicit-any
  const fakeDb: any = {
    query: {
      condominium: {
        findFirst: () => {
          lookupHits++;
          return Promise.resolve(condoRow);
        },
      },
    },
    // INSERT em audit.email_log - captura o payload de `.values()` para asserts.
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        lastInsert = v;
        return Promise.resolve();
      },
    }),
  };
  const pg = {
    // deno-lint-ignore no-explicit-any
    query: <T>(fn: (db: any) => Promise<T>): Promise<T> => fn(fakeDb),
  } as unknown as Postgres;
  return { pg, lookupHits: () => lookupHits, lastInsert: () => lastInsert };
}

// Helper para tests que só precisam do Postgres handle (não da contagem).
const pgOf = (
  row: { bccEmail: string | null; replyToEmail: string | null } | null,
): Postgres => fakePostgres(row).pg;

const baseParams = {
  to: "alice@test.pt",
  subject: "Test",
  html: "<p>hi</p>",
  category: "invite" as const,
};

// ─── Auto-resolve do condominium ───────────────────────────────────────

Deno.test("bcc=undefined + condominiumId + postgres → resolve do condo", async () => {
  const cap = captureTransport();
  try {
    await sendEmail({
      ...baseParams,
      condominiumId: "c1",
      postgres: pgOf({ bccEmail: "copia@condo.pt", replyToEmail: null }),
    });
    assertEquals(cap.last()?.bcc, "copia@condo.pt");
  } finally {
    cap.cleanup();
  }
});

Deno.test("replyTo=undefined + condominiumId + postgres → resolve do condo", async () => {
  const cap = captureTransport();
  try {
    await sendEmail({
      ...baseParams,
      condominiumId: "c1",
      postgres: pgOf({ bccEmail: null, replyToEmail: "admin@condo.pt" }),
    });
    assertEquals(cap.last()?.replyTo, "admin@condo.pt");
  } finally {
    cap.cleanup();
  }
});

Deno.test("ambos undefined → ambos resolvem do condo numa só lookup", async () => {
  const cap = captureTransport();
  const fp = fakePostgres({ bccEmail: "b@x.pt", replyToEmail: "r@x.pt" });
  try {
    await sendEmail({ ...baseParams, condominiumId: "c1", postgres: fp.pg });
    assertEquals(cap.last()?.bcc, "b@x.pt");
    assertEquals(cap.last()?.replyTo, "r@x.pt");
    // 1 lookup partilhado para os 2 fields - não 2.
    assertEquals(fp.lookupHits(), 1);
  } finally {
    cap.cleanup();
  }
});

// ─── Override explícito ─────────────────────────────────────────────────

Deno.test("bcc='string' explícito → usa direto, sem tocar na DB", async () => {
  const cap = captureTransport();
  const fp = fakePostgres({ bccEmail: "from_db@x.pt", replyToEmail: null });
  try {
    await sendEmail({
      ...baseParams,
      condominiumId: "c1",
      postgres: fp.pg,
      bcc: "explicit@x.pt",
      replyTo: null, // também explicit (suprime), evita lookup
    });
    assertEquals(cap.last()?.bcc, "explicit@x.pt");
    assertEquals(fp.lookupHits(), 0, "Caller passou ambos explícitos - sem DB lookup");
  } finally {
    cap.cleanup();
  }
});

Deno.test("bcc=null explícito → suprime (não usa do condo mesmo havendo)", async () => {
  const cap = captureTransport();
  try {
    await sendEmail({
      ...baseParams,
      condominiumId: "c1",
      postgres: pgOf({ bccEmail: "from_db@x.pt", replyToEmail: null }),
      bcc: null,
    });
    assertEquals(cap.last()?.bcc, null);
  } finally {
    cap.cleanup();
  }
});

Deno.test("um explícito, outro undefined → resolve só o em falta (1 query)", async () => {
  const cap = captureTransport();
  const fp = fakePostgres({
    bccEmail: "from_db_bcc@x.pt",
    replyToEmail: "from_db_reply@x.pt",
  });
  try {
    await sendEmail({
      ...baseParams,
      condominiumId: "c1",
      postgres: fp.pg,
      bcc: "explicit@x.pt", // bcc explícito
      // replyTo: undefined → resolve
    });
    assertEquals(cap.last()?.bcc, "explicit@x.pt"); // explicit wins
    assertEquals(cap.last()?.replyTo, "from_db_reply@x.pt"); // resolved
    assertEquals(fp.lookupHits(), 1, "1 lookup mesmo só precisando de 1 dos campos");
  } finally {
    cap.cleanup();
  }
});

// ─── occupant_id no audit log ──────────────────────────────────────────

Deno.test("occupantId propaga para o audit.email_log (chave estável do destinatário)", async () => {
  const cap = captureTransport();
  const fp = fakePostgres(null);
  try {
    await sendEmail({
      ...baseParams,
      condominiumId: "c1",
      unitId: "u1",
      occupantId: "occ_42",
      postgres: fp.pg,
    });
    assertEquals(fp.lastInsert()?.occupantId, "occ_42");
    assertEquals(fp.lastInsert()?.unitId, "u1");
  } finally {
    cap.cleanup();
  }
});

Deno.test("sem occupantId → audit.email_log grava occupant_id null (não undefined)", async () => {
  const cap = captureTransport();
  const fp = fakePostgres(null);
  try {
    await sendEmail({ ...baseParams, condominiumId: "c1", postgres: fp.pg });
    assertEquals(fp.lastInsert()?.occupantId, null);
  } finally {
    cap.cleanup();
  }
});

// ─── Corpo + anexos no audit log ───────────────────────────────────────

Deno.test("audit.email_log grava o corpo HTML enviado", async () => {
  const cap = captureTransport();
  const fp = fakePostgres(null);
  try {
    await sendEmail({
      ...baseParams,
      html: "<p>recibo</p>",
      condominiumId: "c1",
      postgres: fp.pg,
    });
    assertEquals(fp.lastInsert()?.bodyHtml, "<p>recibo</p>");
  } finally {
    cap.cleanup();
  }
});

Deno.test("audit.email_log grava só nome+tipo dos anexos (nunca o conteúdo)", async () => {
  const cap = captureTransport();
  const fp = fakePostgres(null);
  try {
    await sendEmail({
      ...baseParams,
      condominiumId: "c1",
      postgres: fp.pg,
      attachments: [
        {
          filename: "recibo.pdf",
          content: new Uint8Array([1, 2, 3]),
          contentType: "application/pdf",
        },
      ],
    });
    assertEquals(fp.lastInsert()?.attachments, [
      { filename: "recibo.pdf", contentType: "application/pdf" },
    ]);
  } finally {
    cap.cleanup();
  }
});

Deno.test("audit.email_log sem anexos grava attachments null (não undefined)", async () => {
  const cap = captureTransport();
  const fp = fakePostgres(null);
  try {
    await sendEmail({ ...baseParams, condominiumId: "c1", postgres: fp.pg });
    assertEquals(fp.lastInsert()?.attachments, null);
  } finally {
    cap.cleanup();
  }
});

// ─── Categoria password_reset ──────────────────────────────────────────

Deno.test("password_reset: nunca aplica BCC nem Reply-To, mesmo com condominiumId", async () => {
  const cap = captureTransport();
  try {
    await sendEmail({
      ...baseParams,
      category: "password_reset",
      condominiumId: "c1",
      postgres: pgOf({ bccEmail: "leak@x.pt", replyToEmail: "leak@x.pt" }),
      bcc: "should_be_ignored@x.pt", // nem mesmo override explícito passa
      replyTo: "should_be_ignored@x.pt",
    });
    assertEquals(cap.last()?.bcc, null);
    assertEquals(cap.last()?.replyTo, null);
  } finally {
    cap.cleanup();
  }
});

// ─── Sem condominiumId / postgres ──────────────────────────────────────

Deno.test("sem condominiumId → não tenta lookup, valores default null", async () => {
  const cap = captureTransport();
  try {
    await sendEmail({ ...baseParams }); // só `to/subject/html/category`
    assertEquals(cap.last()?.bcc, null);
    assertEquals(cap.last()?.replyTo, null);
  } finally {
    cap.cleanup();
  }
});

Deno.test("sem postgres → não tenta lookup, valores default null", async () => {
  const cap = captureTransport();
  try {
    await sendEmail({ ...baseParams, condominiumId: "c1" }); // sem postgres
    assertEquals(cap.last()?.bcc, null);
    assertEquals(cap.last()?.replyTo, null);
  } finally {
    cap.cleanup();
  }
});

// ─── Sanitização CRLF nos valores resolvidos ───────────────────────────

Deno.test("valores do condo passam por sanitização CRLF", async () => {
  const cap = captureTransport();
  try {
    await sendEmail({
      ...baseParams,
      condominiumId: "c1",
      postgres: pgOf({ bccEmail: "x@y.pt\r\nBcc: leak@x.pt", replyToEmail: null }),
    });
    // Newlines removidas (defesa header injection).
    assertEquals(cap.last()?.bcc?.includes("\n"), false);
    assertEquals(cap.last()?.bcc?.includes("\r"), false);
  } finally {
    cap.cleanup();
  }
});
