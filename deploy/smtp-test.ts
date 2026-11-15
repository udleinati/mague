// Script standalone para testar a configuração SMTP. Útil para diagnosticar
// problemas de envio em produção sem ter de mexer na app inteira.
//
// USO (a partir da raiz do projecto, com .env.prod carregado ou inline):
//
//   # Local (Mailpit):
//   deno run --allow-net --allow-env --allow-read deploy/smtp-test.ts \
//     --host=localhost --port=1025 --to=teste@exemplo.pt
//
//   # Produção (Resend):
//   SMTP_HOST=smtp.resend.com SMTP_PORT=465 SMTP_USER=resend \
//   SMTP_PASS=re_xxx SMTP_FROM='MAGUE <noreply@mague.pt>' \
//     deno run --allow-net --allow-env --allow-read deploy/smtp-test.ts \
//       --to=teste@exemplo.pt
//
// Imprime cada passo (DNS, conexão, auth, send) com tempos e erros completos.

import nodemailer from "npm:nodemailer@6.9.16";

function arg(name: string, fallback?: string): string {
  const found = Deno.args.find((a) => a.startsWith(`--${name}=`));
  return found ? found.split("=").slice(1).join("=") : (fallback ?? "");
}

const cfg = {
  host: arg("host", Deno.env.get("SMTP_HOST") ?? ""),
  port: Number(arg("port", Deno.env.get("SMTP_PORT") ?? "587")),
  user: arg("user", Deno.env.get("SMTP_USER") ?? ""),
  pass: arg("pass", Deno.env.get("SMTP_PASS") ?? ""),
  from: arg("from", Deno.env.get("SMTP_FROM") ?? ""),
  to: arg("to", ""),
};

if (!cfg.host || !cfg.from || !cfg.to) {
  console.error("Faltam args. Pelo menos --host, --from e --to (ou env vars).");
  Deno.exit(2);
}

console.log("─".repeat(60));
console.log(`Host:    ${cfg.host}:${cfg.port}`);
console.log(`User:    ${cfg.user || "(nenhum)"}`);
console.log(`Pass:    ${cfg.pass ? "********** (" + cfg.pass.length + " chars)" : "(nenhuma)"}`);
console.log(`From:    ${cfg.from}`);
console.log(`To:      ${cfg.to}`);
console.log(`Secure:  ${cfg.port === 465 ? "true (TLS implícito)" : "false (STARTTLS ou plain)"}`);
console.log("─".repeat(60));

// 1. DNS resolve do host
console.log("\n[1] Resolver DNS do host…");
try {
  const t0 = performance.now();
  const ips = await Deno.resolveDns(cfg.host, "A");
  console.log(`    ✓ ${ips.join(", ")}  (${Math.round(performance.now() - t0)}ms)`);
} catch (e) {
  console.error(`    ✗ Falhou: ${(e as Error).message}`);
  Deno.exit(1);
}

// 2. Verify (handshake + auth, sem enviar nada)
console.log("\n[2] Conectar + autenticar (verify)…");
const transporter = nodemailer.createTransport({
  host: cfg.host,
  port: cfg.port,
  secure: cfg.port === 465,
  auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
  // logger: true, // descomenta para debug muito verboso
  // debug: true,
  connectionTimeout: 15_000,
  greetingTimeout: 15_000,
  socketTimeout: 30_000,
});

try {
  const t0 = performance.now();
  await transporter.verify();
  console.log(
    `    ✓ Servidor aceita ligação e autenticação  (${Math.round(performance.now() - t0)}ms)`,
  );
} catch (e) {
  const err = e as Error & { code?: string; response?: string };
  console.error(`    ✗ Falhou (${err.code ?? "?"}): ${err.message}`);
  if (err.response) console.error(`      Resposta servidor: ${err.response}`);
  Deno.exit(1);
}

// 3. Send real
console.log("\n[3] A enviar email de teste…");
try {
  const t0 = performance.now();
  const info = await transporter.sendMail({
    from: cfg.from,
    to: cfg.to,
    subject: `MAGUE SMTP test · ${new Date().toISOString()}`,
    html: `
      <div style="font-family:sans-serif;padding:24px;">
        <h2 style="color:#0d9488;">SMTP test ok ✓</h2>
        <p>Este email foi enviado por <code>deploy/smtp-test.ts</code>.</p>
        <ul>
          <li>Host: <code>${cfg.host}:${cfg.port}</code></li>
          <li>From: <code>${cfg.from}</code></li>
          <li>Sent at: <code>${new Date().toISOString()}</code></li>
        </ul>
      </div>
    `,
    text: `SMTP test ok. Host=${cfg.host}:${cfg.port} From=${cfg.from} At=${
      new Date().toISOString()
    }`,
  });
  console.log(`    ✓ Aceite pelo servidor  (${Math.round(performance.now() - t0)}ms)`);
  console.log(`      Message-ID: ${info.messageId}`);
  if (info.response) console.log(`      Resposta:   ${info.response}`);
  if (info.accepted?.length) console.log(`      Accepted:   ${info.accepted.join(", ")}`);
  if (info.rejected?.length) console.log(`      Rejected:   ${info.rejected.join(", ")}`);
} catch (e) {
  const err = e as Error & { code?: string; response?: string; responseCode?: number };
  console.error(`    ✗ Falhou (${err.code ?? "?"} ${err.responseCode ?? ""}): ${err.message}`);
  if (err.response) console.error(`      Resposta servidor: ${err.response}`);
  Deno.exit(1);
}

console.log("\n✓ Tudo ok. Verifica a inbox em " + cfg.to);
