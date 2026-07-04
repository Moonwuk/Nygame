# Void Dominion

Мобильная/браузерная **real-time** космическая grand strategy с массовым мультиплеером —
в духе игр Bytro Labs (Iron Order, Call of War, Supremacy 1914), но в сеттинге тёмного
космоса. Мир идёт в непрерывном реальном времени и круглосуточно; игрок действует
асинхронно (зашёл, отдал приказы на часы вперёд, вышел). Не пошаговая. Жанр и темп —
как вдохновение; весь код, контент и механики оригинальные.

**▶ Попробовать в браузере (без установки):** https://moonwuk.github.io/Nygame/

**Играбельная альфа (Android APK):**
https://github.com/Moonwuk/Nygame/releases/download/alpha/void-dominion-alpha.apk

Это `prototype/` — single-file HTML на **реальном** ядре (в браузере по ссылке выше,
или завёрнутый в Capacitor → APK):
скирмиш против ИИ на квадратной карте 7×7, экономика и постройки, флоты ⊕ десант, бой и
захват, победа по очкам/доминированию, **полная дипломатия** (мир/война/пакт/союз) и
**сессионное меню** (ростер участников с фильтрами, личные чаты + общий чат коалиции,
**пинги-метки на карте**). Портретная ориентация, автоскейл под экран.

## Принципы (коротко)

- **Data-driven ядро** — игровые объекты описаны в JSON, ядро лишь выполняет правила.
- **Микроядро + модули** — маленькое неизменяемое ядро, всё остальное — подключаемые
  модули, общающиеся только через шину (события / хуки / реестр возможностей).
- **Детерминизм** — ядро это чистая функция: одинаковый вход → одинаковый выход
  (replay боёв, предпросмотр на клиенте, античит). Seeded RNG, время — параметр.
- **Server-authority** — клиент шлёт намерение, сервер решает (основа античита).
- **Туман войны как граница безопасности** — сервер физически не отправляет невидимое
  (`visibleState`), а не «шлёт всё и прячет на клиенте».
- **Fail-secure** — любая ошибка ведёт к безопасному отказу, не к пропуску.
- **TypeScript везде** — `shared-core` пишется один раз и работает и на сервере, и на клиенте.

Подробности — в [`docs/`](./docs): [`gdd.md`](./docs/gdd.md) (игровой дизайн),
[`architecture.md`](./docs/architecture.md), [`modulesystem.md`](./docs/modulesystem.md),
[`roadmap.md`](./docs/roadmap.md), [`state.md`](./docs/state.md) (живой снимок текущего
состояния), [`backlog.md`](./docs/backlog.md) (кирпичики задач). Стек и обоснование —
[`tech-stack.md`](./docs/tech-stack.md) (ADR: выбор + причины + триггеры). По-блочные
роадмапы: [`core-roadmap.md`](./docs/core-roadmap.md), [`server-roadmap.md`](./docs/server-roadmap.md),
[`persistence-roadmap.md`](./docs/persistence-roadmap.md), [`accounts-roadmap.md`](./docs/accounts-roadmap.md),
[`matchmaking-roadmap.md`](./docs/matchmaking-roadmap.md), [`game-integrity-roadmap.md`](./docs/game-integrity-roadmap.md),
[`operations-roadmap.md`](./docs/operations-roadmap.md), [`cross-platform-roadmap.md`](./docs/cross-platform-roadmap.md);
безопасность — [`secure-sdlc-roadmap.md`](./docs/secure-sdlc-roadmap.md) и
[`secure-environment-roadmap.md`](./docs/secure-environment-roadmap.md).

## Структура монорепы

```
.
├── packages/
│   ├── shared-core/   # детерминированное ядро-симуляция (готово в основном, покрыто тестами)
│   ├── action-layer/  # Stage 2: envelope validation, auth, idempotency, sequence
│   ├── server/        # авторитетный сервер — Stage 3 (WS-мультиплеер + туман + персистентность + реестр матчей)
│   └── client/        # клиент — Stage 4 (PWA-first; transport adapter + сетевые пинги)
├── data/              # игровой контент (data-driven): units, factions, buildings, technologies, sectors, …
├── prototype/         # играбельная альфа: single-file HTML на реальном ядре (в Capacitor → APK)
├── mobile/            # Capacitor-обёртка прототипа (бренд-иконка/сплэш, портрет, debug-подпись)
└── docs/              # проектные документы и роадмапы
```

### `@void/shared-core`

| Зона       | Что внутри                                                                                          |
| ---------- | -------------------------------------------------------------------------------------------------- |
| `kernel/`  | Микроядро: `createKernel`, `applyAction`, `advanceTo` (real-time), шина, хуки, реестр, манифест    |
| `state/`   | `GameState`; `visibleState` (туман войны — проекция-граница безопасности); `diffState`/`applyDelta` (дельта-sync); `hashState` (детект десинка); `diplomacy.ts` (стойки `war`/`peace`/`pact`/`alliance`) |
| `action/`  | Контракт действия (`Action`/`Context`/`ApplyResult`), `Rejection`, `timeScale`                      |
| `data/`    | zod-схемы игровых данных + `parseGameData` (валидация всего входа, A05/A08)                          |
| `modules/` | Базовые модули-плагины (см. ниже) — каждая механика подключается через шину                          |
| `rng/`     | Seeded PRNG (sfc32) — детерминизм; состояние сериализуется в `GameState` (golden-тест)               |
| `util/`    | `deepClone`/`deepFreeze` (immutable-контракт), общие хелперы казны/стеков/времени                    |

