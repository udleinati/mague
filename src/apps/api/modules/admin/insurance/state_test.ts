// Atomicidade da renovação, do undo e da aprovação. O fake abaixo recusa UPDATE
// e INSERT fora de `transaction()` e só "aplica" o que passou pelo commit - é
// assim que estes testes distinguem "correu numa transação" de "correu em dois
// passos soltos", que era o bug: se o UPDATE falhava a fração ficava com duas
// apólices ativas. DELETE fora de transação é registado em vez de recusado: o
// rollback da renovação documentada usa o delete canónico, que não é atómico.

import { assertEquals, assertInstanceOf, assertRejects } from "@std/assert";
import { AppError } from "$api/libs/error/app_error.ts";
import type { Postgres } from "$api/libs/postgres/postgres.ts";
import type { ActorSnapshot } from "$api/libs/postgres/schemas/_audit.ts";
import {
  approveInsurancePolicy,
  rejectInsurancePolicy,
  renewInsurancePolicy,
  undoRenewalInsurancePolicy,
} from "./state.ts";

const ACTOR: ActorSnapshot = { user_id: "u_admin", email: "admin@mague.pt" };
const TODAY = new Date();
const isoDay = (n: number) => new Date(TODAY.getTime() + n * 86_400_000).toISOString().slice(0, 10);

type Op = { kind: "update" | "insert" | "delete"; values: Record<string, unknown> };

interface FakeOptions {
  policy?: Record<string, unknown>;
  /**
   * Resposta de cada `findFirst`, pela ordem das chamadas - para os caminhos que
   * fazem mais do que o lookup inicial (a guarda de duplicação, o rollback).
   * Quando ausente, todas as chamadas devolvem `policy`.
   */
  findFirstSequence?: Array<Record<string, unknown> | undefined>;
  attachments?: Array<{ id: string }>;
  /** Linhas devolvidas por cada UPDATE, pela ordem em que acontecem (default 1). */
  updateRows?: number[];
  /** Linhas devolvidas pelo DELETE (default 1). */
  deleteRows?: number;
  failInsert?: boolean;
  /** `reject` é um UPDATE de uma linha só - atómico sem transação. */
  allowUpdateOutsideTx?: boolean;
}

function fakePostgres(opts: FakeOptions) {
  /** Operações que sobreviveram ao commit. Vazio = a transação voltou atrás. */
  const committed: Op[] = [];
  /** DELETEs fora de transação (o rollback da renovação documentada). */
  const deletedOutsideTx: Op[] = [];
  let updateCall = 0;
  let findFirstCall = 0;

  const outsideTx = (op: string) => () => {
    throw new Error(`${op} fora de transação - a operação tem de ser atómica`);
  };

  const findFirst = () =>
    Promise.resolve(
      opts.findFirstSequence ? opts.findFirstSequence[findFirstCall++] : opts.policy,
    );

  // deno-lint-ignore no-explicit-any
  const db: any = {
    query: {
      insurancePolicy: { findFirst },
      attachment: { findMany: () => Promise.resolve(opts.attachments ?? []) },
    },
    // Datas da nova vigência (o domínio delega o +1 ano ao PostgreSQL).
    execute: () => Promise.resolve([{ next_from: isoDay(0), next_to: isoDay(365) }]),
    update: opts.allowUpdateOutsideTx
      ? () => ({
        set: (values: Record<string, unknown>) => ({
          where: () => ({
            returning: () => {
              committed.push({ kind: "update", values });
              return Promise.resolve([{ id: "p_old", ...values }]);
            },
          }),
        }),
      })
      : outsideTx("UPDATE"),
    insert: outsideTx("INSERT"),
    delete: () => ({
      where: () => {
        deletedOutsideTx.push({ kind: "delete", values: {} });
        return Promise.resolve([]);
      },
    }),
  };

  // deno-lint-ignore no-explicit-any
  const tx = (staged: Op[]): any => ({
    query: db.query,
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          returning: () => {
            const rows = opts.updateRows?.[updateCall++] ?? 1;
            if (rows > 0) staged.push({ kind: "update", values });
            return Promise.resolve(
              Array.from({ length: rows }, () => ({ id: "p_old", ...values })),
            );
          },
        }),
      }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        returning: () => {
          if (opts.failInsert) return Promise.reject(new Error("INSERT rebentou"));
          staged.push({ kind: "insert", values });
          return Promise.resolve([{ id: "p_new", ...values }]);
        },
      }),
    }),
    delete: () => ({
      where: () => ({
        returning: () => {
          const rows = opts.deleteRows ?? 1;
          if (rows > 0) staged.push({ kind: "delete", values: {} });
          return Promise.resolve(Array.from({ length: rows }, () => ({ id: "p_new" })));
        },
      }),
    }),
  });

  const postgres = {
    // deno-lint-ignore no-explicit-any
    query: (fn: any) => Promise.resolve(fn(db)),
    // deno-lint-ignore no-explicit-any
    transaction: async (fn: any) => {
      const staged: Op[] = [];
      const result = await fn(tx(staged)); // se rejeitar, `staged` é descartado
      committed.push(...staged);
      return result;
    },
  } as unknown as Postgres;

  return { postgres, committed, deletedOutsideTx };
}

