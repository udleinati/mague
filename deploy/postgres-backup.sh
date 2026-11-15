#!/usr/bin/env bash
# Backup/restore da BD `mague` + bucket S3 de PDFs (RustFS em dev, qualquer
# S3 em prod - AWS, R2, etc). `save` produz UM ficheiro consolidado:
#
#   • mague-backup-<ts>.tar.gz  → tar com `db.dump` (pg_dump custom format)
#                                  + `s3/` (snapshot do bucket inteiro).
#
# `restore <file>` detecta o formato pela extensão e nome:
#   • mague-backup-*.tar.gz → restaura BD + S3.
#   • mague-db-*.dump       → restaura só BD (legacy).
#   • mague-s3-*.tar.gz     → restaura só S3 (legacy).
#
# Subcomandos granulares: save:db, save:s3, restore:db, restore:s3.
#
# Estratégia S3: container ad-hoc com `amazon/aws-cli` (cliente S3 standard,
# compatível com qualquer endpoint S3 - RustFS, AWS, Cloudflare R2, ...).
# Permite restaurar um backup feito em RustFS para um bucket AWS sem mudar
# nada no script - basta apontar o S3_ENDPOINT certo no .env.

set -euo pipefail

# Auto-detect qual docker-compose.yml foi usado para criar o container db
# em uso. Evita o caso clássico: corres o script em dev (sem env vars) e
# os defaults apontam para `docker-compose.prod.yml`, que tem outra config
# (sem ports mapeadas). O `dc up -d api panel` no fim do restore "converte"
# os containers para a definição prod e perdes acesso a localhost:3000/3400.
#
# Quando o container existe, lê o label nativo do Docker Compose. Se não
# existir, faz fallback razoável: dev se houver `docker-compose.yml`, senão
# prod.
detect_compose_file() {
  local from_label
  from_label="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.config_files" }}' mague-db 2>/dev/null || true)"
  if [ -n "$from_label" ] && [ "$from_label" != "<no value>" ] && [ -f "$from_label" ]; then
    echo "$from_label"
    return
  fi
  if [ -f "docker-compose.yml" ]; then
    echo "docker-compose.yml"
  else
    echo "docker-compose.prod.yml"
  fi
}

detect_env_file() {
  local compose="$1"
  case "$compose" in
    *prod*) [ -f ".env.prod" ] && echo ".env.prod" || echo ".env" ;;
    *)      [ -f ".env" ] && echo ".env" || echo ".env.prod" ;;
  esac
}

COMPOSE_FILE="${COMPOSE_FILE:-$(detect_compose_file)}"
ENV_FILE="${ENV_FILE:-$(detect_env_file "$COMPOSE_FILE")}"
SERVICE=db
DB_NAME=mague
DB_USER=mague
BACKUP_DIR="${BACKUP_DIR:-./deploy/backups}"
COMPOSE_NETWORK="${COMPOSE_NETWORK:-mague_default}"
AWS_CLI_IMAGE="${AWS_CLI_IMAGE:-amazon/aws-cli:latest}"

dc() {
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
}

# Lê uma var do ENV_FILE.
read_env() {
  local key="$1"
  grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' || true
}

# Adapta endpoint para o ponto de vista de um container na network do compose:
# `http://localhost:9000` → `http://rustfs:9000` (DNS interno). Endpoints
# externos (AWS, R2, ...) passam intactos.
internal_endpoint() {
  echo "$1" | sed 's|//localhost:|//rustfs:|; s|//127.0.0.1:|//rustfs:|'
}

s3_vars() {
  S3_ENDPOINT="$(read_env S3_ENDPOINT)"
  S3_BUCKET="$(read_env S3_BUCKET)"
  S3_ACCESS_KEY="$(read_env S3_ACCESS_KEY)"
  S3_SECRET_KEY="$(read_env S3_SECRET_KEY)"
  S3_REGION="$(read_env S3_REGION)"
  : "${S3_REGION:=us-east-1}"
  if [ -z "$S3_ENDPOINT" ] || [ -z "$S3_BUCKET" ] || [ -z "$S3_ACCESS_KEY" ] || [ -z "$S3_SECRET_KEY" ]; then
    echo "✗ S3_* vars em falta em $ENV_FILE (S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY)" >&2
    return 1
  fi
  S3_ENDPOINT_INTERNAL="$(internal_endpoint "$S3_ENDPOINT")"
}

