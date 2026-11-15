FROM denoland/deno:2.7.12

# Chromium para geração de PDFs (recibos via libs/pdf/render.ts com astral).
# `ASTRAL_CHROMIUM_PATH` aponta para o binário do sistema → evita download
# automático em runtime e mantém a imagem reproduzível.
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libgbm1 \
    libasound2 \
    poppler-utils \
    tesseract-ocr \
    tesseract-ocr-por \
  && rm -rf /var/lib/apt/lists/*
ENV ASTRAL_CHROMIUM_PATH=/usr/bin/chromium

WORKDIR /app

# Copiar manifesto primeiro para aproveitar cache de camadas
COPY deno.json deno.lock* ./

# Pré-cache de dependências (opcional, falha silenciosa se ainda não há src)
RUN deno cache --reload deno.json || true

# Copiar código
COPY src/ ./src/
COPY static/ ./static/

# Cache do entry point
RUN deno cache src/apps/api/main.ts || true

EXPOSE 3000

CMD ["deno", "task", "start"]