const apoliceAtiva = {
  id: "p_old",
  condominiumId: "c1",
  unitId: "u1",
  status: "active",
  validFrom: isoDay(-365),
  validTo: isoDay(30),
  policyNumber: "POL-1",
  insurer: "Fidelidade",
  coverageAmountCents: 100_000,
  presumedAt: null,
  renewedFromId: null,
};

// ─── renew ──────────────────────────────────────────────────────────────────

Deno.test("renew: supersede e insert acontecem os dois dentro da transação", async () => {
  const { postgres, committed } = fakePostgres({ policy: apoliceAtiva });
  const nova = await renewInsurancePolicy(postgres, {
    policyId: "p_old",
    condominiumId: "c1",
    actor: ACTOR,
  });
  assertEquals(committed.map((o) => o.kind), ["update", "insert"]);
  assertEquals(committed[0].values.status, "superseded");
  assertEquals(committed[1].values.status, "active");
  // Linhagem (ADR 0040) e presunção: a nova nasce sem evidência.
  assertEquals(committed[1].values.renewedFromId, "p_old");
  assertEquals(committed[1].values.presumedAt instanceof Date, true);
  assertEquals(nova.id, "p_new");
});

Deno.test("renew: falha no insert não deixa a antiga superseded (nunca duas ativas)", async () => {
  // O bug original: INSERT e UPDATE eram duas queries soltas. Com o insert a
  // falhar depois do supersede, a fração perdia a cobertura; com a ordem
  // inversa, ficava com duas ativas. Ambas impossíveis dentro da transação.
  const { postgres, committed } = fakePostgres({ policy: apoliceAtiva, failInsert: true });
  await assertRejects(() =>
    renewInsurancePolicy(postgres, {
      policyId: "p_old",
      condominiumId: "c1",
      actor: ACTOR,
    })
  );
  assertEquals(committed, []);
});

Deno.test("renew: duplo-clique - o segundo UPDATE não vê linhas e devolve 409", async () => {
  // Guard `status = 'active'` no WHERE: quem chega depois já não encontra a
  // apólice ativa e não cria uma segunda renovação.
  const { postgres, committed } = fakePostgres({ policy: apoliceAtiva, updateRows: [0] });
  const err = await assertRejects(
    () =>
      renewInsurancePolicy(postgres, {
        policyId: "p_old",
        condominiumId: "c1",
        actor: ACTOR,
      }),
    AppError,
  );
  assertEquals(err.statusCode, 409);
  assertEquals(committed, []);
});