aws_run() {
  # Wrapper para `aws-cli`. Args após `--` são passados ao `aws`.
  # `${arr[@]+...}` é o idioma para usar arrays sob `set -u` quando podem
  # estar vazios (sem este guard, "${extra_mounts[@]}" expande a unbound).
  local extra_mounts=()
  while [ "$1" != "--" ]; do extra_mounts+=("$1"); shift; done
  shift  # consume `--`
  docker run --rm \
    --network "$COMPOSE_NETWORK" \
    -e AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY" \
    -e AWS_SECRET_ACCESS_KEY="$S3_SECRET_KEY" \
    -e AWS_DEFAULT_REGION="$S3_REGION" \
    ${extra_mounts[@]+"${extra_mounts[@]}"} \
    "$AWS_CLI_IMAGE" \
    --endpoint-url "$S3_ENDPOINT_INTERNAL" \
    "$@"
}

# ─── save ────────────────────────────────────────────────────────────────────

save_db() {
  local ts="$1"
  local out="$BACKUP_DIR/mague-db-$ts.dump"
  echo "→ pg_dump (custom format, compressão 9)…"
  dc exec -T "$SERVICE" pg_dump \
    -U "$DB_USER" -d "$DB_NAME" \
    -F c -Z 9 --no-owner --no-privileges > "$out"
  local size; size=$(du -h "$out" | cut -f1)
  echo "✓ Guardado: $out  ($size)"
}

save_s3() {
  local ts="$1"
  s3_vars
  local out="$BACKUP_DIR/mague-s3-$ts.tar.gz"
  local abs_backup_dir; abs_backup_dir="$(cd "$BACKUP_DIR" && pwd)"
  local tmp="$abs_backup_dir/.s3_snapshot_$ts"

  echo "→ aws s3 sync s3://${S3_BUCKET} → ${tmp}…"
  mkdir -p "$tmp"
  aws_run -v "$tmp":/snapshot -- s3 sync "s3://$S3_BUCKET" /snapshot --quiet

  echo "→ tar.gz…"
  tar -czf "$out" -C "$tmp" .
  rm -rf "$tmp"

  local size; size=$(du -h "$out" | cut -f1)
  echo "✓ Guardado: $out  ($size)"
}

# Backup consolidado: um único `.tar.gz` com `db.dump` + `s3/` lá dentro.
# Usa o mesmo `pg_dump custom format` e o mesmo `aws s3 sync` que os
# subcomandos granulares - a diferença é só a embalagem.
save_combined() {
  local ts="$1"
  s3_vars
  local out="$BACKUP_DIR/mague-backup-$ts.tar.gz"
  local abs_backup_dir; abs_backup_dir="$(cd "$BACKUP_DIR" && pwd)"
  local tmp="$abs_backup_dir/.combined_$ts"

  mkdir -p "$tmp/s3"

  echo "→ pg_dump (custom format, compressão 9) → $tmp/db.dump…"
  dc exec -T "$SERVICE" pg_dump \
    -U "$DB_USER" -d "$DB_NAME" \
    -F c -Z 9 --no-owner --no-privileges > "$tmp/db.dump"

  echo "→ aws s3 sync s3://${S3_BUCKET} → $tmp/s3…"
  aws_run -v "$tmp/s3":/snapshot -- s3 sync "s3://$S3_BUCKET" /snapshot --quiet

  echo "→ tar.gz → ${out}…"
  tar -czf "$out" -C "$tmp" db.dump s3
  rm -rf "$tmp"

  local size; size=$(du -h "$out" | cut -f1)
  echo "✓ Guardado: $out  ($size)"
}

# ─── restore ─────────────────────────────────────────────────────────────────

