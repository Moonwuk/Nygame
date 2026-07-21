# Void Dominion — Установка на Ubuntu Server

Готовый пакет для развертывания проекта на Ubuntu Server с использованием Docker Compose.

## 📋 Предварительные требования

- Ubuntu 20.04+ (протестировано на 22.04 LTS)
- Минимум 2GB оперативной памяти
- 10GB свободного места на диске
- Интернет-соединение для скачивания Docker образов
- Доступ в интернет для клонирования репозитория

## 🚀 Быстрая установка (в один клик)

```bash
# На сервере, от пользователя с sudo доступом:
sudo bash deploy/install-ubuntu.sh
```

Скрипт автоматически:
1. Установит Docker и Docker Compose
2. Клонирует репозиторий проекта
3. Настроит PostgreSQL базу данных
4. Создаст systemd сервис для автозапуска
5. Запустит сервер

Процесс займет **2-3 минуты** при первом запуске (скачивание образов Docker).

## 🎮 Доступ к серверу

После установки сервер будет доступен по адресам:

- **Локально:** `http://192.168.1.7:8788`
- **Снаружи:** требует проксирования на `http://94.190.83.220:95367`

### Настройка проксирования (для внешнего доступа)

Если хочешь играть с внешних устройств через `94.190.83.220:95367`:

#### Вариант 1: Nginx на том же сервере

```bash
sudo apt-get install -y nginx

# Создай конфиг:
sudo bash -c 'cat > /etc/nginx/sites-available/moongame << EOF
server {
    listen 95367;
    server_name 94.190.83.220;

    location / {
        proxy_pass http://192.168.1.7:8788;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_read_timeout 86400;
    }
}
EOF'

sudo ln -sf /etc/nginx/sites-available/moongame /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

#### Вариант 2: На роутере

Настрой Port Forward:
- Внешний порт: `95367`
- Внутренний IP: `192.168.1.7`
- Внутренний порт: `8788`
- Протокол: TCP

## ⚙️ Управление сервером

После установки используй команду `moongame` для управления:

```bash
# Просмотр логов (в реальном времени)
moongame logs

# Статус сервера
moongame status

# Управление
moongame start      # запустить
moongame stop       # остановить
moongame restart    # перезапустить

# Обновление кода и перезапуск (разработка)
moongame update

# Попасть в shell проекта
moongame shell
```

## 📝 Быстрое обновление кода (разработка)

Во время разработки для быстрого обновления:

```bash
# Способ 1: одной командой
moongame update

# Способ 2: вручную
cd /opt/moongame
git pull origin main
moongame restart

# Способ 3: скрипт обновления
bash /opt/moongame/update-dev.sh
```

Это займёт ~1–3 минуты: `git pull` + пересборка Docker-образа + перезапуск на новом
образе. (Раньше тут обещалось «10–15 секунд без пересборки» — то обновление на самом
деле перезапускало старый образ, свежий код в контейнер не попадал.)

## 🔍 Отладка

### Проверка здоровья сервера

```bash
curl http://localhost:8788/health
# Должен вернуть 200 OK
```

### Просмотр логов Docker

```bash
# Логи systemd сервиса
sudo journalctl -u moongame -f

# Или напрямую Docker
docker compose -f /opt/moongame/deploy/docker-compose.yml logs -f