// ─── renew com o documento entregue à administração ─────────────────────────
// WHY: o admin recebe a apólice por email e não tinha onde a pôr - o sistema
// pedia à condómina, por email automático, o papel que ele já tinha na mão. O
// que estes testes protegem é a diferença face à renovação presumida: a antiga
// NÃO é substituída aqui (senão a fração aparecia por cobrir enquanto a nova
// espera revisão) e a nova nasce marcada como documentada pela administração.

/** O upload real do ficheiro não corre em teste (S3): `uploadAttachment` recusa
 *  os bytes vazios antes de lá chegar. O que interessa verificar já foi escrito
 *  pela transação nessa altura - daí devolver o erro em vez de o propagar. */
function renovarComDocumento(
  postgres: Postgres,
  over: { dates?: { validFrom: string; validTo: string } } = {},
): Promise<Error | null> {
  return renewInsurancePolicy(postgres, {
    policyId: "p_old",
    condominiumId: "c1",
    actor: ACTOR,
    attachment: {
      bytes: new Uint8Array(),
      filename: "apolice.png",
      mimeType: "image/png", // não-PDF: salta o OCR e mantém o teste hermético
    },
    dates: { validFrom: isoDay(30), validTo: isoDay(395) },
    ...over,
  }).then(() => null, (e) => e as Error);
}

/** Lookups do caminho documentado, por ordem: a apólice a renovar, a guarda de
 *  duplicação, o anti-IDOR do anexo e os dois do rollback. */
const LOOKUPS_DO_CAMINHO_DOCUMENTADO = [
  apoliceAtiva,
  undefined,
  { id: "p_new" },
  { id: "p_new", status: "pending_review", uploadedBy: {} },
  undefined,
];

Deno.test("renew com documento: a antiga fica intacta e a nova nasce por rever", async () => {
  // D4: superseder já fazia a fração cair para `awaiting_approval` e o painel
  // dizia que estava por cobrir uma fração que está coberta. O supersede é do
  // approve.
  const { postgres, committed } = fakePostgres({
    policy: apoliceAtiva,
    findFirstSequence: LOOKUPS_DO_CAMINHO_DOCUMENTADO,
  });
  await renovarComDocumento(postgres);
  assertEquals(committed.map((o) => o.kind), ["insert"]);
  const nova = committed[0].values;
  assertEquals(nova.status, "pending_review");
  assertEquals(nova.evidenceSource, "admin");
  // Tem documento, logo não é presunção - e é o que impede o email de sair.
  assertEquals(nova.presumedAt, undefined);
  assertEquals(nova.renewedFromId, "p_old");
  // Ninguém confirmou nem aprovou ainda: isso acontece no approve.
  assertEquals(nova.confirmedAt, undefined);
  assertEquals(nova.approvedAt, undefined);
});

Deno.test("renew com documento: a vigência é a do modal, não a aritmética", async () => {
  // O admin tem o documento à frente; a renovação pode não ser de um ano certo.
  const { postgres, committed } = fakePostgres({
    policy: apoliceAtiva,
    findFirstSequence: LOOKUPS_DO_CAMINHO_DOCUMENTADO,
  });
  await renovarComDocumento(postgres, {
    dates: { validFrom: "2027-03-01", validTo: "2028-02-29" },
  });
  assertEquals(committed[0].values.validFrom, "2027-03-01");
  assertEquals(committed[0].values.validTo, "2028-02-29");
});

Deno.test("renew com documento: sem vigência → 422 e nada escrito", async () => {
  // Gravar datas que ninguém conferiu contra o papel é pior do que não gravar.
  const { postgres, committed } = fakePostgres({ policy: apoliceAtiva });
  const err = await renovarComDocumento(postgres, {
    dates: { validFrom: "", validTo: "" },
  });
  assertInstanceOf(err, AppError);
  assertEquals(err.statusCode, 422);
  assertEquals(committed, []);
});

