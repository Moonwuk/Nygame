# Состояние проекта — снапшот

> Живой «якорь контекста»: что готово, как работает, что дальше. Обновляется по
> мере разработки (после крупных изменений). Парные документы: `architecture.md`,
> `modulesystem.md`, `gdd.md`, `roadmap.md`, `backlog.md` (кирпичики задач),
> `deep-technical-roadmap.md`, `multiplayer.md`, `metagame.md`, `map-roadmap.md`, `security-a06.md` (модель угроз/A06), корневой `CLAUDE.md` / `CONTRIBUTING.md`.
>
> **Ветка:** feature-ветка · **PR:** создаётся после изменений.
> **Гейт:** `pnpm run check` (lint + typecheck + test). **Тесты: 1115 зелёных** (5 skip, 111 файлов).

---

## 1. Что это

Void Dominion — мобильная/браузерная **real-time** (непрерывное wall-clock время,
24/7, асинхронная игра) 4X космо-стратегия в духе Bytro (Iron Order). Ставка —
**гибкое, расширяемое ядро**: новые механики/юниты/фракции добавляются **данными
и модулями**, не переписыванием логики.

Монорепо (pnpm workspaces):

- `packages/shared-core` — детерминированная, data-driven симуляция. Без сервера/БД/сети.
- `packages/action-layer` — Stage 2 security gate: `ActionEnvelope`, validation, authorization, idempotency receipts, per-session `clientSeq`.
- `packages/server` — авторитетный сервер (Этап 3). WebSocket multiplayer slice: `MatchRoom`, `createMultiplayerServer`, action/state sync, per-player туман. Персистентность: `MatchStore`/`AccountStore`/`ReceiptStore` (in-memory + Postgres JSONB) — durable-матч переживает рестарт, durable receipts дедупят повтор после рестарта, ник-логин лобби. Offline-«будилка» (PA-4.1 v1): `MatchRoom.tick()`/`msUntilNextEvent()` + одно-процессный `setTimeout`-драйвер — отложенные события (прибытия/бои/захваты) срабатывают без подключённых игроков (мир идёт 24/7). Есть в обоих серверах: прото-сервер (`netserver.ts`, APK) с PA-4.1, боевой вход `packages/server/src/main.ts` — с F8 (`persistence.ts`+`clockDriver.ts`, паритет). Баг-фикс F8: `MatchRoom.initialSeq` восстанавливает счётчик действий при рестарте, иначе optimistic-by-seq store дропал пост-рестартные сохранения — прокинут в оба сервера. Строгий commit-before-broadcast (risk14, опция `MatchRoom.persist`): действие идёт async-путём через актор-**mailbox** (сериализован per-room; туда же lobby-`start`), ждёт durable-запись снапшота+квитанции ДО коммита/рассылки (`computeAdvance` считает догон мира чисто, не трогая `stateValue` до ack); провал записи → транзиентный reject, ретрай доезжает; синхронный `submitAction` не тронут; прошёл 3-линзовый состязательный ревью. **SV-0.2 match-actor:** `RoomRegistry` (роутинг по matchId — N изолированных матчей/процесс, `InMemoryRoomRegistry` eager) + `LazyRoomRegistry` (lifecycle/risk13: ленивая загрузка по запросу + гибернация простаивающих в стор после idle-окна → live-память ∝ активным матчам; **пробуждение спящего матча к его следующему событию** — реорганизует+персистит+снова спит, мир идёт 24/7 при всех офлайн; таймер инжектируемый = шов под pg-boss; reconnect детерминированно догоняет). Рядом — браузерный `MatchRegistry` (`matchRegistry.ts`, main-menu §2): meta-состояние матчей (карта/правила/архив) с read-model `GET /matches` + archive-интентами (`registerBrowserApi` в `matchApi.ts`); структурно совместим с `RoomRegistry`, так что служит и источником комнат для транспорта (прото-сервер). DoS-границы (аудит F-03/F-04): карта `receipts` капается с FIFO-эвикцией (`maxReceipts`), действия — per-player rate-limit (`actionRateMax`/`actionRateWindowMs`, флуд → транзиентный `E_RATE_LIMIT` без квитанции, ретрай переживает). **SV-1.1 action-layer front-door (опционально):** `MatchRoom.gate?` подключает `@void/action-layer` `ActionGate` — gated-сообщение `action.v1` (конверт) проходит validate→authorize→sequence→dedup ДО редьюсера (стабильные `E_*` без утечки), а bare-`action` на gated-комнате отклоняется (нет обхода гейта); rate-limit стоит ДО резервации seq, поэтому троттлинг не сжигает `clientSeq` (ретрай доезжает, не `E_REPLAY`). `submitAction`/`admitEnvelope` делят общее ядро `applyAndBroadcast`, не перепроверяя чужие гейты. Абьюз-e2e (E3) зелёный (невалид/несанкц/replay/out-of-order → безопасный отказ; дубль → реплей без повторного применения). **Боевой вход (Fastify, SV-0.1):** `/health` без утечки id (**F-13**), `/ready` со стор-probe `MatchStore.ping`, pino, graceful drain — заменил голый node:http. **Аутентификация handshake (SE-0.1, **F-01**):** опция `auth` требует верифицированный join-токен (`?token=`); при ней `?player=`/`?nick=` игнорируются, `matchId`/`playerId` токена сверяются с матчем и местом; `allowedOrigins` (**F-06**) режет cross-site upgrade. Токены — `verifyJoinToken`/`signJoinToken` на `jose` с пином алгоритма (нет `none`/alg-confusion), `typ`, iss/aud/exp, опц. max-age (SE-2.1, прошёл состязательное ревью — verified против исходников jose). **Живой гейт:** транспорт минтит серверный `sessionId` (randomUUID — не клиентский, это ключ курсора seq), отдаёт в `welcome` и в `receive`; gated-envelope авторизуется против него, end-to-end (SV-1.1-live-A). Стора гейта ограничены — FIFO receipts + LRU cursors (SV-1.1-live-B, закрыл MAJOR из ревью). **Payload-схемы (SV-1.2 + REL-2, инвариант #5):** zod-схема на каждый из **42** клиентских типов действий — ПОЛНЫЙ интент-набор прототипа (вкл. артиллерию/отступление/рынок обоих хостов (`market.take`/`side`)/дипломатию/дивизии/`fleet.launch`/`split`/`merge`/`engage`/капиталь/Хранителя/стоячие приказы/`unit.build{modules}`); `patrol.stamp` намеренно НЕ клиентский (рантайм-штамп серверного драйвера — клиентский штамп заправлял бы своё крыло); паритет закреплён `prototype/src/gateparity.test.ts` (сэмплы через реальные билдеры) (`shared-core/actions/payloadSchemas` + `isValidActionPayload`) инжектится в гейт как `payloadValidator` — кривой payload или не-клиентский тип → `E_BAD_PAYLOAD` до редьюсера. **Гейт на durable-пути (gate+persist):** принятое gated-действие коммитится-до-broadcast на durable-пути; весь admit→commit сериализован в mailbox (резервация seq и persist атомарны), при транзиентном сбое `SequenceGate.rollback` отпускает курсор → тот же `clientSeq` ретраится (не `E_REPLAY`). Прошло состязательное ревью (дизайн звучит; закрыт MAJOR — broadcast теперь per-player изолирован, не может застрять на throw). **Боевой вход:** `main.ts` включает auth/гейт по env (`AUTH_JWT_SECRET`, `GATE=1`, `ALLOWED_ORIGINS`), default off (live-C). **Мульти-матч (SV-4.0):** вход хостит N матчей через `LazyRoomRegistry` — матч грузится из стора по первому коннекту, гибернируется в простое, будится к событиям; `dev` сидируется на буте (реальный create — SV-2.4). **Вход игроков (SV-2.4 + SE-1.x, логин+пароль):** аккаунты `users` (Memory/Postgres, логин уникален без регистра), пароли scrypt (`node:crypto`, параметры вшиты в хеш), `POST /auth/register`/`/auth/login` → сессионный JWT (`typ session+jwt`, отдельная audience — невзаимозаменяем с join-токеном); uniform-401 + decoy-hash (не раскрываем существование аккаунта ни телом, ни таймингом), per-IP rate-limit. `POST /matches` и `GET /matches/:id/join` требуют `Authorization: Bearer <session>` — ник места = логин сессии (никем другим не зайдёшь), `accountId` штампуется в join-токен (15 мин); оба маршрута пишут durable-состояние (сид матча / занятие места), поэтому оба за per-IP sliding-window rate-limit (общий бюджет create+join, `E_RATE_LIMIT`/429, ограниченная FIFO-карта), как auth-эндпоинты. Сверх точечных лимитеров весь account+match-контур в `main.ts` обёрнут `@fastify/rate-limit` в инкапсулированном scope — грубый per-IP бэкстоп (health/ready на родительском app не троттлятся). Всё выставляется **только при включённом auth**; e2e прогнан вживую: register → login → Bearer-join → WS welcome. Дальше по треку: refresh/ревокация сессий (AC-0.2), OIDC как второй провайдер (AC-1.1). **Фабрика матчей (SV-2.5):** `MatchKeeper` держит `OPEN_MATCHES` (env, деф. 3) открытых матчей — как только один заполнился/закончился, засевается новый, так лента не пустеет и игрок всегда может зайти в свежую игру. Счёт открытых берётся из durable-стора (`MatchStore.ongoingMatchIds` + `occupiedSeats`), а не из in-process счётчика → рестарт реконсилит по реальному миру, не переплождая; кап на конкурентные матчи (`max`), reentrancy-guard, ошибка create/read проглатывается и ретраится следующим тиком. Реконсиляция на буте + интервал 30с. Публичная read-only лента `GET /matches/open` (id/seated/capacity из стора, переживает гибернацию — видит и спящие матчи) — браузинг до логина, join по-прежнему требует сессию. Прогнано вживую: `OPEN_MATCHES=3` → сервер добил до 3 открытых (посчитал `dev`, создал 2), все в `/matches/open`. **Метрики (OPS-0.1):** `/metrics` — агрегатные gauge'ы (число матчей/коннектов, без id). **Крит-путь до онлайн-сессии закрыт.** Пройден 3-линзовый ревью (корректность/безопасность/чистота): починен HIGH-баг живости (драйвер часов не пере-armился после committed-действия — вынес эмиссию `action`-наблюдения за окно `committing`); добавлен Fastify error-handler (инвариант #4, без утечки); ядро gate/session/JWT подтверждено безопасным. **Вектор 2 (надёжность) сделан:** durable-места (`createStores` отдаёт `PostgresAccountStore` при `DATABASE_URL` — ник→место переживает рестарт, 2.2); CI-workflow (`ci.yml`) с сервис-Postgres гоняет durable-адаптеры в CI + `configFromEnv` вынесен из `main.ts` и покрыт тестом round-trip mint↔verify (2.3). **Durable-стора гейта — НЕ нужны (2.1, verified):** они ключуются по per-connection `sessionId` (серверный, неповторимый), теряются ровно когда отслеживаемые сессии заканчиваются → переподключение минтит свежий `sessionId` → свежий курсор; персистить нечего. **Деплой одной командой (REL-3):** `pnpm stack` (= `docker compose -f deploy/docker-compose.yml up -d --build`) поднимает игровой сервер (distroless-образ: игра на `/`, WS, `/health`) + Postgres; отказоустойчивость — `restart: unless-stopped` на обоих, durable-резюме матчей из PG, healthchecks (server ждёт healthy-PG), bounded-логи, PG на loopback; runbook (обновление/бэкап+cron/восстановление/границы) — `deploy/README.md`. **Гейт на играбельном пути (REL-4):** прото-хост `prototype/netserver.ts` принимает `GATE=1|true` — комната получает тот же `ActionGate({payloadValidator: isValidActionPayload})`, что и боевой вход (зеркало serverConfig); в compose релиз-постура — `GATE` по умолчанию **ON** (`${GATE:-1}`, `GATE=0` — дев-откат к голым actions). Прогнано вживую в обе стороны: gated — `welcome{gated,sessionId}` → голый `action` отклонён (`E_BAD_MESSAGE`), `action.v1`-конверт того же клиента применён (delta); ungated — голый `action` применён (обратная совместимость). Серверные драйверы (ИИ/Хранитель/стоячие приказы) идут через `room.submitAction` МИМО гейта — так и задумано: гейт стоит на проводе, не внутри хоста. **Замок мест (REL-5, `SEAT_LOCK=1`, в compose по умолчанию ON):** ник-логин без аккаунтов защищён «посадочным билетом» — первый вход ника минтит случайный тикет (`randomBytes(24)`), транспорт хранит ТОЛЬКО его sha256 в `AccountStore` (`bindSeatTicket` — первый bind атомарно выигрывает, Memory и Postgres; колонка `seats.ticket_hash`, `ALTER … IF NOT EXISTS` — старые ряды дозамыкаются при следующем входе владельца), плэйнтекст едет клиенту один раз в `welcome.seatTicket` (`addPeer welcomeExtras`); каждый последующий вход обязан предъявить `?ticket=` (сравнение constant-time), иначе 401; прямой `?player=` под замком отклоняется (обход невозможен). Клиент самонастраивается: `MultiplayerClient.onSeatTicket` → прототип кладёт билет в `localStorage` (`void.ticket.<base>|<match>|<nick>`) и добавляет `&ticket=` при коннекте. Проверено: юнит-e2e транспорта (`seatLock.test.ts`), стор-контракт на Memory+Postgres 16 (включая миграцию старой схемы), живой raw-ws прогон и БРАУЗЕРНЫЙ CDP-прогон реального клиента (билет ложится в localStorage → реконнект пускает; удалили билет → тот же ник заперт). Потерянный билет невосстановим с сервера (hash-only) — владелец чистит ряд в `seats`. ⏳ Дальше: OIDC-идентичность, полные аккаунты на прото-пути (JWT join-токены в транспорте готовы), контейнер-хардненинг. _Известный нюанс (клиентская сверка, не серверная durability):_ acked-но-недоставленное действие + рестарт + наивный ресенд может примениться дважды (`actionId` session-scoped) — закрывается сверкой клиента с полным `welcome`-состоянием на реконнекте, не durable-стора́ми гейта.
- `packages/client` — клиент (Этап 4): направление **PWA-first веб-клиент** (TWA Android + Capacitor iOS, не React Native — см. `cross-platform-roadmap.md`). Есть `MultiplayerClient` transport adapter — **закрывает SV-1.1-петлю**: ловит `sessionId`+`gated` из `welcome` и на gated-комнате оборачивает намерение в `action.v1` конверт (`createActionEnvelope`, strict per-session `clientSeq` 1,2,…, `actionId=sessionId:playerId:clientSeq`, сброс на реконнекте), иначе — голый `action`; сервер отдаёт `gated:true` в welcome → клиент самонастраивается по рукопожатию. Прогнано вживую: gated-сервер → welcome`{gated,sessionId}` → конверт принят → delta; юнит-тесты прогоняют вывод клиента через те же `validateActionEnvelope`+`authorizeActionEnvelope`, что и гейт. Токены темы (`theme.ts`) и framework-agnostic view-models (паттерн: чистая фабрика + fail-secure, JSON-сериализуемо): `welcomeScreen.ts` (экран входа) и `matchHud.ts` (внутриматчевый HUD: зоны A+D — `createStatusBarModel` стат-бар, `createSelectionModel` панель флота; **боевая зона** — `createBattleModel` + `resolveBattleAction` панель активного боя с единственным действием «Отступить»; всё поверх fog-проекции `visibleState`; см. `hud-inmatch.md`). App shell — рабочий
  Vite-каркас: welcome-экран, живая карта на общем рендер-ките (камера/holoDraw/territory),
  подключение к серверу по `?join=`-диплинку (снапшоты/дельты + приказ движения через
  `action.v1`); полный игровой HUD в shell — впереди, играбельный клиент игроков — `prototype/`.
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
  util/          clone.ts (deepClone/deepFreeze), treasury.ts (canAfford/payCost — shared by construction & technology), fitting.ts (генерик-гейт «слоты+предметы», SHIP-4) + loadout.ts (ship-обёртка над ним)
  modules/       army, artillery, captureOnArrival, combat, construction, diplomacy, economy, espionage, faction, hero, heroEffects, intercept, market, movement, orbital, planetType, scientist, sector, station, steward, technology, victory, visibility  (23 модуля, + *.test.ts)
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
- `UnitStack {unit, count, hp?, shieldHp?, modules?}` (`hp` — пул корпуса, `shieldHp` — пул
  **аблятивного щита**, shields-roadmap SH-0.1). Для наземных стеков оба пула живут
  только во время боя (после — сброс в `undefined` = полное HP/щит). Для
  **корабельных** стеков (`fleet.units`) оба **сохраняются и вне боя**; вне боя
  щит регенит сам, корпус чинится только в порту (see construction, SH-1.1/2.1).
- `heroes?: Record<id, Hero>` (`{owner, location, cooldowns}`), `tempLanes?: TempLane[]`
  (временные публичные трассы), `topology?` (версия графа для инвалидации `RouteCache`),
  `heroSeq?` (счётчик id лейнов) — модуль `hero`.
- `intel?: Record<PlayerId, IntelGrant[]>` — **шпионаж (SPY-1)**: украденные «окна
  разведданных» `{kind: treasury|planet|fleets, target, until}`. `espionage.spy` платит
  (150¤ база, хук `espionage.cost`), бросает seeded-шанс (0.6 база, хук, кламп 0.05–0.95)
  и на успех даёт окно на 24ч×timeScale (хук `espionage.duration`); плата сгорает и при
  провале. `visibleState` уважает только ЖИВЫЕ гранты зрителя: казна цели / контент
  одного мира / флоты цели читаются сквозь туман; чужие гранты вырезаются (кто за кем
  шпионит — тайна вора), истечение проверяется на границе безопасности, не только
  чисткой `time.advanced`. События `intel.stolen`/`espionage.failed` адресованы вору
  (`owner` в payload — серверный фильтр событий не отдаёт их жертве). Кап 8 окон.
  **Играбельно в прототипе (H5)**: `espionageModule` подключён в `MODULES` (значит и в
  netserver); билдер `spyOn` в `game.ts`; UI — «🕵 казна»/«🕵 флоты» в развёрнутой строке
  ростера дипломатии + «🕵 Разведать мир · 150¤» на карточке чужого мира (включая
  fogged-«LAST KNOWN» — цель берётся из памяти; протухший владелец честно отбивается
  ядром). Клиентский туман уважает живые окна: `planet` добавляет узел в identify (и в
  память), `fleets` показывает флоты цели на карте (`fleetSeen`), `treasury` печатает
  ресурсы жертвы в ростере с остатком окна. Тосты `intel.stolen`/`espionage.failed`
  фильтруются по `owner === ME` (зеркало серверного фильтра). 4 e2e-теста
  (`prototype/src/espionage.test.ts`).
  **Контрразведка (SPY-2)**: каждый оплаченный `espionage.spy` бросает и ОБНАРУЖЕНИЕ
  (пайплайн `espionage.detect`; база 0.5 после провала — агент наследил, 0.25 после
  чистого успеха; кламп [0,1]; бросок всегда, чтобы форма RNG-потока не зависела от
  исхода/хуков). Обнаружение → событие `espionage.detected`, адресованное ЖЕРТВЕ:
  провал несёт `spy` (пойман с поличным), успех — только `kind` (утечка без вора);
  шпион о срабатывании контрразведки не узнаёт. В прототипе жертва-человек получает
  тост «🛡 Контрразведка…», жертва-бот роняет одобрение к пойманному шпиону на
  `FAVOUR_SPY_CAUGHT_HIT` (=20; `botDiplomacyModule` слушает событие — анонимная
  утечка никого не винит). +4 core-теста + 1 proto favour-e2e.
- `diplomacy?: Record<pairKey, DiplomaticStance>` — попарные дип-отношения (`war`/`peace`/
  `pact`/`alliance`), симметрично и **публично** (туман не режет). Дефолт пары без записи —
  `war` (= FFA). Примитивы в `state/diplomacy.ts`. **`combat.isHostile` читает стойку прямо из
  `state.diplomacy`** (`getStance(...) === 'war'`) — бой идёт только при объявленной войне. **ПВО бьёт залпами, двумя ярусами** (не непрерывно):
  **орбитальное** (здания-батареи, Σ их `aaDamage`) — полный залп раз в игровой час;
  **ближняя** (юниты гарнизона, Σ их `aaDamage`) — залп раз в 15 игровых минут по четверти
  часовой ставки (часовой выход тот же, окно уклонения — 15 минут). Сетки — мировое время
  ×timeScale (`roundIntervalMs`; четвертная сетка содержит часовую — на общей границе
  тяжёлый залп ложится первым), перецеливание на каждом залпе; флот, нырнувший в орбиту
  МЕЖДУ залпами, уходит невредимым — тайминг рейда мимо ПВО имеет смысл. Каждый залп — событие `aa.fired {planetId, owner, fleetId,
  by, damage}` (эмит до применения урона; прототип рисует трассер+вспышку; фазы боя
  различимы: красные кольца орбиты vs янтарный пунктир десанта).
  **Ядровой `diplomacyModule` (D2, `modules/diplomacy.ts`)**: понижение стойки одностороннее
  (`diplomacy.declare`), повышение по согласию — `diplomacy.propose` кладёт оффер в
  `state.diplomacyOffers` (pairKey → `{from, stance}`, один на пару, новее замещает),
  `diplomacy.accept`/`diplomacy.reject` его разрешают; любой сдвиг стойки аннулирует оффер
  пары. **Коалиция — только между людьми**: `alliance` с участием ИИ-игрока
  (`Player.ai === true`, сеется картой/слотом/`newGame` прототипа) отклоняется с
  `E_BOT_ALLIANCE` (propose и защитно accept); мир/пакт с ботом разрешены. События
  `diplomacy.changed`/`proposed`/`rejected`; capability `diplomacy`
  `{getStance, getRelation}` — методы принимают `state` параметром (war→hostile,
  peace/pact→neutral, alliance→ally). Офферы фог-чувствительны: `visibleState` отдаёт
  только пары с участием зрителя; `diplomacyOffers` — в `delta`-META. **Прототип
  использует этот же ЯДРОВЫЙ модуль (D4 ✅):** собственная реализация
  `diplomacy.declare` из `game.ts` удалена, в `MODULES` подключён ядровый (эскалация
  односторонняя и стирает офферы; смягчение — оффер (`diplomacy.offered`), встречное
  объявление коммитит (`diplomacy.changed`); повтор — `E_ALREADY_OFFERED`, тот же
  станс — `E_SAME_STANCE`, кривой target — `E_BAD_PAYLOAD`; `stance` обязателен —
  дефолт 'war' остался в билдере `declareWar`). Одна реализация на репозиторий.
  Бот отвечает в том же приказе по favour-шкале: peace принимает при
  ≥ `FAVOUR_PEACE_ACCEPT` (=15, линия войны), pact при ≥ 55, иначе отклоняет
  (`diplomacy.declined`) и стирает оффер — «висящий» оффер бывает только у людей.
  Прототип сеет всем парам `peace` в `newGame` и держит клиентский
  гейт: маршрут через чужую территорию без войны блокируется, ручной тык по ней открывает
  предупреждение «это объявит войну», ИИ объявляет войну, когда нейтралы кончились.
  **Сеть честна (№10 + NETP0-4/5)**: сессионный чат ходит через сервер (см. ниже), пинги 📍
  сетевые; смены стоек И офферы между снапшотами диффаются клиентом —
  «⚔ X объявил вам войну!» / «🕊 X предлагает: мир» всплывают тостом + бейдж
  непрочитанного на ✉ рейла; в ростере входящий оффер подсвечивает кнопку станса
  «✓ принять» (пульс), свой отправленный — «⏳» (задизейблена).
  **APK-удобство**: аппаратная кнопка «Назад» закрывает верхний слой интерфейса
  (history-sentinel: попапы → окна → меню → выделение → сетап; пустая карта → подсказка
  «ещё раз — выход»), ландшафтный телефон определяется по coarse-pointer (не только
  ширине), выбор стартового мира в сетапе ловит тап по ближайшему кандидату, cmdbar
  влезает в узкий экран (подписи 10px, перенос), пинч-зум страницы разрешён (a11y —
  жесты карты и так живут на canvas/touch-action:none).
  **Автообновление (плейтест):** APK сравнивает свой baked `window.__BUILD__`
  (versionCode = счётчик коммитов, инжект CI) с маркером rolling-релиза `alpha`
  (`updater.ts`, GitHub REST, все отказы → «нет обновления»); `#updbar` —
  **глобальный fixed-баннер** (z-96, поверх welcome/хаба/матча — раньше жил внутри
  `#connect`, и путь возвращающегося игрока через хаб его никогда не видел), «Обновить»
  отдаёт APK-ассет системному браузеру через `window.VoidNative.open`
  (`mobile/patch-updater.mjs`), подпись стабильна (закоммиченный debug.keystore).
  Тихая проверка: на старте, при возврате приложения в форграунд
  (`visibilitychange`) и раз в 4ч — с троттлингом 15 мин; ручная — кнопка на
  `#connect` (диагностика в `cver`) и **тайл «Обновления» в хабе** (диагностика в
  `hub-note`). Браузерная «автообновляемость» — GitHub Pages
  (`pages.yml` → https://moonwuk.github.io/Nygame/ — ссылка всегда на свежий main);
  ⚠ требует ОДНОГО ручного включения: Settings → Pages → Source **«GitHub Actions»**
  (без него job гибнет до шагов — см. runbook-комментарий в `pages.yml`).
  **Тач-управление (№12 аудита)**: при взведённом Move палец ТЯНЕТ прицел (живое
  превью, камера не панится), отпускание = приказ, второй палец = отмена; радиус снапа
  превью равен радиусу коммита (24px мышь / 30px тач). Лонг-тап (~350мс) по своему
  флоту = добавить/убрать из группы (Ctrl-клик телефона), по пустому месту = бокс-выбор
  (Shift-драг телефона), с вибро-откликом. Нижняя панель при открытии автопанорамит
  карту, чтобы выделенный объект не прятался под ней.
  **Сессионное меню дипломатии/сообщений** (прототип, рейл → Дипломатия/Dispatches):
  ростер всех участников (иконка человек ☻ / ИИ ⌬, сорт. по имени/провинциям/отношению +
  фильтры-чипы по отношению и типу человек/ИИ — AND между категориями, OR внутри),
  смена стойки консент-офферами (NETP0-5): повышение до мира/пакта/союза записывает
  предложение, вторая сторона принимает встречным объявлением (кнопка «✓», пульс);
  бот отвечает сразу по favour-шкале; **союз с ИИ невозможен** (кнопка погашена,
  «Боты не вступают в коалиции»), понижение/война односторонни. Признак бота UI
  читает из state (`Player.ai`; в NET-режиме сервер снимает флаги — место, занятое
  человеком, не бот).
  Вкладка «Сообщения» — переписки master-detail: слева список чатов (групповой
  «⚡ Коалиция» = ты + союзники, закреплён сверху; ниже личные DM по участникам),
  справа открывается выбранный тред + composer. Системные дип-события с твоим участием
  ложатся в DM с этой стороной (через `diplomacy.changed`). В чате коалиции — **пинги**:
  выделил провинцию → 📍 шлёт метку; тык по метке → камера летит туда (`centerOn`) и
  меню закрывается. **Пинг виден и на карте** как маркер-булавка (цвет владельца) с
  сонарными волнами от узла и дышащим свечением: тык по
  нему → попап с автором и **коротким описанием, которое пишет ставящий** (текст из
  composer'а) + «↪ камера» и «убрать» (для своих). Тумблер «Свои метки на карте» в
  настройках (хаб → Ещё) прячет ТОЛЬКО свои булавки (метки союзников видны всегда;
  чат-строка и серверный relay не затрагиваются; `void.showOwnPings`). Сообщения живут
  в клиенте (не в ядре — на симуляцию не влияют). **Сеть (пинги):** `MultiplayerClient` теперь шлёт `ping.place`/
  `ping.clear` и принимает `ping.added`/`ping.removed` (`onPingAdded`/`onPingRemoved`); в
  NET-режиме прототип ставит/убирает пинг через сервер (авторитетный — штампует id/TTL,
  раздаёт владельцу+союзникам, прячет от врагов), а эхо `ping.added` рисует
  маркер. **Сеть (чат, NETP0-4):** текстовый чат ходит тем же relay-узором —
  `chat.send` → сервер штампует id/время, режет текст (240), rate-limit по wall-clock
  (6/4с, работает и в замороженном лобби) и раздаёт `chat.msg` по каналу: `session` —
  всем, `coalition` — себе + живому альянсу (`areAllied` читает статические team'ы ИЛИ
  alliance из state.diplomacy), `dm` — двоим; ограниченный бэклог (100) реплеится на
  (ре)джойне, клиент дедупит по id и рендерит с серверного эха (свои строки тоже).
  Плавающее окно чата — desktop-only; на телефоне сетевые каналы доступны из
  Дипломатии → Сообщения (коалиция + DM; вкладки «Сессия»/«Глобальный» — только в
  плавающем окне, глобальный канал ждёт глобального сервера).

**Время:** все длительности — через `schedule(at,…)`; `timeScale` (MatchConfig)
делит реальные длительности (×1/×2/×4). `time.advanced` спаны дают накопление.

## 5. Модули ядра (что делают)

Порядок в кернелах обычно: `sector, planet-type, technology, economy, movement, combat, construction, army`.

### economy (`economy`)

На `time.advanced`: **производство** каждого своего мира → казну владельца
(хук `economy.production`, масштаб по часам×timeScale); **содержание** юнитов/
гарнизонов **и зданий** (`BuildingLevel.upkeep`, ECON-5) — суточный дрейн из казны
(clamp ≥0). Неоплаченный ресурс попадает в `Player.arrears` (приватно, срезается в
fog как казна): пока долг висит, здания-потребители ЭТОГО ресурса производят на
**×`BROWNOUT`(0.5)** — свет тускнеет, не гаснет; погасил счёт — флаг снят. Формула
непрерывна (arrears прошлого расчёта тускнят следующий спан — детерминизм на любом
разбиении). **Бомбардируемый мир не производит** (`isBombarded`). Действий нет.

### market (`market`) — сессионная биржа ресурсов

Публичный per-match ордербук `GameState.market` (не путать с мета-аукционом из
`economy-roadmap.md`). Действия: **`market.list {resource, amount, price}`** —
выставить ресурс (эскроу: `amount` списывается из казны в ордер); **`market.buy
{orderId, amount}`** — купить (частично) за деньги (`credits`); **`market.cancel
{orderId}`** — продавец забирает непроданный остаток. **Комиссия 15% сжигается**
(сток против инфляции): покупатель платит `amount×price`, продавец получает 85%.
Коды: `E_BAD_PAYLOAD, E_UNKNOWN_RESOURCE, E_FORBIDDEN, E_INSUFFICIENT, E_ORDER_LIMIT
(≤20 открытых на игрока, A06), E_NO_ORDER, E_OWN_ORDER, E_BAD_AMOUNT`. Публичен (туман не режет); в `delta` META.

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
Коды: `E_BAD_PAYLOAD, E_NO_FLEET (и «не твой флот» — один код, A06), E_FLEET_BUSY,
E_SAME_LOCATION, E_NO_DESTINATION, E_NO_ROUTE, E_NOT_A_LANE, E_FLEET_IMMOBILE`.
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
остаётся открытым. **Предматчевый выбор (C3):** `SlotAssignment.technologies`
(`buildStateFromMap`) выдаёт посаженному в слот игроку стартовые технологии как
`completed` — бонусы/анлоки действуют с первой секунды; неизвестный id валит сборку
(`E_UNKNOWN_TECHNOLOGY`, fail-secure), дубли схлопываются, prerequisites намеренно
не проверяются (стартовый кит может дарить узел из середины дерева).

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
  сама. Коды: `E_NO_FLEET (вкл. «не твой»), E_NO_ARTILLERY, E_NO_TARGET (вкл. «не враг» —
не течёт стойка, A06), E_BAD_PAYLOAD`. Поиск флота по цели — **own-key** (`__proto__`/`constructor` не
  проходят, защита от отравления `barrageTarget` → тихий DoS отрезка).
- **Режимы огня артиллерии** (`barrageMode` на флоте, лестница агрессии; действие
  **`fleet.barrageMode {fleetId, mode}`**): **`passive`** — не стреляет; **`return`**
  — только после того, как флот получил урон (флаг `barrageProvoked`, ставится в
  `applyDamageToSide`); **`standard`** (дефолт) — по тем, с кем **война**;
  **`aggressive`** — по любому флоту, кроме **пакта/союза** (т.е. война ИЛИ мир —
  открывает огонь по несоюзным соседям). Стойка читается из `state.diplomacy`.
- Действие **`fleet.retreat {fleetId}`** — выйти из орбитального боя. Плата: **−40%
  ТЕКУЩЕГО корпуса и щита** на стек (`applyRetreatToll`; израненный флот теряет 40% остатка,
  корабли гибнут при усадке пула, но **сам отход флот не добивает** — 0.6×остаток > 0, десант
  в трюме уходит вместе с кораблями); награда: **баф скорости** ×1.5 на 3ч (`retreatHasteUntil`,
  хук `fleet.speed`). Уход с орбиты ВНЕ боя — обычный `fleet.move`, бесплатен. Бой 1-на-1
  распускается, противник освобождается (`releaseOrDestroyFleet`).
  Только орбитальный корабль-сторона (не десант/гарнизон). Событие `fleet.retreated {escaped}`.
  Коды: `E_BAD_PAYLOAD, E_NO_FLEET (вкл. «не твой»), E_NOT_IN_BATTLE, E_CANNOT_RETREAT`.

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
  планетой** (иначе вложение сгорает); **под бомбардировкой — пауза\*\* (re-defer).
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
Все пороги переопределяются через `MatchConfig.victory`. **Коалиции (SES-1, GDD §3.3):**
score-гонка идёт по «юнитам победы» — соло-игрок или alliance-компонента активных
(коалиция — только люди), порог коалиции = `scoreLimit × N × coalitionFactor` (деф. 0.7,
сублинейный) и **замещает** соло-порог участникам; коалиция побеждает вместе —
`match.winners[]` + топ-скорер в `winner`, `winners` едет в `match.ended`; прототип
рисует баннер «ПОБЕДА КОАЛИЦИИ» и начисляет XP каждому победителю.

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
(корабль, которым герой командует, пока жив). **Позиция героя = нода его корабля**
(HERO-2, `heroNode`): развёрнутый герой действует от `fleets[fleetId].location`; в полёте
(`location: null`) и без корабля — фолбэк `Hero.location`, которая теперь **память
последней подтверждённой ноды** (синкается на `fleet.transit`/`fleet.arrived`) и якорь
респауна после `home`. `hero.move` развёрнутому герою → `E_HERO_DEPLOYED` (кораблём
ходит обычный `fleet.move`); телепорт-редеплой остаётся только бескорабельному герою.
Смерть — **два идемпотентных сигнала** (общий `killHero`, гард по `alive`): `unit.died`
(пал стек-герой) и `fleet.destroyed` (флот снесён целиком, стек не дренировался).
Состояние JSON-сериализуемо, длительности через `schedule`, бонус — через хук;
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
- Действие **`hero.spawn {heroId, at}`** (HERO-3) — ручной подъём корабля героя на
  **своём** мире. Гейты: `E_HERO_ALIVE` (уже командует живым кораблём; stale-`fleetId`
  не блокирует) · `E_RESPAWN_COOLDOWN` · `E_NO_PLANET`/`E_BAD_SPAWN` (только свой мир) ·
  `E_HERO_CAP` (кэп **3 активных**/игрок, `activeHeroCount`). Корпус — из архетипа:
  `Hero.archetype` → `data.heroes[..].ship.unit`, фолбэк — юнит `hero`. Общий
  деплой-путь `formHeroShip` с авто-респауном; **авто-респаун уважает тот же кэп**
  (переполнен — герой остаётся мёртв). Ручной спавн — путь спасения: бездомно-мёртвый
  или удержанный кэпом герой поднимается вручную, когда мир/слот появился. Событие
  `hero.spawned` (авто-путь по-прежнему `hero.respawned`). **HERO-8:** ноская способность
  маркер-типа `spawn_fleet`/`spawn_allied` (не кастуемая — «носится» в `Hero.abilities`)
  расширяет цели спавна: **свой флот** (герой абордажится в стек хоста — `addUnits`, аура
  кроет весь флот, `fleetId`→хост, событие с `aboard: true`; чужой флот — `E_BAD_SPAWN`)
  и **союзный мир** (D1-дипломатия, только `alliance`; нейтрал/война — `E_BAD_SPAWN`).
  Шипованы «Абордажная транслокация» (ravager) и «Дипломатическая высадка» (commander).
- Действие **`hero.fit {heroId, fitting}`** (HERO-6) — установка фитинга из
  `data/heroFittings.json` (`HeroFittingDef {statMods, grants{ability?|passive?}, cost}`,
  анти-self-expansion рефайн) в слот архетипа (`slots`; `Hero.fittings`, **без refit** —
  owner-правило ship-модулей). Гейты: владение/живость → `E_NO_FITTING` →
  `E_ALREADY_FITTED` → `E_NO_SLOTS` (безархетипный герой слотов не имеет) → казна.
  **Инсталл-гейт — общий генерик-механизм «слоты+предметы»** (`util/fitting.ts`, SHIP-4):
  `canInstall`/`validateInstalled(spec)` — каталог → дубль → `allowed` → бюджет
  по категории, generic-причины, которые каждый потребитель мапит в СВОИ стабильные
  `E_*`-коды; ship-лоадаут (`canEquip`/`validateLoadout`) и `hero.fit` — обёртки над ним
  (герои = одно-категорийный бюджет без предиката), поведение и коды не изменились.
  `grants` — живые (общий `applyGrants` с дедупом, HERO-4/5); `statMods` — данные без
  шва эффективных статов героя (свой будущий кирпич; «designed, not live» — SHIP-4
  унифицировал только слот-гейт, не статы). Событие `hero.fitted`. Шипованы
  «Пси-усилитель» (scan), «Матрица „Эгида"» (rally_beacon), «Абляционная обшивка»
  (hp+40, не live).
- **Пред-матч ростер (HERO-9, buildFromMap):** `SlotAssignment.heroes?: string[]` — до
  **3 разных** архетипов (решение по прецедентам C3/совета учёных: снапшот при сборке;
  `E_UNKNOWN_HERO`/`E_DUPLICATE_HERO`/`E_TOO_MANY_HEROES`; ростер без владеемого мира —
  `E_HERO_NO_HOMEWORLD`). Сеются **неразвёрнутыми** (`hero:{player}:{n}`, `home` =
  первый владеемый мир слота, лоадаут из `startAbilities`/`startPassives`); корабли
  поднимает `hero.spawn`.
- Действие **`hero.skill.unlock {heroId, node}`** (HERO-7) — прокачка дерева навыков из
  `data/heroSkillTrees.json` (`HeroSkillNode {branch?, requires[], cost, grants
  {ability?|passive?}}`, ветки `transhuman|psionic`). Гейты: владение/живость →
  `E_NO_NODE` → `E_ALREADY_UNLOCKED` → ветка узла против ветки архетипа героя
  (`E_WRONG_BRANCH`; безветочный узел — общий) → `E_REQUIRES` (родители в `Hero.skills`)
  → казна (`E_INSUFFICIENT`, `payCost` на драфте). Грант дописывается в лоадаут инстанса
  (`abilities`/`passives`, с дедупом) — HERO-4/5 применяют его штатно; `Hero.skills`
  ведёт разблокированные узлы. Событие `hero.skill.unlocked`. Шипованы 2 ветки × 2 узла
  (рут-пассивка + дитя-способность за ресурсы).
- **Пассивки (HERO-5, `data/heroPassives.json`):** `HeroPassiveDef {hook, scope,
  params{bonus, radius}}`, хуки — enum `fleet.speed|combat.damage` (fail-closed, новый
  хук = запись в enum + кейс-интерпретатор), scope — `heroFleet` (флот героя) |
  `ownFleetsNear` (свои флоты в `radius` от ноды героя, `heroNode`). Живой герой
  множит значение хука на ×(1+Σ применимых бонусов) ПОВЕРХ лейн-бонуса и базовой
  +5% ауры; мёртвый герой и неизвестный id пассивки — ноль. Несёт `Hero.passives?`
  (сеется из `startPassives` архетипа). Шипованы: `vanguard_impulse` (+10% скорость
  флота героя), `rally_beacon` (+8% урона своих флотов в 300 от героя).
- Действие **`hero.ability {heroId, abilityId, target?}`** (HERO-4) — **обобщённый
  data-driven диспетчер**: способность берётся из каталога `data.heroAbilities`
  (`HeroAbilityDef {type, cooldownHours, range, cost, params}`), гейты выводятся из
  данных генерически — владение (`E_FORBIDDEN`), живость (`E_HERO_DEAD`), каталог
  (`E_NO_ABILITY`), экипировка `Hero.abilities` (`E_NOT_EQUIPPED`), кулдаун
  (`E_COOLDOWN`), дальность от узла героя (`E_NO_PLANET`/`E_OUT_OF_RANGE`;
  ranged ⇒ обязателен `target`, иначе `E_BAD_PAYLOAD`; для встроенных типов пропущенный
  `range` **фолбэчится на движковую константу** (600/500) — никогда не «безлимит»),
  стоимость `cost` из казны (nonnegative в схеме — каталог не может минтить)
  (`E_NO_PLAYER`/`E_INSUFFICIENT`, `payCost` на драфте — реджект отменяет всё).
  Диспетчеризация по `type`: встроенные **`temp_lane`** / **`annihilate`** исполняются
  **теми же телами эффектов** (`castTempLane`/`castAnnihilate`), что и legacy-действия
  `hero.path.create`/`planet.annihilate` (поведение последних сохранено 1:1); прочие
  типы — через **capability `hero.effect.<type>`** (контракт `HeroEffect`, экспортирован
  из пакета; impl обязан `h.reject` на своих отказах); тип без capability →
  `E_NO_EFFECT` (fail-secure: данные обещают только то, что движок умеет).
  **Провайдеры шва — `heroEffectsModule`** (`modules/heroEffects.ts`):
  `hero.effect.recall` мгновенно телепортирует корабль героя в столицу (`Hero.home`),
  гейты `E_HERO_NOT_DEPLOYED`/`E_FLEET_BUSY` (не выдёргивать из боя)/`E_NO_CAPITAL`/
  `E_SAME_LOCATION`; событие `hero.recalled`. `hero.effect.aura` (rally/bulwark) —
  **таймбоксед** боевая аура: каст кладёт `{bonus, radius, until}` в `Hero.activeAuras`
  (прунинг истёкших на касте), а собственный хук `combat.damage` модуля бафает флоты
  владельца в `radius` от ноды героя, пока `until > now` — временный близнец пассивки
  HERO-5 `rally_beacon`; кривая аура → `E_BAD_EFFECT`; событие `hero.aura`.
  `hero.effect.reveal` (scan) — **таймбоксед fog-шов**: ranged-каст (диспетчер уже
  проверил цель в радиусе) кладёт `{center, radius, until}` в `Hero.activeReveals`
  (прунинг на касте), а проекция тумана `coverageFor` (`state/visibility.ts`) читает
  активные раскрытия **только своих** героев (per-viewer) и поднимает полный identify
  на миры в `radius` от `center`, пока `until > state.time` — раскрытие не течёт
  сопернику; кривой reveal (0-радиус/0-длит.) → `E_BAD_EFFECT`; событие `hero.revealed`.
  Эффекты приходят добавлением провайдера, ядро/диспетчер не трогаются — трилогия
  recall/aura/reveal закрывает все не-встроенные эффекты (спавн-маркеры не кастуются).
  **Кулдаун-ключи**: встроенные типы делят ключ с legacy (`path`/`annihilate`) — generic
  и legacy маршруты нельзя скомбинировать в double-fire; кастомные типы — ключ `fx:<type>`
  (два каталожных id одного эффекта делят кулдаун; префикс не коллидирует с `respawn`).
  Гейт живости распространён и на legacy-действия (`hero.move`/`hero.path.create`/
  `planet.annihilate` мёртвым героем → `E_HERO_DEAD` — обход через legacy закрыт). `params`-оверрайды `durationHours`/`speedBonus` (числовые, с движковыми
  фолбэками). Успех → кулдаун + событие `hero.ability.used {heroId, owner, abilityId,
  type, target?}`. Payload-схема `hero.ability` добавлена в гейт (SV-1.2). 7 тестов; дифф прошёл 4-линзовый состязательный ревью (все находки закрыты).

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
флоты/бои, **всё расписание** (утечка планов) и **чужие дип-офферы** (`diplomacyOffers`
остаются только у пар с участием зрителя; сами стойки публичны). Покрыто тестами,
включая anti-leak по JSON.
**`visibleView`** — та же проекция + её identify-набор за **один** проход
покрытия: рассылка (`MatchRoom.broadcastState`) берёт оба из него, не считая
`coverageFor` дважды на игрока (~−40% на проекцию броадкаста по бенчу).
**Радарные бонусы (A2):** reach каждого радара игрока
(зданий и кораблей) множится на (1 + Σ `radarRangeBonus` завершённых технологий +
`radarRangeBonus` пассива фракции) — данными, не kernel-хуком: проекция чистая и
живёт вне кернела. **Разведка флотом (A3):** транзитный флот опознаёт ближайший узел
по ходу (`fleetNode` интерполирует позицию), так что память фиксирует и пройденные
узлы маршрута. **Хелпер `isVisibleTo(state, viewer, {planetId|fleetId}, data)` (A4)** —
ad-hoc запрос «видим ли объект на identify-уровне» по тому же правилу, что режет
проекция: своё — всегда, radar-blip/память/неизвестный id — false (fail-secure).

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
- **Герои — 5 data-каталогов (HERO-1..9 ✅):** `heroes.json` (архетипы `commander/ravager/
  vanguard/warden`; `branch` — своя ось `transhuman|psionic`, `ship.unit`, `slots`,
  `startAbilities`/`startPassives`), `heroAbilities.json` (`{type, cooldownHours, range,
  cost, params}` — включая маркер-типы `spawn_fleet`/`spawn_allied`), `heroPassives.json`
  (`{hook, scope, params}`), `heroSkillTrees.json` (`{branch?, requires[], cost,
  grants}`), `heroFittings.json` (`{statMods, grants, cost}`). Движок ПОЛНОСТЬЮ живой:
  `hero.ability`/`hero.spawn`/`hero.skill.unlock`/`hero.fit` + пассивки на хуках +
  пред-матч ростер (`SlotAssignment.heroes`) — см. §5 hero-модуль. Referential-integrity
  тесты связывают все каталоги; загрузчик собирает 5 фрагментов.

## 7. Прототип (`prototype/`)

`pnpm run prototype` → esbuild собирает всё (ядро + zod + UI) в один
self-contained `dist/void-dominion.html` (открывается с диска, без сервера).

- **Реальное ядро** в браузере: `createKernel([sector, planetType, tax, faction, economy,
movement, hero, heroEffects, orbital, combat, artillery, intercept, captureOnArrival,
construction, technology, steward, army, victory, fleetLaunch, diplomacy, espionage,
botDiplomacy, market, division, capital, standingOrders])` (26 модулей), тик в реальном
  времени (скорость ⏸/▶/⏩). Концовка матча — из авторитетного `state.match` (`victoryModule`),
  баннер победы/поражения/ничьи (а не хардкод по узлам).
- **Фракции (H3):** setup-экран несёт **пикер из 4 лор-домов** (`data.factions`:
  blue «Azure Compact» +12% экономика · red «Crimson Hegemony» +10% урон · amber
  «Amber Concord» +15% скорость флотов · violet «Violet Ascendancy» +5%/+5%) — пока
  фракция это **чисто пассивный бонус к экономике или юнитам**, применяемый ядровым
  `factionModule` через те же хуки, что и технологии. Человек выбирает дом, ИИ-места
  разбирают оставшиеся (имя места = имя дома; цвет остаётся за местом); карточка
  игрока показывает дом + пассив. Тесты `factions.test.ts` (3).
  Миры размечены типами (terran/barren/oceanic/volcanic/gas_giant) — карточка планеты
  показывает тип и его бонусы (prod/def), `netIncome` учитывает множитель производства.
- **Герои — полная новая модель в прототипе:** 5 hero-каталогов инлайн в данных `game.ts`
  (зеркало `data/*.json`, те же id, что и в легаси-пуле меню), ростер меню (4 героя)
  сеется **core-инстансами** `hero:{seat}:{n}` (grade→архетип 1:1: main→commander,
  legendary→ravager, rare→vanguard, common→warden; главный — флагман домашнего флота,
  остальные — резерв как в `buildFromMap`; способности = выбор меню + маркер-перки
  архетипа). Ростер героев **свёрнут в таб «Верфи»** (панель «Герои» → `heroBodyHtml`;
  окно `#hero`/рельс `rail-hero` ретайрнуты в CON-4) — весь цикл: развёртывание
  `hero.spawn` armed-тапом (свой мир / свой флот / мир союзника по маркерам), каст
  `hero.ability` (встроенные `temp_lane`/`annihilate` armed-тапом цели + `recall` /
  `aura` (rally/bulwark) / `reveal` (scan, armed-тап цели) — прототип-кернел несёт
  `heroEffectsModule`; **все не-встроенные эффекты имеют провайдеры → «скоро» не
  осталось**), дерево `hero.skill.unlock`, фиттинги `hero.fit`. Кастуемость —
  `HERO_CASTABLE` (built-ins + провайдеры `hero.effect.*`). Билдеры действий —
  `castHeroAbility`/`spawnHero`/`unlockHeroSkill`/`fitHero` (`game.ts`); тесты
  `herostate.test.ts` (сид) + `heroactions.test.ts` (интеграция пяти действий, включая
  reveal/scan, против прототипных каталогов).
- **Конструктор «Верфь» (`rail-constructor` → `renderConstructor`, оверлей `#constructor`):**
  единый in-match таб-лоадаут со Stellaris-свитчером `[Корабли|Эскадрильи|Армия|Герои]` —
  все четыре панели живые (разгрузка игрового HUD: рельс `rail-hero` и окно `#hero`
  ретайрнуты, штаб героев свёрнут внутрь этого таба).
  Панели **Корабли** и **Эскадрильи** рендерят один framework-agnostic view-model
  `@void/client/loadoutEditor` (`conLoadoutPane(hullList)`, переиспользован напрямую, без
  дублирования логики) над разными семействами корпусов: типизированные слоты
  (Оружие/Защита/Система), палитра с `installable`/причиной от `canEquip`, живой превью
  base→derived (`effectiveStats`), разбивка стоимости (`loadoutCost`) и «Построить ×N» →
  `buildShip` → `unit.build{modules}` (ядро валидирует/платит/штампует; лоадаут заморожен
  на постройке — без переоснастки). Панель **Армия** редактирует шаблон дивизии
  (`division.template`): 6 слотов (тап цикл пусто→пехота→танк), живой агрегат
  (`formationStats`) — атака/оборона/корпус, синергии состава и стоимость мобилизации;
  сама мобилизация остаётся в панели мира. Панель **Герои** — ростер/штаб (`heroBodyHtml`:
  способности `hero.ability`, дерево `hero.skill.unlock`, фиттинги `hero.fit`), клики
  роутятся через слушатель конструктора. Инлайн-данные `game.ts` дополнены каталогом
  `modules` (6 модулей, зеркало `data/modules.json`) + типизированными `slots` на корпусах
  кораблей (cruiser/siege/scout/dropship) и эскадрилий (fighter_squadron/strike_carrier).
  Тесты `constructor.test.ts` (7): каталог+слоты, редактор над прототип-данными, экип/дубль,
  `unit.build{modules}` принят/заряжен, кривой лоадаут → reject, слоты эскадрилий + экип
  на них, цикл слота шаблона дивизии через ядро.
  **Мобильная адаптация** (`@media (max-width:560px)`): двухколоночная сетка панелей
  уже сворачивается в одну на ≤760px; на телефоне палитра модулей `.cn-pal` переходит
  на 2 колонки (имена перестают переноситься), крупнее тап-таргеты (`.cn-close` 36px,
  шаг счётчика 38px, таб/корпус-кнопки выше), меньше рамка оверлея (шире бокс); на
  коротких вьюпортах (`max-height:680px`, ландшафт-телефоны) оверлей скроллится, как
  соседние окна. Проверено CDP-скриншотами в portrait 390×844 (все 4 панели, без
  горизонтального переполнения).
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
  `fleet.split` (кнопка «Запустить эскадрилью»); дерётся обычным боем, `orbital_aa`
  (теперь защитное здание, не юнит) — встроенный counter; ядро суммирует `aaDamage`
  и по гарнизону, и по зданиям (`aaStrengthAt`). Топливо/перезарядка (`SortieState`), евклидов `strikeRange`,
  детерминированное решение патруля (`patrolTarget`) — чистые тестируемые хелперы `game.ts`.
- **Цепочки приказов (command-chains) — УДАЛЕНЫ к релизу (REL-1, «пока убери»).**
  Очередь приказов (CC-1/CC-5/CC-6/CC-server: `orderQueueModule`, `state.orders`,
  клиентский план `fleetQueues`+`driveQueues`, серверный драйвер `runServerQueues`,
  весь UI «Очередь приказов»/«➕ строить»/план на карте) и `subscriptionModule`
  (лимит-апселл) вырезаны из кернела, UI и netserver — команды панели (штурм/
  обстрел/погрузка/выгрузка) теперь прямые действия. История дизайна — в git
  (ветка до REL-1) и `docs/backlog.md` (блок CC). **Стоячие приказы ОСТАЛИСЬ**
  (CC-2/CC-4, `standingOrdersModule`): `order.auto`→`state.autoAssault` (авто-штурм),
  `order.scramble`→`state.patrols` (дежурный вылет, сервер сам считает центр/радиус/
  запас вылетов), `patrol.stamp`; чистые драйверы `serverAutoAssaultActions`/
  `serverPatrolActions` + хост-цикл `netserver.runServerStanding`; `autoAssault`/
  `patrols` фильтруются в fog; кнопки «⚔ авто-штурм» и «🛩 дежурный вылет» работают
  в соло и NET.
- Валидаторы: `src/smoke.ts` (Node-сценарий ядра) и `uitest.mjs` (headless-DOM
  прогон UI-бандла).
- **UI-прототип экрана корпорации (mock)** — межсессионный альянс из `metagame.md`:
  оверлей `#corp` (вход с вкладки «Альянсы» в хабе и с рейл-кнопки ⬢) с табами
  Обзор/Участники/Казна/Владения/Войны/Чат на **локальных mock-данных** (ни сервера,
  ни аккаунтов ещё нет). Дизайн — `docs/corporation-ui.md`; интенты пока лишь пишут
  строку в лог (`[corp mock] intent: …`), реальные проекции/интенты — Этап 3+.

## 8. Метаигра (north-star)

Два контура: обычные сессии (малая карта) + AvA-битвы за сектора мета-галактики
(корпорации, очки влияния, мета-шпионаж). Зафиксировано в **`docs/metagame.md`**.
Ключ: сессионное ядро — движок обоих контуров; мета-слой — сервер (Этап 3+).
Сейчас **не строим**. UX мета-шелла — **`docs/main-menu.md`**; экран управления
корпорацией (ростер/роли/казна/владения/AvA/чат) — **`docs/corporation-ui.md`**.

## 9. Статус

> Компактный агрегат; помашинная матрица — [`readiness.md`](readiness.md),
> запуск для живых игроков — [`launch-runbook.md`](launch-runbook.md).

**✅ Этап 1 (ядро) — готово целиком:** 23 модуля на микроядре (шина/хуки/манифест,
seeded RNG + golden, `advanceTo`): экономика + рынок, карта/движение/перехват, типы
секторов и планет, бой (мелэ + орбитальное ПВО/бомбардировка + артиллерия) с двухфазным
захватом, здания + станции, флот ⊕ армия + транспорт, технологии + учёные, фракции,
дипломатия (стойки + consent-офферы), шпионаж + контрразведка, герои, «Хранитель»,
победа/счёт, туман (`visibleState` + память + radar).

**✅ Этап 2 (action-layer) — готово и вшито в сервер** (`GATE=1`); клиент шлёт
`action.v1`-конверты по `gated`-рукопожатию.

**🚧 Этап 3 (сервер) — крит-путь до онлайн-сессии закрыт:** durable Postgres +
commit-before-broadcast, туман-на-отправке, offline-планировщик, `LazyRoomRegistry` +
MatchKeeper, аккаунты логин/пароль + JWT (opt-in); action-гейт включён и на
играбельном пути (netserver, REL-4 — в compose по умолчанию ON), места игроков
заперты посадочными билетами (REL-5, `SEAT_LOCK`, тоже default-ON). Дальше:
OIDC/полные аккаунты на прото-пути, мультипроцесс.

**🚧 Этап 4 (клиент):** играбельный клиент игроков — `prototype/` (браузер + APK,
RU/EN, мобильный UI-пасс, мета-прогрессия); `packages/client` — transport-adapter +
Vite-shell с живой картой. Полный HUD в shell — впереди.

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

Тесты лежат рядом с кодом (`*.test.ts`) — и в пакетах, и в `prototype/src` (Vitest
их видит). Прототип исключён из ESLint/tsc-скоупа (свой esbuild), но это уже НЕ
throwaway — это играбельный клиент игроков. Разработка — на фиче-ветке, PR (draft).

## 11. Как возобновить работу

1. Прочитать корневой `CLAUDE.md` (инварианты + рабочие правила), затем этот файл
   и нужные `docs/`.
2. Своя фиче-ветка от `main`; перед коммитом — `pnpm run check`.
3. Новая механика = новый модуль (события + хуки) + возможно данные; ядро трогать
   не нужно. Этот снапшот обновлять после крупных изменений.
