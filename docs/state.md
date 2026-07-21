# Состояние проекта — снапшот

> Живой «якорь контекста»: что готово, как работает, что дальше. Обновляется по
> мере разработки (после крупных изменений). Парные документы: `architecture.md`,
> `modulesystem.md`, `gdd.md`, `roadmap.md`, `backlog.md` (кирпичики задач),
> `deep-technical-roadmap.md`, `multiplayer.md`, `metagame.md`, `map-roadmap.md`, `security-a06.md` (модель угроз/A06), корневой `CLAUDE.md` / `CONTRIBUTING.md`.
>
> **Ветка:** feature-ветка · **PR:** создаётся после изменений.
> **Гейт:** `pnpm run check` (lint + typecheck + test + docs-check). **Тесты: 1559 зелёных** (42 skip, 143 файла).

**Быстрый старт сессии** (навигация — факты живут в секциях и не дублируются здесь):

- Возобновить работу → **§11** (внизу) · статус этапов → **§9** · команды/качество → **§10**.
- Что брать в работу → `backlog.md` (кирпичики со статусами и зонами; 1 кирпич ≈ 1 PR).
- Инварианты и рабочие правила → корневой `CLAUDE.md` (Claude Code подгружает его сам).
- Как устроено ядро/сервер/прототип → §2–§7 этого файла; полный индекс доков → `README.md`.

---

## 1. Что это

Void Dominion — мобильная/браузерная **real-time** (непрерывное wall-clock время,
24/7, асинхронная игра) 4X космо-стратегия в духе Bytro (Iron Order). Ставка —
**гибкое, расширяемое ядро**: новые механики/юниты/фракции добавляются **данными
и модулями**, не переписыванием логики.

Монорепо (pnpm workspaces):

