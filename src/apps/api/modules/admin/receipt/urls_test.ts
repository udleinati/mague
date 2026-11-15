import { assertEquals } from "@std/assert";
import { portalReceiptUrl } from "./urls.ts";

Deno.test("portalReceiptUrl - formato canónico com /u/:uid/receipts/:id", () => {
  assertEquals(
    portalReceiptUrl("https://app.mague.pt", "cd_abc", "u_xyz", "rec_123"),
    "https://app.mague.pt/portal/c/cd_abc/u/u_xyz/receipts/rec_123",
  );
});

Deno.test("portalReceiptUrl - panelBaseUrl sem trailing slash", () => {
  // Os callers passam panelBaseUrl sem `/` final; o construtor não duplica `/`.
  const url = portalReceiptUrl("http://localhost:3400", "c1", "u1", "r1");
  assertEquals(url.startsWith("http://localhost:3400/portal/"), true);
  assertEquals(url.includes("//portal"), false);
});

Deno.test("portalReceiptUrl - inclui sempre /u/<unitId>/ (regression contra bug 2026-05-03)", () => {
  // Bug: o link era /portal/c/:cid/recibos/:id (sem unitId) -> 404, pois
  // requirePortalAccessToUnit valida ownership por unitId. Este teste fixa o formato.
  const url = portalReceiptUrl("https://x", "C", "U", "R");
  assertEquals(url.includes("/c/C/u/U/receipts/"), true);
  // NÃO deve ter o segmento PT antigo.
  assertEquals(url.includes("/recibos/"), false);
});
