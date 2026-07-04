# Глубокий технический roadmap

> Артефакт-план: что строить дальше, в каком порядке, какие инженерные риски заранее закрывать и какие решения дадут масштаб, честный multiplayer и высокий FPS.

## 0. Моя позиция по проекту

У проекта правильная база: детерминированный `shared-core`, модульная архитектура, data-driven контент, строгие инварианты и уже работающий HTML-прототип. Главный риск теперь не в ядре, а в том, что сервер/клиент можно начать строить слишком быстро и получить гонки действий, утечки fog-of-war, тяжёлые full-state обновления и падение FPS.

Моё предложение: следующие этапы делать не «большими фичами», а **инженерными слоями**, каждый из которых закрывает отдельный класс будущих проблем.

## 1. Целевое направление на 3 горизонта

### Горизонт A — ближайшие PR: защитить multiplayer-контур

Цель: превратить действия игрока в безопасный, проверяемый поток.

> ✅ уже в коде: пакет `packages/action-layer/` собран (`envelope.ts` —
> `validateActionEnvelope`/`authorizeActionEnvelope`/`createActionEnvelope`; `gate.ts` —
> `ActionGate`; `sequence.ts` — `InMemorySequenceGate` с `E_REPLAY`/`E_OUT_OF_ORDER`;
> `receipts.ts`; тесты `envelope.test.ts`/`gate.test.ts`). Осталось **интегрировать пакет
> в сервер**: `packages/server/src/matchRoom.ts` пока принимает сырой `Action` и держит
> собственный `ActionReceipt`, без `@void/action-layer`.

1. `@void/action-layer` — ✅ построен
   - `ActionEnvelope` вокруг core `Action`:
     - `matchId`;
     - `playerId`;
     - `sessionId`;
     - `clientSeq`;
     - `actionId`;
     - `issuedAt`;
     - `schemaVersion`.
   - `validateActionEnvelope(raw)` — JSON/zod validation.
   - `authorizeActionEnvelope(envelope, session)` — действие принадлежит игроку.
   - `dedupe(actionId)` — повтор не применяет эффект второй раз (`InMemoryActionReceiptStore`).
   - `sequence gate` — защита от out-of-order команд (`InMemorySequenceGate`).

2. Integration с server slice из PR #9 — ⏳ следующий шаг
   - заменить прямой WebSocket `Action` на `ActionEnvelope`;
   - `MatchRoom` должен принимать только envelope;
   - rejection codes остаются стабильными и без внутренних деталей.

3. Тесты гонок — ✅ покрыты в пакете (`gate.test.ts`/`envelope.test.ts`)
   - double spend;
   - double fleet move;
   - retry same action;
   - spoof чужого `playerId`;
   - out-of-order `clientSeq`;
   - действие после `match.ended`.

### Горизонт B — первая настоящая online-сессия

Цель: матч работает на сервере, переживает reconnect и не теряет state.

> ✅ уже в коде (частично): `packages/server/src/store/` содержит интерфейсы `MatchStore`/
> `ReceiptStore` (`types.ts`, с optimistic concurrency) и обе реализации — in-memory
> (`memory.ts`) и Postgres (`postgres.ts`, с `migrate`). Осталось прогнать боевой сценарий
> reconnect/retry через persisted store в хосте.

1. PostgreSQL persistence — ✅ store-слой построен
   - `matches(id, version, game_state_jsonb, manifest, updated_at)`;
   - `action_receipts(action_id, match_id, player_id, seq, result_code, state_version)`;
   - optimistic locking: `WHERE version = previousVersion`.

2. WebSocket sync v2
   - `welcome` всегда отдаёт snapshot;
   - далее сервер шлёт monotonic `diff { seq, patch }`;
   - каждые N diff'ов или при reconnect — full snapshot;
   - slow clients получают backpressure policy.

3. Reconnect protocol
   - клиент присылает `lastSeq`;
   - сервер либо досылает missing diffs, либо отдаёт snapshot;
   - action retry безопасен через `action_receipts`.

4. Minimal lobby
   - создать матч;
   - подключиться за `p1/p2`;
   - увидеть shared state;
   - отдать приказ флоту;
   - второй клиент получает обновление.

### Горизонт C — production MMO-подготовка

