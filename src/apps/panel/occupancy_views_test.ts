// Smoke tests de render: uma associação com data de fim tem de continuar
// visível e alcançável no Panel. Um filtro binário `!endDate` faria o
// ocupante desaparecer de todas as vistas no ato de gravar a data - a mesma
// leitura que "foi removido". Sem BD/API - render puro com dados mock.

import { assertStringIncludes } from "@std/assert";
import { render } from "./render.ts";

const occupancy = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "uo1",
  unitOccupantId: "uo1",
  occupantId: "o1",
  relationshipType: "owner",
  startDate: "2025-01-01",
  endDate: null,
  occupant: { id: "o1", name: "Ana Saiu", email: null, phone: null },
  ...over,
});

const unitShowData = (over: Partial<Record<string, unknown>> = {}) => ({
  currentCondominiumId: "c1",
  currentUser: { role: "super" },
  condominium: { reconciledThroughDate: "2026-05-20" },
  unitId: "u1",
  unit: {
    designation: "A",
    isActive: true,
    identifier: null,
    unitType: "residential",
    permillage: 1000,
    block: null,
    floor: null,
    door: null,
    description: null,
    occupants: [],
  },
  activeOccupants: [],
  pastOccupants: [],
  charges: [],
  bankBreakdown: [],
  insuranceStatus: null,
  insurancePolicies: [],
  unitEmails: [],
  activePaymentPlan: null,
  paymentPlanHistory: [],
  activePaymentPlanExpired: false,
  stats: {
    overdueCents: 0,
    futureDebtCents: 0,
    creditBalanceCents: 0,
    chargesCount: 0,
    settlementsCount: 0,
    bankBreakdownCount: 0,
  },
  ...over,
});

Deno.test("units/show: ocupante com saída já efetiva aparece em 'anteriores'", async () => {
  const html = await render(
    "pages/units/show.vto",
    unitShowData({ pastOccupants: [occupancy({ endDate: "2026-07-15" })] }),
  );
  assertStringIncludes(html, "Ocupantes anteriores");
  assertStringIncludes(html, "Ana Saiu");
});

Deno.test("units/show: saída marcada para o futuro fica nos ativos, com a data à vista", async () => {
  const html = await render(
    "pages/units/show.vto",
    unitShowData({
      activeOccupants: [
        occupancy({ occupant: { id: "o2", name: "Rui Sai Depois" }, endDate: "2026-12-31" }),
      ],
    }),
  );
  assertStringIncludes(html, "Rui Sai Depois");
  assertStringIncludes(html, "sai a 31/12/2026");
});

Deno.test("occupants/show: associação terminada continua editável (modal presente)", async () => {
  const html = await render("pages/occupants/show.vto", {
    currentCondominiumId: "c1",
    currentUser: { role: "super" },
    occupant: {
      occupantId: "o1",
      occupantName: "Ana Saiu",
      occupantData: { id: "o1", name: "Ana Saiu", email: null, nif: null, phone: null },
      units: [],
      pastUnits: [{
        unit: { id: "u1", designation: "A", identifier: null, permillage: 1000 },
        unitOccupantId: "uo1",
        relationshipType: "owner",
        startDate: "2025-01-01",
        endDate: "2026-07-15",
      }],
    },
    availableUnits: [],
    occupantEmails: [],
  });
  assertStringIncludes(html, "Associações anteriores");
  // O modal de edição tem de existir para a linha terminada - é por aqui que
  // se limpa a data de fim quando foi gravada por engano.
  assertStringIncludes(html, 'id="modal_uo_uo1"');
});
