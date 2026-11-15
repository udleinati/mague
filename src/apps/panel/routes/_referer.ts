// Query string do `Referer` para preservar filtros (year, status, search) num
// redirect de volta à listagem. O `flash`/`flashType` da request anterior são
// descartados (substituídos pelo flash novo).

import type { Context } from "hono";

// Devolve `?<qs>` derivado do Referer, ou `""` se inválido / sem filtros.
export function refererQueryAppend(c: Context): string {
  const ref = c.req.header("Referer") ?? "";
  if (!ref) return "";
  let url: URL;
  try {
    url = new URL(ref);
  } catch {
    return "";
  }
  const sp = url.searchParams;
  // Filtra o flash da request anterior - vai ser substituído pelo novo.
  sp.delete("flash");
  sp.delete("flashType");
  const qs = sp.toString();
  return qs ? `?${qs}` : "";
}