Цель: долгоживущие матчи 24/7, fog-of-war, нагрузка, FPS.

1. Scheduler
   - Redis/BullMQ или DB-backed scheduler;
   - wake-up по ближайшему событию матча;
   - dead-letter для failed scheduled events;
   - catch-up лимиты.

2. Fog of war
   - `visibleState(state, playerId)`;
   - server-side filtering before broadcast;
   - тесты: клиент не получает чужие скрытые флоты даже в JSON.

3. Diff engine
   - JSON patch или custom compact diff;
   - stable entity paths: `/planets/HOME/owner`, `/fleets/blue-1/movement`;
   - event stream отдельно от state patch.

4. Client performance layer
   - spatial index;
   - render culling;
   - static/dynamic layers;
   - low-zoom aggregation;
   - worker/off-thread simulation preview.

## 2. Самый логичный следующий PR

> ✅ уже в коде: сам пакет **Action Layer** (`packages/action-layer/`) построен с тестами.
> Следующий PR теперь — **интеграция action-layer в сервер** (`MatchRoom` принимает
> `ActionEnvelope` через `ActionGate` вместо сырого `Action`). Ниже — исходная мотивация,
> она всё ещё объясняет, зачем этот слой идёт впереди «большего мультиплеера».

Я бы следующим сделал **Action Layer** (теперь: его интеграцию в сервер).

Почему не сразу «больше мультиплеера»:

- WebSocket без action-layer быстро превращается в доверие клиенту.
- Persistence без idempotency приводит к double apply после reconnect/retry.
- Клиентский UI без server contracts потом придётся переписывать.

Минимальный результат следующего PR:

```ts
type ActionEnvelope = {
  matchId: string;
  playerId: PlayerId;
  sessionId: string;
  clientSeq: number;
  actionId: string;
  issuedAt: number;
  action: Action;
};

validateEnvelope(raw) -> { ok: true, envelope } | { ok: false, code }
authorizeEnvelope(envelope, session) -> ok | E_FORBIDDEN
sequenceGate(envelope, lastSeq) -> ok | E_REPLAY | E_OUT_OF_ORDER
```

Definition of done:

- invalid payload rejected as `E_BAD_PAYLOAD`;
- spoofing rejected as `E_FORBIDDEN`;
- same `actionId` returns cached receipt;
- same `clientSeq` cannot apply twice;
- action with future/invalid `issuedAt` is clamped or rejected by policy;
- tests cover all cases.

## 3. Гонки: где они появятся и как закрывать

### 3.1 Double-spend race

Сценарий:

1. Игрок имеет 100 metal.
2. Клиент отправляет два `building.construct` почти одновременно.
3. Оба action читают старый state и оба проходят `afford()`.
4. В итоге построено два здания за цену одного.

Решение:

```txt
transaction start
  SELECT match FOR UPDATE / optimistic version
  advanceTo(serverNow)
  validate + authorize + dedupe
  applyAction
  INSERT action_receipt
  UPDATE match SET state, version = version + 1 WHERE version = oldVersion
transaction commit
broadcast after commit
```

В одном процессе `MatchRoom` уже сериализует обработку, но в production этого мало: при нескольких server instances нужна DB/blocking или optimistic retry.

### 3.2 Fleet command race

Сценарий:

- игрок кликает `move HOME -> NEXUS`;
- почти сразу кликает `move HOME -> RELAY`;
- разные клиенты видят разные маршруты.

Решение:

- action применяются строго по `clientSeq`;
- повтор sequence rejected/cached;
- если fleet уже moving, второй command либо:
  - rejected `E_FLEET_BUSY`, либо
  - explicit `fleet.redirect` отдельным action type.

Важно: не делать «последний клик победил» неявно. Это ломает replay и вызывает спорные результаты.

### 3.3 Time race

Сценарий:

- флот должен прибыть в 10:00;
- игрок отдаёт action в 10:00;
- сервер получает его в 10:00.005;
- порядок arrival/action влияет на бой.

Решение:

- сервер использует authoritative `serverNow`;
- `advanceTo(serverNow)` всегда перед action;
- scheduled events сортируются `(at, seq)`;
- player action получает порядок после всех due events на `<= serverNow`.

