// Routes /admin/c/:cid/expense-categories/* - chart_of_accounts (despesas).

import type { Hono } from "hono";
import { parseFormString } from "$panel/libs/form_parsing.ts";
import { getChartOfAccount, listExpenseCategories } from "../../controllers/chart_of_accounts.ts";
import { runFormAction } from "../_form_action.ts";
import { client } from "$panel/client.ts";

export function registerExpenseCategoriesRoutes(panelRouter: Hono): void {
  panelRouter.get("/admin/c/:cid/expense-categories", async (c) => {
    return c.html(await listExpenseCategories());
  });

  panelRouter.get("/admin/c/:cid/expense-categories/:id/edit", async (c) => {
    return c.html(await getChartOfAccount(c.req.param("id")));
  });

  panelRouter.post(
    "/admin/c/:cid/expense-categories/:id/update",
    (c) =>
      runFormAction(c, async (form) => {
        const { updateChartOfAccount } = await import("../../controllers/chart_of_accounts.ts");
        return await updateChartOfAccount(c.req.param("id"), form);
      }, {
        successPath: "expense-categories",
        successMsg: "Categoria atualizada.",
        errorPrefix: "Erro ao atualizar categoria",
      }),
  );

  panelRouter.post(
    "/admin/c/:cid/expense-categories/:id/delete",
    (c) =>
      runFormAction(c, async () => {
        const { deleteChartOfAccount } = await import("../../controllers/chart_of_accounts.ts");
        return await deleteChartOfAccount(c.req.param("id"));
      }, {
        successPath: "expense-categories",
        successMsg: "Categoria eliminada.",
        errorPrefix: "Erro ao eliminar categoria",
      }),
  );

  panelRouter.post("/admin/c/:cid/expense-categories", (c) =>
    runFormAction(c, async (form) => {
      const name = parseFormString(form, "name");
      if (!name) return;
      const type = parseFormString(form, "type", { default: "expense" });
      let code = parseFormString(form, "code").toUpperCase();
      if (!code) {
        const slug = name.normalize("NFD").replace(/[̀-ͯ]/g, "")
          .toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 12);
        code = `${slug || "CAT"}_${Date.now().toString(36).toUpperCase()}`.slice(0, 20);
      }
      const parentCode = parseFormString(form, "parentCode", { emptyAsNull: true });
      const description = parseFormString(form, "description", { emptyAsNull: true });
      return await client.admin.createChartOfAccount({
        name,
        code,
        type,
        parentCode,
        description,
      });
    }, {
      successPath: "expense-categories",
      successMsg: "Categoria criada.",
      errorPrefix: "Erro ao criar categoria",
    }));
}
