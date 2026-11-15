// Pentest E2E: redirect "next" pós-login.
//
// Quando um user deslogado tenta uma URL autenticada, o middleware do
// panel redirecciona para `/login?next=<path>`. Após login bem-sucedido,
// o handler POST envia o user de volta a esse path.
//
// Validações de segurança (anti-open-redirect):
//   - Apenas paths internos /admin/* ou /portal/* são honrados
//   - URLs absolutas (https://evil.com) → ignoradas
//   - Protocol-relative (//evil.com) → ignoradas
//   - Paths de loop (/login, /logout) → ignorados
//
// Este teste corre contra o PANEL (port 3400), não a API diretamente.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { describe, it } from "@std/testing/bdd";

const PANEL_URL = "http://localhost:3400";
// Password do super seedado. Default "test" (seed `deno task seed`);
// override via env `SUPER_PASSWORD` quando o DB local tem outra
// password (alinha com `_helpers/auth.ts`).
const SUPER_PASSWORD = Deno.env.get("SUPER_PASSWORD") ?? "test";

async function postLogin(body: Record<string, string>) {
  const fd = new URLSearchParams(body);
  const resp = await fetch(`${PANEL_URL}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: fd.toString(),
    redirect: "manual",
  });
  await resp.body?.cancel();
  return {
    status: resp.status,
    location: resp.headers.get("location") ?? null,
    setCookie: resp.headers.get("set-cookie") ?? null,
  };
}

async function getDeslogado(path: string) {
  const resp = await fetch(`${PANEL_URL}${path}`, { redirect: "manual" });
  await resp.body?.cancel();
  return {
    status: resp.status,
    location: resp.headers.get("location") ?? null,
  };
}

describe("panel login next-redirect", () => {
  it("deslogado em /admin/... → redirect com ?next= preserva path", async () => {
    const r = await getDeslogado("/admin/c/MgX001/dashboard");
    assertEquals(r.status, 302);
    assertStringIncludes(
      r.location ?? "",
      "/login?next=%2Fadmin%2Fc%2FMgX001%2Fdashboard",
    );
  });

  it("deslogado em /portal/... → redirect com ?next=", async () => {
    const r = await getDeslogado("/portal/c/whatever/u/whatever/dashboard");
    assertEquals(r.status, 302);
    if (r.location) {
      assertStringIncludes(r.location, "/login?next=");
    }
  });

  it("login válido com next interno → redirect para next", async () => {
    const r = await postLogin({
      identifier: "super@mague.pt",
      password: SUPER_PASSWORD,
      next: "/admin/c/MgX001/dashboard",
    });
    assertEquals(r.status, 302);
    assertEquals(r.location, "/admin/c/MgX001/dashboard");
  });

  it("login válido com next protocol-relative (//evil) → bloqueado", async () => {
    const r = await postLogin({
      identifier: "super@mague.pt",
      password: SUPER_PASSWORD,
      next: "//evil.com/phish",
    });
    assertEquals(r.status, 302);
    assertEquals(r.location, "/choose-condominium", "deve ignorar next malicioso");
  });

  it("login válido com next absoluto (https://) → bloqueado", async () => {
    const r = await postLogin({
      identifier: "super@mague.pt",
      password: SUPER_PASSWORD,
      next: "https://evil.com",
    });
    assertEquals(r.status, 302);
    assertEquals(r.location, "/choose-condominium");
  });

  it("login válido com next=/login (loop) → bloqueado", async () => {
    const r = await postLogin({
      identifier: "super@mague.pt",
      password: SUPER_PASSWORD,
      next: "/login",
    });
    assertEquals(r.status, 302);
    assertEquals(r.location, "/choose-condominium");
  });

  it("login válido com next=/logout (loop) → bloqueado", async () => {
    const r = await postLogin({
      identifier: "super@mague.pt",
      password: SUPER_PASSWORD,
      next: "/logout",
    });
    assertEquals(r.status, 302);
    assertEquals(r.location, "/choose-condominium");
  });

  it("login válido com next=/etc/passwd (fora de scope) → bloqueado", async () => {
    const r = await postLogin({
      identifier: "super@mague.pt",
      password: SUPER_PASSWORD,
      next: "/etc/passwd",
    });
    assertEquals(r.status, 302);
    assertEquals(r.location, "/choose-condominium");
  });

  it("login válido com next=javascript:alert(1) → bloqueado", async () => {
    const r = await postLogin({
      identifier: "super@mague.pt",
      password: SUPER_PASSWORD,
      next: "javascript:alert(1)",
    });
    assertEquals(r.status, 302);
    assertEquals(r.location, "/choose-condominium");
  });

  it("login com password errada + next → next preservado no redirect de erro", async () => {
    const r = await postLogin({
      identifier: "super@mague.pt",
      password: "WRONG",
      next: "/admin/c/MgX001/dashboard",
    });
    assertEquals(r.status, 302);
    assertStringIncludes(r.location ?? "", "/login?");
    assertStringIncludes(r.location ?? "", "next=%2Fadmin%2Fc%2FMgX001%2Fdashboard");
  });

  it("login válido sem next → fluxo default (/choose-condominium)", async () => {
    const r = await postLogin({
      identifier: "super@mague.pt",
      password: SUPER_PASSWORD,
    });
    assertEquals(r.status, 302);
    assertEquals(r.location, "/choose-condominium");
  });
});