Если нужно поддержать latency compensation, это отдельная политика. Для grand strategy лучше честная серверная хронология, а не rewind.

### 3.4 Retry/reconnect race

Сценарий:

- мобильная сеть оборвалась;
- клиент не знает, применился ли action;
- отправляет тот же action ещё раз.

Решение:

- `actionId` уникален и стабилен;
- сервер хранит `action_receipts`;
- retry возвращает прежний result, но не применяет reducer второй раз.

### 3.5 Broadcast-before-commit race

Сценарий:

- сервер применил action in-memory;
- отправил клиентам update;
- DB commit упал;
- клиенты видят state, которого нет в persistence.

Решение:

- broadcast только после успешного commit;
- event bus outbox pattern:
  - transaction writes `state` + `outbox_messages`;
  - publisher sends committed messages.

## 4. Гонки времени и offline catch-up

Главная ловушка real-time стратегии: нельзя считать offline доход по финальному snapshot.

Плохо:

```txt
player offline 8h
за это время planet captured на 3h
server at 8h считает income по владельцу на 8h
```

Правильно:

```txt
advance 0h -> 3h: income старому владельцу
resolve capture at 3h
advance 3h -> 8h: income новому владельцу
```

Для этого уже хорошая база: `advanceTo` эмитит contiguous `time.advanced {from,to}`. Следующий шаг — не сломать это при scheduler/persistence.

Рекомендации:

- scheduled events всегда хранятся в `GameState.scheduled` и persisted state;
- server scheduler только будит матч, но не является source of truth;
- после restart сервер берёт ближайшее due event из persisted state;
- catch-up должен иметь лимит операций и метрики.

## 5. Network sync: от full-state к diff-stream

> ✅ уже в коде: `packages/server/src/matchRoom.ts` уже шлёт **per-player fog deltas**
> (`type: 'delta'` через `diffState(baseline, view.base)` поверх `visibleState`), а не full
> state. Fog-of-war — серверная граница: каждый игрок диффится против своего последнего
> видимого view, поэтому скрытые миры/флоты физически не уходят на провод. Описанный ниже
> Sync v1 пройден; текущее состояние ближе к Sync v2 (не хватает seq-протокола reconnect).

Путь развития:

### Sync v1 — пройдено

```ts
welcome: { snapshot }
action result: { full state, events }
```

Плюсы: просто, легко тестировать.
Минусы: дорого, раскрывает fog-of-war, плохо для мобильного интернета.

(Оставлено для контекста: с этого начинали; slice уже ушёл дальше — см. заметку выше.)

### Sync v2 — production baseline

```ts
welcome: { snapshot, seq }
update: { seq, patch, events }
reconnect(lastSeq): missing patches | snapshot
```

Патчи должны быть monotonic. Клиент применяет только `seq === currentSeq + 1`; если gap — просит snapshot.

### Sync v3 — масштаб

- interest management: клиент подписан только на видимые/близкие sectors;
- low-frequency background updates для далёких объектов;
- high-frequency only for selected/visible fleets;
- compression/binary protocol только после стабилизации JSON-протокола.

Моё предложение: не начинать с binary protocol. Сначала JSON + строгие версии + тесты, потом оптимизировать размер.

## 6. Fog of war как security boundary

UI не является защитой. Если сервер отправил скрытый флот в JSON, игрок его найдёт.

> ✅ уже в коде: `visibleState(state, viewerId, data)` в
> `packages/shared-core/src/state/visibility.ts`; сервер применяет его перед каждой дельтой,
> так что скрытые данные физически не уходят на провод. Раздел ниже — граница и что фильтровать.

Нужен отдельный слой:

```ts
visibleState(state, viewerPlayerId, rules) -> VisibleGameState
```

Что фильтровать:

- hidden enemy fleets;
- exact enemy fleet composition;
- enemy schedules/build queues;
- hidden battle details;
- resources/production чужих игроков;
- unexplored planet data.

Тесты должны проверять не UI, а сам JSON:

```ts
expect(JSON.stringify(visibleState)).not.toContain('red-hidden-fleet-id');
```

## 7. FPS и оптимизация клиента

### 7.1 Главный принцип

FPS у игроков будет зависеть не от React как такового, а от количества работы на frame.

