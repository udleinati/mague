#!/bin/sh
# test_api/_run_rate_limit.sh - corre os pgTAP de rate-limit do login.
#
# O .env local desabilita o rate limit (10k/100k) para a suite normal não
# saturar. Este script:
#   1. Backup do .env
#   2. Substitui as 3 vars de rate limit por valores production-like (5/100/300)
#   3. Restart do container API para ler a nova config
#   4. FLUSHDB Valkey (counters começam limpos)
#   5. Corre o teste com RUN_RATE_LIMIT_TEST=1
#   6. Restore .env + restart (sempre, mesmo em failure - via trap)
#
# Custo: ~20s extra (2 restarts do container API). Por isso NÃO está em
# `test:all` - é correr-quando-mexes-em-rate-limit.

set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

ENV_FILE=".env"
BACKUP="$ENV_FILE.bak.rate_limit_test"

# Cleanup: restore .env e restart, mesmo se o teste falhar.
cleanup() {
  if [ -f "$BACKUP" ]; then
    mv "$BACKUP" "$ENV_FILE"
    echo "→ .env restaurado"
    docker compose restart api > /dev/null 2>&1 || true
    wait_api_ready || true
    echo "→ API restaurada"
  fi
}
trap cleanup EXIT INT TERM

wait_api_ready() {
  tries=0
  until curl -sf http://localhost:3000/health > /dev/null 2>&1; do
    tries=$((tries + 1))
    if [ $tries -gt 30 ]; then
      echo "✗ Timeout à espera que /health responda 200"
      return 1
    fi
    sleep 1
  done
}

echo "→ Backup do .env"
cp "$ENV_FILE" "$BACKUP"

echo "→ A baixar rate limit para production-like (5/100/300)"
sed -i.tmp \
  -e 's/^LOGIN_RATE_LIMIT_MAX_PER_IDENTIFIER_IP=.*/LOGIN_RATE_LIMIT_MAX_PER_IDENTIFIER_IP=5/' \
  -e 's/^LOGIN_RATE_LIMIT_MAX_PER_IP_GLOBAL=.*/LOGIN_RATE_LIMIT_MAX_PER_IP_GLOBAL=100/' \
  -e 's/^LOGIN_RATE_LIMIT_WINDOW_SECONDS=.*/LOGIN_RATE_LIMIT_WINDOW_SECONDS=300/' \
  "$ENV_FILE"
rm -f "$ENV_FILE.tmp"

echo "→ Restart do container API para apanhar nova config"
docker compose restart api > /dev/null
wait_api_ready

echo "→ FLUSHDB Valkey (counters começam limpos)"
docker exec mague-valkey valkey-cli FLUSHDB > /dev/null

echo "→ A correr testes de rate-limit..."
RUN_RATE_LIMIT_TEST=1 deno test --allow-net --allow-read --allow-env \
  test_api/api_security_rate_limit_test.ts
