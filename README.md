# Void Dominion

Мобильная/браузерная **real-time** космическая grand strategy с массовым мультиплеером —
в духе игр Bytro Labs (Iron Order, Call of War, Supremacy 1914), но в сеттинге тёмного
космоса. Мир идёт в непрерывном реальном времени и круглосуточно; игрок действует
асинхронно (зашёл, отдал приказы на часы вперёд, вышел). Не пошаговая. Жанр и темп —
как вдохновение; весь код, контент и механики оригинальные.

**Играбельная альфа (Android APK, rolling-релиз):**
https://github.com/Moonwuk/Nygame/releases/download/alpha/void-dominion-alpha.apk

Браузерная версия — тот же single-file HTML: собери `pnpm run prototype` и открой
`prototype/dist/void-dominion.html`, или подними сервер для друзей — `pnpm host`
(он раздаёт игру на `/`; полный путь — [`docs/launch-runbook.md`](./docs/launch-runbook.md)).
Публикация на GitHub Pages настроена (`pages.yml`), но на приватном репозитории
Pages недоступен — деплой не проходит.

Это `prototype/` — single-file HTML на **реальном** ядре (27 модулей поверх того же
кернела, что и сервер): скирмиш против ИИ, **командный бой** (стороны-союзники) или
**онлайн-матч до 10 живых игроков по позывным** — FFA/5v5/2v2, лобби, seat-lock-билеты,
durable Postgres (матч переживает рестарт сервера), ИИ-подмена отключившихся. Экономика
5 ресурсов и постройки, флоты ⊕ **наземные дивизии** (сборка шаблонов из пехоты/танков с
превью характеристик), бой с двухфазным захватом + **дальнобойная артиллерия с дугами
снарядов**, **герои** и **совет учёных**, **дерево технологий**, **дипломатия**
(мир/война/пакт/союз по согласию, боты с одобрением), **сессионная биржа**, **шпионаж с
контрразведкой**, **«Хранитель»** (делегируй место ИИ на время сна), **мета-прогрессия
командира** (XP между матчами, три ветки прокачки), **онбординг** (гайдовый первый матч,
туры-подсветки, поисковый справочник, чеклист целей), **экран итогов матча**, сессионный
чат/пинги, **локализация RU/EN**. Мобильный UI: портрет, safe-area, 44px-таргеты, нижние
листы. Серверный слой меты: **корпорации** (роли/заявки/аудит, REST) и **войны корпораций
AvA** (влияние → вызов → ростер → авто-сборка сессии → итог в историю); клиентский UI
к ним — впереди. Полное описание текущего состояния —
[`docs/game-description.md`](./docs/game-description.md).

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

**Модули ядра (22):** `sector`, `planetType`, `technology`, `scientist` (лидер исследований),
`economy`, `market`, `movement`, `combat` (мелэ-бой, двухфазный захват орбита→десант),
`orbital` (ПВО + бомбардировка), `artillery` (дальнобойный standoff-огонь + barrage-приказы),
`intercept` (перехват на лейнах), `captureOnArrival` (walk-in захват необоронённого
нейтрального сектора), `construction`, `army` (флот ⊕ наземная армия + транспорт), `station`,
`faction`, `hero` (аура/респаун), `diplomacy` (объявления + consent-офферы), `espionage`
(шпионаж + контрразведка), `steward` («Хранитель» — делегирование места ИИ), `victory`
(data-driven очки/счёт), `visibility` (память тумана, вариант B).
**`combat.isHostile` читает стойку из `state.diplomacy`** — бой только при объявленной войне.
Новая механика = новый модуль (+ данные), ядро не трогается. Прототип добавляет свои
модули поверх (налоги, дивизии, командные цепочки, стоячие приказы, мета-прогрессия).

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
рестарт), **offline-«будилка»** (мир идёт 24/7 без подключённых игроков), **мульти-матч
реестр с гибернацией** (`LazyRoomRegistry`) + **MatchKeeper** (держит пул открытых
матчей), **аккаунты логин/пароль** (scrypt, session-JWT 7 дней → join-JWT 15 минут,
`/auth/register`·`/auth/login`, включаются `AUTH_JWT_SECRET`), **action-gate** (`GATE=1`
— строгие `action.v1`-конверты + `clientSeq`), Origin-allowlist, и **эфемерные
ally-пинги**. DoS-границы: cap+FIFO на receipts, per-player rate-limit действий,
per-IP лимиты HTTP. Auth/gate пока **не подключены к играбельному пути прототипа**
(там ник-вход без пароля) — это следующий кирпич перед публичным запуском.