Нужно разделить:

- simulation state updates;
- network diff application;
- UI state;
- render commands;
- expensive labels/layout.

### 7.2 Render pipeline

Рекомендуемый pipeline:

```txt
server diff -> normalized client store -> derived visible render list -> renderer
```

Не рендерить напрямую из полного `GameState` каждый frame.

### 7.3 Viewport culling

На каждом frame рисовать только то, что видно:

- planets inside viewport + padding;
- lanes where at least one endpoint visible or crossing viewport;
- fleets in viewport;
- effects in viewport.

Для этого нужен spatial index:

- simple grid/quadtree для planets/fleets;
- rebuild only when entity moves sector/grid cell;
- labels computed after culling.

### 7.4 Static/dynamic layers

Разделить слои:

1. static background: звёзды, grid;
2. semi-static map: lanes, planet base markers;
3. dynamic: fleets, battles, projectiles/effects;
4. overlay: selection, labels, panels.

Static layers перерисовывать только при zoom/pan или map change. Dynamic layer — каждый frame.

### 7.5 Level of detail

На дальнем zoom:

- не показывать все подписи;
- агрегировать флоты в cluster markers;
- buildings icons заменить count/summary;
- battle effects упрощать.

На ближнем zoom:

- detailed labels;
- building icons;
- fleet composition;
- routes.

### 7.6 UI update discipline

Частая ошибка: каждый network update вызывает полный rerender UI.

Решения:

- normalized store by entity id;
- selectors per visible panel;
- update panel only if selected entity changed;
- log virtualized/limited;
- no text measurement in hot loop;
- no large JSON stringify in render.

### 7.7 Simulation preview off UI thread

Клиенту нужен preview: «если атакую, что будет?». Это тяжёлая работа.

Решение:

- web/mobile worker для preview;
- input: small cloned subset or deterministic snapshot;
- cancel previous preview when player changes target;
- never block rendering.

## 8. Server performance roadmap

### 8.1 Match actor model

Идеальная mental model:

```txt
one match = one serialized actor
```

Actor получает:

- player actions;
- scheduler wake-ups;
- admin/system events.

Actor делает:

- load current persisted state;
- advance/apply;
- persist;
- publish.

На одном Node process это просто queue. На нескольких instances нужно:

- sticky routing per match, или
- DB optimistic lock + retry, или
- external queue per match.

### 8.2 Persistence model

Минимально:

```sql
matches(
  id uuid primary key,
  version bigint not null,
  state jsonb not null,
  manifest jsonb not null,
  updated_at timestamptz not null
)

action_receipts(
  action_id text primary key,
  match_id uuid not null,
  player_id text not null,
  seq bigint not null,
  ok boolean not null,
  code text,
  state_version bigint not null,
  created_at timestamptz not null
)
```

Позже можно выделить hot indexes по match/player, но сначала важнее correctness.

### 8.3 Scheduler

Не надо запускать tick-loop по всем матчам.

Правильно:

- при записи state найти next scheduled event;
- поставить wake-up job;
- на wake-up загрузить матч и `advanceTo(now)`;
- если за время ожидания игрок уже продвинул матч дальше, wake-up становится no-op.

## 9. Data/versioning roadmap

Долгоживущие матчи нельзя молча переводить на новые правила.

Каждый match должен хранить:

- `dataVersion`;
- `moduleManifest`;
- `rulesVersion`;
- `mapVersion`;
- `createdAt`.

Изменение баланса должно быть одним из трёх типов:

1. affects new matches only;
2. explicit migration for active matches;
3. compatibility adapter.

Тест: replay старого golden match должен давать тот же результат.

## 10. Observability roadmap

Без метрик race conditions будут выглядеть как «игрок жалуется».

Нужны counters:

- rejected actions by code;
- duplicate action retries;
- out-of-order seq;
- advance duration;
- scheduled events processed;
- catch-up span duration;
- websocket clients per match;
- outbound bytes per client;
- dropped/slow clients;
- render FPS/client telemetry позже.

Нужны structured logs:

- `matchId`;
- `playerId`;
- `actionId`;
- `seq`;
- `stateVersion`;
- rejection code.

Не логировать payload целиком, если там потенциально приватные данные.