restore_db() {
  local file="$1"
  [ -f "$file" ] || { echo "Ficheiro não encontrado: $file" >&2; exit 1; }

  local size; size=$(du -h "$file" | cut -f1)
  echo "⚠  Vai substituir completamente a BD '$DB_NAME' pelo conteúdo de:"
  echo "   $file  ($size)"
  echo "   API e panel ficam a correr (sem restart); queries em curso vão"
  echo "   dar erro transiente por ~5s - o pool reconecta sozinho."
  read -r -p "   Escrever 'RESTORE' para confirmar: " CONFIRM
  [ "$CONFIRM" = "RESTORE" ] || { echo "Cancelado."; exit 0; }

  # ALLOW_CONNECTIONS=false impede a api de re-conectar à `mague` entre o
  # terminate e o DROP. O pool fica com erros até a DB ser recriada (~5s).
  # Trap garante restauro em caso de falha a meio (sem isto, ficavas com
  # uma DB sem conexões permitidas, e a api permanente em erro).
  trap "dc exec -T \"$SERVICE\" psql -U \"$DB_USER\" -d postgres -c \"ALTER DATABASE $DB_NAME WITH ALLOW_CONNECTIONS true;\" >/dev/null 2>&1 || true" EXIT

  echo "→ Bloquear novas conexões à ${DB_NAME}…"
  dc exec -T "$SERVICE" psql -U "$DB_USER" -d postgres \
    -c "ALTER DATABASE $DB_NAME WITH ALLOW_CONNECTIONS false;" > /dev/null

  echo "→ Terminar conexões existentes…"
  dc exec -T "$SERVICE" psql -U "$DB_USER" -d postgres \
    -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = '$DB_NAME' AND pid <> pg_backend_pid();" > /dev/null

  # DROP/CREATE precisam de comandos separados (não correm em transaction).
  echo "→ Drop + create ${DB_NAME}…"
  dc exec -T "$SERVICE" psql -U "$DB_USER" -d postgres \
    -c "DROP DATABASE $DB_NAME;" > /dev/null
  dc exec -T "$SERVICE" psql -U "$DB_USER" -d postgres \
    -c "CREATE DATABASE $DB_NAME OWNER $DB_USER;" > /dev/null
  # CREATE DATABASE não herda allow_connections do template - fica true por
  # default. Não precisamos de re-allow explícito (mas o trap garante).

  echo "→ pg_restore…"
  dc exec -T "$SERVICE" pg_restore \
    -U "$DB_USER" -d "$DB_NAME" \
    --no-owner --no-privileges < "$file"

  trap - EXIT

  # Aplica migrations posteriores ao dump + re-aplica components (CLAUDE.md
  # avisa que dumps antigos podem ter funções/triggers desactualizados,
  # ex: sem a simplificação de roles). Soft-fail: se a
  # api estiver down ou migrate falhar, avisa mas não aborta - o restore em
  # si correu OK e o user pode correr `deno task migrate` manualmente depois.
  echo "→ deno task migrate (api container)…"
  if dc exec -T api deno task migrate 2>&1 | grep -E "→|aplicar|✓|Erro|FATAL"; then
    :
  else
    echo "  ⚠  migrate falhou ou api não está a correr - corre manualmente:"
    echo "     dc exec api deno task migrate"
  fi

  echo "✓ DB restaurada de $file (api/panel não foram reiniciados)"
}

# Restore consolidado: extrai o `.tar.gz` num temp, alimenta `restore_db`
# com o `db.dump` extraído, e faz sync S3 inline (sem re-empacotar).
# Reusa restore_db (que já tem o dance de ALLOW_CONNECTIONS, terminate,
# drop+create, pg_restore, migrate). O prompt do restore_db é skipado
# via stdin (`echo RESTORE | …`) - a confirmação combinada é a desta
# própria função.
restore_combined() {
  local file="$1"
  [ -f "$file" ] || { echo "Ficheiro não encontrado: $file" >&2; exit 1; }
  s3_vars

  local size; size=$(du -h "$file" | cut -f1)
  echo "⚠  Vai substituir BD '$DB_NAME' E bucket '$S3_BUCKET' (sync com --delete):"
  echo "   $file  ($size)"
  echo "   Endpoint S3: $S3_ENDPOINT"
  read -r -p "   Escrever 'RESTORE' para confirmar: " CONFIRM
  [ "$CONFIRM" = "RESTORE" ] || { echo "Cancelado."; exit 0; }

  local abs_backup_dir; abs_backup_dir="$(cd "$BACKUP_DIR" && pwd)"
  local tmp="$abs_backup_dir/.combined_restore_$$"
  trap "rm -rf '$tmp'" EXIT
  mkdir -p "$tmp"

  echo ""
  echo "→ Extract → ${tmp}…"
  tar -xzf "$file" -C "$tmp"

  if [ ! -f "$tmp/db.dump" ]; then
    echo "✗ '$file' não contém db.dump - não é um combined backup." >&2
    exit 1
  fi
  if [ ! -d "$tmp/s3" ]; then
    echo "✗ '$file' não contém s3/ - não é um combined backup." >&2
    exit 1
  fi

  echo ""
  echo "═ DB ════════════════════════════════════════════════════════════"
  echo "RESTORE" | restore_db "$tmp/db.dump"

  echo ""
  echo "═ S3 ════════════════════════════════════════════════════════════"
  echo "→ aws s3 mb (idempotente)…"
  set +e
  aws_run -- s3 mb "s3://$S3_BUCKET" >/dev/null 2>&1
  set -e
  echo "→ aws s3 sync --delete → s3://${S3_BUCKET}…"
  aws_run -v "$tmp/s3":/snapshot:ro -- s3 sync /snapshot "s3://$S3_BUCKET" --delete --quiet

  trap - EXIT
  rm -rf "$tmp"
  echo ""
  echo "✓ Restore combinado completo de $file"
}

