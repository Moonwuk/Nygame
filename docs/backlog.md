# Бэклог-кирпичики — как делим работу

> Гранулярные, назначаемые задачи. **1 кирпичик ≈ 1 PR ≈ 1 сессия Claude**, в
> пределах **одной зоны** (пакет / модуль / данные) — чтобы параллельная работа не
> конфликтовала. Регламент — `CONTRIBUTING.md`; высокоуровневый план —
> `roadmap.md` и `deep-technical-roadmap.md`; что уже готово — `state.md`.

## Как взять кирпичик

1. Возьми кирпичик со статусом ⏳ (не 🔒 — у того ещё не закрыты зависимости).
2. Застолби его (issue/доска), помечен зоной — чтобы не пересечься с напарником.
3. Ветка от `main` → код + тесты → **`pnpm run check`** зелёный → PR в `main`.
4. **Один кирпичик — одна зона.** Не бери два кирпича в одном файле одновременно.
5. Закрыл — отметь ✅ здесь и обнови `state.md` (в том же PR).

## Зоны

`[core]` `packages/shared-core/src/modules` (+ `data`) · `[act]` `action-layer` ·
`[srv]` `server` · `[cli]` `client` · `[proto]` `prototype` · `[data]` `data/*.json` ·
`[docs]` `docs` · `[sec]` CI/сканеры (`.github/workflows/security.yml`, `docs/security`, конфиги сканеров)

## Статусы

✅ готово · ⏳ можно брать · 🔒 ждёт зависимость (в скобках — какую)

> **Фундамент готов** (не переделывать): микроядро/шина/хуки/манифест, RNG+golden,
> модель времени, экономика, карта+движение (incl. `fleet.stop`), секторы, бой
> (орбита/десант/захват/бомбардировка/ПВО), здания, флот⊕армия+транспорт, **типы
> планет**, **victory-модуль** (data-driven очки), **`visibleState`** (туман войны),
> каркас **action-layer**, multiplayer-slice, **F6 туман на рассылке**, играбельный прототип.
> Тесты зелёные (актуальный счётчик — в шапке `state.md`).

---

## Блок A · Ядро: туман войны / видимость `[core]`

- **A1** ✅ Проекция `visibleState(state, viewerId, data)` — identify (1 прыжок) +
  radar-сигнатуры (`◆S/M/L` по `signature`), прячет чужое/расписание; 7 тестов incl.
  anti-leak по JSON; поля `signature`/`radarRange` в схеме. Прообраз в прототипе.
- **A1m** ✅ Память последнего увиденного (вариант B): `GameState.fog` (per-player
  снимки), `visibilityModule` обновляет на `time.advanced`/`planet.captured`/`fleet.arrived`;
  `visibleState` отдаёт серое «last known» (`remembered[]`) вместо unknown. 3 теста.
- **A2** 🚧 Радарная дальность от зданий: **радар-постройка с 3 уровнями** в `data/buildings.json`
  (`radarRange` 300→500→700), `radarRange` **уровневый** (`BuildingLevelSchema`). Радар ловит по
  **физическому расстоянию** (евклидово по `position`), а не по прыжкам графа — близкий в космосе
  узел виден, даже если недостижим по лейнам. Осталось: хук `vision.source`/`radar.source` (вклад
  тех/фракций в дальность) + сенсорная дальность зданий (не только радар).
- **A3** 🔒(A1) Разведка флотом (флот раскрывает узлы по маршруту/в орбите); тесты.
- **A4** 🔒(A1) Хелпер-запрос «видим ли объект X игроку P» + дефолт «видно всё» без модуля.

## Блок B · Ядро: фракции `[core]` `[data]`

- **B1** ✅ Расширить `FactionDef`: стартовый лоадаут (`startingLoadout`: ресурсы/флот/
  гарнизон/постройки) + `uniqueUnits` + `passives` (prod/speed/combat, зеркало tech-effects)
  в схеме; `data/factions.json` наполнен 2 фракциями (vanguard/swarm), все ссылки
  на юниты/постройки валидны. Тест `factions.test.ts` + bundle-валидация. _(necromancer вырезан — B4.)_
