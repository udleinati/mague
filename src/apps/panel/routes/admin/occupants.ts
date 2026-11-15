// Routes /admin/c/:cid/occupants/*. O invite vive aqui (não em units.ts):
// é sobre notificar o ocupante, que pode estar em várias frações.

import type { Hono } from "hono";
import { client } from "$panel/client.ts";
import { parseFormString } from "$panel/libs/form_parsing.ts";
import { runFormAction } from "../_form_action.ts";
import { addOccupantToUnit } from "../../controllers/units.ts";
import {
  createOccupant,
  deleteOccupant,
  getOccupant,
  listOccupants,
  updateOccupant,
} from "../../controllers/occupants.ts";

export function registerOccupantsRoutes(panelRouter: Hono): void {
  panelRouter.get("/admin/c/:cid/occupants", async (c) => {
    const filter = c.req.query("filter");
    const html = await listOccupants(filter || undefined);
    return c.html(html);
  });

  panelRouter.get("/admin/c/:cid/occupants/:id", async (c) => {
    const id = c.req.param("id");
    const html = await getOccupant(id);
    return c.html(html);
  });

  panelRouter.post("/admin/c/:cid/occupants", (c) =>
    runFormAction(c, async (form) => {
      return await createOccupant(form as Record<string, string>);
    }, {
      successPath: "occupants",
      successMsg: "Condómino criado.",
      errorPrefix: "Erro ao criar condómino",
    }));

  panelRouter.post("/admin/c/:cid/occupants/:id/update", (c) => {
    const id = c.req.param("id");
    return runFormAction(c, async (form) => {
      return await updateOccupant(id, form as Record<string, string>);
    }, {
      successPath: `occupants/${id}`,
      successMsg: "Condómino atualizado.",
      errorPrefix: "Erro ao atualizar condómino",
    });
  });

  panelRouter.post("/admin/c/:cid/occupants/:id/units", (c) => {
    const id = c.req.param("id");
    return runFormAction(c, async (form) => {
      const unitId = parseFormString(form, "unitId");
      const relationshipType = parseFormString(form, "relationshipType", { default: "owner" });
      if (unitId) await addOccupantToUnit(unitId, id, relationshipType);
    }, {
      successPath: `occupants/${id}`,
      successMsg: "Fração associada.",
      errorPrefix: "Erro ao associar fração",
    });
  });

  panelRouter.post("/admin/c/:cid/occupants/:id/units/:unitId/remove", (c) => {
    const id = c.req.param("id");
    return runFormAction(c, async () => {
      const { removeUnitOccupant } = await import("../../controllers/occupants.ts");
      return await removeUnitOccupant(id, c.req.param("unitId"));
    }, {
      successPath: `occupants/${id}`,
      successMsg: "Associação removida.",
      errorPrefix: "Erro ao remover associação",
    });
  });

  // PATCH-like (POST) - atualiza unit_occupant (relacionamento + datas).
  // Usado pelo modal "Editar associação" na página do ocupante.
  panelRouter.post(
    "/admin/c/:cid/occupants/:id/units/:unitId/uo/:unitOccupantId/update",
    (c) => {
      const id = c.req.param("id");
      const unitId = c.req.param("unitId");
      const unitOccupantId = c.req.param("unitOccupantId");
      return runFormAction(c, async (form) => {
        const { updateUnitOccupant } = await import("../../controllers/occupants.ts");
        await updateUnitOccupant(unitId, unitOccupantId, form);
      }, {
        successPath: `occupants/${id}`,
        successMsg: "Associação atualizada.",
        errorPrefix: "Erro ao atualizar associação",
      });
    },
  );

  panelRouter.post("/admin/c/:cid/occupants/:id/delete", (c) =>
    runFormAction(c, async () => {
      return await deleteOccupant(c.req.param("id"));
    }, {
      successPath: "occupants",
      successMsg: "Condómino eliminado.",
      errorPrefix: "Erro ao eliminar condómino",
    }));

  // ── Convidar ocupante para o portal ───────────────────────────────────────
  // HTMX: OOB partial + toast (sem reload); non-HTMX: redirect com flash.
  panelRouter.post("/admin/c/:cid/occupants/:occupantId/invite", async (c) => {
    const cid = c.req.param("cid");
    const occupantId = c.req.param("occupantId");
    if (c.req.header("hx-request") === "true") {
      const { inviteOccupantHtmx } = await import("../../controllers/occupants.ts");
      return c.html(await inviteOccupantHtmx(occupantId));
    }
    // Fallback non-HTMX (mantido por defesa).
    try {
      const { data } = await client.admin.inviteOccupant(occupantId);
      const sentTo = data.sentTo ?? "o ocupante";
      return c.redirect(
        `/admin/c/${cid}/occupants?flash=${
          encodeURIComponent(`Convite enviado para ${sentTo}.`)
        }&flashType=success`,
      );
    } catch (e) {
      return c.redirect(
        `/admin/c/${cid}/occupants?flash=${
          encodeURIComponent((e as Error).message)
        }&flashType=danger`,
      );
    }
  });
}