### `@void/client`

`MultiplayerClient` transport-adapter: `welcome`/`state`/`delta` (реконструкция
состояния через `applyDelta`), `action`/`rejection` — **включая `action.v1`-конверты
со строгим `clientSeq`**, когда сервер объявляет `gated`, — latency `ping`/`pong`,
лобби и **сетевые ally-пинги**. Плюс общий рендер-кит (камера/holo/территории),
view-models HUD и Vite-shell с живой картой (`?join=`-диплинк). Играбельный клиент
для игроков — по-прежнему `prototype/` (см. `docs/cross-platform-roadmap.md`).

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

**CI:** [`ci.yml`](./.github/workflows/ci.yml) гоняет гейт (`pnpm run check` =
lint/typecheck/test) + `pnpm audit` на каждый пуш — против сервисного Postgres, так что
durable-тесты тоже бегут. Рядом: **security-пайплайн**
([`security.yml`](./.github/workflows/security.yml): Semgrep, CodeQL, Trivy, OSV,
Gitleaks, TruffleHog, zizmor, Syft SBOM — сейчас информационный, не блокирующий),
**APK прототипа** ([`android.yml`](./.github/workflows/android.yml), rolling-релиз
`alpha`) и [`pages.yml`](./.github/workflows/pages.yml) (не деплоится: приватный репо).
`main` защищён — изменения едут через PR с зелёным CI.
На сейчас **1027 тестов** зелёные (104 файла, 4 skip).

## Статус

- **Этап 0 (Каркас)** — ✅ готово.
- **Этап 1 (Ядро)** — ✅ готово и покрыто тестами: микроядро + шина + хуки + манифест,
  seeded RNG (golden), модель времени `advanceTo`, экономика + рынок, карта + движение +
  перехват, секторы и типы планет, **бой с двухфазным захватом** (орбита→десант, ПВО,
  бомбардировка, артиллерия), здания + станции, флот ⊕ армия + транспорт, **дерево
  технологий + учёные**, **фракции**, **дипломатия** (стойки + consent-офферы),
  **шпионаж + контрразведка**, **герои**, **«Хранитель»**, **победа и data-driven очки**,
  **туман войны** (`visibleState` + память + radar-сигнатуры).
- **Этап 2 (Слой действий)** — ✅ готово: envelope-валидация, zod-схемы payload'ов,
  сессии, идемпотентность, `clientSeq`; подключается на сервере через `GATE=1`.
- **Этап 3 (Сервер)** — 🧪 крит-путь до онлайн-сессии закрыт: WS-мультиплеер +
  дельта-sync + **туман на рассылке (F6)** + **персистентность (Postgres)** +
  **offline-планировщик** + **мульти-матч реестр с гибернацией + MatchKeeper** +
  **аккаунты логин/пароль + JWT** (opt-in); впереди — включение auth/gate на играбельном
  пути, OIDC, мульти-процесс.
- **Этап 4 (Клиент)** — 🧪 играбельный клиент живёт в `prototype/` (браузер + Capacitor →
  APK; RU/EN, мобильный UI-пасс); `packages/client` — transport-adapter + Vite-shell
  с живой картой и `action.v1`.

См. [`docs/roadmap.md`](./docs/roadmap.md) (раздел «Статус реализации») и
[`docs/state.md`](./docs/state.md) — живой снимок того, что готово и как работает.

## Лицензия

© 2026 Moonwuk Games. Все права защищены.

Проприетарный проект — см. [`LICENSE`](./LICENSE). Никакого разрешения на
использование, копирование, изменение или распространение исходного кода,
данных, артов и документации не предоставляется без письменного согласия
правообладателя. Просмотр или форк репозитория через интерфейс хостинга прав на
произведение не даёт.
