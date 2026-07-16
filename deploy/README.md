# 🚀 Void Dominion — Развертывание на Ubuntu Server

Полный пакет скриптов и документации для однокликовой установки игрового сервера на Ubuntu.

## 📖 Быстрый старт

### Вариант 1: Автоматическая установка (рекомендуется)

```bash
# На Ubuntu Server, от пользователя с sudo доступом:
sudo bash deploy/install-ubuntu.sh
```

**Это делает:**
- ✅ Установит Docker + Docker Compose
- ✅ Клонирует репозиторий в `/opt/moongame`
- ✅ Настроит systemd сервис для автозапуска
- ✅ Запустит сервер (2-3 минуты)

**Результат:**
```bash
moongame status      # проверить статус
moongame logs        # просмотреть логи
moongame update      # быстрое обновление кода
```

### Вариант 2: Docker Compose вручную (как прежде)

```bash
cd deploy && docker compose up -d --build
```

Поднимает **два сервиса**:

| Сервис     | Назначение | Порт |
|-----------|-----------|------|
| `server` | Игровой сервер + WebSocket | `8788` |
| `postgres` | База данных (durable хранилище) | `127.0.0.1:5432` (только локально) |

## 📋 Переменные окружения

Все переменные в `server.env` (см. `server.env.example`):

| Переменная | Описание | Значение по умолчанию |
|-----------|---------|----------------------|
| `PORT` | Порт сервера | `8788` |
| `TIME_SCALE` | Ускорение времени (1=реальное) | `100` (разработка) |
| `GATE` | Включить валидацию action.v1 | `0` (разработка) |
| `SEAT_LOCK` | Блокировка мест | `0` (разработка) |
| `DATABASE_URL` | Строка подключения PostgreSQL | `postgres://void:void@postgres:5432/void` |
| `POSTGRES_PASSWORD` | Пароль БД | генерируется случайно |

**Для разработки** используется конфиг из `install-ubuntu.sh`:
- `TIME_SCALE=100` — 1 сек = 100 игровых сек (быстрые тесты)
- `GATE=0` — простая авторизация
- `SEAT_LOCK=0` — без блокировки мест

## 🛠️ Управление сервером (после автоустановки)

После запуска `install-ubuntu.sh` используй команду `moongame`:

```bash
moongame start      # запустить сервер
moongame stop       # остановить
moongame restart    # перезапустить
moongame status     # статус сервера
moongame logs       # просмотреть логи (реальное время)
moongame update     # быстрое обновление кода (10-15 сек)
moongame shell      # shell в директории проекта
```

## 🔄 Отказоустойчивость

- **Автоперезапуск**: systemd сервис `moongame` автоматически перезапускает контейнеры при краше
- **Durable-матчи**: состояние сохраняется в PostgreSQL → матч продолжается после рестарта
- **Healthchecks**: образ проверяет `/health` endpoint; сервер стартует только после здорового PostgreSQL
- **Автозапуск**: при перезагрузке сервера сервис запускается автоматически
- **Ограниченные логи**: логи ротируются (10MB×3) чтобы не переполнить диск

## 🌐 Внешний доступ

Для доступа через `94.190.83.220:95367` запусти:

```bash
sudo bash deploy/setup-proxy.sh
```

Это настроит Nginx проксирование с поддержкой WebSocket.

Или настрой Port Forwarding на роутере:
- Внешний порт: `95367 TCP`
- Внутренний IP: `192.168.1.7`
- Внутренний порт: `8788 TCP`

## 📚 Документация

| Файл | Для кого | Время |
|------|----------|-------|
| **[QUICK-START.md](QUICK-START.md)** | Я спешу | 5 мин |
| **[INSTALLATION.md](INSTALLATION.md)** | Я хочу все понять | 15 мин |
| **[README-UBUNTU.md](README-UBUNTU.md)** | Мне нужна справка | справочник |

## 🔍 Статус и логи

```bash
# Автоустановка
moongame status                    # статус сервера
moongame logs                      # логи (реальное время)
moongame logs | tail -50           # последние 50 строк

# Docker Compose (вручную)
docker compose ps                  # состояние контейнеров
docker compose logs -f server      # логи сервера
curl -s http://127.0.0.1:8788/health  # проверка здоровья
```

## 🛠️ Отладка и восстановление

### Если сервер не запускается

```bash
# 1. Проверь логи
moongame logs | head -50

# 2. Проверь статус Docker
docker ps -a | grep moongame

# 3. Попробуй перезапустить
moongame restart

# 4. Если проблема продолжается
sudo journalctl -u moongame -n 100
```

### Замок мест (SEAT_LOCK) — восстановление

Если игрок потерял билет (почистил localStorage / сменил устройство):

```bash
# Сбросить замок места (следующий вход сминтит новый билет)
docker compose exec postgres psql -U void void \
  -c "UPDATE seats SET ticket_hash = NULL WHERE room='proto' AND nick='Имя';"

# Или полностью освободить место
# docker compose exec postgres psql -U void void \
#   -c "DELETE FROM seats WHERE room='proto' AND nick='Имя';"
```

**Важно:** не публикуй ссылки с `?ticket=` в access-логах реверс-прокси — это bearer-секрет.

## 💾 Бэкап и восстановление БД

```bash
# Экспорт БД
docker compose exec -T postgres pg_dump -U void void | gzip > void-$(date +%F).sql.gz

# Восстановление в чистый volume
docker compose down && docker volume rm deploy_void-pgdata
docker compose up -d postgres
gunzip -c void-2026-07-10.sql.gz | docker compose exec -T postgres psql -U void void
docker compose up -d --build
```

Автоматический бэкап (crontab):
```bash
# Ежедневно в 04:00
0 4 * * * cd /path/to/repo/deploy && docker compose exec -T postgres pg_dump -U void void | gzip > /backups/void-$(date +\%F).sql.gz
```

## 🔗 Альтернативные пути развертывания

### Docker Compose вручную (как раньше)

```bash
cd deploy && docker compose up -d --build
```

### Без Docker (tmux на VPS) — legacy

```bash
bash deploy/serve.sh
```

Требует:
- Node.js >= 20
- pnpm
- PostgreSQL (или используй `docker compose up -d postgres`)
- Конфиг: `deploy/server.env` (см. `server.env.example`)

## 📊 Известные границы

- **Один процесс**: мульти-процессное масштабирование (pg-boss) — будущий этап
- **TLS**: вешай реверс-прокси (Nginx/Traefik/Caddy) перед `8788` — приложение слушает HTTP
- **Один хост**: отказоустойчивость = автоперезапуск + durable-резюме (не горячий резерв)

## 📞 Помощь и дальнейшее

1. Прочитай **[QUICK-START.md](QUICK-START.md)** (5 мин)
2. Полное руководство: **[INSTALLATION.md](INSTALLATION.md)** (15 мин)
3. Все вопросы: **[README-UBUNTU.md](README-UBUNTU.md)** (справочник)
4. Проблемы: `moongame logs` и `sudo journalctl -u moongame -n 100`

---

**Готово!** Запусти:
```bash
sudo bash deploy/install-ubuntu.sh
```
