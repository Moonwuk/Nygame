# Состояние проекта — снапшот

> Живой «якорь контекста»: что готово, как работает, что дальше. Обновляется по
> мере разработки (после крупных изменений). Парные документы: `architecture.md`,
> `modulesystem.md`, `gdd.md`, `roadmap.md`, `backlog.md` (кирпичики задач),
> `deep-technical-roadmap.md`, `multiplayer.md`, `metagame.md`, `map-roadmap.md`, корневой `CLAUDE.md` / `CONTRIBUTING.md`.
>
> **Ветка:** feature-ветка · **PR:** создаётся после изменений.
> **Гейт:** `pnpm run check` (lint + typecheck + test). **Тесты: 794 зелёных** (4 skip, 85 файлов).

---

## 1. Что это

Void Dominion — мобильная/браузерная **real-time** (непрерывное wall-clock время,
24/7, асинхронная игра) 4X космо-стратегия в духе Bytro (Iron Order). Ставка —
**гибкое, расширяемое ядро**: новые механики/юниты/фракции добавляются **данными
и модулями**, не переписыванием логики.

Монорепо (pnpm workspaces):

- `packages/shared-core` — детерминированная, data-driven симуляция. Без сервера/БД/сети.
- `packages/action-layer` — Stage 2 security gate: `ActionEnvelope`, validation, authorization, idempotency receipts, per-session `clientSeq`.
- `packages/server` — авторитетный сервер (Этап 3). WebSocket multiplayer slice: `MatchRoom`, `createMultiplayerServer`, action/state sync, per-player туман. Персистентность: `MatchStore`/`AccountStore`/`ReceiptStore` (in-memory + Postgres JSONB) — durable-матч переживает рестарт, durable receipts дедупят повтор после рестарта, ник-логин лобби. Offline-«будилка» (PA-4.1 v1): `MatchRoom.tick()`/`msUntilNextEvent()` + одно-процессный `setTimeout`-драйвер — отложенные события (прибытия/бои/захваты) срабатывают без подключённых игроков (мир идёт 24/7). Есть в обоих серверах: прото-сервер (`netserver.ts`, APK) с PA-4.1, минимальный `packages/server/main.ts` — с F8 (`persistence.ts`+`clockDriver.ts`, паритет). Баг-фикс F8: `MatchRoom.initialSeq` восстанавливает счётчик действий при рестарте, иначе optimistic-by-seq store дропал пост-рестартные сохранения — прокинут в оба сервера. Строгий commit-before-broadcast (risk14, опция `MatchRoom.persist`): действие идёт async-путём через актор-**mailbox** (сериализован per-room; туда же lobby-`start`), ждёт durable-запись снапшота+квитанции ДО коммита/рассылки (`computeAdvance` считает догон мира чисто, не трогая `stateValue` до ack); провал записи → транзиентный reject, ретрай доезжает; синхронный `submitAction` не тронут; прошёл 3-линзовый состязательный ревью. **SV-0.2 match-actor:** `RoomRegistry` (роутинг по matchId — N изолированных матчей/процесс, `InMemoryRoomRegistry` eager) + `LazyRoomRegistry` (lifecycle/risk13: ленивая загрузка по запросу + гибернация простаивающих в стор после idle-окна → live-память ∝ активным матчам; **пробуждение спящего матча к его следующему событию** — реорганизует+персистит+снова спит, мир идёт 24/7 при всех офлайн; таймер инжектируемый = шов под pg-boss; reconnect детерминированно догоняет). Рядом — браузерный `MatchRegistry` (`matchRegistry.ts`, main-menu §2): meta-состояние матчей (карта/правила/архив) с read-model `GET /matches` + archive-интентами (`registerBrowserApi` в `matchApi.ts`); структурно совместим с `RoomRegistry`, так что служит и источником комнат для транспорта (прото-сервер). DoS-границы (аудит F-03/F-04): карта `receipts` капается с FIFO-эвикцией (`maxReceipts`), действия — per-player rate-limit (`actionRateMax`/`actionRateWindowMs`, флуд → транзиентный `E_RATE_LIMIT` без квитанции, ретрай переживает). **SV-1.1 action-layer front-door (опционально):** `MatchRoom.gate?` подключает `@void/action-layer` `ActionGate` — gated-сообщение `action.v1` (конверт) проходит validate→authorize→sequence→dedup ДО редьюсера (стабильные `E_*` без утечки), а bare-`action` на gated-комнате отклоняется (нет обхода гейта); rate-limit стоит ДО резервации seq, поэтому троттлинг не сжигает `clientSeq` (ретрай доезжает, не `E_REPLAY`). `submitAction`/`admitEnvelope` делят общее ядро `applyAndBroadcast`, не перепроверяя чужие гейты. Абьюз-e2e (E3) зелёный (невалид/несанкц/replay/out-of-order → безопасный отказ; дубль → реплей без повторного применения). **Боевой вход (Fastify, SV-0.1):** `/health` без утечки id (**F-13**), `/ready` со стор-probe `MatchStore.ping`, pino, graceful drain — заменил голый node:http. **Аутентификация handshake (SE-0.1, **F-01**):** опция `auth` требует верифицированный join-токен (`?token=`); при ней `?player=`/`?nick=` игнорируются, `matchId`/`playerId` токена сверяются с матчем и местом; `allowedOrigins` (**F-06**) режет cross-site upgrade. Токены — `verifyJoinToken`/`signJoinToken` на `jose` с пином алгоритма (нет `none`/alg-confusion), `typ`, iss/aud/exp, опц. max-age (SE-2.1, прошёл состязательное ревью — verified против исходников jose). **Живой гейт:** транспорт минтит серверный `sessionId` (randomUUID — не клиентский, это ключ курсора seq), отдаёт в `welcome` и в `receive`; gated-envelope авторизуется против него, end-to-end (SV-1.1-live-A). Стора гейта ограничены — FIFO receipts + LRU cursors (SV-1.1-live-B, закрыл MAJOR из ревью). **Payload-схемы (SV-1.2, инвариант #5):** zod-схема на каждый из 21 клиентского типа действий (вкл. артиллерию/отступление/рынок из main) (`shared-core/actions/payloadSchemas` + `isValidActionPayload`) инжектится в гейт как `payloadValidator` — кривой payload или не-клиентский тип → `E_BAD_PAYLOAD` до редьюсера. **Гейт на durable-пути (gate+persist):** принятое gated-действие коммитится-до-broadcast на durable-пути; весь admit→commit сериализован в mailbox (резервация seq и persist атомарны), при транзиентном сбое `SequenceGate.rollback` отпускает курсор → тот же `clientSeq` ретраится (не `E_REPLAY`). Прошло состязательное ревью (дизайн звучит; закрыт MAJOR — broadcast теперь per-player изолирован, не может застрять на throw). **Боевой вход:** `main.ts` включает auth/гейт по env (`AUTH_JWT_SECRET`, `GATE=1`, `ALLOWED_ORIGINS`), default off (live-C). **Мульти-матч (SV-4.0):** вход хостит N матчей через `LazyRoomRegistry` — матч грузится из стора по первому коннекту, гибернируется в простое, будится к событиям; `dev` сидируется на буте (реальный create — SV-2.4). **Вход игроков (SV-2.4):** dev-grade create/join API — `POST /matches` (сид+persist), `GET /matches/:id/join?nick=` (ник занимает место first-come → короткоживущий join-токен, 15 мин); выставляется **только при включённом auth** (иначе у дефолтного сервера нет неаутентифицированной write-поверхности), с кепом на создание. Токен — реальная граница на WS; **кто** его получил — пока нет (нужен OIDC, отдельный трек). **Метрики (OPS-0.1):** `/metrics` — агрегатные gauge'ы (число матчей/коннектов, без id). **Крит-путь до онлайн-сессии закрыт.** Пройден 3-линзовый ревью (корректность/безопасность/чистота): починен HIGH-баг живости (драйвер часов не пере-armился после committed-действия — вынес эмиссию `action`-наблюдения за окно `committing`); добавлен Fastify error-handler (инвариант #4, без утечки); ядро gate/session/JWT подтверждено безопасным. **Вектор 2 (надёжность) сделан:** durable-места (`createStores` отдаёт `PostgresAccountStore` при `DATABASE_URL` — ник→место переживает рестарт, 2.2); CI-workflow (`ci.yml`) с сервис-Postgres гоняет durable-адаптеры в CI + `configFromEnv` вынесен из `main.ts` и покрыт тестом round-trip mint↔verify (2.3). **Durable-стора гейта — НЕ нужны (2.1, verified):** они ключуются по per-connection `sessionId` (серверный, неповторимый), теряются ровно когда отслеживаемые сессии заканчиваются → переподключение минтит свежий `sessionId` → свежий курсор; персистить нечего. ⏳ Дальше: OIDC-идентичность + rate-limit на create/join, envelope-клиент (гейт под флагом ждёт клиента с `action.v1`), контейнер-хардненинг. _Известный нюанс (клиентская сверка, не серверная durability):_ acked-но-недоставленное действие + рестарт + наивный ресенд может примениться дважды (`actionId` session-scoped) — закрывается сверкой клиента с полным `welcome`-состоянием на реконнекте, не durable-стора́ми гейта.
- `packages/client` — клиент (Этап 4): направление **PWA-first веб-клиент** (TWA Android + Capacitor iOS, не React Native — см. `cross-platform-roadmap.md`). Есть `MultiplayerClient` transport adapter, токены темы (`theme.ts`) и framework-agnostic view-models (паттерн: чистая фабрика + fail-secure, JSON-сериализуемо): `welcomeScreen.ts` (экран входа) и `matchHud.ts` (внутриматчевый HUD: зоны A+D — `createStatusBarModel` стат-бар, `createSelectionModel` панель флота; **боевая зона** — `createBattleModel` + `resolveBattleAction` панель активного боя с единственным действием «Отступить»; всё поверх fog-проекции `visibleState`; см. `hud-inmatch.md`). App shell ещё плейсхолдер.
- `data/` — контент в JSON. `docs/` — дизайн. `prototype/` — играбельный
  single-file HTML на реальном ядре (для «пощупать»).

## 2. Архитектура ядра

`createKernel(modules)` компилирует неизменяемое ядро из упорядоченного списка
модулей (порядок = приоритет, версионируется per-match). Два **чистых** входа:

- `applyAction(state, action, ctx)` — применить намерение игрока в `ctx.now`.
- `advanceTo(state, ctx)` — продвинуть мировые часы до `ctx.now`: исполняет
  запланированные события в порядке `(at, seq)` и эмитит непрерывные спаны
  `time.advanced {from,to}` (накопление по формуле, а не по тикам).
  Реальный поток сервера: `advanceTo` до настоящего → затем `applyAction`.
  При переполнении `MAX_ADVANCE_STEPS` возвращает **частичный** прогресс
  (`partial:true`), а не выбрасывает работу — комната догоняет чанками и детектит
  same-instant runaway (стойло), драйверы делают backoff (отказоустойчивость,
  `infra-sizing-roadmap.md` блокер #3).

  **Оптимизация:** `scheduled` поддерживается в отсортированном порядке `(at, seq)` —
  вставка через binary search (`O(log N)`), извлечение ближайшего события `O(1)` вместо
  линейного сканирования. Нормализация при входе в `advanceTo`.

Модуль в `setup(api)` регистрирует: `onAction(type,h)` (один обработчик на тип),
`on(event,h)`, `hook(name,fn)`, `provideCapability(name,impl)`. Обработчик
получает `HandlerContext`: `state` (черновик-клон), `ctx` (now + данные), `rng`,
`emit`, `schedule(at,type,payload)`, `hook`, `capability`, `reject(code)`.

**Инварианты** (нарушение = баг):

1. **Детерминизм.** Никаких `Math.random`/`Date.now` в ядре (ESLint-гард);
   seeded `Rng` (sfc32, golden-тест), время — параметр `ctx.now`.
2. **Чистота/иммутабельность.** `applyAction` не мутирует вход (работает на
   `deepClone`); `GameState` — JSON-сериализуемый (JSONB), без классов/Map/Date.
3. **Только через шину.** Модули не импортируют друг друга. Три механизма:
   события (pub/sub), хуки (конвейеры с базовым дефолтом), реестр возможностей
   (опц. связи с фолбэком). Любая точка расширения деградирует мягко.
4. **Fail-secure (A10).** Любая ошибка → отказ `{ok:false, code}` со стабильным
   кодом, без утечки деталей; `h.reject(code)`, неожиданный throw → `E_INTERNAL`.
   Упавшее запланированное событие — dead-letter (мир не зависает).
5. **Server-authority.** Клиент шлёт намерение, не состояние.
6. **Детерминизм порядка модулей** (фиксирован в манифесте).

## 3. Карта файлов

```
packages/shared-core/src/
packages/action-layer/src/
  kernel/        kernel.ts (createKernel/applyAction/advanceTo, шина/хуки/расписание), module.ts (контракт)
  state/         gameState.ts (типы GameState), orbit.ts (isBombarded, bombardedPlanets), visibility.ts (visibleState — туман войны)
  action/        types.ts (Action, Context, MatchConfig.timeScale/victory, ApplyResult/AdvanceResult, Rejection, timeScaleOf)
  data/          schemas.ts (zod-схемы + parseGameData, buildingLevel/buildingMaxLevel)
  rng/           rng.ts (sfc32)
  util/          clone.ts (deepClone/deepFreeze), treasury.ts (canAfford/payCost — shared by construction & technology)
  modules/       army, captureOnArrival, combat, construction, economy, faction, hero, market, movement, planetType, reanimation, sector, station, technology, victory, visibility  (16 модулей, + *.test.ts)
  examples/      skirmish.test.ts (демо-сценарий + SVG)
  index.ts       баррель (экспорт публичного API)
data/            manifest, resources, units, buildings, factions, events, sectors, planetTypes, technologies (.json)
docs/            architecture, modulesystem, roadmap, deep-technical-roadmap, multiplayer, engineering-risks, gdd, metagame, state(этот)
prototype/       src/game.ts, src/main.ts (UI), src/smoke.ts, build.mjs, uitest.mjs, dist/ (артефакт, в .gitignore)
```

## 4. Модель состояния (`GameState`)

- `version {data, manifest}`, `time`, `rng`.
- `players: Record<id, Player>` — `Player.resources: ResourceBag` = **казна
  игрока** (производство копится сюда, содержание/стоимости списываются),
  `technologies?` = сессионные исследования (`completed[]`, `active`).
- `planets: Record<id, Planet>` — `owner|null`, `position{x,y}`, `links?`
  (лейны графа), `terrain?` (террейн → `sectors`) и `kind?` (тип провинции → `sectorKinds`:
  capturable/buildable/orbit + ростер `allowedBuildings` + вид `appearance`), `size?`, `resources`,
  **`buildings: BuildingInstance[]`**
  (`{type, level, hp}`), `garrison: UnitStack[]` (наземная армия мира), `traits`.
- `fleets: Record<id, Fleet>` — `owner`, `location|null`, `movement|null`,
  `units: UnitStack[]` (корабли), **`landing?: UnitStack[]`** (перевозимая
  наземная армия = десант), **`orbit?: 'near'`** (одна орбита: `'near'` = стоит на
  орбите, `undefined` = в перелёте/не на орбите), **`bombarding?: boolean`**,
  `battleId?`, **`retreatHasteUntil?`** (мир-время, до которого действует баф скорости
  после отступления — читает хук `fleet.speed`).
- `battles: Record<id, Battle>` — `location`, `phase:'orbital'|'ground'`,
  `attacker/defender {ref: CombatantRef, owner}`, `round`, **`nextRoundAt?`**
  (время следующего почасового раунда — таймер боя для клиента). `CombatantRef` =
  `fleet` | `landing` | `garrison`.
- `scheduled: ScheduledEvent[]` `{id, at, type, payload, seq}`, счётчики
  `battleSeq`, `scheduleSeq`.
- `UnitStack {unit, count, hp?, shieldHp?}` (`hp` — пул корпуса, `shieldHp` — пул
  **аблятивного щита**, shields-roadmap SH-0.1). Для наземных стеков оба пула живут
  только во время боя (после — сброс в `undefined` = полное HP/щит). Для
  **корабельных** стеков (`fleet.units`) оба **сохраняются и вне боя**; вне боя
  щит регенит сам, корпус чинится только в порту (see construction, SH-1.1/2.1).
- `heroes?: Record<id, Hero>` (`{owner, location, cooldowns}`), `tempLanes?: TempLane[]`
  (временные публичные трассы), `topology?` (версия графа для инвалидации `RouteCache`),
  `heroSeq?` (счётчик id лейнов) — модуль `hero`.
- `diplomacy?: Record<pairKey, DiplomaticStance>` — попарные дип-отношения (`war`/`peace`/
  `pact`/`alliance`), симметрично и **публично** (туман не режет). Дефолт пары без записи —
  `war` (= FFA). Примитивы в `state/diplomacy.ts`. **`combat.isHostile` читает стойку прямо из
  `state.diplomacy`** (`getStance(...) === 'war'`) — бой идёт только при объявленной войне (не
  через capability: она статична и не видит живой `state`). Прототип сеет всем парам `peace`
  в `newGame`, даёт `diplomacyModule` (действие `diplomacy.declare` → `setStance`) и клиентский
  гейт: маршрут через чужую территорию без войны блокируется, ручной тык по ней открывает
  предупреждение «это объявит войну», ИИ объявляет войну, когда нейтралы кончились.
  **Сессионное меню дипломатии/сообщений** (прототип, рейл → Дипломатия/Dispatches):
  ростер всех участников (иконка человек ☻ / ИИ ⌬, сорт. по имени/провинциям/отношению +
  фильтры-чипы по отношению и типу человек/ИИ — AND между категориями, OR внутри),
  смена стойки предложениями — повышение ранга (мир<пакт<союз, и мир из войны) требует
  согласия ИИ (детерминированно по числу провинций), понижение/война односторонни.
  Вкладка «Сообщения» — переписки master-detail: слева список чатов (групповой
  «⚡ Коалиция» = ты + союзники, закреплён сверху; ниже личные DM по участникам),
  справа открывается выбранный тред + composer. Системные дип-события с твоим участием
  ложатся в DM с этой стороной (через `diplomacy.changed`). В чате коалиции — **пинги**:
  выделил провинцию → 📍 шлёт метку; тык по метке → камера летит туда (`centerOn`) и
  меню закрывается. **Пинг виден и на карте** как маркер-булавка (цвет владельца): тык по
  нему → попап с автором и **коротким описанием, которое пишет ставящий** (текст из
  composer'а) + «↪ камера» и «убрать» (для своих). Сообщения живут в клиенте (не в ядре —
  на симуляцию не влияют). **Сеть (пинги):** `MultiplayerClient` теперь шлёт `ping.place`/
  `ping.clear` и принимает `ping.added`/`ping.removed` (`onPingAdded`/`onPingRemoved`); в
  NET-режиме прототип ставит/убирает пинг через сервер (авторитетный — штампует id/TTL,
  раздаёт владельцу+союзникам по командам, прячет от врагов), а эхо `ping.added` рисует
  маркер. Текстовый чат (DM/коалиция) пока клиентский — в протоколе только пинги.

**Время:** все длительности — через `schedule(at,…)`; `timeScale` (MatchConfig)
делит реальные длительности (×1/×2/×4). `time.advanced` спаны дают накопление.

## 5. Модули ядра (что делают)

Порядок в кернелах обычно: `sector, planet-type, technology, economy, movement, combat, construction, army`.

### economy (`economy`)

На `time.advanced`: **производство** каждого своего мира → казну владельца
(хук `economy.production`, масштаб по часам×timeScale); **содержание** юнитов/
гарнизонов — суточный дрейн из казны (clamp ≥0). **Бомбардируемый мир не
производит** (`isBombarded`). Действий нет.

### market (`market`) — сессионная биржа ресурсов

Публичный per-match ордербук `GameState.market` (не путать с мета-аукционом из
`economy-roadmap.md`). Действия: **`market.list {resource, amount, price}`** —
выставить ресурс (эскроу: `amount` списывается из казны в ордер); **`market.buy
{orderId, amount}`** — купить (частично) за деньги (`credits`); **`market.cancel
{orderId}`** — продавец забирает непроданный остаток. **Комиссия 15% сжигается**
(сток против инфляции): покупатель платит `amount×price`, продавец получает 85%.
Коды: `E_BAD_PAYLOAD, E_UNKNOWN_RESOURCE, E_FORBIDDEN, E_INSUFFICIENT, E_NO_ORDER,
E_OWN_ORDER, E_BAD_AMOUNT`. Публичен (туман не режет); в `delta` META.

### movement (`movement`)

**Непрерывная позиция (как у Bytro).** Флот — это уже не «узел или в пути»: третье
состояние — **припаркован НА лейне** (`Fleet.edge {from,to,t}`, `t∈(0,1)`), взаимно
исключающее с `location`/`movement`. Лега несёт `startT`/`endT` — под-отрезок
`[startT,endT]` лейна (частичная лега из/в припаркованную точку).

Действие **`fleet.move {fleetId, to}` ИЛИ `{fleetId, toEdge:{from,to,t}}`** — маршрут
Дейкстрой по лейнам, многохоп, планирует `fleet.arrival`; на узле эмитит
`fleet.transit` (промежуточный) или `fleet.arrived` (финал). Начало **каждой** леги
(старт пути И каждый промежуточный хоп) эмитит **`fleet.leg {fleetId}`** — чтобы
combat считал перехват двух флотов, пересекающихся **на лейне**, а не только на узле.
`toEdge` — марш в **точку
на дороге**: маршрут до ближайшего конца лейна + финальная частичная лега, паркуется
(`fleet.parked`). Припаркованный флот **перемаршрутизируется** из своей точки (выбирает
дешёвый конец, может пойти назад); репозиция вдоль того же лейна — одна прямая лега.
Событие `fleet.arrival` несёт `departedAt` → устаревшее прибытие брошенной леги (после
stop + re-route) игнорируется (без телепорта). Хук `fleet.speed` (скорость = по
медленному кораблю). **Оптимизация:** `RouteCache` — ленивый кэш узловых маршрутов.
Коды: `E_BAD_PAYLOAD, E_NO_FLEET, E_FORBIDDEN, E_FLEET_BUSY, E_SAME_LOCATION,
E_NO_DESTINATION, E_NO_ROUTE, E_NOT_A_LANE, E_FLEET_IMMOBILE`.
Действие **`fleet.stop {fleetId}`** — припарковать летящий флот в его **текущей
непрерывной точке** на лейне (доля по прошедшему времени леги), эмит `fleet.parked`
— не на следующем узле, а где стоит; в глубоком космосе не зависает.

### sector (`sector`)

Хуки: `fleet.speed` (×(1+speedBonus) сектора назначения), `combat.damage`
(делит урон на (1+hpBonus) — живучесть в секторе; ×1.25 урона в своём секторе).
Типы секторов — данные. Действий нет.

### planet-type (`planet-type`)

Тип планеты (`planetType`, данные `data/planetTypes.json`) даёт модификаторы через
хуки — как сектор, но про сам мир. `economy.production` (×(1+productionBonus)
производства мира); `combat.damage` (наземная фаза: урон по гарнизону владельца
÷(1+defenseBonus); знак учитывается — защищённый мир делит, открытый усиливает),
складывается со зданиями. Типы: terran/barren/oceanic/volcanic/gas_giant. Без
модуля — без эффекта (мягкая деградация). Действий нет.

### technology (`technology`) — сессионное дерево технологий

Действие **`technology.research {technology}`** запускает исследование игрока в
рамках матча — до **2 одновременных** (база; поднимается хуком `research.slots`,
напр. учёным-«+слот», до максимума **3**). Стоимость списывается из казны сразу,
завершение планируется как `technology.complete` с учётом `timeScale`. Состояние
лежит в `Player.technologies` (`completed[]`, `active[]` — по записи на слот).

**Гейтинг данными — `technologyLock(def, state, playerId, data)`** (чистая,
экспортируется для сервера/UI): техно доступно, когда все `prerequisites` завершены
**И** наступил день `dayGate` (мировой клок: `state.time − startedAt ≥
dayGate·MS_PER_DAY`, совпадает с «Day N» матч-браузера) **И** выполнены все
`conditions`. Условия — курируемый каталог (`own_sectors` / `has_building` /
`controls_planet_type` / `has_unit` с count-порогом `min`; `has_scientist
{branch?, minLevel?}` — учёный), диспетч по `type`, fail-secure на неизвестный тип. Коды: `E_BAD_PAYLOAD, E_FORBIDDEN, E_UNKNOWN_TECHNOLOGY,
E_ALREADY_RESEARCHED, E_RESEARCH_SLOTS_FULL, E_PREREQUISITE, E_TOO_EARLY,
E_CONDITIONS_UNMET, E_INSUFFICIENT`.

Данные `data/technologies.json` задают **branch** (4 ветки-вкладки), **dayGate**,
**conditions**, tier, cost, researchTimeHours, prerequisites, unlocks и effects.
Модуль подключается только через хуки: `construction.requirement` закрывает
юниты/здания из unlocks, пока технология не завершена; `economy.production`,
`fleet.speed` и `combat.damage` применяют сессионные бонусы; `research.slots`
поднимает число слотов. Без модуля unlock-гейт мягко деградирует: строительство
остаётся открытым.

### scientist (`scientist`) — research-лидер (учёный)

Выбирается на старте и снапшотится в `Player.scientist {id, level}` (через
слот-ассайнмент `buildStateFromMap`; `E_UNKNOWN_SCIENTIST` при неизвестном id;
приватен в тумане — стрипается у чужих проекций). Каталог `data/scientists.json`
(`ScientistDef {name, branch?, slotBonus}`) — НЕ юнит, НЕ hero-модуль. Эффекты идут
через существующие швы: **`+слот`-лидер** добавляет `slotBonus` в хук
`research.slots` (клампится к 3); **фокус ветки и лейт-капстоун** — data-driven через
условие `has_scientist` (качественный доступ, **не % скорости**). `+слот`
INSTEAD-of-фокус — opportunity-cost (лидер-«+слот» branchless). Уровень — мета (из
аккаунта; пока параметр сборки — `account-level` ещё docs-only).

### combat (`combat`) — бой, орбиты, ПВО, бомбардировка

- На `fleet.arrived`/`fleet.transit`: флот встаёт на **орбиту** (одна орбита, `'near'`);
  `engageFleets` авто-завязывает **орбитальный бой флот-vs-флот** при встрече
  враждебных флотов **на узле** (прибытие само по себе **не** захватывает).
- **Перехват на лейне** (`fleet.leg`/`fleet.parked` → `fleet.intercept`): два
  враждебных флота, пересекающиеся **на одном лейне** (а не на узле), сводятся
  «встречей по формуле» — позиция каждого линейна по времени, момент пересечения
  решается аналитически (интерполяция позиций 0..1 на концах окна перекрытия), и в
  эту точку планируется `fleet.intercept`. Событие **самопроверяется** при срабатывании
  (оба ещё на лейне, враждебны, живы, свободны), так что переприказ до контакта
  делает устаревший перехват безвредным no-op. На встрече оба флота пинятся к точке
  на лейне (`edge`) и начинается орбитальный бой; победитель остаётся припаркован на
  лейне (без телепорта на узел).
- `combat.tick` — почасовые раунды: атакующая сторона бьёт `attack`, стоящий
  защитник — `defense` (ответный огонь). Линии `front/mid/rear/artillery`
  (артиллерия — трейт `artillery`, в ближнем бою бьёт `attack` и получает урон
  последней; вне боя бьёт **на расстоянии** — см. `runArtillery` ниже). Пул HP стека с переносом, `unit.died`. Интервал раунда =
  `MS_PER_HOUR / timeScale`; `battle.nextRoundAt` несёт время следующего раунда
  (таймер боя). Урон через хук **`combat.damage`** (args: battleId, phase, location,
  attacker, defender). Исход → `battle.resolved`.
- **Аблятивный щит (shields SH-0.2):** `applyDamage` сначала снимает `shieldHp` стека,
  остаток — в корпус (`hp`); корабль гибнет **по корпусу** (щит не убивает), павшие
  корабли уносят щит (пул капается `newCount × shield`). Наземным `finishBattle` сбрасывает
  оба пула, корабли — сохраняют. Реген вне боя — `construction` на `time.advanced`
  (SH-1.1): щит регенит бесплатно, корпус — только в порту.
- Действие **`fleet.orbit {orbit:'near'}`** — «выйти на орбиту» (одна орбита,
  единственное значение — `'near'`; прибытие на объект ставит флот на неё само).
- Действие **`fleet.assault`** — стоя **на орбите**: штурм гарнизона десантом
  (`landing`) или оккупация необоронённого враждебного мира. Победа десанта →
  `capturePlanet` (десант становится гарнизоном, `planet.captured`). Коды:
  `E_WRONG_ORBIT, E_ORBIT_CONTESTED, E_NO_TROOPS, E_OWN_PLANET, E_NO_PLANET, E_FLEET_BUSY,…`.
- Действие **`fleet.bombard {on}`** — тумблер бомбардировки (стоя на орбите,
  враждебный мир, есть корабли; `E_NO_SHIPS`).
- На `time.advanced` — **орбитальный тик** (`runOrbital`): (а) **ПВО** —
  гарнизонный `aaDamage` бьёт по враждебному флоту **на орбите**, **если
  нет наземного штурма** (иначе ПВО просто обороняет гарнизон как наземный
  юнит); обнулённый флот уничтожается. (б)
  **Бомбардировка** — каждый бомбящий флот эмитит `planet.bombarded
{planetId, power, owner}` (`power = Σ attack × 0.5 × часы`).
  **Оптимизация `runOrbital`:** пре-индекс флотов по локации + сет наземных штурмов;
  стоимость O(planets + fleets + battles) вместо O(planets × fleets).
- На `time.advanced` — **артиллерийский залп на расстоянии** (`runArtillery`,
  GDD §7.2 «бьёт на расстоянии»): каждый **свободный, СТОЯЩИЙ** флот (не в бою, без
  `movement`) с юнитами-трейтом `artillery` обстреливает **ОДНУ** враждебную
  **стоящую** цель-флот в радиусе `range` (евклид, единицы карты; макс. среди
  артиллерии флота). **Чистый стэндофф** — без ответного огня и без входа в бой;
  урон `= Σ(artillery count × attack) × часы`. Два инварианта: (1) только стоящие
  стрелок+цель — их позиции постоянны на отрезке, так что разовая проверка радиуса и
  биллинг за весь отрезок ТОЧНЫ (урон не зависит от дробности шага времени; летящий
  флот вместо этого дерётся столкновением-перехватом). (2) **Одновременность** — все
  залпы считаются из снимка до отрезка, затем применяются, так что две артиллерии,
  выбивающие друг друга, обе успевают выстрелить (как пред-раундовая модель
  `combat.tick`, без форы по id). Авто-цель — **ближайший** враждебный флот
  (тай-брейк по id); событие `artillery.fired`. Обнулённая цель → `fleet.destroyed`.
- Действие **`fleet.barrage {fleetId, targetId|null}`** — фокус-огонь: навести
  артиллерию на конкретный враждебный флот (`barrageTarget` на флоте) или сбросить
  (`null` → авто-ближайший). Устаревшая цель (погибла / вышла из радиуса) сбрасывается
  сама. Коды: `E_NO_FLEET, E_FORBIDDEN, E_NO_ARTILLERY, E_NO_TARGET, E_NOT_HOSTILE,
E_BAD_PAYLOAD`. Поиск флота по цели — **own-key** (`__proto__`/`constructor` не
  проходят, защита от отравления `barrageTarget` → тихий DoS отрезка).
- **Режимы огня артиллерии** (`barrageMode` на флоте, лестница агрессии; действие
  **`fleet.barrageMode {fleetId, mode}`**): **`passive`** — не стреляет; **`return`**
  — только после того, как флот получил урон (флаг `barrageProvoked`, ставится в
  `applyDamageToSide`); **`standard`** (дефолт) — по тем, с кем **война**;
  **`aggressive`** — по любому флоту, кроме **пакта/союза** (т.е. война ИЛИ мир —
  открывает огонь по несоюзным соседям). Стойка читается из `state.diplomacy`.
- Действие **`fleet.retreat {fleetId}`** — выйти из орбитального боя. Плата: **−40%
  МАКС корпуса и щита** на стек (`applyRetreatToll`, может добить уже потрёпанный флот →
  `fleet.destroyed`); награда: **баф скорости** ×1.5 на 3ч (`retreatHasteUntil`, хук
  `fleet.speed`). Бой 1-на-1 распускается, противник освобождается (`releaseOrDestroyFleet`).
  Только орбитальный корабль-сторона (не десант/гарнизон). Событие `fleet.retreated {escaped}`.
  Коды: `E_BAD_PAYLOAD, E_NO_FLEET, E_FORBIDDEN, E_NOT_IN_BATTLE, E_CANNOT_RETREAT`.

### construction (`construction`) — здания + наземная стройка

- Действия **`building.construct`**, **`building.upgrade`**, **`unit.build
{count}`** — оплата вперёд из казны, отложенное завершение через
  `construction.complete` (`buildTimeHours`×timeScale). Одно здание каждого типа
  на планету; юниты идут в гарнизон. Коды: `E_BAD_PAYLOAD, E_NO_PLANET,
E_FORBIDDEN, E_UNKNOWN_BUILDING/UNIT, E_ALREADY_BUILT, E_ALREADY_QUEUED,
E_NO_BUILDING, E_MAX_LEVEL, E_INSUFFICIENT, E_BOMBARDED, E_WRONG_SECTOR`.
- **Ростер по типу провинции (province-centric):** `sectorKinds[kind].allowedBuildings`
  — единый источник «что здесь строится», редактируется в одном месте. `building.construct`
  проверяет `building ∈ allowedBuildings`, иначе `E_WRONG_SECTOR`. Отсутствует/`undefined`
  = любое здание (kind не задан → пермиссивно); явный `[]` = строить нельзя (empty/debris).
  Так у каждого типа свои постройки: **планета** — всё; **астероид** — шахты/радар/форт;
  **туманность** — радар/форт; **`void_station`** — верфь/космопорт/радар/форт (без шахт/казарм).
- **`sectorKinds` = единый реестр типов провинций** (планета — тоже провинция): на каждый kind
  — структурные флаги (`capturable/buildable/orbit`) + ростер (`allowedBuildings`) + вид на карте
  (`appearance{color,label,shape}`, резолвится по kind на клиенте, в `GameState` не хранится).
  Аксессоры: `allowedBuildings(data, planet)`, `sectorAppearance(data, planet)`. Экономические
  слои (`terrain`/`planetType`: производство/защита/скорость/HP/очки) остаются ортогональными.
  `PlanetSnapshot.kind` снапшотится в тумане → неразведанный узел не утекает истинным типом,
  а вспомненный показывает запомненный. Прототип красит провинцию по `appearance.color` и
  показывает тип + ростер в панели.
  планетой** (иначе вложение сгорает); **под бомбардировкой — пауза** (re-defer).
- Хук `combat.damage`: **бонус обороны гарнизона** = сумма `defenseBonus`
  зданий (наземная фаза). На `combat.round` (наземный штурм) и на
  `planet.bombarded` — **износ/разрушение зданий** (`building.destroyed`).
- **Лечение/ремонт на `time.advanced`:** (а) **гарнизон** лечится по сумме
  `healRate` зданий (госпиталь). (б) **Корабли флота** (`fleet.units`) — **два пула**
  чинятся по-разному (shields SH-1.1): **щит** (`shieldHp`) регенит **бесплатно где угодно
  вне боя** (`SHIELD_REGEN` 6%/ч), после **задержки** от последнего урона (`lastDamagedAt` +
  `SHIELD_REGEN_DELAY`, реген только на части спана после окна); **корпус** (`hp`) **не** регенит
  бесплатно — чинится только пока флот стоит над **своим** миром **с ремонтной верфью** (SH-2.1:
  Σ `BuildingDef.shipRepair`; `shipyard` 0.1/ч, `spaceport` 0.05/ч; госпиталь корпус НЕ чинит), и до
  ремонта **тянет скорость вниз** (`route.ts fleetBaseSpeed` — штраф <30%). Флот в бою (`battleId`) не
  регенит ничего.
- События: `construction.started, building.constructed/upgraded/destroyed,
unit.built`.

### station (`station`) — аванпосты в пустом космосе

Контекст: корабли теперь **почти слепые** (`visibility.ts`: identify-флуд флота = 0
прыжков, видит только свой узел; миры — 1 прыжок). Разведка — через **радар**
(постройка `radar` или юнит с `radarRange`). Чтобы вынести радар/форт **в пустоту**,
нужен аванпост: пустой космос нельзя ни захватить, ни застраивать (`sectorKinds.empty`).

Действие **`station.deploy {planetId}`** — закрепить станцию на **пустом** узле из
стоящего там своего флота: узел становится владеемым застраиваемым **`void_station`**
(`sectorKinds`: capturable/buildable), оплата вперёд из казны. Дальше обычной
`building.construct` на нём поднимается радар/форт/прочее. Станция — настоящий узел:
оставишь без гарнизона — враг заходит (capture-on-arrival). Коды: `E_BAD_PAYLOAD,
E_NO_PLANET, E_NOT_EMPTY, E_FORBIDDEN, E_NO_ANCHOR, E_INSUFFICIENT`. Событие
`station.deployed`. Новый модуль + данные, ядро не тронуто.

### army (`army`) — разделение флота и наземной армии + транспорт

Действия **`army.load`** / **`army.unload {fleetId, unit, count}`** — перекладка
наземных юнитов между гарнизоном и трюмом флота, в пределах **вместимости**
(`Σ cargoCapacity` кораблей; груз занимает `cargoSize`). Корабли (`domain:space`)
возить нельзя; юниты с трейтом **`immobile`** (стационарные установки — орбитальное
ПВО) грузить нельзя (`E_IMMOBILE`). Коды: `E_NO_CAPACITY, E_NO_ARMY, E_NOT_GROUND,
E_IMMOBILE, E_FLEET_BUSY, E_FORBIDDEN, E_NO_PLANET, E_UNKNOWN_UNIT, E_BAD_PAYLOAD`.
События `army.loaded/unloaded`.

**Общий запрос:** `isBombarded(state, planetId)` / `bombardedPlanets(state)` (`state/orbit.ts`) —
есть ли враждебный бомбящий флот на near; используют economy и construction.
**Оптимизация:** `bombardedPlanets(state)` строит `Set<PlanetId>` за один проход O(fleets),
затем O(1) на проверку; economy вызывает один раз на `time.advanced` вместо O(fleets) на планету.

### victory (`victory`) — победа и счёт

`victoryModule` слушает `time.advanced`, `planet.captured`, `fleet.destroyed`,
`battle.resolved`, `unit.built`; пересчитывает `GameState.match.scores` и завершает
матч событием `match.ended`. Гонка триггеров (GDD §3.2): **доминирование** по доле
**КАПЧУРНЫХ** провинций (некапчурный void в знаменатель не идёт; по умолчанию 60%,
`MatchConfig.victory.dominationPercent`), **уничтожение** соперников (0 провинций →
`defeated` + флот распускается), **счёт** (порог `scoreLimit`, **по умолчанию 600**
— GDD §3.2) и **тайм-аут** (`endsAt`, **по умолчанию** кап сессии по скорости:
×1→100 / ×2→60 / ×4→30 игровых дней; победитель = лучший счёт, ничья = `winner:null`).
Все пороги переопределяются через `MatchConfig.victory`.

**Счёт — data-driven, только территория** (GDD §8.1). База очков узла задаётся его
**видом** (`sectorKinds[kind].scoreValue`): **планета — 50** (приз), любой другой вид —
**10** (дефолт схемы; «мёртвый мир» — тоже 10). Поверх базы — Σ `building.scoreValue ×
level` (вложение в апгрейды растит счёт, разрушение — снижает; здания дают очки по тиру).
Тип планеты (`planetType`) и террейн (`sector`) теперь кормят экономику/защиту, но **в
счёт не идут** — так баланс карты считается «12 планет × 50 + остальное × 10». **Армия
очков НЕ даёт** (только headcount в `units`). Поверх базы — **хук `victory.score`** на
провинцию (args `{planetId, owner}`): модули (тех/фракции/улучшения) добавляют очки
данными. «Жив ли игрок» для elimination считается по владению провинцией (0 провинций →
выбыл), **независимо** от `total`.

### hero (`hero`) — герой-сущность игрока + способности

**Инстанс-ключёванная** сущность: `GameState.heroes: Record<HeroId, Hero>` (ключ —
инстанс-id `Hero.id`, **не** `playerId`; фильтр по `owner` — до нескольких героев на
игрока). Запись: `{id, owner, name?, location, cooldowns, alive?, grade?, abilities?,
home?, fleetId?}` — `grade` (редкость, число слотов в клиентском ростере), `abilities`
(надетые «модули», по слоту на градацию), `home` (якорь респауна = столица), `fleetId`
(корабль, которым герой командует, пока жив). Способности действуют из/вокруг текущего
узла. Состояние JSON-сериализуемо, длительности через `schedule`, бонус — через хук;
ядро не меняется. (До миграции — один герой на игрока с ключом `playerId`.)

- Действие **`hero.move {to}`** — передислокация героя в **свой** мир. Коды:
  `E_BAD_PAYLOAD, E_NO_HERO, E_NO_PLANET, E_FORBIDDEN`.
- Действие **`hero.path.create {to}`** — открыть **временную публичную трассу** от узла
  героя к ближайшему (≤ `PATH_RANGE` = 600): **реальное ребро графа** (добавляется в
  `Planet.links` в обе стороны, маршрутизируемо всеми) на `PATH_DURATION_HOURS` = 6 ч, по
  которому **флоты владельца** идут с бонусом скорости `PATH_SPEED_BONUS` = +50%. Лейн
  лежит в `GameState.tempLanes[]`, истечение — отложенный `hero.path.expire`; кэш
  маршрутов инвалидируется через **`GameState.topology`** (версия топологии, бампится при
  любой смене `links`). Кулдаун `PATH_COOLDOWN_HOURS` = 12 ч. Коды: `E_BAD_PAYLOAD,
  E_NO_HERO, E_SAME_LOCATION, E_NO_PLANET, E_OUT_OF_RANGE, E_COOLDOWN`.
- Событие **`hero.path.expire`** снимает лейн и **убирает ребро только если его добавил
  именно этот лейн** (`addedLink`) и его не держит другой живой лейн; бампит `topology`.
- Действие **`planet.annihilate {planetId}`** — уничтожение мира в радиусе
  (`ANNIHILATE_RANGE` = 500): узел **остаётся** (сквозь него можно лететь), `kind`/
  `planetType` → **`dead_world`**, гарнизон+здания снесены, владелец сброшен (нейтрал).
  Мёртвый мир — **захватываемый и застраиваемый**, но стоит лишь **10** очков (вместо 50)
  и **богат металлом (+30%)**; единственная доступная постройка — **`metal_station`**
  (салвага). Повторно «убить» dead_world нельзя (гард по `kind`). Кулдаун
  `ANNIHILATE_COOLDOWN_HOURS` = 48 ч. Коды: `E_BAD_PAYLOAD, E_NO_HERO, E_NO_PLANET,
  E_NOT_DESTRUCTIBLE, E_OUT_OF_RANGE, E_COOLDOWN`.
- Хук `fleet.speed`: ×(1+`speedBonus`) для леги, идущей вдоль активного лейна владельца
  флота. Без модуля способностей/лейнов нет (мягкая деградация).

**Проекция-герой (развёрнутый герой игрока).** Особый **юнит-корабль** `hero` (трейт
`hero`, высокий HP) в стеке флота. Хук **`combat.damage`**: флот, несущий героя,
бьёт и держит на **+5%** (`HERO_COMBAT_BONUS`) — баф применяется к стороне,
наносящей урон, поэтому покрывает и атаку, и ответный огонь. На гибель героя
(`unit.died` с `unit:'hero'`; событие несёт `fleetId` павшего стека и `owner`, т.к.
опустевший флот удаляется до дренажа) heroModule находит героя **по его `fleetId`**
(чтобы при нескольких героях одного владельца смерть приписалась нужному; фолбэк — по
`owner`), зануляет `fleetId` и через `HERO_RESPAWN_HOURS` = 24 ч **возрождает** героя
свежим одно-корабельным флотом в **столице** (`Hero.home`, если ещё своя), иначе на
последнем узле, иначе на любом своём мире — и **перепривязывает** `fleetId` к новому
кораблю; без территории остаётся мёртв (`Hero.alive`). Развёрнут — **главный** (градация
`main`) герой ростера; имя (`Hero.name`) — ник игрока. В прототипе сидируется в стартовый
флот со своим лоадаутом, `home` = столица (на старте — родной мир); `capital.designate`
перенацеливает `home` героев владельца на новую столицу. Развёртывание **остальных**
героев ростера отдельными кораблями — следующий кирпич.

Герой **приватен**: `visibleState` отдаёт игроку только его собственного (позиция +
кулдауны), чужих вырезает; `tempLanes` остаются — это публичная топология (реальные
`links`). `dead_world` есть в `data/sectorKinds.json` (захватываемый/застраиваемый,
очки 10, ростер `[metal_station]`) и `data/planetTypes.json`
(`productionByResource.metal` = 0.3). Сидируется в dev-сценарии (`scenario.ts`):
по герою на игрока в его `home_*`.

### видимость / туман войны (`state/visibility.ts`) — граница безопасности

`visibleState(state, viewerId, data)` — **чистая проекция** (не модуль, не редьюсер):
сервер прогоняет её перед отправкой клиенту, **физически** убирая невидимое (а не
«шлём всё, прячем на клиенте»). Не влияет на симуляцию — read-only вид, детерминизм
не трогает. Текущая видимость: **identify** (полное опознание, дальность 1 прыжок по
графу от своих миров/флотов) + **radar** — по **физическому расстоянию** (евклидово, от
`BuildingDef.radarRange`/`UnitDef.radarRange` в координатных единицах), **не по прыжкам**:
узел близкий в космосе, но далёкий/недостижимый по лейнам, всё равно ловится радаром.
Враг в радаре, но не опознан → **сигнатура** `{location, size:S/M/L}`
(грубое «что-то есть», ведро по `Σ count × UnitDef.signature`), а не сам флот. Прячет:
чужую казну/технологии, контент невидимых миров (топология остаётся), невидимые
флоты/бои и **всё расписание** (утечка планов). Покрыто тестами, включая anti-leak
по JSON.

**Память (вариант B, `visibilityModule` + `modules/visibility.ts`).** Модуль на
`time.advanced`/`planet.captured`/`fleet.arrived` пишет per-player снимки опознанных
миров в **`GameState.fog`** (JSON, детерминировано). `visibleState` для мира вне обзора,
но виденного ранее, отдаёт **серое «last known»** из снимка и кладёт id в `remembered[]`
(а `fog` из проекции вырезается — внутреннее). Без модуля — память пустая, мир читается
как unknown (мягкая деградация).

**Туман на рассылке (F6, `packages/server/MatchRoom`).** Сервер шлёт **per-player
дельты** от `visibleState` (своя базовая линия на игрока) + сигнатуры/`remembered`
отдельными полями; **события тоже фильтруются** по видимости (`eventVisibleTo`). e2e:
на dev-карте green не видит флот red и `red_1` **не появляется по проводу** ни в стейте,
ни в событиях. **Дальше:** AOI-оптимизация, JWT в рукопожатии (F7).

**Реестр матчей / мета-шелл (`packages/server/MatchRegistry`, первый кирпич MM-0.1).**
Мульти-матч реестр поверх `MatchRoom` + **мета-запись рядом с матчем** (`MatchMeta`:
`mapId, rules:MatchConfig, createdAt, startedAt, archivedBy`) — **вне `GameState`**
(инвариант `main-menu.md` §2: мета-состояние не живёт в ядре). Read-model браузера
матчей `MatchRegistry.list(nick)` отдаёт три вкладки для зрителя: **available**
(присоединяемые — есть слот, не `ended`, ты не в них), **active** (ты держишь слот),
**archived** (ты перенёс в свой архив — **per-player** флаг, не глобальный). Строка
статуса: `days` (игровые дни от старта = `(state.time-startedAt)/MS_PER_DAY`), `players`
(занято/всего — занятость через `AccountStore.occupiedSeats`), `mapId`, `rules`, `status`.
Интент **archive/unarchive** — fail-secure (`E_NO_MATCH`/`E_FORBIDDEN`, авторизация по
посадке nick). По проводу: `wsServer` маршрутит `/matches/<id>` по реестру (404 на
неизвестный id), `GET /matches?nick=` (read-model) + `POST /matches/<id>/archive?nick=`
(интент). Идентичность — лёгкая, по nick (`AccountStore.seatOf`), **без аккаунтов**
(полное меню ждёт `AC-0.1`). `main.ts` сидит 2-3 dev-матча. **Дальше:** клиентский
экран меню (Этап 4), персистентность меты + `MatchStore.list` (Postgres уже под это
индексирован), лобби/создание матча (MM-1.1).

## 6. Данные (`data/*.json`, версия `0.1.0`)

- **resources:** `credits` (деньги), `metal`, `food`, `energy`, `microelectronics` —
  внутриматчевый набор из 5. Торгуются на сессионной бирже (модуль `market`).
- **units** (схема `UnitDef`): `domain('space'|'ground')`, `stats{attack, defense,
speed, hp, shield, range, cargoCapacity, cargoSize, aaDamage}` (+ любые доп. числа),
  `line, traits, abilities, cost, buildTimeHours, upkeep`, `signature, radarRange`
  (армия очков не даёт — см. victory). Есть: `scout_drone,
cruiser, siege_lance(artillery,range), dropship(cargoCapacity 12), militia,
drop_infantry, tank(cargoSize 3), orbital_aa(aaDamage), infected_cruiser`.
  Щиты (аблятивные) у боевых кораблей: cruiser 15, dropship 12, hero 40, infected_cruiser 8.
- **buildings** (`BuildingDef`): `cost, buildTimeHours, produces, hp,
defenseBonus, upgrades[{…}], traits, scoreValue, radarRange, healRate, shipRepair`. Есть: `mine_t1, mine_t2,
shipyard, biomass_pit, barracks, spaceport, radar, fort, metal_station, power_plant, fabricator`
  (форт — 3 уровня: HP 35→50→65, defenseBonus 0.35→0.50→0.65; **радар — 3 уровня**: `radarRange`
  300→500→700 (расстояние), HP 18→26→34). `radarRange` теперь **уровневый** (`BuildingLevelSchema`),
  `visibleState` читает его через `buildingLevel(def, level)`. `scoreValue`: fort 20·уровень,
  shipyard 12, fabricator 14, mine/biomass/power_plant 8, barracks/spaceport/radar 6.
  **ECON-3 — производители недостающих ресурсов:** `power_plant` (Fusion Reactor, 3 уровня:
  `energy` 25→60→110) и `fabricator` (Microelectronics Fab, 3 уровня: `microelectronics`
  8→18→32; стоит metal+credits+`energy` — премиум-ресурс «варится» из энергии, гейтится
  технологией `microelectronics_fabrication`). Так у каждого экономического ресурса
  (кроме `credits` — валюта/сток) есть хотя бы одно здание-производитель; экономика
  начисляет любой `produces`-ресурс агностично (движок не трогался). Ростеры
  `sectorKinds`: реактор — планета/астероид/туманность/`void_station`, фабрикатор —
  планета/`void_station`. Referential-integrity тест следит, что любой `produces`/`cost`/
  `upkeep`-ресурс контента есть в `resources`.
- **sectors:** `empty_space(+скорость), asteroid_field(−скорость/+живучесть/score 5),
nebula(score 3)`. **planetTypes** дают `scoreValue` (terran 40, oceanic 35,
volcanic 20, gas_giant 10, barren 5).
- **factions:** `vanguard, swarm` (пока флейвор/трейты).
- **events:** `infect_planet, void_anomaly` (правила
  trigger→effect; движок трейтов пока не построен).
- **technologies:** сессионное дерево (`industrial_automation`,
  `orbital_logistics`, `siege_doctrine`, `fortified_infrastructure`,
  `microelectronics_fabrication`): стоимость,
  длительность, prerequisite-цепочки, unlocks юнитов/зданий и бонусы к
  production/speed/damage.

## 7. Прототип (`prototype/`)

`pnpm run prototype` → esbuild собирает всё (ядро + zod + UI) в один
self-contained `dist/void-dominion.html` (открывается с диска, без сервера).

- **Реальное ядро** в браузере: `createKernel([sector, planetType, tax, economy, movement,
hero, combat, captureOnArrival, construction, technology, army, victory, fleetLaunch,
diplomacy, botDiplomacy, market, division, capital])` (18 модулей), тик в реальном
времени (скорость ⏸/▶/⏩). Концовка матча — из авторитетного `state.match` (`victoryModule`),
баннер победы/поражения/ничьи (а не хардкод по узлам).
  Миры размечены типами (terran/barren/oceanic/volcanic/gas_giant) — карточка планеты
  показывает тип и его бонусы (prod/def), `netIncome` учитывает множитель производства.
- **Карта (квадратная 7×7, генерится в `game.ts::buildField`):** 49 провинций — ровно **12
  «планет»** (по 50 очков) + 37 не-планет (по 10) = **~970** базовых очков на доске; 4 старт-
  кандидата по углам (инсет), нейтральные планеты по центру. Квадратный аспект — чтобы карта
  читалась в портрете (заполняет ширину, панится по вертикали). Победа по очкам — **450**
  (`SCORE_LIMIT`, прототип переопределяет дефолт ядра 600). Джиттер-решётка, RNG-линки и границы канваса выводятся из констант
  `FIELD`/`*_CELLS` — карта переформировывается правкой списков клеток.
- **Прототип-модуль `fleet.launch {planetId}`** (`game.ts`, не в ядре) — поднимает
  флот из гарнизона (корабли→`units`, наземные→`landing`). Кандидат в ядро.
- **UI — тактический пульт (DEFCON-вайб):** векторно-каркасный стиль на чёрном.
  - **Карта = радарный планшет:** панорамируемая координатная сетка (двигается/
    масштабируется с камерой), редкие звёзды-тики, лёгкие скан-линии (CSS). Фон усилен мягкими туманностями и twinkle-звёздами; jump lanes
    — тонкие статичные неоновые линии (кэшированный список связей). **Планеты —
    wireframe-кольца** с неоновым свечением (glow), секторной аурой, пульсирующим
    ядром, крестовыми тиками-блипами, анимированным пунктирным кольцом «сенсорной
    дальности», форт = гекс-контур; выделение — вращающиеся target-скобки. **Флоты —
    светящиеся chevron-ы** по курсу, с engine-pulse, заливкой и затухающим следом.
    **Стоящие флоты сидят на одном кольце орбиты** вокруг планеты (одна орбита, без
    меток N/F); у летящих рисуется **путь** (анимированная dash-полилиния по хопам), бомбардировка —
    beam. Бой — многокольцевая пульсирующая красная волна. Render loop кэширует
    HUD/log DOM-строки и отсекает offscreen планеты/флоты.
  - **HUD минималистичный, моноширинный, неоновые тонкие линии:** верхняя планка
    (callsign-ромб + читалки ресурсов `MTL/CRD/WLD/FLT` с `+N/h` из `netIncome` на всю
    ширину); кнопки скорости вынесены в **отдельный горизонтальный бар**; левая
    рейка-иконки, нижняя карточка-досье, терминальный лог `>`. **Командный бар флота**
    (горизонтальный, появляется по выбору флота): **Move** (взводит приказ → тап по миру
    отдаёт его — тап по узлу ИЛИ **по дороге** (`moveFleetEdge`/`nearestLanePoint`:
    армия выходит маршрутом на лейн и встаёт в точке; превью — путь + ETA-пип)),
    **Stop** (`fleet.stop` — паркует там, где стоит, прямо на дороге), **Attack**
    (штурм). Орбита одна — отдельного переключателя орбиты в баре больше нет.
    Припаркованный флот — chevron в его непрерывной точке, перемаршрутизируется
    по Move. Палитра: cyan (свои) / red (враг) / фосфорный зелёный (chrome) на near-black.
  - **Радар-кольцо:** при тумане — бледный teal-эллипс охвата моих радаров (массивы
    L1/L2/L3 = 300/500/700 коорд-ед + радар-корабли); радиус евклидов, проецируется
    по осям → граница тумана совпадает с кольцом.
  - **Камера pan/zoom** (тащить / колесо / pinch / двойной тап-сброс); **адаптив**
    (мобайл/десктоп, media-queries, DPR-чёткость, тач). `netIncome` считает прирост.
- **Орбитальные контролы игрока в панели флота** (выводят механику ядра, а не
  стопгап): переключатель **бомбардировки** (`fleet.bombard`), ручной **штурм**
  (`fleet.assault`), и **погрузка/высадка наземной армии** между гарнизоном своей
  планеты и трюмом флота (`army.load`/`army.unload`). Орбита одна — на неё флот
  встаёт сам по прибытии, отдельной кнопки спуска/подъёма нет. Ошибочные приказы
  кратко логируются (`✖ code`).
- **Стопгап (сужен):** авто-штурм (`autoEngage`) остался **только для ИИ**
  (вражеские флоты), чтобы давление сохранялось; флоты игрока теперь полностью
  ручные. `fleet.launch` — пока прототип-модуль.
- **Эскадрильи-авианосцы** (squadrons-roadmap SQ-1.1→4.1): `fighter_squadron` +
  `strike_carrier` строятся; носитель отделяет крыло в отдельный быстрый флот через
  `fleet.split` (кнопка «Запустить эскадрилью»); дерётся обычным боем, `orbital_aa` —
  встроенный counter; топливо/перезарядка (`SortieState`), евклидов `strikeRange`,
  детерминированное решение патруля (`patrolTarget`) — чистые тестируемые хелперы `game.ts`.
- **Цепочки приказов (command-chains).** Простаивающий флот сам проходит цепочку
  `move→штурм→погрузка→ждать N ч` (клиентский план `fleetQueues` + драйвер `driveQueues`);
  «дежурный вылет» (CC-4) — эскадрилья авто-бьёт опознанного врага в радиусе
  (`scrambleOrder`/`drivePatrols`). **CC-server:** в NET цепочка — авторитетное
  durable-состояние (`state.orders`, `orderQueueModule`), ведётся сервером
  (`serverQueueActions` + `runServerQueues` в `netserver.ts`) → идёт офлайн 24/7.
- Валидаторы: `src/smoke.ts` (Node-сценарий ядра) и `uitest.mjs` (headless-DOM
  прогон UI-бандла).

## 8. Метаигра (north-star)

Два контура: обычные сессии (малая карта) + AvA-битвы за сектора мета-галактики
(корпорации, очки влияния, мета-шпионаж). Зафиксировано в **`docs/metagame.md`**.
Ключ: сессионное ядро — движок обоих контуров; мета-слой — сервер (Этап 3+).
Сейчас **не строим**. UX мета-шелла — **`docs/main-menu.md`**; экран управления
корпорацией (ростер/роли/казна/владения/AvA/чат) — **`docs/corporation-ui.md`**.

## 9. Статус

**✅ Готово (Этап 1, ядро):** микроядро/шина/хуки/манифест; seeded RNG +
golden; модель времени `advanceTo`; экономика (казна + содержание); карта
(лейны + Дейкстра) и движение; **типы секторов** и **типы планет** (производство/
оборона через хуки, data-driven); бой (раунды, линии, attack/defense); **двухфазный
захват орбита→десант**; **одна орбита + ручной штурм + бомбардировка (заморозка
производства) + орбитальное ПВО**; **здания** (инстансы, уровни/апгрейд, HP, бонус
обороны, разрушение); **разделение флота и наземной армии + транспорт (load/unload)**;
**победа и счёт** (`victoryModule`: domination/elimination/score/timeout, `match.ended`);
играбельный прототип с тактическим векторно-радарным UI + ручными орбитальными
контролами и типами планет.

**⏳ Дальше — план эволюции ядра** (каждый этап = модуль + data, kernel не трогаем):

1. ✅**Победа и счёт** (`victoryModule`) — сделано: scoreboard + `match.ended` по
   доминированию, уничтожению соперников, лимиту счёта и тайм-ауту. **Выбираемые
   режимы игры** (захват столицы, удержание точек и др.) поверх этого каркаса —
   дизайн в `docs/game-modes-roadmap.md`.
2. ✅ **Туман войны** (`visibilityModule` + проекция `visibleState`) — сделано:
   видимость по сенсорам/разведке, серверная проекция `visibleState` по игроку.
3. ✅ **Типы планет** — сделано (этот заход).
4. **Фракции** — стартовые лоадауты + уникальные юниты/пассивы (зависят от типов планет).
5. **Древо технологий** — предматчевый выбор + внутриматчевые разблоки/бонусы.
6. ✅ **Дипломатия** (`getStance`/`setStance`: война/мир/альянс — мост к мете) —
   сделано. Опц. **движок трейтов** (если фракции/тех дадут дублирование) — пока нет.
7. Затем **UI-стадия**, **Этап 2** (action-layer/персистентность), **Этап 3**
   (сервер + мета-галактика), **Этап 4** (PWA-клиент).

**⚠️ Известные стопгапы/долги:**

- Прототип: орбитальные контролы (bombard, assault, load/unload) теперь в
  UI игрока; орбита одна (флот встаёт на неё по прибытии); `autoEngage` остался
  только для ИИ; ПВО считается в ядре, но отдельной индикации в UI пока нет;
  `fleet.launch` — пока прототип-модуль.
- ✅ ~~Бой: флот-только-десант (без кораблей) выигрывает наземный бой, но не
  захватывает~~ — **исправлено**: `capturePlanet` вызывается до `releaseOrDestroyFleet`,
  десант депонируется в гарнизон; fleet без кораблей уничтожается после захвата.
- ✅ ~~Стройка: два одинаковых заказа до завершения спишут ресурсы дважды~~ —
  **исправлено**: `building.construct` и `building.upgrade` проверяют pending
  `construction.complete` в `scheduled[]` и отклоняют дубль (`E_ALREADY_QUEUED`).

## 10. Команды и качество

```bash
pnpm install
pnpm run check       # lint + typecheck + test (гейт)
pnpm test            # vitest
pnpm run prototype   # собрать prototype/dist/void-dominion.html
```

Тесты лежат рядом с кодом (`*.test.ts`). Прототип исключён из lint/typecheck/CI
(throwaway-демо). Разработка — на фиче-ветке, PR (draft).

## 11. Как возобновить работу

1. Прочитать корневой `CLAUDE.md` (инварианты + рабочие правила), затем этот файл
   и нужные `docs/`.
2. Ветка `claude/awesome-bohr-ygnunp`; перед коммитом — `pnpm run check`.
3. Новая механика = новый модуль (события + хуки) + возможно данные; ядро трогать
   не нужно. Этот снапшот обновлять после крупных изменений.
