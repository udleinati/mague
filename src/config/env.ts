import "@std/dotenv/load";

function required(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`Variável de ambiente obrigatória em falta: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  return Deno.env.get(name) ?? fallback;
}

function asInt(value: string, name: string): number {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) {
    throw new Error(`Variável ${name} deve ser um inteiro, recebi: ${value}`);
  }
  return n;
}

export function asEmailProvider(value: string): "smtp" | "resend-http" {
  if (value === "smtp" || value === "resend-http") return value;
  throw new Error(
    `EMAIL_PROVIDER inválido: "${value}". Valores aceites: "smtp" ou "resend-http".`,
  );
}

export const env = {
  databaseUrl: required("DATABASE_URL"),
  valkeyUrl: optional("VALKEY_URL", "redis://localhost:6379"),
  port: asInt(optional("PORT", "3000"), "PORT"),
  environment: optional("ENVIRONMENT", "development"),

  smtp: {
    host: optional("SMTP_HOST", ""),
    port: asInt(optional("SMTP_PORT", "587"), "SMTP_PORT"),
    user: optional("SMTP_USER", ""),
    pass: optional("SMTP_PASS", ""),
    from: optional("SMTP_FROM", "noreply@mague.pt"),
  },

  // `resend-http` evita o pipeline MIME/SMTP que corrompia anexos binários
  // em produção; API key reusa SMTP_PASS. Default `smtp` via nodemailer.
  email: {
    provider: asEmailProvider(optional("EMAIL_PROVIDER", "smtp")),
  },

  // URL base do panel para links absolutos nos emails (convite, reset password).
  panelBaseUrl: optional("PANEL_BASE_URL", "http://localhost:3400"),

  sessionSecret: required("SESSION_SECRET"),
  sessionCookieName: optional("SESSION_COOKIE_NAME", "mague_session"),
  // Cap absoluto do JWT/cookie. Cosmético na arquitectura - Valkey é fonte
  // de verdade; este só importa em "cookie vazou + utilizador legítimo
  // nunca volta + atacante mantém sessão viva". Ver ADR 0020.
  sessionExpiryDays: asInt(
    optional("SESSION_EXPIRY_DAYS", "7"),
    "SESSION_EXPIRY_DAYS",
  ),
  // TTL real da sessão Valkey. Sliding: cada request autenticada faz EXPIRE
  // session:<sid> para "agora + idle". Sem uso durante este período, sessão
  // evapora-se e próxima request é 401. Ver ADR 0020.
  sessionIdleHours: asInt(
    optional("SESSION_IDLE_HOURS", "3"),
    "SESSION_IDLE_HOURS",
  ),

  corsOrigins: optional("CORS_ORIGINS", "")
    .split(",").map((o) => o.trim()).filter(Boolean),

  // Rate limit do login. Defaults production (5/IP-conta/5min, 100/IP-global/5min);
  // o `.env` local sobrepõe com valores altos para não bloquear HMR/e2e/scripts.
  loginRateLimit: {
    maxPerIdentifierIp: asInt(
      optional("LOGIN_RATE_LIMIT_MAX_PER_IDENTIFIER_IP", "5"),
      "LOGIN_RATE_LIMIT_MAX_PER_IDENTIFIER_IP",
    ),
    maxPerIpGlobal: asInt(
      optional("LOGIN_RATE_LIMIT_MAX_PER_IP_GLOBAL", "100"),
      "LOGIN_RATE_LIMIT_MAX_PER_IP_GLOBAL",
    ),
    windowSeconds: asInt(
      optional("LOGIN_RATE_LIMIT_WINDOW_SECONDS", "300"),
      "LOGIN_RATE_LIMIT_WINDOW_SECONDS",
    ),
  },

  // S3-compatible object storage - PDFs de recibos. Dev: RustFS (docker-compose);
  // prod: AWS S3/R2. `forcePathStyle=true` para RustFS/MinIO; AWS usa virtual-hosted.
  s3: {
    endpoint: optional("S3_ENDPOINT", "http://localhost:9000"),
    region: optional("S3_REGION", "us-east-1"),
    bucket: optional("S3_BUCKET", "mague-receipts"),
    accessKey: optional("S3_ACCESS_KEY", ""),
    secretKey: optional("S3_SECRET_KEY", ""),
    forcePathStyle: optional("S3_FORCE_PATH_STYLE", "true").toLowerCase() === "true",
  },

  // Limite de upload partilhado por todos os endpoints e injectado nos templates
  // como `uploadMaxMb` (texto "Máximo X MB" sincronizado). Mudar aqui = mudar em todo o lado.
  upload: {
    maxFileSizeMb: asInt(optional("UPLOAD_MAX_MB", "20"), "UPLOAD_MAX_MB"),
    get maxFileSizeBytes(): number {
      return this.maxFileSizeMb * 1024 * 1024;
    },
  },
} as const;

export const isDev = env.environment === "development";