Deno.test("renew com documento: fim antes do início → 422", async () => {
  const { postgres, committed } = fakePostgres({ policy: apoliceAtiva });
  const err = await renovarComDocumento(postgres, {
    dates: { validFrom: isoDay(395), validTo: isoDay(30) },
  });
  assertInstanceOf(err, AppError);
  assertEquals(err.statusCode, 422);
  assertEquals(committed, []);
});

Deno.test("renew com documento: segunda renovação por rever → 409", async () => {
  // Sem o supersede da antiga deixa de haver `WHERE status = 'active'` a
  // serializar o duplo-clique; esta guarda é o que sobra contra duas pendentes
  // sobre o mesmo predecessor.
  const { postgres, committed } = fakePostgres({
    policy: apoliceAtiva,
    findFirstSequence: [apoliceAtiva, { id: "p_pendente" }],
  });
  const err = await renovarComDocumento(postgres);
  assertInstanceOf(err, AppError);
  assertEquals(err.statusCode, 409);
  assertEquals(committed, []);
});

Deno.test("renew com documento: anexo falhado apaga a apólice que ficaria sem prova", async () => {
  // Uma linha marcada `evidence_source='admin'` sem ficheiro é uma mentira
  // gravada: o alarme de evidência cala-se e não há papel nenhum.
  const { postgres, committed, deletedOutsideTx } = fakePostgres({
    policy: apoliceAtiva,
    findFirstSequence: LOOKUPS_DO_CAMINHO_DOCUMENTADO,
  });
  const err = await renovarComDocumento(postgres);
  assertInstanceOf(err, AppError);
  assertEquals(committed.map((o) => o.kind), ["insert"]);
  assertEquals(deletedOutsideTx.length, 1);
});

// ─── approve ────────────────────────────────────────────────────────────────
// WHY: é o caminho partilhado com o portal. O gate da confirmação existe porque
// a fração submete e confirma antes de o admin aprovar; relaxá-lo a mais do que
// o documento da administração deixava aprovar submissões que ninguém conferiu.

const submissaoDoPortal = {
  id: "p_portal",
  condominiumId: "c1",
  unitId: "u1",
  status: "pending_review",
  evidenceSource: "unit",
  confirmedAt: null,
  renewedFromId: null,
};

Deno.test("approve: submissão do portal por confirmar continua a ser recusada", async () => {
  const { postgres, committed } = fakePostgres({ policy: submissaoDoPortal });
  const err = await assertRejects(
    () =>
      approveInsurancePolicy(postgres, {
        policyId: "p_portal",
        condominiumId: "c1",
        actor: ACTOR,
      }),
    AppError,
  );
  assertEquals(err.statusCode, 422);
  assertEquals(committed, []);
});

Deno.test("approve: documento da administração dispensa a confirmação da fração", async () => {
  // D3: o papel chegou ao admin por email, não há segundo interveniente. A
  // confirmação grava-se com o mesmo actor para a coluna não ficar sem
  // significado ("alguém verificou os dados").
  const { postgres, committed } = fakePostgres({
    policy: { ...submissaoDoPortal, evidenceSource: "admin" },
  });
  await approveInsurancePolicy(postgres, {
    policyId: "p_portal",
    condominiumId: "c1",
    actor: ACTOR,
  });
  assertEquals(committed.map((o) => o.kind), ["update"]);
  assertEquals(committed[0].values.status, "active");
  assertEquals(committed[0].values.confirmedAt instanceof Date, true);
  assertEquals(committed[0].values.approvedAt instanceof Date, true);
});

Deno.test("approve: reaprovar não reescreve a confirmação já existente", async () => {
  // Reabrir e voltar a aprovar não pode apagar quem confirmou os dados da
  // primeira vez.
  const original = new Date("2026-01-05T10:00:00Z");
  const { postgres, committed } = fakePostgres({
    policy: { ...submissaoDoPortal, evidenceSource: "admin", confirmedAt: original },
  });
  await approveInsurancePolicy(postgres, {
    policyId: "p_portal",
    condominiumId: "c1",
    actor: ACTOR,
  });
  assertEquals(committed[0].values.confirmedAt, undefined);
});

