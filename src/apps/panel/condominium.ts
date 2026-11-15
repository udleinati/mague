// Condomínio ativo (getMe), memoizado per-request via ALS - o render.ts
// (layout admin) e os controllers que precisam dele para lógica partilham
// UMA chamada à API. Mesmo padrão do `_portalCtx` em portal_context.ts.

import type { Condominium } from "$shared/client/mod.ts";
import { client } from "$panel/client.ts";
import { als, currentCondominiumId, currentToken, currentUser } from "$panel/context.ts";

/** Variante para controllers admin que usam o condomínio em lógica -
 *  mesma cache, mas lança em vez de devolver `null`. */
export async function requireCurrentCondominium(): Promise<Condominium> {
  const condominium = await loadCurrentCondominium();
  if (!condominium) throw new Error("Sem condomínio ativo no contexto admin.");
  return condominium;
}

// `null` fora do contexto admin (sem user/cid, ou cid não gerido). Erros da
// API propagam (página admin sem condominium deve falhar alto).
export function loadCurrentCondominium(): Promise<Condominium | null> {
  const user = currentUser();
  const cid = currentCondominiumId();
  if (!user || !cid || !currentToken()) return Promise.resolve(null);
  if (user.role !== "super" && !user.managedCondominiumIds.includes(cid)) {
    return Promise.resolve(null);
  }
  const store = als.getStore();
  if (store?._condominium) return store._condominium as Promise<Condominium | null>;
  const promise = client.admin.getMe().then((r) => r.data);
  if (store) store._condominium = promise;
  return promise;
}
