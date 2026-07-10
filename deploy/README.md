# Деплой Void Dominion — runbook (REL-3)

Сервер игры поднимается **одной командой** и сам себя чинит. Всё в этом каталоге.

## Запуск (одна команда)

```bash
cd deploy && docker compose up -d --build
```

Это собирает образ (multi-stage → distroless, non-root) и поднимает **два сервиса**:

| Сервис     | Что это                                                | Порт                      |
| ---------- | ------------------------------------------------------ | ------------------------- |
| `server`   | прото-сервер: игра по адресу `/` + WebSocket-матч      | `8788` (наружу)           |
| `postgres` | durable-хранилище матчей (рестарт сервера не теряет их) | `127.0.0.1:5432` (только loopback) |

Игроки просто открывают `http://<хост>:8788/` — connect-оверлей сам подставляет
`ws(s)://` того же origin'а.

Переменные (можно в `.env` рядом с `docker-compose.yml`):

- `POSTGRES_PASSWORD` — пароль БД (обязательно смените вне локального теста);
- `TIME_SCALE` — множитель wall→game времени (по умолчанию `1` = real-time 24/7;
  для быстрых плейтестов удобно `200`).

## Отказоустойчивость — что уже сделано

- **Автоперезапуск**: `restart: unless-stopped` на обоих сервисах — краш/OOM/ребут
  хоста самовосстанавливаются. Один раз включите автозапуск демона:
  `sudo systemctl enable docker`.
- **Durable-матчи**: сервер снапшотит мир в Postgres (`DATABASE_URL` уже прописан на
  compose-сеть) — после рестарта контейнера матч **продолжается**, а не теряется.
  Данные Postgres живут в volume `void-pgdata` и переживают пересоздание контейнеров.
- **Healthchecks**: образ сервера сам проверяет `GET /health`; `server` стартует только
  после **здорового** Postgres (`condition: service_healthy`).
- **Ограниченные логи**: json-file 10MB×3 на сервис — диск не переполняется.
- **Безопасность поверхности**: distroless-образ без shell/apt (см. `Dockerfile`),
  digest-pinned базовые слои, non-root; Postgres не выставлен наружу.

## Обновление до свежего main

```bash
cd <repo> && git pull
cd deploy && docker compose up -d --build   # пересборка + бесшовная замена сервера
```

Матч переживает обновление за счёт снапшота в Postgres.

## Статус · логи · здоровье

```bash
docker compose ps                        # состояние + health
docker compose logs -f server            # живые логи сервера
curl -s http://127.0.0.1:8788/health     # liveness руками
```

## Бэкап и восстановление БД

```bash
# бэкап (можно в cron, например ежедневно в 04:00)
docker compose exec -T postgres pg_dump -U void void | gzip > void-$(date +%F).sql.gz

# восстановление в чистый volume
docker compose down && docker volume rm deploy_void-pgdata
docker compose up -d postgres
gunzip -c void-2026-07-10.sql.gz | docker compose exec -T postgres psql -U void void
docker compose up -d --build
```

Пример cron-строки (`crontab -e`):

```
0 4 * * * cd /path/to/repo/deploy && docker compose exec -T postgres pg_dump -U void void | gzip > /backups/void-$(date +\%F).sql.gz
```

## Альтернатива без Docker (tmux на VPS)

`bash deploy/serve.sh` — прежний путь: pull (по deploy-ключу/токену) + `pnpm serve`
в detached-tmux. Конфиг — `deploy/server.env` (см. `server.env.example`). Postgres при
этом поднимайте compose'ом (только сервис `postgres`) или укажите свой `DATABASE_URL`.

## Известные границы (честно)

- **Один процесс — один хост**: мульти-процессное масштабирование (pg-boss шов в
  `LazyRoomRegistry`) — следующий этап; текущая отказоустойчивость = автоперезапуск +
  durable-резюме, не горячий резерв.
- **TLS**: наружный HTTPS/WSS вешайте реверс-прокси (Caddy/Traefik/nginx) перед `8788`
  — приложение слушает голый HTTP за прокси.