- **B2** ✅ `factionModule`: пассивы фракции через хуки `economy.production`/`fleet.speed`/
  `combat.damage` (зеркало tech-effects); мягкая деградация без модуля. 5 тестов.
- **B3** ✅ `factionStart(data, faction)` — чистая детерминированная сборка старта из
  `startingLoadout` (казна/флот/гарнизон/постройки, hp из данных); 4 теста.
- **B4** ❌ **вырезано:** `reanimationModule` (некромант `raise_fallen` поднимал павших как
  `reanimated_drone`) удалён вместе с фракцией necromancer — модуль, юнит, событие и тесты сняты.

## Блок C · Ядро: древо технологий `[core]` `[data]`

> ✅ **Сведено и проверено** (ветка devin `session-tech-tree`, влита в рабочую линию,
> гейт зелёный — 587 тестов). Осталось только **C3** (предматчевый выбор/буст).

- **C1** ✅ Схема `TechnologyDef` + `data/technologies.json` (анлоки/бонусы/стоимость/время).
- **C2** ✅ `technologyModule` + действие `technology.research`, состояние анлоков (`Player.technologies`).
- **C3** ⏳ Предматчевый выбор (config) + стартовые бусты.
- **C4** ✅ Бонусы тех на хуках (производство/скорость/бой) + гейт постройки юнитов/зданий.

## Блок D · Ядро: дипломатия `[core]`

- **D1** ✅ Состояние дипломатии в `GameState`: `diplomacy?: Record<pairKey, DiplomaticStance>`
  (`war`/`peace`/`pact`/`alliance`, симметрично, публично — не режется туманом). Чистые
  примитивы `state/diplomacy.ts` (`pairKey`/`getStance`/`setStance`/`DEFAULT_STANCE='war'`,
  дефолт сохраняет текущее FFA: разные владельцы = враги без модуля). В `delta`-META; 10 тестов.
- **D2** ✅ `diplomacyModule` (`modules/diplomacy.ts`): действие `diplomacy.declare
{target, stance}` — **эскалация унилатеральна** (только к войне по оси
  alliance→pact→peace→war; смягчение → `E_CONSENT_REQUIRED`, иначе жертва выключала бы
  чужой бой односторонним «миром»); событие `diplomacy.changed`. Провайдит capability
  `diplomacy` (`getRelation`, контракт в `state/diplomacy.ts`), которую `combat.isHostile`
  читает с фолбэком на прямой D1-стенс (мягкая деградация); маппинг `stanceToRelation`
  (war→hostile, peace/pact→neutral, alliance→ally). Схема payload'а в гейте; в
  `DEV_MODULES`. 8 тестов (вкл. e2e peace→declare→бой).
- **D3** ✅ Consent-протокол смягчения — то же действие `diplomacy.declare`, взаимно:
  первое дружественное объявление записывает **оффер** (`GameState.diplomacyOffers`,
  направленный `from>to`; станс не меняется, событие `diplomacy.offered`), встречное
  объявление того же станса **коммитит** пару (`diplomacy.changed`) и чистит офферы;
  любая эскалация аннулирует переговоры (инвариант: живой оффер всегда строго дружелюбнее
  текущего станса). Офферы **приватны паре** — `visibleState` вырезает чужие переговоры;
  в `delta`-META. Заменил D2-заглушку `E_CONSENT_REQUIRED`; `E_ALREADY_OFFERED` на повтор.
  9 тестов (модуль + примитивы + туман + дельта).
- **D4** ⏳ `[proto]` Миграция прототипа на ядровый `diplomacyModule` — сейчас существуют
  **две** реализации `diplomacy.declare` с разной семантикой: прототипная в `game.ts`
  (унилатеральная, вкл. односторонний «мир» — допустимо в песочнице с ботами) и ядровая
  (D2/D3, consent). Кернел запрещает два хендлера одного типа, поэтому: убрать
  прототипный модуль из `MODULES`, подключить ядровый; адаптировать UI меню дипломатии
  под офферы (входящие/исходящие «предложить мир/пакт/союз», индикация ожидания
  согласия); научить бот-дипломатию отвечать на офферы через favour-шкалу
  (`botFavour` ≥ порога → бот декларирует тот же станс = принятие; ниже → игнор);
  `newGame`-посев `peace` через `setStance` не меняется. Тесты бот-принятия.

