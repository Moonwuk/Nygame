# Сервер: авторитет и транспорт — технический roadmap

> **Блок 2/7** из `tech-research.md` (§2 realtime-сервер, §5 транспорт/синхро). Авторитетный
> сервер вокруг детерминированного ядра: HTTP-скелет, match-actor, WebSocket-слой, дельта-sync,
> AOI, интеграция слоя действий. Персистентность/планировщик — `persistence-roadmap.md`;
> рантайм-безопасность (JWT/rate-limit/хардненинг) — `secure-environment-roadmap.md`. Формат —
> кирпичики. Расширяет Блок **F** (`backlog.md`). Статусы: ✅ · ⏳ · 🔒(dep).

## Текущее состояние (факт)

Есть in-memory slice: `MatchRoom` (advance → authorize → applyAction → broadcast), `wsServer`
(`createMultiplayerServer`, `/health`, upgrade-handshake `?player=`), дельта-broadcast
(`diffState`), идемпотентные квитанции, **запускаемый `pnpm dev:server`** + headless e2e-тест
двух игроков. Также уже в коде:

- **Фильтр видимости на отправке (SV-3.1):** `broadcastState` диффит каждого peer против
  `visibleState(playerId)`, а `eventVisibleTo` фильтрует события — скрытые миры/флоты физически
  не уходят (`matchRoom.ts`).
- **Per-player rate-limit действий** (`E_RATE_LIMIT`, транзиентно, без квитанции — `matchRoom.ts:449-466`)
  + **connection flood-guard** (грубый per-socket cap до парсинга — `wsServer.ts:200-220`).
- **Мульти-матч реестр** (`matchRegistry.ts`) + браузер матчей `GET /matches` и роутинг
  `/<prefix>/<id>` (`wsServer.ts`).
- **v1 offline-планировщик:** `tick()` / `msUntilNextEvent()` на `MatchRoom` — драйвер пробуждения
  двигает мир по расписанию без действия игрока.
- **Ограниченные квитанции** (FIFO-вытеснение старейших сверх `maxReceipts`, `matchRoom.ts`).
- **`?nick=`→seat-login** через `AccountStore` — вернувшийся ник получает свою сторону
  (`wsServer.ts:163-172`).

**Нет:** Fastify-скелета, интеграции `@void/action-layer`, per-player очереди (concurrency=1),
JWT, масштаба на >1 инстанс.

## Зависимости

`@void/action-layer` (готов каркас) · `persistence-roadmap.md` (F2/F3) · `core` (`visibleState`) ·
`secure-environment-roadmap.md` (SE-0.* JWT, SE-6.* rate-limit/очередь/туман).

---

## Фаза 0 · HTTP/жизненный цикл сервиса