# Только ошибки
docker compose -f /opt/moongame/deploy/docker-compose.yml logs -f --tail 50 | grep -i error
```

### Проверка работающих контейнеров

```bash
docker ps | grep moongame
```

### Переподключение к контейнерам (если они упали)

```bash
sudo systemctl restart moongame
```

## 🔐 Безопасность

### Пароль PostgreSQL

Пароль генерируется случайно и сохраняется в:
```bash
cat /opt/moongame/deploy/server.env | grep POSTGRES_PASSWORD
```

**ВАЖНО:** Этот файл содержит секреты и добавлен в `.gitignore`.

### Разработка vs Production

Текущая конфигурация оптимизирована для **разработки**:
- `GATE=0` — простая авторизация
- `SEAT_LOCK=0` — без блокировки мест
- `TIME_SCALE=100` — ускоренное время (1 реальная минута = 100 игровых минут)

Для production:
- Поменяй `GATE=1`, `SEAT_LOCK=1`
- Установи `TIME_SCALE=1` для реального времени
- Добавь правильный `AUTH_JWT_SECRET`
- Измени пароли БД

## 📊 Мониторинг (опционально)

### Простая проверка нагрузки

```bash
docker stats
```

### Размер базы данных

```bash
# Через psql внутри контейнера
docker exec -it $(docker ps -qf "name=postgres") psql -U void -d void -c "\l+"
```

## 🛠️ Восстановление

### Если контейнеры упали

```bash
moongame status        # проверить статус
moongame restart       # перезапустить
moongame logs          # просмотреть логи
```

### Чистая переустановка

```bash
# Удалить все (будут удалены логи и БД!)
sudo systemctl stop moongame
docker compose -f /opt/moongame/deploy/docker-compose.yml down -v

# Переустановить
sudo bash /opt/moongame/deploy/install-ubuntu.sh
```

### Сохранение/восстановление БД

```bash
# Экспорт БД
docker exec -it $(docker ps -qf "name=postgres") pg_dump -U void -d void > /tmp/void-backup.sql

# Импорт БД
docker exec -i $(docker ps -qf "name=postgres") psql -U void -d void < /tmp/void-backup.sql
```

## 📞 Решение проблем

### Ошибка: "Permission denied" при запуске скрипта

```bash
chmod +x deploy/install-ubuntu.sh
sudo bash deploy/install-ubuntu.sh
```

### Docker не установлен или не работает

```bash
sudo systemctl start docker
sudo systemctl enable docker
```

### Порт 8788 уже занят

```bash
# Проверить что занимает порт
sudo lsof -i :8788

# Изменить порт в /opt/moongame/deploy/docker-compose.yml
# и перезапустить
```

### Сервер не отвечает через некоторое время

```bash
# Проверить логи
moongame logs

# Перезапустить
moongame restart
```

### Недостаточно места на диске

```bash
# Очистить старые Docker образы
docker image prune -a

# Проверить размер данных БД
du -sh /var/lib/docker/volumes/void-pgdata/
```

## 📚 Дополнительно

### Версия времени (TIME_SCALE)

Для разработки используется `TIME_SCALE=100`:
- 1 реальная минута = 100 игровых минут
- Флоты строятся быстро, видны изменения в игре в реальном времени

Для тестирования в реальном времени:
```bash
# Редактируем env файл
nano /opt/moongame/deploy/server.env
# Меняем TIME_SCALE=100 на TIME_SCALE=1
moongame restart
```

### Использование с локальным Git

Если ты разработчик и хочешь работать локально + тестировать на сервере:

1. На ноутбуке: разработка в VS Code (обычно)
2. На сервере: `moongame update` автоматически берет последний `main`
3. Это работает, так как скрипт просто делает `git pull` и перезапуск

Если хочешь использовать другую ветку:
```bash
cd /opt/moongame
git checkout staging
moongame restart
```

## 🎓 Как это работает

Скрипт установки:
1. Устанавливает Docker + Docker Compose
2. Создает пользователя `moongame` для безопасности
3. Клонирует репозиторий в `/opt/moongame`
4. Создает конфиг окружения (`.env`)
5. Регистрирует systemd сервис для автозапуска
6. Запускает `docker compose up`

Все контейнеры:
- Автоматически перезапускаются при сбое
- Сохраняют состояние в PostgreSQL
- Используют том Docker для персистентности БД
- Логируют в systemd журнал

## 📄 Лицензия

Void Dominion © Moonwuk Games. Unlicensed.

---

**Вопросы?** Проверь логи: `moongame logs`
