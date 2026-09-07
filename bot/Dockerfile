FROM node:18-slim

# Устанавливаем зависимости для Puppeteer + rclone (для /backup в облако).
# ca-certificates ОБЯЗАТЕЛЕН: rclone написан на Go и проверяет TLS по системному
# хранилищу сертификатов, а в node:18-slim его нет (apt с --no-install-recommends
# его не тянет) → /backup падал с «x509: certificate signed by unknown authority»
# при обращении к Google API (Проблема 110).
RUN apt-get update && apt-get install -y \
    ca-certificates \
    rclone \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Проблема 115: Chromium (node) не мог создать профиль — /home/node/.config создавался
# docker-демоном от root при bind-mount rclone.conf, и Chromium 15x падал
# «Failed to create headless user data directory» / crashpad. Создаём каталоги В ОБРАЗЕ
# с владельцем node: при bind-mount docker не пересоздаёт существующую папку root-ом.
RUN mkdir -p /home/node/.config /home/node/.cache && chown -R node:node /home/node

WORKDIR /app

COPY bot/package*.json ./
RUN npm install --production

COPY bot/server.js bot/bot.js bot/config.js bot/routes.js ./
COPY bot/handlers /app/handlers
COPY bot/start.sh .
RUN chmod +x start.sh

COPY templates /app/templates
RUN mkdir -p /mnt/data/noco-static/pdfs

# Запускаем скрипт, который поднимет оба процесса
CMD ["./start.sh"]