restore_s3() {
  local file="$1"
  [ -f "$file" ] || { echo "Ficheiro não encontrado: $file" >&2; exit 1; }
  s3_vars

  local size; size=$(du -h "$file" | cut -f1)
  echo "⚠  Vai substituir o bucket '$S3_BUCKET' (sync com --delete) pelo conteúdo de:"
  echo "   $file  ($size)"
  echo "   Endpoint: $S3_ENDPOINT"
  read -r -p "   Escrever 'RESTORE' para confirmar: " CONFIRM
  [ "$CONFIRM" = "RESTORE" ] || { echo "Cancelado."; exit 0; }

  local abs_backup_dir; abs_backup_dir="$(cd "$BACKUP_DIR" && pwd)"
  local tmp="$abs_backup_dir/.s3_restore_$$"

  echo "→ Extract → ${tmp}…"
  mkdir -p "$tmp"
  tar -xzf "$file" -C "$tmp"

  echo "→ aws s3 mb (idempotente)…"
  set +e
  aws_run -- s3 mb "s3://$S3_BUCKET" >/dev/null 2>&1
  set -e

  echo "→ aws s3 sync --delete → s3://${S3_BUCKET}…"
  aws_run -v "$tmp":/snapshot:ro -- s3 sync /snapshot "s3://$S3_BUCKET" --delete --quiet
  rm -rf "$tmp"
  echo "✓ S3 restaurado de $file"
}

# ─── list ────────────────────────────────────────────────────────────────────

list_backups() {
  [ -d "$BACKUP_DIR" ] || { echo "Sem backups em $BACKUP_DIR"; exit 0; }
  local count; count=$(find "$BACKUP_DIR" -maxdepth 1 \
    \( -name "mague-backup-*.tar.gz" -o -name "mague-db-*.dump" -o -name "mague-s3-*.tar.gz" \) \
    | wc -l | tr -d ' ')
  if [ "$count" -eq 0 ]; then
    echo "Sem backups em $BACKUP_DIR"
    exit 0
  fi
  echo "Backups em $BACKUP_DIR:"
  printf "  %-22s  %-9s  %-9s  %-9s  %s\n" "TIMESTAMP" "COMBINED" "DB" "S3" "DATA"
  # Lista timestamps únicos extraídos dos nomes (qualquer formato)
  for ts in $(find "$BACKUP_DIR" -maxdepth 1 \
                \( -name "mague-backup-*.tar.gz" -o -name "mague-db-*.dump" -o -name "mague-s3-*.tar.gz" \) \
                -print0 \
              | xargs -0 -n1 basename \
              | sed -E 's/^mague-(backup|db|s3)-(.*)\.(tar\.gz|dump)$/\2/' \
              | sort -ur); do
    local combined_file="$BACKUP_DIR/mague-backup-$ts.tar.gz"
    local db_file="$BACKUP_DIR/mague-db-$ts.dump"
    local s3_file="$BACKUP_DIR/mague-s3-$ts.tar.gz"
    local combined_size="-" db_size="-" s3_size="-" mtime="?" mtime_file=""
    if [ -f "$combined_file" ]; then
      combined_size=$(du -h "$combined_file" | cut -f1)
      mtime_file="$combined_file"
    fi
    if [ -f "$db_file" ]; then
      db_size=$(du -h "$db_file" | cut -f1)
      [ -z "$mtime_file" ] && mtime_file="$db_file"
    fi
    if [ -f "$s3_file" ]; then
      s3_size=$(du -h "$s3_file" | cut -f1)
      [ -z "$mtime_file" ] && mtime_file="$s3_file"
    fi
    if [ -n "$mtime_file" ]; then
      mtime=$(stat -f "%Sm" -t "%Y-%m-%d %H:%M" "$mtime_file" 2>/dev/null \
              || stat -c "%y" "$mtime_file" | cut -d. -f1)
    fi
    printf "  %-22s  %-9s  %-9s  %-9s  %s\n" "$ts" "$combined_size" "$db_size" "$s3_size" "$mtime"
  done
}

