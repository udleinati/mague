// Contrato da caixa de resposta do portal (`pages/portal/ticket_show.vto`).
// O template TEM de espelhar os gates da API - form visível onde o POST passa,
// escondido onde daria 404/422; caso contrário o condómino escreve e perde o
// texto. Renderiza sem BD/API (mesmo padrão de page_header_test.ts).

import { assert, assertStringIncludes } from "@std/assert";
import { render } from "./render.ts";

const PAGE = "pages/portal/ticket_show.vto";

const BASE = {
  title: "Ocorrência T001",
  section: "tickets",
  condominium: { name: "Edifício Central" },
  unit: { id: "u1", designation: "1ºA" },
  currentPortalUnitId: "u1",
  currentCondominiumId: "c1",
  categoryLabels: { other: "Outros" },
  priorityLabels: { normal: "Normal" },
  statusLabels: {
    open: "Aberto",
    in_progress: "Em progresso",
    resolved: "Resolvido",
    closed: "Fechado",
  },
};

function ticket(over: Record<string, unknown> = {}) {
  return {
    id: "t1",
    code: "T001",
    title: "Elevador parado",
    status: "in_progress",
    priority: "normal",
    category: "other",
    visibility: "admin_unit",
    location: null,
    description: null,
    attachments: [],
    comments: [],
    createdAt: "2026-07-01T00:00:00Z",
    resolvedAt: null,
    resolutionNotes: null,
    isVisitor: false,
    ...over,
  };
}

Deno.test("resposta disponível em in_progress (a conversa vive depois de o admin pegar)", async () => {
  const html = await render(PAGE, { ...BASE, ticket: ticket() });
  assertStringIncludes(html, "Enviar mensagem");
  assertStringIncludes(html, "/portal/c/c1/u/u1/tickets/t1/comments");
});

Deno.test("estado final fecha a conversa e explica porquê", async () => {
  const html = await render(PAGE, { ...BASE, ticket: ticket({ status: "closed" }) });
  assert(!html.includes("Enviar mensagem"), "ocorrência fechada não aceita comentários");
  assertStringIncludes(html, "já não aceita novas mensagens");
});

Deno.test("visibilidade public: sem form (a API só deixa mutar admin_unit)", async () => {
  const html = await render(PAGE, {
    ...BASE,
    ticket: ticket({ visibility: "public", status: "open" }),
  });
  assert(!html.includes("Enviar mensagem"), "form aqui daria 404 no POST");
  // E não pode alegar que está fechada - está aberta, só não é conversável.
  assert(!html.includes("já não aceita novas mensagens"));
});

Deno.test("visitante de outra fração nunca vê o form", async () => {
  const html = await render(PAGE, { ...BASE, ticket: ticket({ isVisitor: true }) });
  assert(!html.includes("Enviar mensagem"));
});

Deno.test("histórico distingue autoria - 'Eu' vs 'Administração'", async () => {
  const html = await render(PAGE, {
    ...BASE,
    currentUser: { id: "user1" },
    ticket: ticket({
      comments: [
        {
          id: "c1",
          comment: "Continua sem funcionar.",
          submittedBy: { userId: "user1", email: "maria@x.pt" },
          createdAt: "2026-07-02T00:00:00Z",
          statusFrom: null,
          statusTo: null,
        },
        {
          id: "c2",
          comment: "Técnico marcado.",
          submittedBy: { userId: "admin9", email: "admin@x.pt" },
          createdAt: "2026-07-03T00:00:00Z",
          statusFrom: null,
          statusTo: null,
        },
      ],
    }),
  });
  assertStringIncludes(html, ">Eu<");
  assertStringIncludes(html, ">Administração<");
});
