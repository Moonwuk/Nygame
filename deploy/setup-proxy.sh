#!/bin/bash

#############################################################################
# Void Dominion — Настройка Nginx проксирования
#
# Если хочешь получить доступ к серверу через внешний IP и порт
# Использование: sudo bash deploy/setup-proxy.sh
#############################################################################

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[✓]${NC} $1"
}

log_error() {
    echo -e "${RED}[✗]${NC} $1"
}

# Конфигурация
INTERNAL_IP="192.168.1.7"
INTERNAL_PORT="8788"
EXTERNAL_IP="94.190.83.220"
EXTERNAL_PORT="95367"

if [[ $EUID -ne 0 ]]; then
    log_error "Скрипт должен быть запущен от root"
    exit 1
fi

log_info "=========================================="
log_info "Настройка Nginx проксирования"
log_info "=========================================="
log_info "Внутренний адрес: $INTERNAL_IP:$INTERNAL_PORT"
log_info "Внешний адрес:    $EXTERNAL_IP:$EXTERNAL_PORT"
log_info "=========================================="
echo ""

# Установка Nginx
if ! command -v nginx &> /dev/null; then
    log_info "Установка Nginx..."
    apt-get update
    apt-get install -y nginx
    log_success "Nginx установлен"
else
    log_success "Nginx уже установлен"
fi

# Создание конфига
log_info "Создание конфигурации проксирования..."

cat > /etc/nginx/sites-available/moongame << 'EOF'
# Void Dominion — проксирование внешнего доступа
#
# Проксирует запросы с http://94.190.83.220:95367
# на локальный сервер http://192.168.1.7:8788

upstream moongame_backend {
    server 192.168.1.7:8788;
    keepalive 64;
}

server {
    # Слушаем внешний порт
    listen 95367;
    server_name 94.190.83.220;

    # Логирование
    access_log /var/log/nginx/moongame-access.log combined buffer=16k flush=1m;
    error_log /var/log/nginx/moongame-error.log warn;

    # Оптимизация для WebSocket
    client_max_body_size 10m;
    proxy_buffering off;

    location / {
        # Основное проксирование
        proxy_pass http://moongame_backend;

        # HTTP версия для сохранения соединения
        proxy_http_version 1.1;

        # WebSocket поддержка
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # Заголовки для клиента
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Таймауты для долгоживущих соединений
        proxy_connect_timeout 60s;
        proxy_send_timeout 3600s;
        proxy_read_timeout 3600s;

        # Отключаем буферизацию для WebSocket
        proxy_buffering off;
        proxy_request_buffering off;
    }

    # Health check endpoint (не требует проксирования)
    location /health {
        access_log off;
        proxy_pass http://moongame_backend;
        proxy_http_version 1.1;
    }
}

# Редирект HTTP → HTTPS (если нужно добавить SSL позже)
# server {
#     listen 80;
#     server_name 94.190.83.220;
#     return 301 https://$server_name:$server_port$request_uri;
# }
EOF

# Включение сайта
if [ -L /etc/nginx/sites-enabled/moongame ]; then
    log_info "Конфиг уже включен"
else
    ln -sf /etc/nginx/sites-available/moongame /etc/nginx/sites-enabled/
    log_success "Конфиг включен"
fi

# Отключение default сайта если он есть
if [ -L /etc/nginx/sites-enabled/default ]; then
    rm /etc/nginx/sites-enabled/default
    log_info "Default сайт отключен"
fi

# Проверка конфига
log_info "Проверка конфигурации Nginx..."
if nginx -t &>/dev/null; then
    log_success "Конфиг валиден"
else
    log_error "Ошибка в конфиге Nginx!"
    nginx -t
    exit 1
fi

# Перезагрузка Nginx
log_info "Перезагрузка Nginx..."
systemctl restart nginx
systemctl enable nginx
log_success "Nginx перезагружен"

echo ""
log_success "=========================================="
log_success "Настройка завершена!"
log_success "=========================================="
echo ""
echo -e "${BLUE}Проверка доступа:${NC}"
echo ""
echo "1. Локально (внутри сети):"
echo "   curl http://192.168.1.7:8788"
echo ""
echo "2. Через Nginx проксирование:"
echo "   curl http://94.190.83.220:95367"
echo "   (если с внешней машины, нужен доступ к этому IP)"
echo ""
echo -e "${YELLOW}Логирование:${NC}"
echo "  Access: tail -f /var/log/nginx/moongame-access.log"
echo "  Error:  tail -f /var/log/nginx/moongame-error.log"
echo ""
echo -e "${YELLOW}Управление:${NC}"
echo "  Остановить:   sudo systemctl stop nginx"
echo "  Перезапустить: sudo systemctl restart nginx"
echo "  Статус:       sudo systemctl status nginx"
echo ""
