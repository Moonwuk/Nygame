# Void Dominion — Полное руководство установки на Ubuntu Server

Полный набор скриптов и инструкций для развертывания игрового сервера на Ubuntu Server.

**Автор:** Moonwuk Games  
**Дата:** 2026-07-16  
**Версия:** 1.0

---

## 📦 Что включено

### Скрипты установки

| Файл | Назначение | Время |
|------|-----------|-------|
| `install-ubuntu.sh` | **Основной скрипт** — полная установка (Docker, БД, сервис) | 2-3 мин |
| `setup-proxy.sh` | Настройка Nginx для внешнего доступа (опционально) | 1 мин |
| `serve.sh` | Обновление кода на VPS (legacy, используй `moongame update`) | — |

### Документация

| Файл | Назначение |
|------|-----------|
| `QUICK-START.md` | **Начни отсюда** — 5-минутный старт |
| `README-UBUNTU.md` | Полная документация, отладка, FAQ |
| `INSTALLATION.md` | Этот файл — обзор всей системы |

---

## 🚀 Установка за 3 шага

### Шаг 1: Подготовка сервера

Если это чистая Ubuntu:

```bash
# Подключись к серверу
ssh user@192.168.1.7

# Убедись, что есть sudo доступ
sudo whoami  # должен показать "root"

# Опционально: обнови систему
sudo apt-get update && sudo apt-get upgrade -y
```

### Шаг 2: Установка

```bash
# Скачай репозиторий (если еще не скачан)
git clone https://github.com/Moonwuk/moongame.git
cd moongame

# Или если уже есть репозиторий
cd /path/to/moongame

# Запусти скрипт установки
sudo bash deploy/install-ubuntu.sh
```

Скрипт автоматически:
- ✅ Устанавливает Docker + Docker Compose
- ✅ Клонирует репозиторий в `/opt/moongame`
- ✅ Генерирует конфиги (пароли, переменные окружения)
- ✅ Создает systemd сервис для автозапуска
- ✅ Запускает Docker контейнеры

### Шаг 3: Проверка

```bash
# Проверь, что всё работает
moongame status

# Смотри логи
moongame logs

# Открой http://192.168.1.7:8788 в браузере
```

---

## 🎮 После установки

### Команды управления

Все команды через `moongame`:

```bash
moongame start      # запустить сервер
moongame stop       # остановить
moongame restart    # перезапустить
moongame status     # статус
moongame logs       # логи в реальном времени
moongame update     # быстрое обновление кода
moongame shell      # попасть в директорию проекта
```

### Обновление кода

Самое быстрое обновление кода:

```bash
# Все в одной строке
moongame update

# Что происходит:
# 1. Сервер останавливается
# 2. git pull origin main скачивает изменения
# 3. Сервер перезапускается (10-15 сек)
```

**Нет пересборки Docker образов!** Это очень быстро (как для разработки).

### Доступ к серверу

- **Локально:** `http://192.168.1.7:8788`
- **Снаружи:** требует настройки проксирования (см. ниже)

---

## 🌐 Внешний доступ (для игроков из интернета)

### Вариант 1: Nginx на том же сервере (рекомендуется)

```bash
# Установи и настрой проксирование
sudo bash deploy/setup-proxy.sh

# Готово! Теперь доступна по адресу:
# http://94.190.83.220:95367
```

### Вариант 2: Проксирование на роутере

На роутере (тот, где точка доступа Wi-Fi) в "Port Forwarding":
```
Внешний порт: 95367 TCP
Внутренний IP: 192.168.1.7
Внутренний порт: 8788 TCP
```

### Вариант 3: Облачный VPS

Если сервер в облаке (AWS, DigitalOcean и т.д.), просто:

```bash
# Замени IP адреса в скриптах на облачные
# Отредактируй переменные в install-ubuntu.sh:
sudo nano /opt/moongame/deploy/install-ubuntu.sh
# INTERNAL_IP=<облачный_IP>
# EXTERNAL_IP=<облачный_IP>

# Перезапусти
sudo bash /opt/moongame/deploy/install-ubuntu.sh
```

