#!/bin/bash

#############################################################################
# Void Dominion — Ubuntu Server One-Click Installer
#
# Автоматическая установка проекта на Ubuntu с Docker Compose
# Использование: sudo bash deploy/install-ubuntu.sh
#
# Что устанавливает:
#   - Docker + Docker Compose
#   - Клонирует репозиторий
#   - Настраивает systemd сервис для автозапуска
#   - Запускает сервер
#############################################################################

set -e  # Exit on error

# Цвета для вывода
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Конфигурация
REPO_URL="https://github.com/Moonwuk/moongame.git"
REPO_BRANCH="main"
INSTALL_DIR="/opt/moongame"
SERVICE_USER="moongame"
SERVICE_NAME="moongame"
DOCKER_COMPOSE_FILE="$INSTALL_DIR/deploy/docker-compose.yml"
ENV_FILE="$INSTALL_DIR/deploy/server.env"

# Параметры сервера
INTERNAL_IP="192.168.1.7"
EXTERNAL_IP="94.190.83.220"
EXTERNAL_PORT="95367"
INTERNAL_PORT="8788"
TIME_SCALE="100"
POSTGRES_PASSWORD="moongame_dev_$(openssl rand -hex 8)"

# Функции для вывода
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[✓]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[!]${NC} $1"
}

log_error() {
    echo -e "${RED}[✗]${NC} $1"
}

# Проверка, запущен ли скрипт от root
if [[ $EUID -ne 0 ]]; then
    log_error "Скрипт должен быть запущен от root (используй: sudo bash deploy/install-ubuntu.sh)"
    exit 1
fi

log_info "=========================================="
log_info "Void Dominion — Установка на Ubuntu"
log_info "=========================================="

# Проверка ОС
if ! grep -qi ubuntu /etc/os-release; then
    log_error "Этот скрипт работает только на Ubuntu"
    exit 1
fi

log_info "Обновление пакетов системы..."
apt-get update
apt-get upgrade -y

# Проверка и установка Docker
if ! command -v docker &> /dev/null; then
    log_info "Установка Docker..."
    apt-get install -y apt-transport-https ca-certificates curl software-properties-common
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | apt-key add -
    add-apt-repository "deb [arch=amd64] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable"
    apt-get update
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
    log_success "Docker установлен"
else
    log_success "Docker уже установлен"
fi

