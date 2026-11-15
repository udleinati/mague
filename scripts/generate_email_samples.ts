// Gerador de samples HTML dos emails enviados pelo sistema. Útil para
// rever o visual sem ter de configurar SMTP / disparar o fluxo real.
//
// Uso:
//   deno run --allow-write=/tmp scripts/generate_email_samples.ts
//
// Resultado: 4 ficheiros HTML em /tmp/email_samples/, prontos para abrir
// no browser:
//   • invite.html              - convite para o portal
//   • reset_password.html      - pedido de reset de password
//   • receipt_issued.html      - recibo emitido
//   • insurance_reminder.html  - lembrete de apólice em falta

import {
  insuranceReminderEmailHtml,
  inviteEmailHtml,
  receiptIssuedEmailHtml,
  resetPasswordEmailHtml,
} from "../src/apps/api/libs/email/send.ts";

const OUT_DIR = "/tmp/email_samples";

function wrapWithMeta(subject: string, html: string): string {
  // O sendEmail real injecta "from", "to", "subject" via SMTP; o HTML em si
  // não tem `<html>`, `<head>`, etc. Para visualização local envolvo num
  // documento completo com um pequeno header informativo.
  return `<!doctype html>
<html lang="pt">
<head>
  <meta charset="utf-8">
  <title>${subject}</title>
  <style>
    body { margin: 0; background: #f5f5f5; font-family: -apple-system, sans-serif; }
    .meta {
      max-width: 560px;
      margin: 32px auto 0;
      padding: 12px 16px;
      background: #fff7ed;
      border: 1px solid #fed7aa;
      border-radius: 8px;
      font-size: 13px;
      color: #7c2d12;
    }
    .meta strong { color: #431407; }
    .email-wrap {
      max-width: 600px;
      margin: 16px auto 32px;
      background: white;
      border: 1px solid #e5e7eb;
      border-radius: 12px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.05);
    }
  </style>
</head>
<body>
  <div class="meta">
    <div><strong>Sample preview · sem envio real</strong></div>
    <div>Subject: <code>${subject}</code></div>
  </div>
  <div class="email-wrap">
    ${html}
  </div>
</body>
</html>`;
}

await Deno.mkdir(OUT_DIR, { recursive: true });

// ─── 1. Convite occupant ───────────────────────────────────────────────────
const invite = inviteEmailHtml({
  occupantName: "Maria Silva",
  condominiumName: "Edifício Atlântico",
  designationType: "building",
  acceptUrl: "https://app.mague.pt/accept-invite?token=demo-invite-token-9876",
  ttl: "24 horas",
});
await Deno.writeTextFile(
  `${OUT_DIR}/invite.html`,
  wrapWithMeta("Bem-vinda ao portal do condomínio Edifício Atlântico", invite),
);

// ─── 2. Reset de password ──────────────────────────────────────────────────
const reset = resetPasswordEmailHtml({
  userName: "João Pereira",
  resetUrl: "https://app.mague.pt/reset-password?token=demo-reset-token-1234",
  ttl: "1 hora",
});
await Deno.writeTextFile(
  `${OUT_DIR}/reset_password.html`,
  wrapWithMeta("Reposição de password - Mague", reset),
);

// ─── 3. Recibo emitido ─────────────────────────────────────────────────────
const receipt = receiptIssuedEmailHtml({
  recipientName: "Ana Costa",
  condominiumName: "Edifício Atlântico",
  designationType: "building",
  receiptNumber: "2026/0042",
  amount: "120,00 €",
  paymentDate: "15/04/2026",
  receiptUrl: "https://app.mague.pt/portal/c/cdAtl/u/u01/recibos/r042/pdf",
});
await Deno.writeTextFile(
  `${OUT_DIR}/receipt_issued.html`,
  wrapWithMeta("Recibo nº 2026/0042 - Edifício Atlântico", receipt),
);

// ─── 4. Lembrete de seguro ─────────────────────────────────────────────────
const insurance = insuranceReminderEmailHtml({
  recipientName: "Pedro Santos",
  condominiumName: "Edifício Atlântico",
  designationType: "building",
  unitDesignation: "3º A",
  portalUrl: "https://app.mague.pt/portal/c/cdAtl/u/u03A/insurances",
});
await Deno.writeTextFile(
  `${OUT_DIR}/insurance_reminder.html`,
  wrapWithMeta("Apólice de seguro em falta - fracção 3º A", insurance),
);

console.log("Samples gerados em " + OUT_DIR + ":");
for (
  const f of [
    "invite.html",
    "reset_password.html",
    "receipt_issued.html",
    "insurance_reminder.html",
  ]
) {
  console.log("  • " + OUT_DIR + "/" + f);
}
console.log("\nAbre cada ficheiro no browser para visualizar:");
console.log("  open " + OUT_DIR + "/*.html");