## 11. Security roadmap

### Сейчас

- fail-secure reducer;
- stable error codes;
- server-authority direction.

### Следующим

- action-layer validation;
- auth/session boundary;
- rate limits;
- payload size limits;
- replay protection;
- fog-of-war filtering.

### Потом

- JWT rotation;
- WebSocket origin checks;
- abuse throttling;
- audit log for admin actions;
- dependency audit in CI already exists.

## 12. Предлагаемый порядок PR после текущего состояния

### PR A — Action Layer — ✅ пакет построен, ⏳ осталась интеграция в сервер

Файлы:

- ✅ `packages/action-layer/` (envelope/gate/sequence/receipts + tests);
- ⏳ wiring в `packages/server/src/matchRoom.ts` (сейчас всё ещё сырой `Action` + собственный `ActionReceipt`).

Почему первым: закрывает самые опасные multiplayer гонки.

### PR B — Persisted MatchStore — ✅ store-слой построен

Файлы:

- ✅ `packages/server/src/store/types.ts` (`MatchStore`/`ReceiptStore`, optimistic concurrency);
- ✅ `MemoryMatchStore` for tests (`store/memory.ts`);
- ✅ PostgreSQL implementation (`store/postgres.ts` + `migrate`).

Почему вторым: можно подключить persistence без реальной БД и сохранить тестируемость.

### PR C — WebSocket reconnect + seq protocol

Файлы:

- protocol v2;
- reconnect tests;
- snapshot-on-gap.

Почему третьим: после action receipts можно безопасно reconnect.

### PR D — Fog-of-war projection — ✅ уже в коде

Файлы:

- ✅ `packages/shared-core/src/state/visibility.ts` (`visibleState`), применяется в
  `matchRoom.ts` перед broadcast'ом дельт;
- tests that hidden enemy data is absent from serialized JSON.

Почему до UI: иначе UI начнёт зависеть от full state.

### PR E — Prototype/client perf layer

Файлы:

- render culling utilities;
- entity render lists;
- low-zoom aggregation;
- panel update gating.

Почему после protocol: клиент должен оптимизироваться под будущую data flow, а не под временный full-state prototype.

### PR F — Scheduler wake-up skeleton

Файлы:

- scheduler interface;
- in-memory scheduler tests;
- later Redis/BullMQ adapter.

Почему после persistence: scheduler должен будить persisted match, не быть source of truth.

## 13. Что не стоит делать сейчас

1. Не строить полноценный MMO lobby до action-layer и persistence.
2. Не делать binary protocol до стабильного JSON protocol.
3. Не оптимизировать React/Skia заранее без измерений.
4. Не добавлять много контента, пока нет fog-of-war и versioning policy.
5. Не доверять клиенту даже для «маленьких» действий.
6. Не запускать глобальный tick-loop по всем матчам.

## 14. Мои предложения по продуктовой/технической стратегии

1. **Сначала честность и детерминизм, потом масштаб.** Игроки простят мало контента, но не простят потерянные флоты и двойные траты.
2. **Оставить prototype как быстрый полигон.** Всё, что становится настоящей механикой, переносить в `shared-core` с тестами.
3. **Сервер строить через interfaces.** `MatchStore`, `ActionReceiptStore`, `Scheduler`, `Broadcaster` — сначала in-memory, потом PostgreSQL/Redis.
4. **Держать docs живыми.** После каждого слоя обновлять `docs/state.md` и этот roadmap.
5. **FPS мерить рано.** Добавить dev overlay: frame time, visible entities, draw calls, bytes/sec, patches/sec.
6. **Не бояться маленьких PR.** Для такого проекта маленькие verified slices лучше больших «почти готово» веток.

## 15. Критерии успеха на ближайший месяц разработки

Проект будет в хорошем состоянии, если появится:

- action-layer с тестами гонок;
- persisted room/store interface;
- reconnect-safe WebSocket protocol;
- первая fog-of-war projection;
- render culling в prototype/client path;
- технические метрики для server и client;
- один golden multiplayer scenario: два игрока, reconnect, retry, бой/захват, одинаковый результат.

Если эти слои будут сделаны до расширения контента, проект останется управляемым и сможет расти без архитектурного долга.
