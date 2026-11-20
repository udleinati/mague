import { assertEquals } from "@std/assert";
import { validateNextPath } from "./next_path.ts";

// `next` vem de query/form e acaba num `Location`: tudo o que o browser
// normaliza para outro host tem de cair (open redirect para phishing).
Deno.test("validateNextPath: rejeita destinos que o browser leva para outro host", () => {
  for (
    const bad of [
      "https://evil.com",
      "//evil.com",
      "/%2F/evil.com",
      "/\\evil.com",
      "/%5Cevil.com",
      "/%09/evil.com",
      "/evil",
      "/login?next=/admin/x",
    ]
  ) {
    assertEquals(validateNextPath(bad), null, bad);
  }
});

Deno.test("validateNextPath: aceita paths internos admin/portal e devolve o original", () => {
  assertEquals(validateNextPath("/portal/c/a/u/b/receipts/r"), "/portal/c/a/u/b/receipts/r");
  assertEquals(validateNextPath("/admin/c/a/charges?x=1"), "/admin/c/a/charges?x=1");
});
