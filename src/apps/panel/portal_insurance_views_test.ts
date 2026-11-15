// Smoke tests de render do portal de seguros (condómino): o caminho do
// comprovativo da renovação presumida. Sem BD/API - render puro com mocks
// (mesmo harness do insurance_views_test). Intenção: a presumida tem de dar
// ao condómino uma forma de enviar o comprovativo com gate visual, e nunca a
// armadilha "Submeter renovação" (que criava apólice nova a sobrepor).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { render } from "./render.ts";
import {
  classifyPolicy,
  OCCUPANT_NOTICE_DAYS,
  policyCapabilities,
} from "$shared/insurance/policy_status.ts";
import { groupByRenewalChain } from "./controllers/portal_insurance.ts";

/** O histórico recebe cadeias, não apólices soltas - mesma função do controller. */
const chainsOf = (...ps: Array<Record<string, unknown>>) =>
  groupByRenewalChain(ps as unknown as Parameters<typeof groupByRenewalChain>[0]);

const TODAY = new Date("2026-03-01T00:00:00Z");

const common = {
  currentCondominiumId: "c1",
  currentPortalUnitId: "u1",
  condominium: { name: "Cond X", designationType: "condominium" },
  unit: { designation: "1ºE" },
  currentUser: { name: "Ana", role: "occupant" },
};

// `kind` + `can.*` pelos mesmos predicados que a API projeta (gate do condómino:
// é o próprio uploader) - os templates do portal já só consultam `kind`/`can`.
const policy = (over: Record<string, unknown> = {}) => {
  const base = {
    id: "p1",
    status: "active",
    validFrom: "2026-03-01",
    validTo: "2027-03-01",
    policyNumber: "POL-1",
    insurer: "Fidelidade",
    coverageAmountCents: null,
    createdAt: "2026-03-01T00:00:00Z",
    confirmedAt: "2026-03-01T00:00:00Z",
    approvedAt: "2026-03-01T00:00:00Z",
    rejectedAt: null,
    rejectedReason: null,
    presumedAt: null,
    supersededAt: null,
    ...over,
  };
  return {
    ...base,
    kind: classifyPolicy(base, TODAY, { expiringSoonDays: OCCUPANT_NOTICE_DAYS }).kind,
    can: policyCapabilities(base, TODAY, { isAdmin: false, isOwnUpload: true }),
  };
};

// ─── show.vto: formulário do comprovativo ────────────────────────────────────

Deno.test("portal show: presumida sem ficheiro mostra o form de comprovativo com gate", async () => {
  // A presumida (active + presumedAt) é o único sítio onde o condómino não pode
  // apagar depois; logo o envio TEM de ter revisão visual antes de sair do
  // browser. O form existe, volta ao detalhe e tem o gate de confirmação.
  const html = await render("pages/portal/insurance/show.vto", {
    ...common,
    policy: policy({ presumedAt: "2026-03-01T00:00:00Z" }),
    attachments: [],
  });
  assertStringIncludes(html, 'id="comprovativo-form"');
  assertStringIncludes(html, "/insurances/p1/attachments?return=detail");
  assertStringIncludes(html, "Confirmar e enviar");
  // Gate: preview client-side + checkbox "revi e confirmo".
  assertStringIncludes(html, "URL.createObjectURL");
  assertStringIncludes(html, "data-comprovativo-confirm");
  // HEIC cortado de propósito (browsers não-Safari não o pré-visualizam).
  assert(!/accept="[^"]*heic/.test(html));
});

Deno.test("portal show: ativa documentada (sem presumedAt) NÃO mostra o form", async () => {
  // Numa ativa normal o comprovativo já existe; oferecer upload aqui seria
  // confuso e add-only sem reversão. Só a presumida abre o caminho.
  const html = await render("pages/portal/insurance/show.vto", {
    ...common,
    policy: policy({ presumedAt: null }),
    attachments: [],
  });
  assert(!html.includes('id="comprovativo-form"'));
});

