// adminNav para testes de views: fora de um pedido não há cid no ALS e o render injeta null.
import { buildAdminNav } from "./nav.ts";

export const testAdminNav = buildAdminNav({
  cid: "c1",
  activeSection: null,
  inspectionAlertCount: 0,
  availableCondominiums: [],
  occupantUnits: [],
});