# ─── main ────────────────────────────────────────────────────────────────────

mkdir -p "$BACKUP_DIR"

case "${1:-}" in
  save)
    TS="$(date +%Y%m%d-%H%M%S)"
    save_combined "$TS"
    ;;

  save:db)
    TS="$(date +%Y%m%d-%H%M%S)"
    save_db "$TS"
    ;;

  save:s3)
    TS="$(date +%Y%m%d-%H%M%S)"
    save_s3 "$TS"
    ;;

  restore)
    FILE="${2:?Uso: $0 restore <ficheiro>}"
    # Auto-detect pelo nome:
    #   • mague-backup-*.tar.gz → combined (BD + S3)
    #   • mague-s3-*.tar.gz     → só S3 (legacy)
    #   • *.dump                → só BD (legacy; também procura sibling S3)
    BASENAME="$(basename "$FILE")"
    case "$BASENAME" in
      mague-backup-*.tar.gz)
        restore_combined "$FILE"
        ;;
      mague-s3-*.tar.gz)
        restore_s3 "$FILE"
        ;;
      *.tar.gz)
        echo "✗ Nome '$BASENAME' não reconhecido (esperado mague-backup-*.tar.gz ou mague-s3-*.tar.gz)." >&2
        exit 1
        ;;
      *.dump)
        restore_db "$FILE"
        # Legacy: procura sibling S3 com o mesmo timestamp.
        TS="$(echo "$BASENAME" | sed -E 's/^mague-db-(.*)\.dump$/\1/')"
        S3_FILE="$(dirname "$FILE")/mague-s3-$TS.tar.gz"
        if [ -f "$S3_FILE" ]; then
          echo ""
          echo "ℹ  Encontrado backup S3 com mesmo timestamp: $(basename "$S3_FILE")"
          read -r -p "   Restaurar S3 também? (escrever RESTORE para confirmar): " CONFIRM
          if [ "$CONFIRM" = "RESTORE" ]; then
            echo "RESTORE" | restore_s3 "$S3_FILE"
          else
            echo "S3 não foi restaurado."
          fi
        fi
        ;;
      *)
        echo "✗ Extensão não reconhecida em '$FILE'. Esperado: .tar.gz (combined/s3) ou .dump (BD)." >&2
        exit 1
        ;;
    esac
    ;;

  restore:db)
    FILE="${2:?Uso: $0 restore:db <caminho/para/mague-db-xxx.dump>}"
    restore_db "$FILE"
    ;;

  restore:s3)
    FILE="${2:?Uso: $0 restore:s3 <caminho/para/mague-s3-xxx.tar.gz>}"
    restore_s3 "$FILE"
    ;;

  list)
    list_backups
    ;;

  *)
    cat <<EOF
Uso:
  $0 save                          Backup consolidado: 1 ficheiro mague-backup-<ts>.tar.gz
                                   (db.dump + s3/ lá dentro)
  $0 save:db                       Backup só do DB → mague-db-<ts>.dump
  $0 save:s3                       Backup só do S3 → mague-s3-<ts>.tar.gz
  $0 restore <ficheiro>            Auto-detect:
                                     mague-backup-*.tar.gz → BD + S3
                                     mague-s3-*.tar.gz     → só S3 (legacy)
                                     *.dump                → só BD (legacy)
  $0 restore:db <db.dump>          Restore só do DB
  $0 restore:s3 <s3.tar.gz>        Restore só do S3 (mirror com --delete no destino)
  $0 list                          Lista backups

Variáveis de ambiente (override):
  COMPOSE_FILE=$COMPOSE_FILE
  ENV_FILE=$ENV_FILE
  BACKUP_DIR=$BACKUP_DIR
  COMPOSE_NETWORK=$COMPOSE_NETWORK
  AWS_CLI_IMAGE=$AWS_CLI_IMAGE
EOF
    exit 1
    ;;
esac