# Проверка и установка Docker Compose (standalone)
if ! command -v docker-compose &> /dev/null; then
    log_info "Установка Docker Compose..."
    DOCKER_COMPOSE_VERSION=$(curl -s https://api.github.com/repos/docker/compose/releases/latest | grep 'tag_name' | cut -d'"' -f4)
    curl -L "https://github.com/docker/compose/releases/download/${DOCKER_COMPOSE_VERSION}/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
    chmod +x /usr/local/bin/docker-compose
    log_success "Docker Compose установлен"
else
    log_success "Docker Compose уже установлен"
fi

# Включение Docker демона при старте
systemctl enable docker
systemctl start docker

# Создание пользователя для сервиса
if ! id "$SERVICE_USER" &>/dev/null; then
    log_info "Создание пользователя $SERVICE_USER..."
    useradd -m -d /home/$SERVICE_USER -s /bin/bash $SERVICE_USER
    usermod -aG docker $SERVICE_USER
    log_success "Пользователь создан"
else
    log_success "Пользователь $SERVICE_USER уже существует"
    usermod -aG docker $SERVICE_USER
fi

# Создание директории проекта
log_info "Подготовка директории установки..."
if [ -d "$INSTALL_DIR" ]; then
    log_warning "Директория $INSTALL_DIR уже существует"
    read -p "Заменить существующую установку? (y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        rm -rf "$INSTALL_DIR"
    else
        log_error "Установка отменена"
        exit 1
    fi
fi

mkdir -p "$INSTALL_DIR"
chown $SERVICE_USER:$SERVICE_USER "$INSTALL_DIR"

# Клонирование репозитория
log_info "Клонирование репозитория..."
cd "$INSTALL_DIR"
git clone --branch $REPO_BRANCH $REPO_URL .
chown -R $SERVICE_USER:$SERVICE_USER "$INSTALL_DIR"
log_success "Репозиторий клонирован"

# Создание .env файла для Docker Compose
log_info "Создание конфигурации сервера..."
cat > "$ENV_FILE" << EOF
# Void Dominion — Конфигурация сервера

# Порт
PORT=$INTERNAL_PORT

# Ускорение времени для разработки (1 = реальное время)
TIME_SCALE=$TIME_SCALE

# Количество матчей
MATCHES=1

# Пароль PostgreSQL
POSTGRES_PASSWORD=$POSTGRES_PASSWORD

# Дополнительные параметры для разработки
GATE=0
SEAT_LOCK=0
EOF

chown $SERVICE_USER:$SERVICE_USER "$ENV_FILE"
chmod 600 "$ENV_FILE"
log_success "Конфигурация создана"

# Создание systemd сервиса для управления
log_info "Настройка автозапуска (systemd)..."
cat > /etc/systemd/system/$SERVICE_NAME.service << EOF
[Unit]
Description=Void Dominion Game Server
Documentation=https://github.com/Moonwuk/moongame
After=docker.service network-online.target
Wants=network-online.target
Requires=docker.service

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$INSTALL_DIR/deploy
Environment="PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
EnvironmentFile=$ENV_FILE

# Запуск сервера
ExecStart=/usr/bin/docker compose up --remove-orphans

# Остановка
ExecStop=/usr/bin/docker compose down

# Автоматический перезапуск при ошибке
Restart=always
RestartSec=10
StartLimitInterval=60
StartLimitBurst=3

# Логирование
StandardOutput=journal
StandardError=journal
SyslogIdentifier=moongame

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable $SERVICE_NAME.service
log_success "Systemd сервис настроен"

# Создание скрипта обновления
log_info "Создание скрипта быстрого обновления..."
cat > "$INSTALL_DIR/update-dev.sh" << 'UPDATEEOF'
#!/bin/bash

set -e

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="moongame"

echo "[*] Останавливаем сервер..."
sudo systemctl stop $SERVICE_NAME

echo "[*] Обновляем код из репозитория..."
cd $INSTALL_DIR
git pull origin main

echo "[*] Запускаем сервер..."
sudo systemctl start $SERVICE_NAME

echo "[✓] Обновление завершено!"
echo "[*] Логи: sudo journalctl -u $SERVICE_NAME -f"
UPDATEEOF

chmod +x "$INSTALL_DIR/update-dev.sh"
chown $SERVICE_USER:$SERVICE_USER "$INSTALL_DIR/update-dev.sh"
log_success "Скрипт обновления создан"

# Создание хелпера для управления
log_info "Создание управляющих команд..."
cat > /usr/local/bin/moongame << 'HELPEREOF'
#!/bin/bash

SERVICE_NAME="moongame"
INSTALL_DIR="/opt/moongame"

case "$1" in
    start)
        sudo systemctl start $SERVICE_NAME
        echo "Сервер запущен"
        ;;
    stop)
        sudo systemctl stop $SERVICE_NAME
        echo "Сервер остановлен"
        ;;
    restart)
        sudo systemctl restart $SERVICE_NAME
        echo "Сервер перезапущен"
        ;;
    status)
        sudo systemctl status $SERVICE_NAME
        ;;
    logs)
        sudo journalctl -u $SERVICE_NAME -f
        ;;
    update)
        bash $INSTALL_DIR/update-dev.sh
        ;;
    shell)
        cd $INSTALL_DIR
        bash
        ;;
    *)
        echo "Void Dominion — управление сервером"
        echo ""
        echo "Использование: moongame [команда]"
        echo ""
        echo "Команды:"
        echo "  start       — запустить сервер"
        echo "  stop        — остановить сервер"
        echo "  restart     — перезапустить сервер"
        echo "  status      — статус сервера"
        echo "  logs        — вывести логи (Ctrl+C для выхода)"
        echo "  update      — обновить код и перезапустить"
        echo "  shell       — оболочка в директории проекта"
        echo ""
        ;;
esac
HELPEREOF

chmod +x /usr/local/bin/moongame
log_success "Команды CLI установлены"

# Запуск сервера
log_info "Запуск Docker контейнеров..."
log_warning "Это займет время (~2-3 минуты) при первом запуске..."
cd "$INSTALL_DIR/deploy"
sudo -u $SERVICE_USER docker compose up -d --build

# Проверка здоровья сервера
log_info "Проверка здоровья сервера..."
sleep 10

for i in {1..30}; do
    if curl -sf http://localhost:$INTERNAL_PORT/health &>/dev/null; then
        log_success "Сервер готов к работе!"
        break
    fi
    if [ $i -eq 30 ]; then
        log_error "Сервер не отвечает (проверь: moongame logs)"
        exit 1
    fi
    echo -n "."
    sleep 1
done

# Финальная информация
echo ""
log_success "=========================================="
log_success "Установка завершена!"
log_success "=========================================="
echo ""
echo -e "${BLUE}🎮 Доступ к серверу:${NC}"
echo "  Локально:  http://$INTERNAL_IP:$INTERNAL_PORT"
echo "  Снаружи:   http://$EXTERNAL_IP:$EXTERNAL_PORT (требует проксирования)"
echo ""
echo -e "${BLUE}⚙️  Управление:${NC}"
echo "  Логи:           moongame logs"
echo "  Статус:         moongame status"
echo "  Обновление:     moongame update"
echo "  Перезапуск:     moongame restart"
echo "  Оболочка:       moongame shell"
echo ""
echo -e "${BLUE}📋 Информация о базе:${NC}"
echo "  PostgreSQL Пароль: $POSTGRES_PASSWORD"
echo "  (сохранен в $ENV_FILE)"
echo ""
echo -e "${YELLOW}⚠️  Для проксирования внешнего адреса:${NC}"
echo "  На роутере или nginx: перенаправь 94.190.83.220:95367 → $INTERNAL_IP:$INTERNAL_PORT"
echo ""
echo -e "${GREEN}✓ Сервер готов!${NC}"
echo ""
