# Void Dominion

Мобильная **real-time** космическая grand strategy с массовым мультиплеером —
в духе игр Bytro Labs (Iron Order, Call of War, Supremacy 1914), но в сеттинге тёмного
космоса. Мир идёт в непрерывном реальном времени и круглосуточно; игрок действует
асинхронно (зашёл, отдал приказы на часы вперёд, вышел). Не пошаговая. Жанр и темп —
как вдохновение; весь код, контент и механики оригинальные.

Главная инженерная цель — **гибкое, расширяемое ядро**: добавлять механики, юниты,
ресурсы и целые фракции через данные, не переписывая логику.

## Принципы (коротко)

- **Data-driven ядро** — игровые объекты описаны в JSON, ядро лишь выполняет правила.
- **Микроядро + модули** — маленькое неизменяемое ядро, всё остальное — подключаемые
  модули, общающиеся только через шину (события / хуки / реестр возможностей).
- **Детерминизм** — ядро это чистая функция: одинаковый вход → одинаковый выход
  (replay боёв, предпросмотр на клиенте, античит). Seeded RNG, время — параметр.
- **Server-authority** — клиент шлёт намерение, сервер решает (основа античита).
- **Fail-secure** — любая ошибка ведёт к безопасному отказу, не к пропуску.
- **TypeScript везде** — `shared-core` пишется один раз и работает и на сервере, и на клиенте.

Подробности — в [`docs/`](./docs): [`gdd.md`](./docs/gdd.md) (игровой дизайн),
[`architecture.md`](./docs/architecture.md), [`modulesystem.md`](./docs/modulesystem.md),
[`roadmap.md`](./docs/roadmap.md), [`deep-technical-roadmap.md`](./docs/deep-technical-roadmap.md), [`multiplayer.md`](./docs/multiplayer.md), [`engineering-risks.md`](./docs/engineering-risks.md).

## Структура монорепы

```
.
├── packages/
│   ├── shared-core/   # детерминированное ядро-симуляция (готовится первым)
│   ├── action-layer/  # Stage 2: envelope validation, auth, idempotency, sequence
│   ├── server/        # авторитетный сервер — Stage 3 (in-memory multiplayer slice)
│   └── client/        # React Native клиент — Stage 4 (transport adapter slice)
├── data/              # игровой контент (data-driven): units, factions, buildings, events, resources
└── docs/              # проектные документы
```

### `@void/shared-core`

| Модуль     | Назначение                                                                                   |
| ---------- | -------------------------------------------------------------------------------------------- |
| `rng/`     | Seeded PRNG (sfc32) — детерминизм, состояние сериализуется в `GameState`                     |
| `state/`   | `GameState` и фабрика начального состояния (JSON-сериализуемо, хранится как JSONB)           |
| `action/`  | Контракт действия (`Action`/`Context`/`ApplyResult`), `Rejection`, парсер id                 |
| `kernel/`  | Микроядро: `createKernel`, `applyAction`, `advanceTo` (модель времени), шина, хуки, манифест |
| `data/`    | zod-схемы игровых данных + `parseGameData` (валидация всего входа)                           |
| `modules/` | Базовые модули-плагины: `economyModule`, `movementModule`, `combatModule`                    |
| `util/`    | `deepClone`/`deepFreeze` для immutable-контракта редьюсера                                   |

### `@void/action-layer`

Stage 2 security gate before server authority applies actions: `ActionEnvelope` validation, player/session authorization, idempotency receipts and per-session `clientSeq` ordering. This layer is intentionally outside `shared-core`: the core stays deterministic and assumes actions already passed validation/authorization.

## Разработка

Требуется Node ≥ 20 и pnpm 10 (`corepack enable`).

```bash
pnpm install            # установка (использует зафиксированный pnpm-lock.yaml)

pnpm test               # запустить тесты (Vitest)
pnpm run lint           # ESLint (включая правила детерминизма для ядра)
pnpm run typecheck      # tsc --noEmit по всем пакетам
pnpm run format         # Prettier --write
pnpm run audit          # pnpm audit (OWASP A03)

pnpm run check          # lint + typecheck + test (как в CI)
```

CI ([`.github/workflows/ci.yml`](./.github/workflows/ci.yml)) гоняет lint, typecheck,
тесты и `pnpm audit` на каждый push/PR.

## Статус

- **Этап 0 (Каркас)** — ✅ готово.
- **Этап 1 (Ядро)** — 🚧 заложен фундамент (kernel + шина + реестр модулей + `GameState` +
  seeded RNG + `applyAction`), **модель времени `advanceTo`** (real-time: запланированные
  события + континуальное накопление) и **базовые модули-плагины** (движение, экономика,
  **бой с захватом** §7: линии, почасовые раунды, двухфазный захват орбита→десант) плюс
  `timeScale`. Дальше — очки/победа, герои, тактики.

См. [`docs/roadmap.md`](./docs/roadmap.md) — раздел «Статус реализации».
