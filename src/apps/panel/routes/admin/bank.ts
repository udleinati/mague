// Routes /admin/c/:cid/bank-accounts/* - CRUD + import CSV/XLSX + manual tx.

import type { Hono } from "hono";
import { condoUrl } from "../../urls.ts";
import { runFormAction } from "../_form_action.ts";
import { parseFlashFromQuery } from "../_flash.ts";

export function registerBankRoutes(panelRouter: Hono): void {
  panelRouter.get("/admin/c/:cid/bank-accounts", async (c) => {
    const { listBankAccounts } = await import("../../controllers/bank_accounts.ts");
    return c.html(await listBankAccounts());
  });
  panelRouter.get("/admin/c/:cid/bank-accounts/new", async (c) => {
    const { newBankAccountPage } = await import("../../controllers/bank_accounts.ts");
    return c.html(await newBankAccountPage());
  });
  panelRouter.post("/admin/c/:cid/bank-accounts", (c) =>
    runFormAction(c, async (form) => {
      const { createBankAccount } = await import("../../controllers/bank_accounts.ts");
      return await createBankAccount(form);
    }, {
      successPath: (r) => `bank-accounts/${r.id}`,
      successMsg: "Conta bancária criada.",
      errorPath: "bank-accounts/new",
      errorPrefix: "Erro ao criar conta bancária",
    }));
  panelRouter.get("/admin/c/:cid/bank-accounts/:id", async (c) => {
    const { showBankAccount } = await import("../../controllers/bank_accounts.ts");
    return c.html(await showBankAccount(c.req.param("id"), parseFlashFromQuery(c)));
  });
  panelRouter.get("/admin/c/:cid/bank-accounts/:id/edit", async (c) => {
    const { editBankAccountPage } = await import("../../controllers/bank_accounts.ts");
    return c.html(await editBankAccountPage(c.req.param("id"), parseFlashFromQuery(c)));
  });
  panelRouter.post("/admin/c/:cid/bank-accounts/:id/update", (c) => {
    const id = c.req.param("id");
    return runFormAction(c, async (form) => {
      const { updateBankAccount } = await import("../../controllers/bank_accounts.ts");
      return await updateBankAccount(id, form);
    }, {
      successPath: `bank-accounts/${id}`,
      successMsg: "Conta bancária atualizada.",
      errorPath: `bank-accounts/${id}/edit`,
      errorPrefix: "Erro ao atualizar conta bancária",
    });
  });
  panelRouter.post("/admin/c/:cid/bank-accounts/:id/delete", (c) =>
    runFormAction(c, async () => {
      const { deleteBankAccount } = await import("../../controllers/bank_accounts.ts");
      return await deleteBankAccount(c.req.param("id"));
    }, {
      successPath: "bank-accounts",
      successMsg: "Conta bancária eliminada.",
      errorPrefix: "Erro ao eliminar conta bancária",
    }));
  // Cria um movimento bancário manual (entrada ou saída) na conta. Usado
  // sobretudo para contas tipo 'cash' (caixa de numerário) onde não existe
  // CSV para importar - cada recebimento em dinheiro é uma linha aqui.
  panelRouter.post("/admin/c/:cid/bank-accounts/:id/manual-tx", (c) => {
    const id = c.req.param("id");
    return runFormAction(c, async (form) => {
      const { createManualBankTx } = await import("../../controllers/bank_accounts.ts");
      await createManualBankTx(id, form);
    }, {
      successPath: `bank-accounts/${id}`,
      successMsg: "Movimento adicionado.",
      errorPrefix: "Erro ao adicionar movimento",
    });
  });
  // Transferência entre bolsas (ordinária ↔ FCR). Ao nível do condomínio, não
  // de uma conta - por isso sem `:id` no path.
  panelRouter.post(
    "/admin/c/:cid/bank-accounts/fcr-transfer",
    (c) =>
      runFormAction(c, async (form) => {
        const { createFcrTransfer } = await import("../../controllers/bank_accounts.ts");
        await createFcrTransfer(form);
      }, {
        successPath: "bank-accounts",
        successMsg: "Transferência entre bolsas registada.",
        errorPath: "bank-accounts",
        errorPrefix: "Erro ao transferir entre bolsas",
      }),
  );
  panelRouter.post("/admin/c/:cid/bank-accounts/:id/opening-balance", (c) => {
    const id = c.req.param("id");
    return runFormAction(c, async (form) => {
      const { setOpeningBalance } = await import("../../controllers/bank_accounts.ts");
      await setOpeningBalance(id, form);
    }, {
      successPath: `bank-accounts/${id}`,
      successMsg: "Saldo inicial definido.",
      errorPath: `bank-accounts/${id}/edit`,
      errorPrefix: "Erro ao definir saldo inicial",
    });
  });
  panelRouter.post("/admin/c/:cid/bank-accounts/:id/import/preview", async (c) => {
    const { previewImport } = await import("../../controllers/bank_accounts.ts");
    const id = c.req.param("id");
    const form = await c.req.parseBody();
    const file = form.file;
    if (!(file instanceof File) || file.size === 0) {
      return c.redirect(
        condoUrl(
          `bank-accounts/${id}?flash=${
            encodeURIComponent("Escolhe um ficheiro XLSX.")
          }&flashType=danger`,
        ),
      );
    }
    try {
      return c.html(await previewImport(id, file));
    } catch (err) {
      const { extractApiErrorMessage } = await import("../_form_error.ts");
      const msg = extractApiErrorMessage(err, "Erro ao pré-visualizar.");
      return c.redirect(
        condoUrl(`bank-accounts/${id}?flash=${encodeURIComponent(msg)}&flashType=danger`),
      );
    }
  });
  panelRouter.post("/admin/c/:cid/bank-accounts/:id/import/commit", (c) => {
    const id = c.req.param("id");
    return runFormAction(c, async (form) => {
      const { commitImport } = await import("../../controllers/bank_accounts.ts");
      return await commitImport(id, form);
    }, {
      successPath: `bank-accounts/${id}`,
      successMsg: (r) => `${r.created} movimento(s) importado(s), ${r.skipped} ignorado(s).`,
      errorPrefix: "Erro ao importar",
    });
  });
}