Deno.test("portal show: presumida JÁ com ficheiro NÃO mostra o form (envio único)", async () => {
  // Gate `attachments.length === 0`: enviado o comprovativo, fecha o form (não
  // pode apagar; se for o errado, o admin remove e o form reaparece).
  const html = await render("pages/portal/insurance/show.vto", {
    ...common,
    policy: policy({ presumedAt: "2026-03-01T00:00:00Z" }),
    attachments: [{ id: "a1", filename: "recibo.pdf", mimeType: "application/pdf" }],
  });
  assert(!html.includes('id="comprovativo-form"'));
});

// ─── index.vto: o herói não pode ser a armadilha "Submeter renovação" ─────────

Deno.test("portal index: presumida mostra 'Enviar comprovativo' e não 'Submeter renovação'", async () => {
  // Após renovar, o email manda o condómino para o index. O CTA não pode ser
  // "Submeter renovação" (cria apólice nova a sobrepor a presumida); tem de o
  // levar ao detalhe para enviar o comprovativo.
  const p = policy({ presumedAt: "2026-03-01T00:00:00Z" });
  const html = await render("pages/portal/insurance/index.vto", {
    ...common,
    status: { unit: { id: "u1" }, status: { kind: "active", policy: p, daysUntilExpiry: 300 } },
    chains: chainsOf(p),
  });
  assertStringIncludes(html, "Enviar comprovativo");
  assertStringIncludes(html, "falta o comprovativo");
  assert(!html.includes("Renovar apólice"));
});

Deno.test("portal index: ativa documentada aponta à renovação com herança", async () => {
  // Sem presumedAt, o CTA leva ao formulário que herda os dados desta apólice
  // (e não à submissão de raiz, que pediria tudo outra vez).
  const p = policy({ presumedAt: null });
  const html = await render("pages/portal/insurance/index.vto", {
    ...common,
    status: { unit: { id: "u1" }, status: { kind: "active", policy: p, daysUntilExpiry: 300 } },
    chains: chainsOf(p),
  });
  assertStringIncludes(html, "Renovar apólice");
  assertStringIncludes(html, "/insurances/" + p.id + "/renew");
  assert(!html.includes("Enviar comprovativo"));
});

// ─── Badges do histórico: `kind` computado, não o `status` cru ────────────────

Deno.test("portal index: apólice vencida aparece como 'Vencida', não 'Ativa'", async () => {
  // WHY: `status` continua "active" na BD depois de passar a validade. O
  // histórico rotulava-a "Ativa" e dizia ao condómino que estava coberto.
  const vencida = policy({ validFrom: "2024-01-01", validTo: "2025-01-01" });
  const html = await render("pages/portal/insurance/index.vto", {
    ...common,
    status: { unit: { id: "u1" }, status: { kind: "expired", policy: vencida, daysOverdue: 425 } },
    chains: chainsOf(vencida),
  });
  assertStringIncludes(html, "Vencida");
  assert(!/>\s*Ativa\s*</.test(html));
});

Deno.test("portal show: detalhe de apólice vencida rotula 'Vencida'", async () => {
  const html = await render("pages/portal/insurance/show.vto", {
    ...common,
    policy: policy({ validFrom: "2024-01-01", validTo: "2025-01-01" }),
    attachments: [],
  });
  assertStringIncludes(html, "Vencida");
  assert(!/>\s*Ativa\s*</.test(html));
});

Deno.test("portal show: presumida vencida NÃO oferece o form (a API recusaria com 422)", async () => {
  // `canAddAttachment` bloqueia vencida/substituída. O template usava
  // `status === "active"`, que inclui as vencidas, e oferecia um upload morto.
  const html = await render("pages/portal/insurance/show.vto", {
    ...common,
    policy: policy({
      validFrom: "2024-01-01",
      validTo: "2025-01-01",
      presumedAt: "2024-01-01T00:00:00Z",
    }),
    attachments: [],
  });
  assert(!html.includes('id="comprovativo-form"'));
});

// ─── Linhagem no portal (B5) ─────────────────────────────────────────────────
// WHY: sem agrupar, três renovações da mesma apólice apareciam como três
// submissões independentes; o condómino não via que era a mesma cobertura a
// continuar, nem de onde vinha a vigência atual.