---

## 🔧 Конфигурация

### Основные параметры

Все параметры в `/opt/moongame/deploy/server.env`:

```bash
# Время разработки (ускоренное)
TIME_SCALE=100         # 1 сек = 100 игр.сек (быстрые тесты)

# Для production
# TIME_SCALE=1         # Реальное время

# Порт сервера
PORT=8788

# БД (опционально, включена по умолчанию)
# DATABASE_URL=postgres://void:PASSWORD@postgres:5432/void

# Остальные параметры (разработка)
GATE=0                 # простая авторизация
SEAT_LOCK=0            # без блокировки мест
```

### Изменение конфигурации

```bash
# Отредактировать
nano /opt/moongame/deploy/server.env

# Применить изменения
moongame restart
```

---

## 📊 Мониторинг и логи

### Логи

```bash
# Логи приложения (systemd)
moongame logs
sudo journalctl -u moongame -f

# Логи Docker
docker compose -f /opt/moongame/deploy/docker-compose.yml logs -f

# Логи прокси Nginx (если включен)
tail -f /var/log/nginx/moongame-access.log
```

### Проверка здоровья

```bash
# API health check
curl http://localhost:8788/health

# Статус контейнеров
docker ps | grep moongame

# Использование ресурсов
docker stats

# Размер БД
docker exec -it $(docker ps -qf "name=postgres") psql -U void -d void -c "\l+"
```

---

## 🔐 Безопасность

### Пароль БД

Пароль генерируется случайно при установке:

```bash
cat /opt/moongame/deploy/server.env | grep POSTGRES_PASSWORD
```

Файл `.env` добавлен в `.gitignore` и не коммитится.

### SSH доступ

Используй SSH ключи вместо паролей:

```bash
# На локальном ноутбуке
ssh-copy-id -i ~/.ssh/id_rsa.pub user@192.168.1.7

# Теперь можешь подключаться без пароля
ssh user@192.168.1.7
```

### Firewall

Если включен UFW:

```bash
# Разреши порты
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 8788/tcp  # Игровой сервер
sudo ufw allow 95367/tcp # Nginx (если используется)
sudo ufw enable
```

---

## 🛠️ Отладка и восстановление

### Если сервер не запускается

```bash
# 1. Проверь логи
moongame logs | head -50

# 2. Проверь статус Docker
docker ps -a | grep moongame

# 3. Перезапусти
moongame restart

# 4. Если проблема продолжается, смотри подробные логи
sudo journalctl -u moongame -n 100 --no-pager
```

### Если контейнеры упали

```bash
# Проверка всех контейнеров
docker ps -a

# Перезапуск конкретного контейнера
docker restart <container_id>

# Или полный перезапуск
moongame restart
```

### Сохранение и восстановление БД

```bash
# Экспорт БД
docker exec -it $(docker ps -qf "name=postgres") pg_dump -U void -d void > /tmp/void-backup-$(date +%Y%m%d).sql

# Импорт БД
docker exec -i $(docker ps -qf "name=postgres") psql -U void -d void < /tmp/void-backup-20260716.sql
```

### Полная переустановка

```bash
# Удалить все (БД, логи)
sudo systemctl stop moongame
docker compose -f /opt/moongame/deploy/docker-compose.yml down -v

# Переустановить
sudo bash /opt/moongame/deploy/install-ubuntu.sh
```

---

## 📈 Масштабирование

### На одном сервере

Текущая конфигурация рассчитана на:
- Одного игрока для тестирования
- Несколько параллельных соединений
- Примерно 1000 действий/сек в пиковых нагрузках

### Для более высоких нагрузок

1. **Вертикальное масштабирование** (больше памяти/CPU):
   - Увеличь ресурсы в docker-compose.yml

2. **Горизонтальное масштабирование** (несколько серверов):
   - Используй несколько MATCHES в env
   - Добавь load balancer впереди

