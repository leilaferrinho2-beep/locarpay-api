#!/bin/bash
# Watchdog: reinicia o Evolution API se não estiver respondendo
# Instalar: crontab -e → adicionar linha abaixo
# */5 * * * * /home/ubuntu/evolution-watchdog.sh >> /var/log/evolution-watchdog.log 2>&1

EVOLUTION_URL="http://localhost:8080"
CONTAINER_NAME="evolution-api"  # ajuste se necessário
LOG_PREFIX="[$(date '+%Y-%m-%d %H:%M:%S')] [watchdog]"

# Testa se o servidor responde em até 5 segundos
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$EVOLUTION_URL" 2>/dev/null)

if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "401" ] || [ "$HTTP_CODE" = "404" ]; then
  echo "$LOG_PREFIX Evolution OK (HTTP $HTTP_CODE)"
  exit 0
fi

echo "$LOG_PREFIX Evolution não responde (HTTP $HTTP_CODE) — reiniciando..."

# Tenta docker restart primeiro
if command -v docker &> /dev/null; then
  docker restart "$CONTAINER_NAME" 2>/dev/null && echo "$LOG_PREFIX docker restart OK" && exit 0
fi

# Tenta pm2 restart
if command -v pm2 &> /dev/null; then
  pm2 restart evolution 2>/dev/null && echo "$LOG_PREFIX pm2 restart OK" && exit 0
fi

echo "$LOG_PREFIX FALHA: não conseguiu reiniciar. Verifique manualmente."