### SV-0.1 · Fastify-скелет + health/readiness `[srv]` ✅ — M
**Цель:** заменить голый `node:http` на каркас с роутингом/плагинами/валидацией. **Бирка F1.**
**Подзадачи:** Fastify-инстанс; `/health` + `/ready`; структурные логи (pino); graceful shutdown (drain WS); схема-валидация HTTP-входа.
**Готово, когда:** сервер поднимается на Fastify; health/readiness отвечают; завершение дренит соединения.
**Сделано:** Fastify владеет HTTP; `/health` контентless (закрыт F-13), `/ready` со стор-probe `MatchStore.ping`, `/metrics` (агрегат, OPS-0.1), pino, error-handler (инвариант #4), graceful drain WS. WS-upgrade — на `app.server`. (HTTP-вход минимален → валидация инлайновая, не zod-схемы.)

### SV-0.2 · Match-actor модель `[srv]` ✅ — L
**Цель:** один логический актор на матч — сериализованная обработка, изоляция матчей.
**Подзадачи:** реестр матчей; почтовый ящик/очередь сообщений на матч; lifecycle load/idle/evict; согласовать с `MatchRoom`.
**Готово, когда:** действия матча обрабатываются строго последовательно внутри актора; матчи независимы.
**Сделано:** `MatchRegistry` (`InMemory` + `Lazy` с load-on-demand/idle-гибернацией/пробуждением к событию), per-room actor-mailbox сериализует committed-submit + lobby-start; боевой вход хостит N матчей через `LazyMatchRegistry` (SV-4.0 в state.md).

---

## Фаза 1 · Интеграция слоя действий

### SV-1.1 · Подключить `@void/action-layer` к WS-потоку `[srv][act]` ✅ — M
**Цель:** валидация/авторизация/идемпотентность/seq — единым гейтом перед редьюсером.
**Подзадачи:** входящее сообщение → `validateActionEnvelope` → `authorizeActionEnvelope` → `sequence-gate` → receipts → `applyAction`; стабильные `E_*` без утечки; покрыть интеграционным тестом (невалид/повтор/несанкц → безопасный отказ — **E3**).
**Готово, когда:** все действия проходят через гейт; e2e abuse-тест зелёный.
**Сделано:** `MatchRoom.gate?` — на gated-комнате `action.v1` проходит validate→payload-schema→authorize(session)→dedup→sequence, bare-`action` отклоняется; стабильные `E_*`; работает на sync- и durable-committed-путях; серверный `sessionId` (live-A), ограниченные стора (live-B). Abuse-e2e зелёный. Включается по флагу (`GATE=1`) — ждёт клиента, шлющего конверты.

### SV-1.2 · zod-схемы на каждый тип действия `[act]` ✅ — M
**Подзадачи:** схема валидации входа по типу действия (payload). **Бирка E1.**
**Готово, когда:** payload каждого типа валидируется по своей схеме.
**Сделано:** `shared-core/actions/payloadSchemas` — zod-схема на все 15 клиентских типов + `isValidActionPayload`, инжектится в гейт как `payloadValidator`; кривой payload или не-клиентский тип → `E_BAD_PAYLOAD` до редьюсера.

---

## Фаза 2 · WebSocket-слой и синхронизация

### SV-2.1 · Прод-WS поверх Fastify `[srv]` ✅ — M
**Цель:** WS-слой с пушем дельт (есть прототип в `wsServer`). **Бирка F4.**
**Подзадачи:** интеграция WS в Fastify (или `@fastify/websocket`/uWS при нужде по throughput); сохранить дельта-протокол; origin-проверка; лимиты (payload cap ✅, idle/heartbeat — см. SE-6.1).
**Готово, когда:** клиенты получают `welcome`+дельты через прод-WS; нагрузочный smoke ок.
**Сделано:** `ws` (noServer) поверх Fastify-сервера (`app.server` upgrade); дельта-протокол сохранён байт-в-байт; origin-allowlist (F-06), payload cap, ping/pong-heartbeat, backpressure-дроп; soak-тест зелёный. (Throughput-переезд на uWS — при нужде, не сейчас.)

### SV-2.2 · Монотонный seq + ресинк `[srv]` 🔒(SV-2.1) — M
**Цель:** надёжная дельта-доставка с восстановлением.
**Подзадачи:** монотонный `seq` на матч; клиент применяет только `seq=cur+1`, иначе просит снапшот; полный `state` на join/ресинк; backpressure (см. SE-6.1). Детали гонок — `deep-technical-roadmap.md §3/§5`.
**Готово, когда:** при гэпе клиент корректно ресинкается; реконнект без дублей.

### SV-2.3 · Per-player очередь (анти-double-spend) `[srv]` 🔒(F2) — M
**Подзадачи:** concurrency=1 на ключ player/match поверх атомарного редьюсера. **Бирка F5** (= SE-6.3).
**Готово, когда:** два одновременных действия игрока не дают двойную трату; тест гонки.

---

## Фаза 3 · AOI / видимость на отправке

### SV-3.1 · Фильтр видимости перед broadcast `[srv]` ✅ — M
**Цель:** туман как граница безопасности + экономия трафика. **Бирка F6** (= SE-6.4).
**Подзадачи:** диффить per-peer против `visibleState(playerId)`, не полного состояния; кэш проекции на матч; тест anti-leak по байтам.
**Готово, когда:** игрок физически не получает невидимые данные; трафик снизился.
**Сделано:** `matchRoom.ts` — `broadcastState` диффит каждого peer против `visibleState(playerId)` (per-player baseline `lastVisible`; скрытые миры/флоты физически не уходят), `eventVisibleTo` режет невидимые события; per-player изоляция broadcast. (Кэш проекции per-match — при нужде по нагрузке, SV-3.2.)

### SV-3.2 · Interest management при масштабе `[srv]` 🔒(SV-3.1) — L
**Подзадачи:** подписка клиента только на видимые/близкие сектора; согласовать с шардингом (`operations-roadmap.md`).
**Готово, когда:** клиент подписан на релевантное подмножество; масштаб не ломает видимость.

---

## Фаза 4 · Масштаб транспорта

### SV-4.1 · Фан-аут между инстансами `[srv]` 🔒(SV-0.2,F2) — L
**Цель:** WS на >1 инстанс без поломки auth/видимости.
**Подзадачи:** шардинг по матчу (match-actor); fan-out через Redis pub/sub или sticky-сессии; presence; сохранить per-player authz/туман. (Подробнее — `operations-roadmap.md`.)
**Готово, когда:** матчи разнесены по инстансам; авторизация/туман целы.

---

## Последовательность

- **Критический путь к онлайн-сессии:** SV-0.1 (Fastify/F1) → SV-1.1 (гейт) → SV-2.1 (WS/F4) →
  SV-3.1 (туман/F6) + SE-0.1 (JWT/F7) + SV-2.3 (очередь/F5, после F2).
- **Match-actor (SV-0.2)** — до масштаба (Фаза 4).
- **Безопасность рантайма** (rate-limit, лимиты соединений, JWT) — в `secure-environment-roadmap.md`,
  идёт рядом.

## Ссылки

`tech-research.md` §2/§5 · `backlog.md` Блок F (F1/F4/F5/F6/F7), Блок E · `deep-technical-roadmap.md`
§3 гонки/§5 sync · `persistence-roadmap.md` · `secure-environment-roadmap.md` · `multiplayer.md`.
