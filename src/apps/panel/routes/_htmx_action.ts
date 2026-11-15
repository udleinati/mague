// Análogo a `runFormAction` mas para POSTs inline em modo HTMX (botão "Skip",
// "Emitir" numa linha). Sucesso -> HTML com OOB swap da célula + toast OOB;
// erro -> só toast OOB (célula intacta para retry).

import { render } from "$panel/render.ts";

type FormInput = Record<string, string | File>;

export interface HtmxActionOptions<T> {
  /** Form-fields obrigatórios. Se algum estiver vazio, devolve toast de erro
   *  com `validationMsg` sem chamar a API. */
  required?: string[];
  /** Mensagem do toast quando validação falha. */
  validationMsg?: string;
  /** Chama a API. Recebe form como `Record<string,string>` (Files removidos). */
  apiCall: (form: Record<string, string>) => Promise<T>;
  /** Renderiza o partial OOB (ex: substitui a célula da action). Receives
   *  form + result da apiCall. Devolver string vazia para "sem partial"
   *  (modo: só toast). */
  successPartial?: (args: { form: Record<string, string>; result: T }) => Promise<string>;
  /** Mensagem do toast de sucesso. String ou função do (form, result). */
  successMsg: string | ((args: { form: Record<string, string>; result: T }) => string);
  /** Tipo do toast em sucesso. Default "success". */
  successToastType?: "success" | "warning" | "info";
  /** Prefixo da mensagem de erro fallback (`extractApiErrorMessage` faz o resto). */
  errorPrefix: string;
}

// Devolve HTML para `c.html(...)`: sucesso = successPartial + toast; erro = só toast.
export async function runHtmxAction<T>(
  rawForm: FormInput,
  opts: HtmxActionOptions<T>,
): Promise<string> {
  // Ignora Files: handlers HTMX não recebem uploads inline (vão por outras rotas).
  const form: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawForm)) {
    if (typeof v === "string") form[k] = v.trim();
  }

  if (opts.required) {
    for (const field of opts.required) {
      if (!form[field]) {
        return await renderToast({
          type: "error",
          message: opts.validationMsg ?? `Campo obrigatório em falta: ${field}`,
        });
      }
    }
  }

  try {
    const result = await opts.apiCall(form);
    const partialHtml = opts.successPartial ? await opts.successPartial({ form, result }) : "";
    const message = typeof opts.successMsg === "function"
      ? opts.successMsg({ form, result })
      : opts.successMsg;
    const toastHtml = await renderToast({
      type: opts.successToastType ?? "success",
      message,
    });
    return partialHtml + toastHtml;
  } catch (err) {
    const { extractApiErrorMessage } = await import("./_form_error.ts");
    const message = extractApiErrorMessage(err, opts.errorPrefix);
    return await renderToast({ type: "error", message });
  }
}

function renderToast(toast: { type: string; message: string }): Promise<string> {
  return render("pages/reconciliation/_toast.vto", { toast });
}