Deno.test("approve: sem predecessor não mexe em mais nenhuma apólice", async () => {
  const { postgres, committed } = fakePostgres({
    policy: { ...submissaoDoPortal, confirmedAt: new Date() },
  });
  await approveInsurancePolicy(postgres, {
    policyId: "p_portal",
    condominiumId: "c1",
    actor: ACTOR,
  });
  assertEquals(committed.length, 1);
});

Deno.test("approve de uma renovação: predecessor passa a superseded na mesma transação", async () => {
  // D4 fecha aqui: é neste momento, e não na renovação, que a antiga sai de
  // cena - com a nova a ficar ativa no mesmo commit, nunca há duas ativas nem
  // um intervalo sem nenhuma.
  const { postgres, committed } = fakePostgres({
    policy: {
      ...submissaoDoPortal,
      id: "p_new",
      evidenceSource: "admin",
      renewedFromId: "p_old",
    },
  });
  await approveInsurancePolicy(postgres, {
    policyId: "p_new",
    condominiumId: "c1",
    actor: ACTOR,
  });
  assertEquals(committed.map((o) => o.kind), ["update", "update"]);
  assertEquals(committed[0].values.status, "active");
  assertEquals(committed[1].values.status, "superseded");
  assertEquals(committed[1].values.supersededAt instanceof Date, true);
});

Deno.test("approve de uma renovação: predecessor já substituído não falha a aprovação", async () => {
  // A aprovação é o ato que interessa; o predecessor pode ter saído de `active`
  // por outro caminho (undo, reopen) e isso não é motivo para recusar.
  const { postgres, committed } = fakePostgres({
    policy: {
      ...submissaoDoPortal,
      id: "p_new",
      evidenceSource: "admin",
      renewedFromId: "p_old",
    },
    updateRows: [1, 0],
  });
  const aprovada = await approveInsurancePolicy(postgres, {
    policyId: "p_new",
    condominiumId: "c1",
    actor: ACTOR,
  });
  assertEquals(aprovada.status, "active");
  assertEquals(committed.map((o) => o.kind), ["update"]);
});

// ─── undo-renewal ───────────────────────────────────────────────────────────

const renovacaoPresumida = {
  ...apoliceAtiva,
  id: "p_new",
  status: "active",
  presumedAt: new Date("2026-07-01T00:00:00Z"),
  renewedFromId: "p_old",
};

Deno.test("undo: apaga a presumida e devolve o predecessor a active sem superseded_at", async () => {
  const { postgres, committed } = fakePostgres({ policy: renovacaoPresumida });
  await undoRenewalInsurancePolicy(postgres, {
    policyId: "p_new",
    condominiumId: "c1",
    actor: ACTOR,
  });
  assertEquals(committed.map((o) => o.kind), ["delete", "update"]);
  assertEquals(committed[1].values.status, "active");
  // `superseded_at` tem de ficar limpo, senão a apólice restaurada continua a
  // parecer arquivada nas vistas que olham para a data.
  assertEquals(committed[1].values.supersededAt, null);
});

Deno.test("undo: recusa quando a renovação já tem comprovativo (não apaga evidência)", async () => {
  const { postgres, committed } = fakePostgres({
    policy: renovacaoPresumida,
    attachments: [{ id: "ina_1" }],
  });
  const err = await assertRejects(
    () =>
      undoRenewalInsurancePolicy(postgres, {
        policyId: "p_new",
        condominiumId: "c1",
        actor: ACTOR,
      }),
    AppError,
  );
  assertEquals(err.statusCode, 422);
  assertEquals(committed, []);
});

