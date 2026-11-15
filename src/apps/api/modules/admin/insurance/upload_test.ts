// O que `uploadInsurancePolicy` grava, agora que serve dois caminhos: o portal
// (a fração submete, o OCR sugere a vigência) e o documento entregue à
// administração (o admin tem o papel à frente e decide a vigência).
//
// O upload real do ficheiro não corre em teste (S3): `uploadAttachment` recusa
// os bytes vazios antes de lá chegar. O INSERT já aconteceu nessa altura, que é
// o que estes testes observam - daí engolir o erro em vez de o propagar. O que
// vem depois do anexo (a limpeza de drafts) fica fora do alcance deles.

import { assertEquals, assertInstanceOf } from "@std/assert";
import { AppError } from "$api/libs/error/app_error.ts";
import type { Postgres } from "$api/libs/postgres/postgres.ts";
import type { ActorSnapshot } from "$api/libs/postgres/schemas/_audit.ts";
import { requireCoverageDates, uploadInsurancePolicy } from "./upload.ts";
import { addOneYear } from "$shared/insurance/policy_status.ts";

const ACTOR: ActorSnapshot = { user_id: "u_admin", email: "admin@mague.pt" };

function fakePostgres() {
  const inserted: Record<string, unknown>[] = [];

  // deno-lint-ignore no-explicit-any
  const db: any = {
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        returning: () => {
          inserted.push(values);
          return Promise.resolve([{ id: "p_new", ...values }]);
        },
      }),
    }),
  };

  const postgres = {
    // deno-lint-ignore no-explicit-any
    query: (fn: any) => Promise.resolve(fn(db)),
  } as unknown as Postgres;

  return { postgres, inserted };
}

/** Mime não-PDF: salta o OCR e mantém o teste hermético (sem `extract_pdf`). */
function submeter(
  postgres: Postgres,
  args: {
    evidenceSource: "unit" | "admin";
    dates?: { validFrom: string; validTo: string };
  },
): Promise<Error | null> {
  return uploadInsurancePolicy(postgres, {
    condominiumId: "c1",
    unitId: "u1",
    bytes: new Uint8Array(),
    mimeType: "image/png",
    actor: ACTOR,
    ...args,
  }).then(() => null, (e) => e as Error);
}

Deno.test("upload: a marca de quem entregou a prova é a que o caminho escolheu", async () => {
  // A coluna existe para distinguir o comprovativo da fração do documento que
  // chegou à administração; herdar `unit` por default poria o badge a mentir e
  // deixava o `approve` a exigir uma confirmação que nunca vai existir.
  const portal = fakePostgres();
  await submeter(portal.postgres, { evidenceSource: "unit" });
  assertEquals(portal.inserted[0].evidenceSource, "unit");

  const admin = fakePostgres();
  await submeter(admin.postgres, {
    evidenceSource: "admin",
    dates: { validFrom: "2026-08-01", validTo: "2027-07-31" },
  });
  assertEquals(admin.inserted[0].evidenceSource, "admin");
});

Deno.test("upload: a vigência do formulário ganha ao OCR e à aritmética", async () => {
  // O admin tem o documento à frente e a apólice pode não ser de um ano certo -
  // gravar o +1 ano seria gravar o que ninguém conferiu contra o papel.
  const { postgres, inserted } = fakePostgres();
  await submeter(postgres, {
    evidenceSource: "admin",
    dates: { validFrom: "2027-03-01", validTo: "2028-02-29" },
  });
  assertEquals(inserted[0].validFrom, "2027-03-01");
  assertEquals(inserted[0].validTo, "2028-02-29");
  // E sem candidatos inventados em `ocr_extracted`: a vigência não saiu do
  // documento, não pode ficar lá como se tivesse saído.
  assertEquals(inserted[0].ocrExtracted, {});
});

Deno.test("upload: sem vigência decidida, o portal mantém a sugestão de +1 ano", async () => {
  // Caminho da fração: ninguém decidiu nada ainda e o formulário de confirmação
  // precisa de uma sugestão para ela corrigir. A parametrização não podia levar
  // este fallback à frente.
  const { postgres, inserted } = fakePostgres();
  await submeter(postgres, { evidenceSource: "unit" });
  const validFrom = inserted[0].validFrom as string;
  assertEquals(inserted[0].validTo, addOneYear(validFrom));
  assertEquals(
    (inserted[0].ocrExtracted as { candidatesValidUntil?: string[] }).candidatesValidUntil,
    [addOneYear(validFrom)],
  );
});

Deno.test("requireCoverageDates: sem datas → 422", () => {
  // Sem vigência não há o que gravar - a apólice diria estar em vigor num
  // intervalo que ninguém indicou.
  const err = (() => {
    try {
      requireCoverageDates(undefined);
    } catch (e) {
      return e;
    }
  })();
  assertInstanceOf(err, AppError);
  assertEquals(err.statusCode, 422);
});

Deno.test("requireCoverageDates: fim antes do início → 422; iguais passam", () => {
  const err = (() => {
    try {
      requireCoverageDates({ validFrom: "2027-01-01", validTo: "2026-12-31" });
    } catch (e) {
      return e;
    }
  })();
  assertInstanceOf(err, AppError);
  assertEquals(err.statusCode, 422);
  // Um dia só é vigência válida (mesma regra do `confirm` do portal).
  assertEquals(
    requireCoverageDates({ validFrom: "2027-01-01", validTo: "2027-01-01" }),
    { validFrom: "2027-01-01", validTo: "2027-01-01" },
  );
});