- **E1** ✅ Зод-схемы на каждый тип действия (закрыт SV-1.2:
  `shared-core/actions/payloadSchemas.ts` инжектится в гейт как `payloadValidator`).
- **E2** ✅ Стор receipts с интерфейсом под персистентность (закрыт сервером:
  `ReceiptStore` в `store/` — in-memory + Postgres, durable receipts переживают рестарт).
- **E3** ✅ Интеграционный тест: невалидное / повтор по тому же id / несанкц.
  действие → безопасный отказ с кодом (абьюз-e2e зелёный, см. `state.md`).

## Блок F · Сервер (Этап 3) `[srv]` _(опирается на `[act]`)_

- **F1** ✅ Скелет Fastify + health-роут (SV-0.1: `/health`·`/ready`·`/metrics`, pino, drain).
- **F2** ✅ Postgres JSONB: load/save `GameState` + квитанции (`store/postgres.ts`),
  строгий commit-before-broadcast.
- **F3** ✅ (переопределён): будилка по `scheduled`-событиям — v1 без Redis/BullMQ
  (`clockDriver.ts`, in-process); durable-эволюция — **pg-boss** на мульти-процессе
  (решение в `tech-stack.md`).
- **F4** ✅ WebSocket-слой: пуш per-player дельт (`wsServer.ts` + `protocol.ts`).
- **F5** ✅ Последовательная обработка действий: per-room актор-mailbox на durable-пути
  (double-spend невозможен; per-player rate-limit сверху).
- **F6** ✅ Фильтр видимости **перед** отправкой клиенту: `MatchRoom` рассылает
  per-player дельты от `visibleState` (+ сигнатуры/память отдельными полями), события
  тоже фильтруются по видимости; e2e-тест «враг скрыт + нет утечки `red_1` по проводу».
  Дальше: AOI-оптимизация.
- **F7** ✅ JWT в WS-handshake (SE-0.1: join-токен в `?token=`, `auth.ts`, пин алгоритма,
  Origin-allowlist; opt-in через `AUTH_JWT_SECRET`).
- **F8** ✅ Persist + драйвер пробуждения в `packages/server/src/main.ts` (паритет с
  прото-сервером, который имел их с PA-4.1). `persistence.ts` (`createStores`: Memory по
  умолчанию, Postgres по `DATABASE_URL` + `migrate`; `snapshotOf`), `clockDriver.ts`
  (`msUntilNextEvent`→`tick`, cap `MAX_DELAY`), `main.ts` wired (observe→persist+receipt,
  rehydrate на старте, graceful shutdown). **Побочно — реальный баг-фикс:** `seq`
  сбрасывался в 0 при рестарте, из-за чего optimistic-by-seq store дропал пост-рестартные
  сохранения (`WHERE seq <= EXCLUDED.seq`), пока счётчик не догонит — добавлен
  `MatchRoom.initialSeq`, прокинут в **оба** сервера (`main.ts` и `netserver.ts`).
  5 тестов (`f8-persistence.test.ts`: persist/resume, seq-restore + guard, драйвер
  advance/idle). _Оговорка:_ save — после commit (fire-and-forget), не строгий
  commit-до-broadcast risk14 (тот — F2/SV-1.1). Детали — `infra-sizing-roadmap.md`.
  ⚠️ Открытый риск: overflow-клин (`E_ADVANCE_OVERFLOW`/`E_EVENT_OVERFLOW`,
  `kernel.ts:200,327`) — драйвер амортизирует, но не устраняет; алертить.

## Блок G · Клиент (Этап 4) `[cli]` _(параллелен серверу)_

> **Переориентировано на PWA-first веб-клиент** — детальные бирки CP0–CP7 в
> [`cross-platform-roadmap.md`](cross-platform-roadmap.md). Соответствие: G1→CP1,
> G2→CP4 (Pixi вместо Skia), G3→`@void/client`+CP1, G4→CP3. Бирки G1–G4 ниже —
> исходный (RN) вариант.

- **G1** ⏳ React Native оболочка + WS-подключение + graceful reconnect.
- **G2** 🔒(G1) Skia-рендер карты (зум / скролл / culling).
- **G3** 🔒(G1) Применение diff'ов от сервера к локальному состоянию.
- **G4** 🔒(G1) Превью через `shared-core` («если атакую — что будет?»).

