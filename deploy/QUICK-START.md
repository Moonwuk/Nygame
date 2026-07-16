# 🚀 Быстрый старт (5 минут)

## Шаг 1: Подключись к Ubuntu серверу

```bash
ssh user@192.168.1.7
# или используй SSH ключ
ssh -i ~/.ssh/your_key user@192.168.1.7
```

## Шаг 2: Запусти скрипт установки

```bash
# Перейди в директорию, где находится репозиторий MoonGame
cd /path/to/MoonGame

# Запусти скрипт с правами администратора
sudo bash deploy/install-ubuntu.sh
```

**Что происходит:**
- ✅ Установка Docker (если не установлен)
- ✅ Клонирование репозитория в `/opt/moongame`
- ✅ Создание конфигурации (PostgreSQL + сервер)
- ✅ Запуск Docker контейнеров
- ✅ Автозапуск при перезагрузке

Время: **2-3 минуты**

## Шаг 3: Проверь, что всё работает

```bash
# Провери статус
moongame status

# Проверь логи (должно быть "Server ready")
moongame logs

# Дождись, пока контейнеры будут ready (30-60 секунд)
# Выход: Ctrl+C
```

## Шаг 4: Открой игру в браузере

- На ноутбуке, подключенном в локальную сеть:
  ```
  http://192.168.1.7:8788
  ```

- Если с внешней сети (через 94.190.83.220:95367):
  - Нужна настройка проксирования (см. [README-UBUNTU.md](README-UBUNTU.md))

## 🔄 Обновление кода

Во время разработки, чтобы обновить проект:

```bash
# Все в одной команде
moongame update

# Готово! Сервер перезапустился с новым кодом
```

Это займет **10-15 секунд** (не требует пересборки Docker образов).

## 📊 Полезные команды

```bash
# Логи (реальное время)
moongame logs

# Статус
moongame status

# Контроль сервера
moongame start      # запустить
moongame stop       # остановить
moongame restart    # перезапустить

# Попасть в директорию проекта
moongame shell

# Вручную в директорию
cd /opt/moongame
```

## 🐛 Если что-то не работает

```bash
# 1. Проверь логи (там будет ошибка)
moongame logs | head -50

# 2. Проверь, запущены ли контейнеры
docker ps

# 3. Перезапусти
moongame restart

# 4. Если контейнеры не запускаются
sudo systemctl status moongame
journalctl -u moongame -n 50
```

## 💡 Советы

1. **SSH без пароля (по ключам):**
   ```bash
   ssh-copy-id -i ~/.ssh/id_rsa.pub user@192.168.1.7
   ```

2. **Aliases для быстроты:**
   ```bash
   # Добавь в ~/.bashrc на ноутбуке:
   alias mg-update='ssh user@192.168.1.7 "moongame update"'
   alias mg-logs='ssh user@192.168.1.7 "moongame logs"'
   alias mg-restart='ssh user@192.168.1.7 "moongame restart"'
   ```
   Затем:
   ```bash
   mg-update    # обновить
   mg-logs      # логи
   mg-restart   # перезапустить
   ```

3. **VS Code Remote SSH:**
   - Установи расширение "Remote - SSH"
   - Подключись к серверу прямо из VS Code
   - Редактируй файлы удаленно

## 📞 Что дальше?

- Полная документация: [README-UBUNTU.md](README-UBUNTU.md)
- Отладка: [README-UBUNTU.md#-отладка](README-UBUNTU.md#--отладка)
- Проблемы: [README-UBUNTU.md#-решение-проблем](README-UBUNTU.md#--решение-проблем)

---

**Готово!** Если скрипт выполнил все шаги, сервер должен быть запущен и доступен на `http://192.168.1.7:8788` 🎮