**Модули ядра (16):** `sector`, `planetType`, `technology`, `scientist` (лидер исследований),
`economy`, `market`, `movement`, `combat` (орбитальный/наземный бой, двухфазный захват, ПВО,
бомбардировка), `captureOnArrival` (walk-in захват необоронённого нейтрального сектора),
`construction`, `army` (флот ⊕ наземная армия + транспорт), `station`, `faction`,
`hero` (аура/респаун), `victory` (data-driven очки/счёт), `visibility` (память тумана, вариант B).
**`combat.isHostile` читает стойку из `state.diplomacy`** — бой только при объявленной войне.
Новая механика = новый модуль (+ данные), ядро не трогается. Прототип добавляет свои
модули поверх (налоги, авто-ралли построек, `diplomacy.declare`).

### `@void/action-layer`

Stage-2 security gate перед тем, как авторитет сервера применяет действия:
валидация `ActionEnvelope`, авторизация по игроку/сессии, идемпотентность (receipts) и
строгий порядок `clientSeq` per-session. Слой намеренно вне `shared-core`: ядро остаётся
детерминированным и считает, что действие уже прошло валидацию/авторизацию.

### `@void/server`

Срез мультиплеера на **реальном** ядре: `MatchRoom` (advance → authorize → `applyAction`
→ broadcast), WebSocket-слой (`createMultiplayerServer`), **дельта-рассылка с туманом
войны (F6)** — каждый игрок получает только свою `visibleState`. Плюс: **персистентность**
(`MatchStore`/`ReceiptStore`, in-memory + Postgres JSONB — матч и квитанции переживают
рестарт), **offline-«будилка»** (отложенные прибытия/бои/захваты срабатывают без
подключённых игроков — мир идёт 24/7), **мульти-матч реестр** + match-browser read-model
(MM-0.1), и **эфемерные ally-пинги** (`ping.place`/`ping.added`, видимость союзникам, TTL).
DoS-границы: cap+FIFO на receipts, per-player rate-limit действий. Аккаунты/JWT — впереди.

### `@void/client`

Тонкий `MultiplayerClient` transport-adapter: `welcome`/`state`/`delta` (реконструкция
состояния через `applyDelta`), `action`/`rejection`, latency `ping`/`pong`, лобби, и
**сетевые ally-пинги** (`placePing`/`clearPing` + `onPingAdded`/`onPingRemoved`).

## Разработка

Требуется Node ≥ 20 и pnpm 10 (`corepack enable`).

```bash
pnpm install            # установка (использует зафиксированный pnpm-lock.yaml)

pnpm test               # тесты (Vitest)
pnpm run lint           # ESLint (включая правила детерминизма для ядра)
pnpm run typecheck      # tsc --noEmit по всем пакетам
pnpm run format         # Prettier --write
pnpm run audit          # pnpm audit (OWASP A03)
pnpm run prototype      # собрать играбельный prototype/dist/void-dominion.html

pnpm run check          # lint + typecheck + test — гонять перед коммитом
```

**CI:** гейт качества (lint/typecheck/test) запускается локально через `pnpm run check`
(автоматического gate-workflow ещё нет — задача в бэклоге). На GitHub собирается **APK
прототипа** ([`android.yml`](./.github/workflows/android.yml), публикует rolling-релиз
`alpha`) и крутится **security-пайплайн** ([`security.yml`](./.github/workflows/security.yml):
Trivy, Scorecard, zizmor, SHA-pin экшенов). GitLab-пайплайн снят при переезде на GitHub.
На сейчас **422 теста** зелёные (51 файл, 4 skip).

## Статус

- **Этап 0 (Каркас)** — ✅ готово.
- **Этап 1 (Ядро)** — ✅ в основном готово и покрыто тестами: микроядро + шина + хуки +
  манифест, seeded RNG (golden), модель времени `advanceTo`, экономика + рынок, карта +
  движение, секторы и типы планет, **бой с двухфазным захватом** (орбита→десант, ПВО,
  бомбардировка), здания + станции, флот ⊕ армия + транспорт, **дерево технологий**,
  **фракции**, **дипломатия** (стойки в `state.diplomacy`, бой только при войне), **герои**,
  **победа и data-driven очки**, **туман войны** (`visibleState` + память + radar-сигнатуры).
- **Этап 2 (Слой действий)** — 🧪 каркас `@void/action-layer` есть.
- **Этап 3 (Сервер)** — 🧪 WS-мультиплеер + дельта-sync + **туман на рассылке (F6)** +
  **персистентность (Postgres)** + **offline-планировщик** + **реестр матчей (MM-0.1)** +
  **ally-пинги**; впереди — аккаунты/JWT, матчмейкинг.
- **Этап 4 (Клиент)** — 🧪 transport-adapter + сетевые пинги; играбельная альфа пока живёт
  в `prototype/` (Capacitor → APK).

См. [`docs/roadmap.md`](./docs/roadmap.md) (раздел «Статус реализации») и
[`docs/state.md`](./docs/state.md) — живой снимок того, что готово и как работает.

## Лицензия

© 2026 Moonwuk Games. Все права защищены.

Проприетарный проект — см. [`LICENSE`](./LICENSE). Никакого разрешения на
использование, копирование, изменение или распространение исходного кода,
данных, артов и документации не предоставляется без письменного согласия
правообладателя. Просмотр или форк репозитория через интерфейс хостинга прав на
произведение не даёт.