## Блок H · Прототип / играбельность `[proto]`

- **H1** ✅ `victoryModule` подключён в кернел прототипа (`game.ts` MODULES — а значит и в
  `netserver`/плейтест); `checkEnd` читает авторитетный `state.match` (победа/поражение/ничья
  по domination/elimination/score/timeout) вместо хардкода `CRIMSON`/`HOME`. Баннер срабатывает
  в обоих режимах. _Заметка:_ domination считает долю от ВСЕХ узлов (вкл. некапчурные void) —
  на текущей карте реально только elimination; денонатор «только капчурные» — отдельный кирпич.
- **H2** ⏳ Индикация огня ПВО (визуально на карте).
- **H3** 🔒(B1) Предматчевый экран: выбор фракции / технологий.
- **H4** ⏳ Конструктор наземной армии (UI).

## Блок ECON · Ядро: внутриматчевая экономика `[core]` `[data]`

> Внутриматчевые ресурсы + биржа (≠ мета-экономика `economy-roadmap.md`: Суверены/Варранты).

- **ECON-1** ✅ Набор ресурсов → 5: `credits`(деньги)/`metal`/`food`/`energy`/`microelectronics`
  (`data/resources.json` + ремап ссылок biomass→food, dark_matter→energy; убраны
  artifacts/premium_shard). Гейт зелёный.
- **ECON-2** ✅ Сессионная биржа (`marketModule`, `GameState.market`): `market.list`
  (эскроу) / `market.buy` (за деньги, **15% комиссия сжигается**, частичная покупка) /
  `market.cancel` (возврат остатка). Публичный ордербук, в delta. 5 тестов.
- **ECON-3** ✅ Производители `energy`/`microelectronics` (здания): `power_plant` (Fusion
  Reactor, 3 ур.: energy 25→60→110) и `fabricator` (Microelectronics Fab, 3 ур.:
  microelectronics 8→18→32; стоит metal+credits+energy, гейт техом `microelectronics_fabrication`).
  Прописаны в ростеры `sectorKinds`; теперь у каждого экономического ресурса (кроме `credits`)
  есть производитель. Тесты: производство energy/micro экономикой + referential-integrity
  (любой `produces`/`cost`/`upkeep`-ресурс ∈ `resources`). Движок не тронут (агностичен). +3 теста.
- **ECON-4** 🔒(F4) UI биржи в клиенте/прототипе (листинг/покупка/отмена).

## Блок HERO · Ядро: герои `[core]` `[data]`

> Дизайн — [`heroes.md`](heroes.md). Принцип: **всё — данные, движок один**
> (`heroModule` интерпретирует JSON; экзотика — через `capability` `hero.effect.<type>`).
> Герой = корабль (переиспользует `movement`/`combat`). Скелет (HERO-0) уже есть.
>
> **Прим. (прототип-маршрут):** часть HERO-2/HERO-9 уже в проде через прототип, в обход
> data-first порядка: `GameState.heroes` **инстанс-ключёван** (`Hero.id`, фильтр по
> `owner`), у героя есть `grade`/`abilities`/`home`/`fleetId`, смерть приписывается **по
> `fleetId`**, респаун — в **столице** (`Hero.home`); пред-матч **ростер** до 4 героев
> (главный + 3 по редкости) с фитинг-UI. Остаётся data-first ядро (HERO-1/4/5) и
> развёртывание остальных героев ростера кораблями (`hero.spawn`, HERO-3). См. `state.md`.