Deno.test("portal index: cadeia de renovações agrupa as vigências anteriores", async () => {
  const antiga = policy({
    id: "p1",
    validFrom: "2024-03-01",
    validTo: "2025-03-01",
    status: "superseded",
    policyNumber: "POL-2024",
  });
  const atual = policy({ id: "p2", renewedFromId: "p1" });
  const html = await render("pages/portal/insurance/index.vto", {
    ...common,
    status: { unit: { id: "u1" }, status: { kind: "active", policy: atual, daysUntilExpiry: 300 } },
    chains: chainsOf(atual, antiga),
  });
  // Uma entrada de topo (a atual) com a anterior agrupada por baixo.
  assertStringIncludes(html, "1 vigência anterior desta apólice");
  assertStringIncludes(html, "POL-2024");
  assertEquals(html.split("Histórico de submissões").length, 2);
});

Deno.test("portal show: detalhe diz de que apólice veio esta renovação", async () => {
  const html = await render("pages/portal/insurance/show.vto", {
    ...common,
    policy: {
      ...policy({ id: "p2", presumedAt: "2026-03-01T00:00:00Z" }),
      renewedFrom: {
        id: "p1",
        policyNumber: "POL-2024",
        validFrom: "2024-03-01",
        validTo: "2025-03-01",
      },
    },
    attachments: [],
  });
  assertStringIncludes(html, "Renovação de");
  assertStringIncludes(html, "POL-2024");
  assertStringIncludes(html, "/insurances/p1");
});

Deno.test("portal show: apólice submetida de raiz não mostra linhagem", async () => {
  const html = await render("pages/portal/insurance/show.vto", {
    ...common,
    policy: policy({ id: "p1" }),
    attachments: [],
  });
  assert(!html.includes("Renovação de"));
});

// ─── renew.vto: renovação entregue pela fração (ADR 0016) ────────────────────

Deno.test("portal renew: o form nasce com os dados do predecessor e as datas a avançar", async () => {
  // O passo é único (o form É a confirmação), por isso o condómino tem de ver
  // já preenchido o que a nova apólice vai herdar - e poder corrigi-lo.
  const html = await render("pages/portal/insurance/renew.vto", {
    ...common,
    policy: policy({ policyNumber: "POL-1", insurer: "Fidelidade", coverageAmountCents: 5000000 }),
    renewFrom: "2027-03-01",
    renewTo: "2028-03-01",
  });
  assertStringIncludes(html, 'name="validFrom" required value="2027-03-01"');
  assertStringIncludes(html, 'name="validTo" required value="2028-03-01"');
  assertStringIncludes(html, 'value="POL-1"');
  assertStringIncludes(html, 'value="Fidelidade"');
  // Euros no input (mesma forma do confirm.vto), nunca os cêntimos crus: o
  // controller relê-o com parseEurosToCents, logo 5000000 tem de sair 50000.
  assertStringIncludes(html, 'name="coverageAmountEuros" inputmode="decimal" placeholder="0,00"');
  assertStringIncludes(html, 'value="50000"');
  assert(!html.includes('value="5000000"'), "o input não pode levar cêntimos crus");
});

Deno.test("portal renew: os campos herdados são assinalados como copiados, não verificados", async () => {
  // Sem OCR, o contrapeso ao arrasto de dados velhos é humano: quem submete
  // tem de saber que aquilo veio do ano anterior e não do documento.
  const html = await render("pages/portal/insurance/renew.vto", {
    ...common,
    policy: policy({ policyNumber: "POL-1" }),
    renewFrom: "2027-03-01",
    renewTo: "2028-03-01",
  });
  assertStringIncludes(html, "copiados da apólice atual");
});

Deno.test("portal renew: o recibo é obrigatório - submeter fica bloqueado sem ficheiro", async () => {
  // Presumir sem prova é do admin (400 na API). O botão nasce disabled e é o
  // dropzone que o liberta; sem isto o condómino batia no erro do servidor.
  const html = await render("pages/portal/insurance/renew.vto", {
    ...common,
    policy: policy(),
    renewFrom: "2027-03-01",
    renewTo: "2028-03-01",
  });
  assertStringIncludes(html, 'enctype="multipart/form-data"');
  assertStringIncludes(html, "data-upload-submit disabled");
  assertStringIncludes(html, 'name="file"');
});