- `packages/shared-core` — детерминированная, data-driven симуляция. Без сервера/БД/сети.
- `packages/action-layer` — Stage 2 security gate: `ActionEnvelope`, validation, authorization, idempotency receipts, per-session `clientSeq`.
- `packages/server` — авторитетный сервер (Этап 3). WebSocket multiplayer slice: `MatchRoom`, `createMultiplayerServer`, action/state sync, per-player туман. Персистентность: `MatchStore`/`AccountStore`/`ReceiptStore` (in-memory + Postgres JSONB) — durable-матч переживает рестарт, durable receipts дедупят повтор после рестарта, ник-логин лобби. Offline-«будилка» (PA-4.1 v1): `MatchRoom.tick()`/`msUntilNextEvent()` + одно-процессный `setTimeout`-драйвер — отложенные события (прибытия/бои/захваты) срабатывают без подключённых игроков (мир идёт 24/7). Есть в обоих серверах: прото-сервер (`netserver.ts`, APK) с PA-4.1, боевой вход `packages/server/src/main.ts` — с F8 (`persistence.ts`+`clockDriver.ts`, паритет). Баг-фикс F8: `MatchRoom.initialSeq` восстанавливает счётчик действий при рестарте, иначе optimistic-by-seq store дропал пост-рестартные сохранения — прокинут в оба сервера. Строгий commit-before-broadcast (risk14, опция `MatchRoom.persist`): действие идёт async-путём через актор-**mailbox** (сериализован per-room; туда же lobby-`start`), ждёт durable-запись снапшота+квитанции ДО коммита/рассылки (`computeAdvance` считает догон мира чисто, не трогая `stateValue` до ack); провал записи → транзиентный reject, ретрай доезжает; синхронный `submitAction` не тронут; прошёл 3-линзовый состязательный ревью. **SV-0.2 match-actor:** `RoomRegistry` (роутинг по matchId — N изолированных матчей/процесс, `InMemoryRoomRegistry` eager) + `LazyRoomRegistry` (lifecycle/risk13: ленивая загрузка по запросу + гибернация простаивающих в стор после idle-окна → live-память ∝ активным матчам; **пробуждение спящего матча к его следующему событию** — реорганизует+персистит+снова спит, мир идёт 24/7 при всех офлайн; таймер инжектируемый = шов под pg-boss; reconnect детерминированно догоняет). Рядом — браузерный `MatchRegistry` (`matchRegistry.ts`, main-menu §2): meta-состояние матчей (карта/правила/архив) с read-model `GET /matches` + archive-интентами (`registerBrowserApi` в `matchApi.ts`); структурно совместим с `RoomRegistry`, так что служит и источником комнат для транспорта (прото-сервер). DoS-границы (аудит F-03/F-04): карта `receipts` капается с FIFO-эвикцией (`maxReceipts`), действия — per-player rate-limit (`actionRateMax`/`actionRateWindowMs`, флуд → транзиентный `E_RATE_LIMIT` без квитанции, ретрай переживает). **SV-1.1 action-layer front-door (опционально):** `MatchRoom.gate?` подключает `@void/action-layer` `ActionGate` — gated-сообщение `action.v1` (конверт) проходит validate→authorize→sequence→dedup ДО редьюсера (стабильные `E_*` без утечки), а bare-`action` на gated-комнате отклоняется (нет обхода гейта); rate-limit стоит ДО резервации seq, поэтому троттлинг не сжигает `clientSeq` (ретрай доезжает, не `E_REPLAY`). `submitAction`/`admitEnvelope` делят общее ядро `applyAndBroadcast`, не перепроверяя чужие гейты. Абьюз-e2e (E3) зелёный (невалид/несанкц/replay/out-of-order → безопасный отказ; дубль → реплей без повторного применения). **Боевой вход (Fastify, SV-0.1):** `/health` без утечки id (**F-13**), `/ready` со стор-probe `MatchStore.ping`, pino, graceful drain — заменил голый node:http. **Аутентификация handshake (SE-0.1, **F-01**):** опция `auth` требует верифицированный join-токен (`?token=`); при ней `?player=`/`?nick=` игнорируются, `matchId`/`playerId` токена сверяются с матчем и местом; `allowedOrigins` (**F-06**) режет cross-site upgrade. Токены — `verifyJoinToken`/`signJoinToken` на `jose` с пином алгоритма (нет `none`/alg-confusion), `typ`, iss/aud/exp, опц. max-age (SE-2.1, прошёл состязательное ревью — verified против исходников jose). **Живой гейт:** транспорт минтит серверный `sessionId` (randomUUID — не клиентский, это ключ курсора seq), отдаёт в `welcome` и в `receive`; gated-envelope авторизуется против него, end-to-end (SV-1.1-live-A). Стора гейта ограничены — FIFO receipts + LRU cursors (SV-1.1-live-B, закрыл MAJOR из ревью). **Payload-схемы (SV-1.2 + REL-2, инвариант #5):** zod-схема на каждый из **46** клиентских типов действий — ПОЛНЫЙ интент-набор прототипа (вкл. артиллерию/отступление/рынок обоих хостов (`market.take`/`side`)/дипломатию/дивизии/`fleet.launch`/`split`/`merge`/`engage`/капиталь/Хранителя/стоячие приказы/`unit.build{modules}`); `patrol.stamp` намеренно НЕ клиентский (рантайм-штамп серверного драйвера — клиентский штамп заправлял бы своё крыло); паритет закреплён `prototype/src/gateparity.test.ts` (сэмплы через реальные билдеры) (`shared-core/actions/payloadSchemas` + `isValidActionPayload`) инжектится в гейт как `payloadValidator` — кривой payload или не-клиентский тип → `E_BAD_PAYLOAD` до редьюсера. **Гейт на durable-пути (gate+persist):** принятое gated-действие коммитится-до-broadcast на durable-пути; весь admit→commit сериализован в mailbox (резервация seq и persist атомарны), при транзиентном сбое `SequenceGate.rollback` отпускает курсор → тот же `clientSeq` ретраится (не `E_REPLAY`). Прошло состязательное ревью (дизайн звучит; закрыт MAJOR — broadcast теперь per-player изолирован, не может застрять на throw). **Боевой вход:** `main.ts` включает auth/гейт по env (`AUTH_JWT_SECRET`, `GATE=1`, `ALLOWED_ORIGINS`), default off (live-C). **Мульти-матч (SV-4.0):** вход хостит N матчей через `LazyRoomRegistry` — матч грузится из стора по первому коннекту, гибернируется в простое, будится к событиям; `dev` сидируется на буте (реальный create — SV-2.4). **Вход игроков (SV-2.4 + SE-1.x, логин+пароль):** аккаунты `users` (Memory/Postgres, логин уникален без регистра), пароли scrypt (`node:crypto`, параметры вшиты в хеш), `POST /auth/register`/`/auth/login` → сессионный JWT (`typ session+jwt`, отдельная audience — невзаимозаменяем с join-токеном); uniform-401 + decoy-hash (не раскрываем существование аккаунта ни телом, ни таймингом), per-IP rate-limit. `POST /matches` и `GET /matches/:id/join` требуют `Authorization: Bearer <session>` — ник места = логин сессии (никем другим не зайдёшь), `accountId` штампуется в join-токен (15 мин); оба маршрута пишут durable-состояние (сид матча / занятие места), поэтому оба за per-IP sliding-window rate-limit (общий бюджет create+join, `E_RATE_LIMIT`/429, ограниченная FIFO-карта), как auth-эндпоинты. Сверх точечных лимитеров весь account+match-контур в `main.ts` обёрнут `@fastify/rate-limit` в инкапсулированном scope — грубый per-IP бэкстоп (health/ready на родительском app не троттлятся). Всё выставляется **только при включённом auth**; e2e прогнан вживую: register → login → Bearer-join → WS welcome. Дальше по треку: refresh/ревокация сессий (AC-0.2), OIDC как второй провайдер (AC-1.1). **Фабрика матчей (SV-2.5):** `MatchKeeper` держит `OPEN_MATCHES` (env, деф. 3) открытых матчей — как только один заполнился/закончился, засевается новый, так лента не пустеет и игрок всегда может зайти в свежую игру. Счёт открытых берётся из durable-стора (`MatchStore.ongoingMatchIds` + `occupiedSeats`), а не из in-process счётчика → рестарт реконсилит по реальному миру, не переплождая; кап на конкурентные матчи (`max`), reentrancy-guard, ошибка create/read проглатывается и ретраится следующим тиком. Реконсиляция на буте + интервал 30с. Публичная read-only лента `GET /matches/open` (id/seated/capacity из стора, переживает гибернацию — видит и спящие матчи) — браузинг до логина, join по-прежнему требует сессию. Прогнано вживую: `OPEN_MATCHES=3` → сервер добил до 3 открытых (посчитал `dev`, создал 2), все в `/matches/open`. **Метрики (OPS-0.1):** `/metrics` — агрегатные gauge'ы (число матчей/коннектов, без id). **Метрики M1 (metrics-roadmap):** observe-поток комнаты расширен наблюдениями `events` (доменные события коммита, без `time.advanced`), `broadcast` (ms + размер дельты per-player), `timing` (submit/advance) и `desync` (клиентский репорт); `MetricsAggregator` (`metrics.ts`) сводит их в счётчики/avg/max; на `desync`-сообщение комната отвечает полным `state`-ресинком с cool-down 2 с per-player (репорт наблюдается всегда — шторм виден в метриках, но не DoS). **Метрики M2:** клиентское сообщение `perf` `{fps,rttMs?,memMb?}` (клампы при parse, per-player rate-limit 5 с, только наблюдается — `client_perf`); headless перф-харнес `pnpm run perf` (CPU-стоимость кадра idle/pan/zoom против бюджета p95, нон-блок шаг в CI, `PERF_STRICT=1` — гейт). **Крит-путь до онлайн-сессии закрыт.** Пройден 3-линзовый ревью (корректность/безопасность/чистота): починен HIGH-баг живости (драйвер часов не пере-armился после committed-действия — вынес эмиссию `action`-наблюдения за окно `committing`); добавлен Fastify error-handler (инвариант #4, без утечки); ядро gate/session/JWT подтверждено безопасным. **Вектор 2 (надёжность) сделан:** durable-места (`createStores` отдаёт `PostgresAccountStore` при `DATABASE_URL` — ник→место переживает рестарт, 2.2); CI-workflow (`ci.yml`) с сервис-Postgres гоняет durable-адаптеры в CI + `configFromEnv` вынесен из `main.ts` и покрыт тестом round-trip mint↔verify (2.3). **Durable-стора гейта — НЕ нужны (2.1, verified):** они ключуются по per-connection `sessionId` (серверный, неповторимый), теряются ровно когда отслеживаемые сессии заканчиваются → переподключение минтит свежий `sessionId` → свежий курсор; персистить нечего. **Деплой одной командой (REL-3):** `pnpm stack` (= `docker compose -f deploy/docker-compose.yml up -d --build`) поднимает игровой сервер (distroless-образ: игра на `/`, WS, `/health`) + Postgres; отказоустойчивость — `restart: unless-stopped` на обоих, durable-резюме матчей из PG, healthchecks (server ждёт healthy-PG), bounded-логи, PG на loopback; runbook (обновление/бэкап+cron/восстановление/границы) — `deploy/README.md`. **Гейт на играбельном пути (REL-4):** прото-хост `prototype/netserver.ts` принимает `GATE=1|true` — комната получает тот же `ActionGate({payloadValidator: isValidActionPayload})`, что и боевой вход (зеркало serverConfig); в compose релиз-постура — `GATE` по умолчанию **ON** (`${GATE:-1}`, `GATE=0` — дев-откат к голым actions). Прогнано вживую в обе стороны: gated — `welcome{gated,sessionId}` → голый `action` отклонён (`E_BAD_MESSAGE`), `action.v1`-конверт того же клиента применён (delta); ungated — голый `action` применён (обратная совместимость). Серверные драйверы (ИИ/Хранитель/стоячие приказы) идут через `room.submitAction` МИМО гейта — так и задумано: гейт стоит на проводе, не внутри хоста. **Замок мест (REL-5, `SEAT_LOCK=1`, в compose по умолчанию ON):** ник-логин без аккаунтов защищён «посадочным билетом» — первый вход ника минтит случайный тикет (`randomBytes(24)`), транспорт хранит ТОЛЬКО его sha256 в `AccountStore` (`bindSeatTicket` — первый bind атомарно выигрывает, Memory и Postgres; колонка `seats.ticket_hash`, `ALTER … IF NOT EXISTS` — старые ряды дозамыкаются при следующем входе владельца), плэйнтекст едет клиенту один раз в `welcome.seatTicket` (`addPeer welcomeExtras`); каждый последующий вход обязан предъявить `?ticket=` (сравнение constant-time), иначе 401; прямой `?player=` под замком отклоняется (обход невозможен). Клиент самонастраивается: `MultiplayerClient.onSeatTicket` → прототип кладёт билет в `localStorage` (`void.ticket.<base>|<match>|<nick>`) и добавляет `&ticket=` при коннекте. Проверено: юнит-e2e транспорта (`seatLock.test.ts`), стор-контракт на Memory+Postgres 16 (включая миграцию старой схемы), живой raw-ws прогон и БРАУЗЕРНЫЙ CDP-прогон реального клиента (билет ложится в localStorage → реконнект пускает; удалили билет → тот же ник заперт). Потерянный билет невосстановим с сервера (hash-only) — владелец чистит ряд в `seats`. **Сессии Iron Order (SES-2):** автостарт без лобби (SES-2.1 — `MatchRoom.initiallyStarted` работает и без `manualStart`); два ИИ разведены `seatAiDecision` (SES-2.2 — Хранитель по делегированию vs `expand`-заместитель после `AI_GRACE_MS`=3 реальных дня); окно входа `ENTRY_WINDOW_MS` (SES-2.3, деф. 4 реальных дня): `wsServer.admitNewSeat?` отклоняет ПЕРВЫЙ вход ника (проверка `seatOf` до `resolveSeat`, 403) после `MatchRegistry.entryOpen` (возраст = `state.time/timeScale`, переживает рестарт), реконнект своих не гейтится; закрытая сессия выпадает из «Доступных». **Аккаунты на игровом пути (SES-2.5):** с `AUTH_JWT_SECRET` прото-хост монтирует SE-1.x-контур (`registerAuthApi` + свой join-роут: Bearer-сессия → seat логина → join-токен, окно входа тем же `seatOf`-до-`resolveSeat` гейтом → 403 `E_ENTRY_CLOSED`) и передаёт `auth` транспорту — nick/ticket отклоняются; без секрета — прежний nick+ticket. Клиент самонастраивается по `GET /auth/status`: поле «Пароль», zero-friction login→register, session-JWT per-server в localStorage, реконнект минтит свежий join-токен. Живой e2e 10/10 + окно на auth-пути. Плейтест-постура компоуза (SES-2.6): `TIME_SCALE` деф. ×24 (окна отсутствия/входа — реальные); полный цикл прогнан живьём 7/7 (регистрация → лента → вход → gated-игра, часы ≈×24.0). ⏳ Дальше: OIDC-идентичность, полные аккаунты на прото-пути (JWT join-токены в транспорте готовы), контейнер-хардненинг. **Реплей-детерминизм (playtest-hardening RPL-1..3):** shared-core `replay/replay.ts` — самодостаточный `ReplayLog` (полный стартовый стейт, RNG внутри; шаги `{at, action?}`) + чистый `runReplay` с fail-secure пинами версии/порядка; **границы advance — часть лога** (спановое начисление float-чувствительно к членению — движок обещает coarse ≈ fine, не бит-в-бит). `MatchRoom.record` пишет каждую исполненную границу advance и каждое успешно применённое действие (sync + durable пути, серверные драйверы включительно); CI-тест `replayDeterminism.test.ts` — живая комната на полном dev-стеке (шипнутые данные, 48 игровых часов) → реплей → `hashState` бит-в-бит, плюс JSON-round-trip лога (паритет гибернации). Остаток: durable action-log (PE-1.1) → аудит-реплей (GI-1.3). _Известный нюанс (клиентская сверка, не серверная durability):_ acked-но-недоставленное действие + рестарт + наивный ресенд может примениться дважды (`actionId` session-scoped) — закрывается сверкой клиента с полным `welcome`-состоянием на реконнекте, не durable-стора́ми гейта.
- `packages/client` — клиент (Этап 4): направление **PWA-first веб-клиент** (TWA Android + Capacitor iOS, не React Native — см. `cross-platform-roadmap.md`). Есть `MultiplayerClient` transport adapter — **закрывает SV-1.1-петлю**: ловит `sessionId`+`gated` из `welcome` и на gated-комнате оборачивает намерение в `action.v1` конверт (`createActionEnvelope`, strict per-session `clientSeq` 1,2,…, `actionId=sessionId:playerId:clientSeq`, сброс на реконнекте), иначе — голый `action`; сервер отдаёт `gated:true` в welcome → клиент самонастраивается по рукопожатию. Прогнано вживую: gated-сервер → welcome`{gated,sessionId}` → конверт принят → delta; юнит-тесты прогоняют вывод клиента через те же `validateActionEnvelope`+`authorizeActionEnvelope`, что и гейт. **Реконнект и резюме (CP1.4/G1):** неожиданный обрыв сокета → авто-реконнект с экспоненциальным бэкоффом (1с→30с cap, сброс на успешном open) в `net.ts`; клиент флипается в `connecting` и складывает интенты в ограниченный outbox (64, переполнение → `E_OUTBOX_FULL`), флаш после реконнект-`welcome` под свежей сессией (в очереди только никогда-не-отправленные действия → без дублей); дельта с `seq` назад (вперёд-гэпы/повторы легальны) дропается как desync и форсит немедленный ресинк-реконнект; deliberate `close()` финален. **Hash-desync (M1):** на дельте с `hash` клиент сверяет свою реконструкцию (`hashState`), при mismatch шлёт `desync`-репорт и получает полный `state`-ресинк без реконнекта (один запрос за раз; UI-хук `onHashDesync`). Токены темы (`theme.ts`) и framework-agnostic view-models (паттерн: чистая фабрика + fail-secure, JSON-сериализуемо): `welcomeScreen.ts` (экран входа) и `matchHud.ts` (внутриматчевый HUD: зоны A+D — `createStatusBarModel` стат-бар, `createSelectionModel` панель флота; **боевая зона** — `createBattleModel` + `resolveBattleAction` панель активного боя с единственным действием «Отступить»; всё поверх fog-проекции `visibleState`; см. `hud-inmatch.md`). App shell — рабочий
  Vite-каркас: welcome-экран, живая карта на общем рендер-ките (камера/holoDraw/territory),
  подключение к серверу по `?join=`-диплинку (снапшоты/дельты + приказ движения через
  `action.v1`); полный игровой HUD в shell — впереди, играбельный клиент игроков — `prototype/`.
- `data/` — контент в JSON, вкл. карты `data/maps/*` (skirmish-1, ava-duel-1 2×1,
  ava-2v2-1 2×2). **AvA-пул карт (AVA-5):** тег `MatchMapSchema.avaEligible`, форма
  выводится из slots (`avaShape` → `{sides, slotsPerSide}`, `E_AVA_SHAPE` на кривой
  eligible-карте), seeded-выбор — `pickAvaMap` (`packages/server/src/avaMapPool.ts`).
  `docs/` — дизайн. `prototype/` — играбельный
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
  state/         gameState.ts (типы GameState), orbit.ts (isBombarded, bombardedPlanets), visibility.ts (visibleState — туман войны), previewBattle.ts (ONB-6 — чистый прогноз боя + hullPool/damageFraction), threat.ts (ST-3.1 — fog-honest скан угроз узлу)
  action/        types.ts (Action, Context, MatchConfig.timeScale/victory, ApplyResult/AdvanceResult, Rejection, timeScaleOf)
  data/          schemas.ts (zod-схемы + parseGameData, buildingLevel/buildingMaxLevel)
  rng/           rng.ts (sfc32)
  util/          clone.ts (deepClone/deepFreeze), treasury.ts (canAfford/payCost — shared by construction & technology), fitting.ts (генерик-гейт «слоты+предметы», SHIP-4) + loadout.ts (ship-обёртка над ним)
  modules/       army, artillery, captureOnArrival, combat, construction, diplomacy, economy, effects, espionage, faction, hero, heroEffects, intercept, market, movement, orbital, planetType, scientist, sector, station, steward, technology, victory, visibility  (24 модуля, + *.test.ts)
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
  `war` (= FFA). Примитивы в `state/diplomacy.ts`. **Посев при сборке с карты (AVA-1):**
  `buildStateFromMap` сеет стойки из `slot.team` (хелпер `seedTeamDiplomacy`, тот же посев,
  что прото-`newGame`): карта без команд → peace-FFA; та же сторона → `alliance` (seeded —
  минует `E_BOT_ALLIANCE`); между сторонами — `BuildFromMapOptions.crossTeamStart`
  (`war` дефолт / `peace` — мирный старт AvA); пары из отсортированных id — канонический
  JSON. **`combat.isHostile` читает стойку прямо из
  `state.diplomacy`** (`getStance(...) === 'war'`) — бой идёт только при объявленной войне. **ПВО бьёт залпами, двумя ярусами** (не непрерывно):
  **орбитальное** (здания-батареи, Σ их `aaDamage`) — полный залп раз в игровой час;
  **ближняя** (юниты гарнизона, Σ их `aaDamage`) — залп раз в 15 игровых минут по четверти
  часовой ставки (часовой выход тот же, окно уклонения — 15 минут). Сетки — мировое время
  ×timeScale (`roundIntervalMs`; четвертная сетка содержит часовую — на общей границе
  тяжёлый залп ложится первым), перецеливание на каждом залпе; флот, нырнувший в орбиту
  МЕЖДУ залпами, уходит невредимым — тайминг рейда мимо ПВО имеет смысл. Каждый залп — событие `aa.fired {planetId, owner, fleetId,
by, damage}` (эмит до применения урона; прототип рисует трассер+вспышку; фазы боя
  различимы: красные кольца орбиты vs янтарный пунктир десанта).
  **Ядровой `diplomacyModule` (D2+D3, `modules/diplomacy.ts`)**: ОДНО действие
  `diplomacy.declare {target, stance}` на оба направления. К войне (эскалация) —
  односторонне: стойка флипается сразу, офферы пары стираются (объявление войны
  обрывает переговоры). К дружбе — consent-протокол: первый дружественный declare
  кладёт НАПРАВЛЕННЫЙ оффер в `state.diplomacyOffers` (`from>to` → stance, новее
  замещает, точный повтор — `E_ALREADY_OFFERED`); встречный declare той же стойки
  коммитит пару и стирает офферы. На `player.eliminated` офферы павшего (в обе
  стороны) свипаются. **Коалиция — только между людьми**: alliance-ward declare с
  ИИ-игроком (`Player.ai === true`, сеется картой/слотом/`newGame` прототипа)
  отклоняется с `E_BOT_ALLIANCE` (ни оффером не встанет, ни коммитом); мир/пакт с
  ботом разрешены. События `diplomacy.changed {a,b,stance,from}` /
  `diplomacy.offered {from,to,stance}`; capability `diplomacy` `{getRelation}` —
  принимает `state` параметром (war→hostile, peace/pact→neutral, alliance→ally);
  `getStance`/`setStance`/офферные примитивы — чистый state-слой
  (`state/diplomacy.ts`). Офферы фог-чувствительны: `visibleState` отдаёт
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
  (versionCode = счётчик коммитов, инжект CI) с маркером СВОЕГО rolling-релиза —
  `alpha` для дев-APK, `player` для player-APK (`updater.ts` резолвит лейн из
  `__PLAYER_BUILD__`-define; GitHub REST, все отказы → «нет обновления»); `#updbar` —
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
  Плавающее окно чата — desktop-only; на телефоне ВСЕ сетевые каналы доступны из
  Дипломатии → Сообщения: закреплённые «△ Сессия» (весь матч) и «⚡ Коалиция»
  сверху списка бесед + DM по участникам («Глобальный» — только в плавающем окне,
  ждёт глобального сервера).

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
**Премиум-слив (SES-3, GDD §4.3):** `technology.boost {technology}` — платит
`data.researchBoost.cost` (деф. **50 energy** — решение владельца: премиум = energy,
добывается на редких мирах `energy_nexus` из `planetTypes.json`: +100% energy,
+30% обороны — горячая точка) и режет ОСТАВШЕЕСЯ время активного исследования на
`initialPercent × decay^boosts` (деф. 25% с затуханием ×0.5 за буст — убывающая
эффективность, мгновенного завершения не купить; юниты/бой/герои не трогаются).
Ускорение = решедул: `completesAt` двигается раньше + новое `technology.complete`;
старое событие делается no-op штатным stale-гардом (несовпавший `completesAt`).
Счётчик `ActiveResearch.boosts`; конфиг `GameData.researchBoost`
(`ResearchBoostDefSchema`, zod-default — старые бандлы не тронуты); событие
`technology.research.boosted`. Коды: `E_NOT_ACTIVE`, `E_TOO_LATE`, `E_INSUFFICIENT`,
`E_BAD_PAYLOAD`.

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
E_NO_BUILDING, E_MAX_LEVEL, E_INSUFFICIENT, E_BOMBARDED, E_WRONG_SECTOR,
E_NO_SHIPYARD`.
- **Верфь-гейт на постройку кораблей (bugfix, `enablesShipConstruction`):**
  `unit.build` для юнита с `domain: 'space'` требует хотя бы одно ЖИВОЕ (`hp>0`)
  здание с флагом `BuildingDef.enablesShipConstruction` (`shipyard`/`spaceport`
  в `data/buildings.json`) на планете — иначе `E_NO_SHIPYARD`; наземные юниты
  (`domain: 'ground'`) гейт не проверяет. Проверяется ПОСЛЕ тех-лока
  (`requireUnlocked`), так что заблокированный технологией юнит всё ещё даёт
  `E_TECH_LOCKED`, не маскируется отсутствием верфи. Каждый домашний мир
  (`prototype/src/game.ts newGame`, `packages/server/src/scenario.ts
  createDevMatch`, `data/maps/*.json`) стартует с `spaceport`, иначе постройка
  флота с хода 1 была бы невозможна.
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
начисляет XP каждому победителю.
**Награды по итогам (SES-2, первый срез):** `endMatch` пишет детерминированную
таблицу `state.match.rewards` (`Record<PlayerId, {place, xp}>`) и кладёт её в payload
`match.ended`: place — standard competition ranking (1224) по финальным очкам,
XP = участие + капнутая доля счёта + win-бонус каждому члену победившей клики;
участие платится и побеждённым. Масштаб — данными: `data/rewards.json` →
`GameData.rewards` (`RewardsDefSchema`, дефолты = прото-`matchXp`: 40 / ÷10 /
cap 100 / победа 160 — бандл без блока получает их через zod-default). Ядро только
СЧИТАЕТ таблицу; запись на аккаунт — сервер после мета-экономики EC-*. Прото-хост
логирует её в JSONL: observe-`end` несёт `rewards`.
**Экран конца матча** (прототип): при `match.status==='ended'` вместо тонкого баннера
открывается полноэкранный оверлей `#endscreen` (`endScreen`/`renderEndScreen`) —
исход (ПОБЕДА/ПОРАЖЕНИЕ/НИЧЬЯ, цвет по исходу) + причина, итоговый счёт и **место** (N-е
из M), провинции/флоты/юниты, длительность, начисленный XP + лэвел-ап. Числа читаются
из авторитетного `match.scores`, поэтому экран одинаков в соло и в сети. Кнопки честны
по режиму: соло — «⟳ Играть ещё» (новый сетап) · «⌂ В меню» · «Смотреть доску»
(скрыть оверлей, глядеть на замороженную доску); NET — «⟳ Новый матч» (браузер
матчей — рематч того же стола требует серверной части, отдельный кирпич) · «В меню» ·
«Смотреть доску». Мир замораживается (соло-симуляция стоит, пока оверлей активен),
`xpAwarded` метит конец обработанным (не открывается повторно над хабом), сброс — на
свежем матче / реджойне. Дев-хук `__vdFx.endMatch('win'|'lose'|'draw')` под `?dev`.

**Счёт — data-driven, только территория** (GDD §8.1). База очков узла задаётся его
**видом** (`sectorKinds[kind].scoreValue`): **планета — 50** (приз), любой другой вид —
**10** (дефолт схемы; «мёртвый мир» — тоже 10). Поверх базы — Σ `building.scoreValue ×
level` (вложение в апгрейды растит счёт, разрушение — снижает; здания дают очки по тиру).
Тип планеты (`planetType`) и террейн (`sector`) теперь кормят экономику/защиту, но **в
счёт не идут** — так баланс карты считается «30 планет × 50 + остальное × 10». **Армия
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

## 6. Данные (`data/*.json`, версия `0.1.2`)

- **resources:** `credits` (деньги), `metal`, `food`, `energy`, `microelectronics` —
  внутриматчевый набор из 5. Торгуются на сессионной бирже (модуль `market`).
- **units** (схема `UnitDef`): `domain('space'|'ground')`, `stats{attack, defense,
speed, hp, shield, range, cargoCapacity, cargoSize, aaDamage}` (+ любые доп. числа),
  `line, traits, abilities, cost, buildTimeHours, upkeep`, `signature, radarRange`
  (армия очков не даёт — см. victory). Есть: `scout_drone,
cruiser, siege_lance(artillery,range), dropship(cargoCapacity 12), militia,
drop_infantry, tank(cargoSize 3), hero, fighter_squadron, strike_carrier` (10 юнитов,
все vanguard; `orbital_aa` — защитное здание, не юнит; `infected_cruiser` в контенте нет).
  Щиты (аблятивные) у боевых кораблей: cruiser 15, dropship 12, hero 40.
- **buildings** (`BuildingDef`): `cost, buildTimeHours, produces, hp,
defenseBonus, upgrades[{…}], traits, scoreValue, radarRange, healRate, shipRepair`. Есть: `mine_t1, mine_t2,
shipyard, biomass_pit, barracks, spaceport, radar, fort, metal_station, power_plant, fabricator`
  (форт — 3 уровня: HP 35→50→65, defenseBonus 0.35→0.50→0.65; **радар — 3 уровня**: `radarRange`
  180→300→420 (расстояние), HP 18→26→34). `radarRange` теперь **уровневый** (`BuildingLevelSchema`),
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

`pnpm run prototype` → esbuild собирает всё (ядро + zod + UI) в **два** self-contained
HTML (открываются с диска, без сервера): `dist/void-dominion.html` — дев-клиент
(всё как раньше) и `dist/void-dominion-player.html` — **клиент обычного игрока**:
тест-режим, одиночный скирмиш и контролы ускорения времени вырезаны (esbuild-define
`__PLAYER_BUILD__` выкидывает ветки из бандла, `build.mjs` вырезает `<!--dev-only-->`
разметку); главный путь игрока — позывной → браузер запущенных сессий (`GET /matches`).
Экран матчей в player-клиенте — ТОЛЬКО вкладки Доступные/Активные/Архив + список:
поля сервера/позывного, «Обновить список» и подзаголовок скрыты (инпуты остаются в
DOM как носители состояния для `resolveServer`); список сам обновляется тихим
10-секундным поллом, а поле сервера всплывает только пока список недоступен
(APK без same-origin вводит адрес хоста один раз — и оно снова прячется).
Прото-хост отдаёт player-клиент на `/`, дев-клиент — на `/dev`. Обучение (ONB-2
guided sandbox) в player-клиенте живо — идёт на фикс-темпе без ручки скорости.
APK собирается в двух лейнах (matrix в `android.yml`): дев — rolling-релиз `alpha`
(`com.voiddominion.prototype`, как раньше), player — rolling-релиз `player`
(`void-dominion-player.apk`, свой `com.voiddominion.player` — ставится рядом с
дев-версией); каждый APK автообновляется из своего лейна.

- **Реальное ядро** в браузере: `createKernel([sector, planetType, tax, faction, economy,
movement, hero, heroEffects, orbital, combat, artillery, intercept, captureOnArrival,
construction, technology, steward, army, victory, fleetLaunch, diplomacy, espionage,
botDiplomacy, market, division, capital, standingOrders, effects])` (27 модулей), тик в реальном
  времени (скорость ⏸/▶/⏩). Концовка матча — из авторитетного `state.match` (`victoryModule`),
  полноэкранный экран итогов победы/поражения/ничьи (счёт+место+статы+XP, рематч; см.
  раздел victory) — а не хардкод по узлам.
- **Фракции (H3):** setup-экран несёт **пикер из 4 лор-домов** (`data.factions`:
  blue «Azure Compact» +12% экономика · red «Crimson Hegemony» +10% урон · amber
  «Amber Concord» +15% скорость флотов · violet «Violet Ascendancy» +5%/+5%) — пока
  фракция это **чисто пассивный бонус к экономике или юнитам**, применяемый ядровым
  `factionModule` через те же хуки, что и технологии. Человек выбирает дом, ИИ-места
  разбирают оставшиеся (имя места = имя дома; цвет остаётся за местом); карточка
  игрока показывает дом + пассив. Тесты `factions.test.ts` (3).
- **Командный бой (AVA-0, первый шаг к AvA без мета-слоя):** тумблер «⚔ Командный бой» в
  setup + A/B-чипы на местах (ты залочен в A, ИИ-места переключаются). При включении
  `SeatConfig.team` едет в `newGame`, который сеет дипломатию по стороне: **одна сторона
  ALLIED** (побеждают вместе через SES-1, без дружественного огня — `combat.isHostile`
  читает стойку), **между сторонами WAR** с первого часа; нет команд → классический FFA
  (все пары `peace`). Альянс — посеянное состояние, поэтому ИИ-союзник реальный (в обход
  `E_BOT_ALLIANCE`-гейта декларации; клика-победа читает стойку). Коалиционный чат/пинги/
  порог победы работают из коробки. `teams.test.ts` (5). **Сетевые места:**
  прото-хост (`netserver.ts`) по умолчанию сеет FFA на 10 живых кресел (`p1`–`p10`);
  `TEAMS=5v5` делит те же 10 мест на A: p1–p5 и B: p6–p10, а `TEAMS=2v2` сохраняет
  компактный режим на 4 места. **Два ИИ (SES-2.2, `seatAiDecision` — чистая
  тестируемая функция):** `steward` — свой автопилот игрока (играет по своей позе
  даже при живом коннекте, делегирование бьёт грейс), `substitute` — полный
  `expand`-бот на брошенном кресле после **3 РЕАЛЬНЫХ дней** отсутствия
  (`AI_GRACE_MS`, wall-clock, независимо от `TIME_SCALE`; мгновенно снимается при
  возврате), `none` — присутствующий игрок командует сам. Конфигурации, дипломатия
  и таблица истинности двух ИИ закреплены в `networkSeats.test.ts` (8).
  **Мульти-сессии:** `MATCHES=N` (деф. 1, кап 16) поднимает N независимых сессий в
  ОДНОМ процессе (`proto`, `proto-2`, …) — вся пер-матчевая машинерия (комната,
  wake-драйвер, ИИ пустых кресел, standing-приказы, debounced-снапшот, receipts,
  BF-17 grace) закрыта в фабрике `createHostedMatch`; все сессии в `MatchRegistry`
  → браузер матчей клиента показывает каждую строкой, вход по matchId; durable
  restore пер-id (рестарт резюмирует все), shutdown флашит каждую. **Автостарт
  (SES-2.1, модель Iron Order):** лобби нет — часы сессии идут с момента её
  создания (`MatchRoom.initiallyStarted` без `manualStart`: якорь на
  `initialState.time`, `TIME_SCALE` работает), вход всегда в живой мир; клиентский
  лобби-оверлей и кнопка «Старт» удалены. Проверено e2e (реальный Chromium +
  Postgres-resume; автостарт — живой raw-ws смоук).
  Полный AvA-жизненный цикл
  (вызов/ростер/фазы, `corporation-wars.md`) — server/meta, дальше.
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
  (`formationStats`) — атака/оборона/корпус, доктрина состава (организационные метки без
  боевого бонуса — бой резолвит из ростера+офицер, BF-23) и стоимость мобилизации;
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
- **Карта (квадратная 11×11, генерится в `game.ts::buildField`):** 121 провинция — ровно **30
  «планет»** (по 50 очков) + 91 не-планета (по 10) = **~2410** базовых очков на доске; **10
  старт-кандидатов** равномерно разнесены по инсет-периметру, ещё 20 нейтральных планет
  собраны в зеркальные орбиты. Квадратный аспект — чтобы карта читалась в портрете
  (заполняет ширину, панится по вертикали). Победа по очкам — **1100**
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
    L1/L2/L3 = 240/330/420 коорд-ед + радар-корабли); радиус евклидов, проецируется
    по осям → граница тумана совпадает с кольцом.
  - **Камера pan/zoom** (тащить мышью-ЛКМ или пальцем / колесо / pinch / двойной
    тап-сброс); **адаптив** (мобайл/десктоп, media-queries, DPR-чёткость, тач).
    `netIncome` считает прирост.
  - **Семантический зум (LOD):** на отдалении карта становится схемой — голо-бейджи
    типов, callout-тексты, пирамиды/карго/счётчики флотов, орбитальные кольца и
    таймеры боёв растворяются (кроссфейд `globalAlpha` по scale 1.2→1.45; ниже —
    полностью схема). Остаются территории, узлы, флоты-шевроны «носом по курсу»,
    пульсы боёв и пинги; **свои миры подписаны на любом зуме** (якорь, как имена
    городов на глобусе). Пропуск отрисовки деталей на широких видах — заодно и
    выигрыш по кадру.
  - **Вспышка захвата провинции** (`planet.captured`, фог-гейт): провинция, сменившая
    владельца, загорается его цветом — волна расходится из центра ячейки (обрезана по
    её полигону), фронтир вспыхивает, всё гаснет за ~1.5с (`captureFlashes`,
    `CAPTURE_FLASH_MS`). Полигон ячейки берётся `computePowerCell` (тот же
    взвешенный-Вороной, что печёт полит-карту, одна ячейка O(n)) → волна пиксель-в-пиксель
    ложится на заливку и едет с камерой. Раньше захват был «тихим» (только тост).
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
- **Цели первой сессии / чек-лист (ONB-7)** — лёгкий «правильно ли я играю?»-сигнал только в
  онбординг-матче: чистый `src/firstGoals.ts` (`FIRST_GOALS` — шахта/флот/захват/100 очков;
  `metGoals(signals)`→Set, `mergeDone` монотонно, `goalsComplete`) — 10 тестов. main.ts:
  `startFirstGoals()` в гайд-матче снимает baseline (миры/шахты/флоты), сворачиваемый оверлей
  `#goals` (top-right, z-32) тикает цели по живому состоянию каждый кадр (`updateGoals` в
  фрейм-лупе, no-op вне онбординга); всё выполнено → похвала + XP-бонус (ровно раз, guard);
  скрывается на конце гайд-тура и выходе в меню. RU/EN. Проверено вживую (headless-бут):
  чеклист появляется 0/4 в гайд-матче (без ложных тиков — baseline корректен), сворачивается,
  прячется на выходе. Только онбординг-сессия (DoD «чеклист скрыт после онбординга»).
- **Async-модель + дневной дайджест (ONB-5, клиент-часть)** — учим самый трудный концепт
  жанра (мир идёт офлайн) в два хода. (1) **Интро задержки:** первый приказ на курс
  (`fleet.move`) → разовая карточка «мир идёт без тебя» (через ONB-3-механизм `asyncDelay`,
  вне гайд-тура). (2) **Сводка возвращения:** чистый `src/recap.ts` (`buildRecap(events,
  since)` → `{items (attention-first), attention, count}`, `isHighEvent` по emoji-маркерам
  ⚔🚩☠💥 — язык-независимо) — 5 тестов. main.ts: `note()` зеркалит структурный `eventLog`
  (bounded 80, чистится на новый матч); оверлей `#recap` (z-57) группирует «Требуют внимания»
  (жёлтый) + «Пока тебя не было», тап-по-объекту → `jumpToPing`; авто-показ на `visibilitychange`
  (фон-таб догоняет мир на возврате — реальный «пока тебя не было»; порог 15с) + ручной вход
  «🛰» в окне сводок. RU/EN. Проверено вживую (headless-бут): дайджест открывается из окна
  сводок, ловит события матча, закрывается. _Пуш-уведомления и серверный дайджест-хук — за
  зависимостью (PWA push); `buildRecap` уже server-ready для этого шва._
- **Just-in-time интро механик (ONB-3)** — при **первом** открытии продвинутой панели
  (технологии/рынок/Хранитель/верфь/дипломатия) — разовая интро-карточка, потом никогда:
  чистый `src/intros.ts` (`INTROS` — 5 карточек `{id,title,body,trigger}` из готовой копии;
  fail-secure `parseSeenIntros`, идемпотентные `markIntroSeen`/`hasSeenIntro`; `resolveIntro(seen,
  id,{veteran})→{card,seen}` — показывает ровно раз, ветерану suppress-но-помечено) — 9 тестов.
  Хранится per-nick `vd.seenIntros.<ник>`. main.ts: `maybeIntro(id)` в хуках рельс-панелей
  (`rail-tech`/`-steward`/`-market`/`-constructor` + `openDiplo`), оверлей `#intro` (z-58 —
  поверх панели, ниже настроек 59), «Понятно» закрывает; ветеран = завершил матч (`meta.xp>0`)
  → карточки помечаются молча (не спамим). RU/EN. Прогрессивное раскрытие: обучение
  разнесено по сессиям, не фронт-лоадом. Проверено вживую (headless-бут): первое открытие →
  карточка, повторное → нет, другой панель → своя, ветеран → подавлено-но-помечено. _Триггеры
  `firstAvailable`/`firstFail` (ретрит/артиллерия) — модель готова, хуки за доводкой._
- **Help/кодекс-хаб (ONB-4)** — существующий корпус кодекса стал **находимым**: чистый
  индекс `src/codexIndex.ts` (`buildCodexIndex(data)`→плоский `CodexEntry[]` по всем
  юнитам/зданиям + `GLOSSARY` из 7 терминов-статей: async, туман, upkeep, орбита/высадка,
  трассы, очки, коалиц-порог; `searchCodex` — матч по заголовку+тегам, пустой запрос → все,
  инъектируемый `textOf` для локали) — 9 юнит-тестов (`codexIndex.test.ts`: поиск по
  заголовку/тегу, регистронезависимость, пустой→категории, глоссарий, ранжирование). UI:
  оверлей `#codexhub` (z-45, под `#codex`) с поиском + категориями (Юниты/Здания/Механики),
  результат — deep-link в существующий `openCodex` (глоссарий рендерит новая ветвь
  `codexHtml('m')`); точки входа — хаб «Ещё → Справочник» + внутриматчевая рельс-кнопка «?».
  RU/EN, поиск бьёт по локализованному ярлыку (RU «туман» и EN «fog» оба находят). Чистое
  surfacing (низкий риск). Проверено вживую (headless-бут): хаб открывается, пустой запрос →
  категории, поиск находит юнит/здание/термин, тап результата открывает статью. _Per-panel
  контекстная «?» — за последующей доводкой; глобальный хаб + рельс-«?» дают «найти за 2 тапа»._
- **Первый запуск + воронка (ONB-0)** — признак «прошёл онбординг» отдельно от ника:
  чистая per-nick модель `src/onboarding.ts` (`OnboardState {started, stepReached,
  completed, skipped}`, fail-secure `parseOnboardState`, идемпотентные переходы,
  `welcomeMode` new/returning, `isOnboarded`) — 13 юнит-тестов (`onboarding.test.ts`:
  new/returning, идемпотентность completed, skip уважается, парсер не падает на битом
  значении). Хранится в `localStorage` (`vd.onboard.<ник>`, рядом с `vd.meta.<ник>`);
  при сервер-аккаунте (SE-1.x) переедет в профиль. main.ts: новичку — одноразовое
  предложение в хабе (`#onboard-nudge`, «Начать обучение»/«Пропустить»), «Ещё → Обучение»
  — реплей; «Начать» запускает ONB-2-гайд (см. ниже); тонкий воронка-хук пишет
  `stepReached`/исход через чистый `applyTourOutcome` (без PII, агрегаты — за OPS).
  Проверено вживую (headless-бут main.ts): предложение показывается новичку, «Пропустить»
  пишет флаг и прячет карточку, повторный визит не предлагает, признак per-nick.
- **Гайдовый первый матч (ONB-2)** ★ — главный онбординг-deliverable: `startGuidedMatch`
  поднимает **безопасную соло-песочницу без ботов** (`setupSlots` all-off → `startMatch`)
  и запускает над её живым HUD data-цепочку `src/firstMatchTour.ts` — весь цикл §2:
  добыча (`action:building.construct`) → флот (`action:fleet.launch`) → курс
  (`action:fleet.move`, туман) → двухфазный захват (`state`: игрок владеет миром сверх
  стартового) → счёт пошёл (`state`: счёт вырос) → «первая схватка выиграна». «Do X»-беты
  ждут **реального** приказа (через `playerOrder`→`notifyAction`), захват/счёт — по живому
  `s`; скипаемо на любом шаге. Успех (первое прохождение) → `onboarded`=completed +
  XP-пакет (`matchXp`, начисляется один раз) + нудж «сыграй настоящий матч». Скрипт
  запускается через шов `pendingGuide`, срабатывающий из `installMatch` (кадр на прорисовку
  HUD). Тесты: `firstMatchTour.test.ts` (форма цепи, захват gated на `state`, скипаемость)
  + `applyTourOutcome` (награда ровно раз) в `onboarding.test.ts`. Проверено вживую
  (headless-бут): «Начать обучение» ставит матч, гайд ведёт над HUD, action-шаг прячет
  «Далее» (нужен реальный приказ), «Пропустить» пишет `skipped`. _Тонкая доводка захвата
  (микрошаги орбита/десант/дивизия) — за ONB-3/последующими; беты цикла присутствуют и
  корректно гейтятся._ Побочно: у `action`/`state`-шагов подсветка best-effort (missing
  target → ждём, не скип/стоп; ONB-1-движок уточнён), а на них `.sl-dim` прозрачна —
  карта читается, игрок оперирует HUD.
- **Движок гайд-марок (ONB-1, spotlight)** — переиспользуемый онбординг-примитив
  (`src/spotlight.ts` — чистый, DOM-free стейт-машина + геометрия; `src/spotlightDom.ts`
  — браузерный адаптер; `src/onboardingTour.ts` — data-цепочка над реальным HUD).
  Затемняющий оверлей + подсветка узла (дыра из 4 dim-панелей по bounding-box, элемент
  виден/кликабелен сквозь щель) + пузырь-подсказка со счётчиком «шаг k из n», «Далее/
  Понятно» и «Пропустить обучение». Продвижение по `tap` / `action:<type>` (реальный
  приказ через `playerOrder` → `activeTour.notifyAction`) / `state`-предикату (пуллится
  на `refresh`). Устойчив к перерисовке панели (re-query по селектору каждый кадр);
  отсутствующий target → optional-скип или безопасный стоп (не крашится). z-50: поверх
  HUD, ниже критичных модалок; `tap`-шаги ловят клики (только «Далее» ведёт вперёд),
  `action`/`state`-шаги — click-through к живому HUD. Локаль RU/EN. Запуск — шов
  `window.__vdTour` (авто-предложение и «Ещё → Обучение» — за ONB-0/ONB-2, они строятся
  на этом движке). Тесты: `spotlight.test.ts` (19 — tap/action/state, скип, optional-скип
  vs safe-stop, счётчик, re-query-устойчивость, геометрия).
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

**CORP-0 (первый серверный кирпич мета-слоя)** — база корпораций из
`docs/corporations.md`: `CorpStore` (Memory + Postgres) с членством
`head|officer|member|recruit` (рекрут-строка = заявка), `CorpService` применяет матрицу
прав §2 fail-secure стабильными кодами (ровно один Глава, Главу не кикнуть, офицер не
эскалирует, передача главенства — явное действие Главы, уход Главы = передача или
роспуск в одиночку), REST `/corps` в `main.ts` session-gated + per-IP rate-limit на
записи + аудит-лог. Структурные инварианты на уровне стора: одна корпа на аккаунт (PK
по `account_id`), уникальное имя без регистра, атомарные `createCorp`/`swapHead` в
транзакции, аудит переживает роспуск. Контрактные тесты обоих адаптеров +
матрица прав + HTTP-контракт (memory + Postgres 16). Отложено (не спекулятивно):
гейт создания по уровню аккаунта (нужен серверный XP AC-0.3). Клиентский экран (§7 mock)
пока на локальных данных — проводка к `/corps` дальше.

**Медали / достижения (MED-1, corporations.md §3).** Каталог-ДАННЫЕ `data/medals.json`
(вне ядрового `GameData`-загрузчика: свой fail-secure парсер `medalCatalog.ts`,
`E_INVALID_MEDALS` на кривой форме — неизвестное условие никогда не читается как
«eligible»). Условия ОБЪЕКТИВНЫ и проверяются сервером из истории AvA
(`AvaResultStore.statsForCorp` — матчи корпы с любой стороны + победы), не самозаявкой
клиента. MVP — корп-медаль `scope:corp`+`grant:manual`: сервер помечает корпу eligible
по условию, глава/офицер вручает медаль члену своей корпы, сервер ПЕРЕПРОВЕРЯЕТ
eligibility на выдаче (`E_NOT_ELIGIBLE`), грант идемпотентен и перманентен (PK
`(account, medal)`, `MedalStore` memory+Postgres), аудит-запись `medal`. HTTP
session-gated: `GET /medals` (каталог) · `/medals/me` · `/medals/eligible` ·
`POST /medals/grant {target, medalId}`. Отложено (нужен пер-аккаунт леджер участия):
`scope:account`+`grant:auto` авто-достижения. `medalCatalog/medalService/medalApi`
+ стор-контракт `statsForCorp`/`MedalStore` (оба адаптера).

**AVA-2/3/4 (готовность + вызов/принятие AvA)** — серверный слой поверх CORP-0.
**AVA-2 очки влияния:** корп-валюта `influence` в `CorpStore` (`addInfluence`/
`spendInfluence` — списание атомарное с guard'ом `influence >= cost` внутри UPDATE,
`E_INSUFFICIENT`, никогда < 0; аудит `influence`); отдельно от внутриматчевой казны;
Memory + Postgres (`ALTER … IF NOT EXISTS`-backfill). **AVA-3 флаги готовности:**
корп-флаг (глава → пул готовых) + игровой флаг (член → согласие на офлайн-развёртывание,
привязан к текущей корпе — выход/кик/роспуск чистит его в той же транзакции); `GET
/ava/pool`; таблицы `corp_ready`/`player_ready`. **AVA-4 вызов/принятие (S0→S2):**
`AvaService` — глава готовой корпы тратит влияние и вызывает другую готовую (списание
ДО создания заявки, возврат при отказе создания); глава цели `accept` (→ `accepted` =
S2-матчап) или `decline` (возврат); истечение — `sweepExpired(now)` на инжектируемом
таймере (свип-интервал в `main.ts`, без подключённых клиентов). Инварианты в сторе:
одна `pending`-заявка на пару (partial unique index) + exactly-once `pending→terminal`
(условный UPDATE — гонка double-accept закрыта, без двойного возврата влияния). Всё
fail-secure стабильными кодами; REST `/ava/*` session-gated + per-IP rate-limit;
`AvaService`/HTTP/стор-контракт-тесты (memory + Postgres 16).
**AVA-6 ростер + лок (S3):** `accept` открывает окно паузы (`pause_ends_at`, деф. 24ч);
state-машина матчапа расширена `accepted` → `locked`/`cancelled` (exactly-once условным
UPDATE — лок необратим по построению). `AvaRosterStore` (Memory + Postgres `ava_roster`):
PK (matchup, account), пер-сайд кап охраняется атомарно (вставка сериализуется
`FOR UPDATE` на строке матчапа — гонка за последний слот не переполняет сторону).
`setRoster` — глава/офицер, replace-side целиком, ТОЛЬКО флагнутые (AVA-3), кап;
`join` — самозапись члена в окне (нефлагнутый тоже — явка и есть согласие),
идемпотентен; `rosterView` — свой состав + счётчики обеих сторон (чужой ростер
приватен до боя); `sweepRosters` — обе стороны ≥ minPerSide → `locked` (вход S4),
недобор → `cancelled` + возврат цены вызова ровно один раз; свип рядом с expiry в
`main.ts`. Коды `E_NOT_FLAGGED`/`E_ROSTER_FULL`/`E_ROSTER_LOCKED`/`E_WINDOW_CLOSED`; REST
`GET /ava/matchup/:id` + `POST …/roster` + `POST …/join`.
**AVA-7 оркестратор сессии (S4):** `AvaOrchestrator` из залоченного матчапа поднимает живую
AvA-сессию. Чистая `seatAvaRoster(map, rosterBySide)` кладёт каждую сторону на слоты своей
команды (сортированы — союзники сгруппированы), пустые кресла → серверный ИИ; `playerId =
slotId` (id аккаунта не течёт в state). `orchestrate(matchupId)` (идемпотентно): размер =
`max(сторона)` → `pickAvaMap` (seeded `ava:<matchupId>`) → `buildStateFromMap({slots,
crossTeamStart:'peace'})` (мир S5) → комната через инжектируемый `createRoom` (снапшот в
стор, ленивый реестр грузит на коннекте) → `AvaSessionStore.create`. `AvaSessionStore`
(Memory+Postgres `ava_sessions`, PK match_id + UNIQUE matchup_id): matchup↔match_id +
`seats` (account→slot), restart-safe. `resolveAvaSeat(matchId, accountId)` → фикс-место /
`E_NOT_ROSTERED` / `null` (не-AvA → обычный `resolveSeat`), встроен в `matchApi.join`. Свип
по `lockedMatchups` без сессии рядом с roster-свипом (мимо клиента). Коды
`E_NO_MATCHUP`/`E_NOT_LOCKED`/`E_NO_MAP`; загрузчик пула `loadAvaMaps()`. Отложено: снапшот
арсенала в лоадаут (мета-инвентарь), `capPerSide`=слоты карты.
**AVA-8 итог (S7) — самодостаточный срез:** state-машина матчапа продлена терминальным
`ended` (`locked` → `ended`, exactly-once условным UPDATE — тот же паттерн, что
`accepted`→`locked`); `AvaService.settleMatch(matchupId, winnerSide)` архивирует матчап,
пишет исход в `AvaResultStore` (Memory + Postgres `ava_results`, PK matchup — история
MM-3.1: кто с кем/победитель/время) и начисляет влияние победившей корпе (AVA-2
`addInfluence`, деф. `winReward`=150, инжектируемо) + аудит; выигрыш `locked→ended` —
exactly-once-гейт, повторный `match.ended` не начисляет дважды. Ничья (`winnerSide=null`)
— исход пишется, влияние нет. `matchHistory(limit)` — лента исходов newest-first
(фундамент под AVA-9/медали/рейтинг). Код `E_MATCHUP_CLOSED`. Server-driven (мимо гейта,
как свипы).
**AVA-8 S6 + проводка (кирпич закрыт — полный цикл S0→S7 собран):** `AvaSession.warAt`
(= создание + `peaceMs`, деф. 24ч / env `AVA_PEACE_MS`) + exactly-once штамп
`warDeclaredAt` (`markWarDeclared` условным UPDATE, очередь `dueWar`).
`AvaOrchestrator.sweepWar` на общем интервале: `registry.resolve` будит комнату,
`warDeclarationsFor(state)` — чистые системные декларации ровно по кросс-командным
peace-парам (детерминированные id `ava-war:<match>:<a>:<b>` — реплей батча дедупится
квитанциями; `E_SAME_STANCE` = пара уже провёрнута), транзиент-провал → ретрай
следующим свипом; матчап, рассчитанный до войны, вычищается из очереди без эскалации.
Игроки в AvA-комнате войну не объявляют: новая опция **`MatchRoom.denyPlayerActions`**
— wire-правило в `receive` (оба пути bare+gated; серверные драйверы через
`submitAction`/`submitServerAction` идут мимо), в AvA-комнате `diplomacy.declare` →
`E_AVA_DIPLOMACY`. Проводка S7: observe-`end` AvA-комнаты → `onMatchEnded` →
`winnerSideOf` (слот/`bot:`-слот → сторона тем же sorted-teams правилом, что рассадка;
неизвестный → null-ничья, fail-secure) → `settleMatch` (реплей `end` — no-op).
**AVA-9 публичная лента (блок AVA-1…9 закрыт):** `AvaFeedStore` (append-only,
Memory + Postgres `ava_feed`) — только публичные факты: имена корпораций (снапшот на
публикации) + победитель, БЕЗ ростера. Публикация в `AvaService`: `matchup` в конце
`accept` (S2), `result` в конце `settleMatch` (S7, exactly-once его `locked→ended`
гейтом) — последним шагом, best-effort (лента не валит закоммиченный переход).
Чтение `publicFeed(limit, before)` newest-first с курсором по `at`; публичный
`GET /ava/feed` (без сессии, `registerAvaFeed` рядом с open-matches feed;
`?limit` 1..50, `?before`). `corporation-wars.md`.

## 9. Статус

> Компактный агрегат; помашинная матрица — [`readiness.md`](readiness.md),
> запуск для живых игроков — [`launch-runbook.md`](launch-runbook.md).

**✅ Этап 1 (ядро) — готово целиком:** 24 модуля на микроядре (шина/хуки/манифест,
seeded RNG + golden, `advanceTo`): экономика + рынок, карта/движение/перехват, типы
секторов и планет, бой (мелэ + орбитальное ПВО/бомбардировка + артиллерия) с двухфазным
захватом, здания + станции, флот ⊕ армия + транспорт, технологии + учёные, фракции,
дипломатия (стойки + consent-офферы), шпионаж + контрразведка, герои, «Хранитель»,
победа/счёт, туман (`visibleState` + память + radar), движок эффектов (EFX-1:
`data.events` trigger→effect, трейты читаются генерически).

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

**✅ ONB-0 (онбординг — флаг первого запуска + воронка):** `prototype/src/onboarding.ts`
хранит `void.onboarded.<ник>` (started/stepReached/completed/skipped, fail-secure парсер,
как `meta.ts`); `openHub()` — единая точка входа (Новый командир/Вход по позывному/
соц-стабы/автовход) — ветвит new/returning и показывает разовый nudge к гайду только
брендново-новому нику, переживает reload. Сам гайд (spotlight-движок, гайдовый матч) —
ONB-1/ONB-2, следующие кирпичи (`docs/onboarding-roadmap.md`).

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
pnpm run check       # lint + typecheck + test + docs-check (гейт)
pnpm test            # vitest
pnpm run prototype   # собрать prototype/dist/void-dominion{,-player}.html
```

Тесты лежат рядом с кодом (`*.test.ts`) — и в пакетах, и в `prototype/src` (Vitest
их видит). Прототип исключён из ESLint/tsc-скоупа (свой esbuild), но это уже НЕ
throwaway — это играбельный клиент игроков. Разработка — на фиче-ветке, PR (draft).

Поверх юнитов — **property/fuzz-слой ядра** (fast-check, playtest-hardening FUZZ-1…4,
SD-7.3 ✅): test-only `shared-core/src/testkit/arbitraries.ts` (генераторы действий по
каталогу `actionPayloadSchemas` + fixture-вселенная) и три сьюта в гейте —
`applyAction.property.test.ts` (fail-secure на враждебном мусоре, чистота/детерминизм
frozen-vs-thawed), `advanceTo.property.test.ts` (спаны, партиционная инвариантность:
бит-в-бит на дискретном ядре, coarse ≈ fine на полном стеке, модуль-бомба),
`delta.property.test.ts` (`applyDelta∘diffState = id` + JSON-провод + идемпотентность).
Падение печатает seed — репро детерминирован.

## 11. Как возобновить работу

1. Прочитать корневой `CLAUDE.md` (инварианты + рабочие правила), затем этот файл
   и нужные `docs/`.
2. Своя фиче-ветка от `main`; перед коммитом — `pnpm run check`.
3. Новая механика = новый модуль (события + хуки) + возможно данные; ядро трогать
   не нужно. Этот снапшот обновлять после крупных изменений.