- **HERO-0** ✅ Скелет: герой-позиция (`GameState.heroes`/`tempLanes`/`topology`),
  `heroModule` с `hero.move`/`hero.path.create`/`planet.annihilate`, `dead_world`,
  приватность в `visibleState`, кэш маршрутов по `topology`. 11 тестов (PR #31).
- **HERO-1** ⏳ `[data]` Схемы + `data/heroes.json` (архетипы), `data/heroAbilities.json`
  (тип-эффект/cooldown/range/params); загрузчик дополнен; `parseGameData` валидирует. Тесты схем.
- **HERO-2** 🔒(HERO-1) Движок: герой → **корабль** (`Hero.fleetId`, `traits:['hero']`),
  миграция `location`→флот, `on('fleet.destroyed')` → `hero.died` + `respawnAt`. Тесты.
- **HERO-3** 🔒(HERO-2) `hero.spawn {heroId, at}` — спавн на своём мире, кэп **3/игрок**,
  респаун-кулдаун. Коды `E_HERO_ALIVE/E_RESPAWN_COOLDOWN/E_HERO_CAP/...`. Тесты.
- **HERO-4** 🔒(HERO-1) Обобщённый `hero.ability {heroId, abilityId, target}` + диспетчер по
  `type` (+ `capability hero.effect.<type>`); `path.create`/`annihilate` → типы-эффекты в данных. Тесты.
- **HERO-5** 🔒(HERO-1) Пассивки из данных → хуки (`fleet.speed`/`combat.damage`) с `scope`
  (баф усиления флота). `data/heroPassives.json`. Тесты.
- **HERO-6** 🔒(HERO-2) Фитинги корабля: `data/heroFittings.json` + `hero.fit` (слоты,
  модификаторы статов / выдаёт способность). Тесты.
- **HERO-7** 🔒(HERO-4) Дерево навыков: `data/heroSkillTrees.json` (ветки **transhuman**/
  **psionic**) + `hero.skill.unlock` (валидация `requires`/ветки); бонусы к способностям/статам. Тесты.
- **HERO-8** 🔒(HERO-4) Способность спавна **на флоте / у союзника** (тип-эффект,
  ослабляет проверку `at` в `hero.spawn`; союзник — через будущую `MatchRoom.areAllied`/дипломатию D1). Тесты.
- **HERO-9** 🔒(HERO-3) Ростер: пред-матч выбор до 3 героев (config, как фракция/тех C3) +
  сборка старта. Тесты. _(зависит от open-question «ростер» в `heroes.md`)_

## Блок SHIP · Модульность кораблей `[proto]` `[core]` `[data]`

> Дизайн — GDD §6.1 («корабль собирается из модулей»). **ТОТ ЖЕ модульный движок, что
> у героев** — слоты + модули-данные (`statMods`/`grants`) → вклад в те же хуки
> (`combat.damage`/`fleet.speed`). Развилки зафиксированы из доков:
> **(а)** лоадаут на **КЛАСС/корпус**, не на инстанс (GDD §6.1 + сотни юнитов + прецедент
> `FormationTemplate`) — иначе взрыв JSON-стейта; **(б)** **заморожен на старте** матча
> (GDD §2 «дека модулей фиксируется при создании сессии») — лоадаут в `SetupConfig`, как
> `templates`/`heroes`; **(в)** **decoupled от мета-экономики** (предметы/заточка/аукцион
> EC-1..3) — это чистая внутриматчевая модель, как герои до сервера.
>
> **Этот блок — про МОДУЛИ корабля** (фиттинг в «Верфи», SHIP-1..6). **Эскадрильи /
> авианосцы / десант** (включая десантную эскадрилью-конверсию) — **отдельный канон:**
> [`squadrons-roadmap.md`](squadrons-roadmap.md) (SQ-блок; модель: общий трюм + вылет юнитом).
> Парные доки: `missiles-roadmap.md`, `shields-roadmap.md`, `command-chains-roadmap.md`, `mechanics-roadmap.md`.

- **SHIP-1** ✅ `[proto]` Модель: `prototype/src/ships.ts` — корпуса (`SHIP_HULLS`: cruiser 3 ·
  siege 2 · scout 1 · dropship 2), модули (`SHIP_MODULES`: батарея/броня/щит/двигатель/
  наведение, дробные `mods`, стэкаются), `shipStats(base, loadout)` (детерминированная
  деривация статов), `DEFAULT_SHIP_LOADOUTS`. 11 тестов. Модули пока `live:false` (превью).
- **SHIP-2** ✅ `[proto]` UI «Верфь»: вкладка в setup (как «Дивизии»/«Герои») —
  фиттинг модулей в слоты корпуса, **переиспользуя инвентарь-UI героев** (CSS вынесен
  в общий `.fitpane`); превью деривированных статов (derived (base)); модули стэкаются;
  лоадауты в `SetupConfig` (заморожены на старте). Браузер-проверено.
- **SHIP-3** 🔒(SHIP-2) `[core]` Эффекты: деривированные статы по лоадауту класса доходят
  до боя/постройки (через хук на эффективные статы юнита; `live:true`). Тесты.
- **SHIP-4** 🔒(SHIP-1) `[core]` Обобщить фиттинг-движок: один общий «слоты+модули»
  механизм для героев и кораблей (и при желании зданий), вместо двух параллельных. Тесты.
- **SHIP-5** 🔒(EC-1.1) `[srv]` Модули как **предметы мета-экономики** (data-driven схема,
  soulbound/заточка/аукцион) → снапшот лоадаута в матч (GDD §5.2). _(зависит от блока ECON)_
- **SHIP-6** 🔒(SHIP-1) Типизированные слоты (оружие/броня/двигатель/утилита) вместо
  любых — опциональное усложнение, если потребует баланс.
- **SHIP-7..11** → **перенесено в** [`squadrons-roadmap.md`](squadrons-roadmap.md) (канон,
  чтобы не дублировать): десантная эскадрилья-конверсия (`SQ-7`), эскадрильи-истребители +
  выпуск/возврат/топливо/патруль (`SQ-0..4`), носитель `dropship` ✅ (большой трюм / мало
  пушек), ПВО-counter (`aaDamage` штатно), бой с гарнизоном (`SQ-7.2`). Эти кирпичи едут там.

## Кросс-каттинг

- **PERF-1** ✅ **Сведено и проверено** (ветка devin `engine-optimization`, влита):
  горячий путь планировщика (`kernel.ts`: `scheduled` отсортирован → `earliestDue` O(1)
  - бинарная вставка), route-кэш в `movement`, оптимизации `combat`/`orbit`/`economy`.
    **Детерминизм сохранён** (golden-RNG + 587 тестов зелёные).

## Блок SEC · AppSec / DevSecOps `[sec]`

> Трек безопасности — живёт рядом с продуктовым и раздаётся как задачи. База —
> `.github/workflows/security.yml` + `docs/security/pipeline.md`. Один кирпич = один сканер/правило/шаг.
> Глубокие роадмапы (задачи/подзадачи): `secure-sdlc-roadmap.md` (как строим безопасно) и
> `secure-environment-roadmap.md` (как безопасно эксплуатируем) — SEC/F-бирки сшиты с ними.

- **SEC-0** ✅ Базовый DevSecOps-пайплайн: SAST (Semgrep) + SCA (pnpm audit + osv-scanner)
  - секреты (Gitleaks) + Trivy fs + SBOM (Syft), ratcheting-гейт. Сейчас живёт в GitHub
    Actions (`security.yml`; мигрирован с GitLab — `docs/security/audit-2026-06-27.md`).
- **SEC-1** ⏳ Триаж + baseline: разобрать находки, подавить ложные **с обоснованием**
  (`.semgrepignore` / `.gitleaks.toml` / `.trivyignore`), разобранные сканеры → блокирующие.
- **SEC-2** ⏳ Кастомные Semgrep-правила под инварианты ядра: запрет `Math.random`/
  `Date.now` и Node-built-ins в `shared-core/src` (детерминизм/чистота как security-граница).
- **SEC-3** ⏳ Безопасность самого пайплайна: пин образов сканеров по `sha256`,
  masked+protected CI-переменные, least-privilege токены.
- **SEC-4** ⏳ Агрегация находок: SARIF → DefectDojo / GitHub Code Scanning (единая панель, трекинг).
- **SEC-5** 🔒(F1, Docker сервера) Container scanning: `trivy image` на образ сервера + пин базового образа.
- **SEC-6** 🔒(F1+ запущенный сервер) DAST: ZAP baseline против `packages/server` (раскомментировать `dast-zap`).
- **SEC-7** 🔒(SEC-5) Supply-chain integrity (A08): подпись образов `cosign` + provenance **SLSA** + проверка на деплое.
- **SEC-8** 🔒(Этап 7) Полный проход **OWASP Top 10 2021** по чек-листу + threat model.

---

> Документ живой: добавляйте и дробите кирпичики обычным PR'ом.