3. **Оптимизация БД**:
   - Индексы на часто запрашиваемые поля
   - Архивирование старых данных

---

## 📚 Дополнительно

### VS Code Remote SSH

Если развиваешь локально и хочешь видеть изменения на сервере:

1. Установи расширение "Remote - SSH" в VS Code
2. Подключись к серверу через палитру команд (`Remote-SSH: Connect to Host`)
3. Открой `/opt/moongame` в VS Code
4. Редактируй файлы (они синхронизируются)
5. Запусти `moongame update` для перезагрузки

### Git Deploy Key

Для автоматического обновления без хранения токена:

```bash
# На сервере
ssh-keygen -t ed25519 -f ~/.ssh/moongame_deploy -N ""

# Добавь ~/.ssh/moongame_deploy.pub в GitHub репо как Deploy Key

# Используй SSH для клонирования
cd /opt/moongame
git remote set-url origin git@github.com:Moonwuk/moongame.git
```

### Переменные окружения

Полный список доступных переменных в `/opt/moongame/deploy/server.env.example`:

```bash
PORT              # Порт сервера (8788)
TIME_SCALE        # Ускорение времени (1-1000)
GATE              # Включить авторизацию (0/1)
SEAT_LOCK         # Блокировка мест (0/1)
DATABASE_URL      # Строка подключения PostgreSQL
POSTGRES_PASSWORD # Пароль БД
```

---

## 🤝 Помощь

### Логирование

Проверь логи перед тем, как искать проблему:

```bash
# Основные логи
moongame logs

# Более подробные
sudo journalctl -u moongame -n 200

# Docker логи
docker compose -f /opt/moongame/deploy/docker-compose.yml logs --tail 100
```

### Поиск ошибок

```bash
# Найди все ошибки в логах
moongame logs 2>&1 | grep -i error

# Проверь здоровье сервера
curl -v http://localhost:8788/health

# Проверь подключение к БД
docker exec -it $(docker ps -qf "name=postgres") psql -U void -d void -c "SELECT 1;"
```

### Контакты

- GitHub Issues: https://github.com/Moonwuk/moongame/issues
- Документация: `docs/` в репозитории

---

## 📋 Чек-лист установки

- [ ] Ubuntu Server подготовлена (> 20.04)
- [ ] Скрипт `install-ubuntu.sh` запущен с успехом
- [ ] `moongame status` показывает "running"
- [ ] `moongame logs` не содержит ошибок
- [ ] `http://192.168.1.7:8788` открывается в браузере
- [ ] Игра загружается и показывает экран входа
- [ ] `moongame update` работает (тестирование обновления)
- [ ] Настроено внешнее проксирование (опционально)

---

## 🎓 Архитектура системы

```
┌─────────────────────────────────────────┐
│         Ubuntu Server                   │
├─────────────────────────────────────────┤
│  systemd: moongame.service             │
│  ├─ docker compose                      │
│  │  ├─ server container                │
│  │  │  ├─ Node.js                      │
│  │  │  ├─ Fastify (HTTP + WebSocket)   │
│  │  │  └─ Game Core                    │
│  │  └─ postgres container               │
│  │     └─ Void Dominion БД             │
│  └─ Nginx (опционально)                |
│     └─ Проксирование внешних запросов  │
└─────────────────────────────────────────┘
```

**Данные:**
- Игровое состояние → PostgreSQL (JSONB)
- Логи → systemd журнал
- Конфиг → `/opt/moongame/deploy/server.env`

**Автозапуск:**
- systemd сервис настроен автоматически
- При перезагрузке сервер запускается самостоятельно

---

## 📝 Версия и лицензия

**Void Dominion** © Moonwuk Games, 2026  
Unlicensed (All rights reserved)

Скрипты установки: July 16, 2026  
Рекомендуемая версия Node.js: >= 20  
Docker Compose: >= 2.20

---

**🎮 Готов разрабатывать!**

Начни с [QUICK-START.md](QUICK-START.md) или запусти скрипт:
```bash
sudo bash deploy/install-ubuntu.sh
```