Deno.test("undo: recusa uma apólice que não nasceu de renovação", async () => {
  const { postgres, committed } = fakePostgres({
    policy: { ...renovacaoPresumida, renewedFromId: null },
  });
  const err = await assertRejects(
    () =>
      undoRenewalInsurancePolicy(postgres, {
        policyId: "p_new",
        condominiumId: "c1",
        actor: ACTOR,
      }),
    AppError,
  );
  assertEquals(err.statusCode, 422);
  assertEquals(committed, []);
});

Deno.test("undo: predecessor já não substituído → 409 e a presumida sobrevive", async () => {
  // Cenário de corrida: alguém reabriu ou renovou o predecessor entretanto. O
  // DELETE já tinha corrido, mas a transação volta atrás com ele.
  const { postgres, committed } = fakePostgres({
    policy: renovacaoPresumida,
    updateRows: [0],
  });
  const err = await assertRejects(
    () =>
      undoRenewalInsurancePolicy(postgres, {
        policyId: "p_new",
        condominiumId: "c1",
        actor: ACTOR,
      }),
    AppError,
  );
  assertEquals(err.statusCode, 409);
  assertEquals(committed, []);
});

Deno.test("undo: apólice inexistente → 404", async () => {
  const { postgres } = fakePostgres({ policy: undefined });
  const err = await assertRejects(
    () =>
      undoRenewalInsurancePolicy(postgres, {
        policyId: "p_x",
        condominiumId: "c1",
        actor: ACTOR,
      }),
    AppError,
  );
  assertEquals(err.statusCode, 404);
});

// ─── reject ──────────────────────────────────────────────────────────────────
// O `reject` não tinha gate nenhum: era um UPDATE directo com um 404 por baixo.
// Rejeitava uma apólice substituída (histórico fechado) ou uma já rejeitada, e
// nesse caso reescrevia `rejected_at`/`rejected_reason` por cima do original.

const rejeitar = (postgres: Postgres, policyId = "p_old") =>
  rejectInsurancePolicy(postgres, {
    policyId,
    condominiumId: "c1",
    reason: "PDF ilegível",
    actor: ACTOR,
  });

Deno.test("reject: pending_review é o fluxo normal (ADR 0016)", async () => {
  const { postgres, committed } = fakePostgres({
    policy: { ...apoliceAtiva, status: "pending_review" },
    allowUpdateOutsideTx: true,
  });
  await rejeitar(postgres);
  assertEquals(committed.length, 1);
  assertEquals(committed[0].values.status, "rejected");
});

Deno.test("reject: uma apólice ativa é rejeitável - é o 'rejeitar primeiro' do ADR 0040", async () => {
  // Sem isto o admin não teria caminho para apagar cobertura viva saudável, que
  // `canDeletePolicy` só permite depois de rejeitada.
  const { postgres, committed } = fakePostgres({
    policy: apoliceAtiva,
    allowUpdateOutsideTx: true,
  });
  await rejeitar(postgres);
  assertEquals(committed[0].values.status, "rejected");
});

Deno.test("reject: uma substituída é histórico e recusa-se (422, sem escrita)", async () => {
  const { postgres, committed } = fakePostgres({
    policy: { ...apoliceAtiva, status: "superseded" },
    allowUpdateOutsideTx: true,
  });
  const err = await assertRejects(() => rejeitar(postgres), AppError);
  assertEquals(err.statusCode, 422);
  assertEquals(committed, []);
});

Deno.test("reject: rejeitar outra vez não reescreve a rejeição original (422)", async () => {
  const { postgres, committed } = fakePostgres({
    policy: { ...apoliceAtiva, status: "rejected", rejectedReason: "razão original" },
    allowUpdateOutsideTx: true,
  });
  const err = await assertRejects(() => rejeitar(postgres), AppError);
  assertEquals(err.statusCode, 422);
  assertEquals(committed, []);
});

Deno.test("reject: apólice inexistente → 404", async () => {
  const { postgres } = fakePostgres({ policy: undefined, allowUpdateOutsideTx: true });
  const err = await assertRejects(() => rejeitar(postgres, "p_x"), AppError);
  assertEquals(err.statusCode, 404);
});
