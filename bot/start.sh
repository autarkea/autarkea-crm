#!/bin/sh
echo "🚀 Запуск сервера документов (server.js) на порту 3000..."
node server.js > /tmp/server.log 2>&1 &
SERVER_PID=$!
sleep 2
if ! kill -0 $SERVER_PID 2>/dev/null; then
    echo "❌ server.js упал при старте!"
    cat /tmp/server.log
    exit 1
fi
echo "✅ server.js запущен (PID: $SERVER_PID)"
echo "🤖 Запуск Telegram-бота (bot.js)..."
exec node bot.js
