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
`[docs]` `docs` · `[sec]` CI/сканеры (`.gitlab-ci.yml`, `docs/security`, конфиги сканеров)

## Статусы

✅ готово · ⏳ можно брать · 🔒 ждёт зависимость (в скобках — какую)

> **Фундамент готов** (не переделывать): микроядро/шина/хуки/манифест, RNG+golden,
> модель времени, экономика, карта+движение (incl. `fleet.stop`), секторы, бой
> (орбита/десант/захват/бомбардировка/ПВО), здания, флот⊕армия+транспорт, **типы
> планет**, **victory-модуль** (data-driven очки), **`visibleState`** (туман войны),
> каркас **action-layer**, multiplayer-slice, **F6 туман на рассылке**, играбельный прототип. 255 тестов зелёные.

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
  в схеме; `data/factions.json` наполнен 3 фракциями (vanguard/swarm/necromancer), все ссылки
  на юниты/постройки валидны. Тест `factions.test.ts` (4 кейса) + bundle-валидация.
- **B2** ✅ `factionModule`: пассивы фракции через хуки `economy.production`/`fleet.speed`/
  `combat.damage` (зеркало tech-effects); мягкая деградация без модуля. 5 тестов.
- **B3** ✅ `factionStart(data, faction)` — чистая детерминированная сборка старта из
  `startingLoadout` (казна/флот/гарнизон/постройки, hp из данных); 4 теста.
- **B4** ✅ `reanimationModule`: некромант (`raise_fallen`) на `unit.died` поднимает долю
  павших в живом флоте как `reanimated_drone` (детерминированно, бой сходится); 3 теста.

## Блок C · Ядро: древо технологий `[core]` `[data]`

> ✅ **Сведено и проверено** (ветка devin `session-tech-tree`, влита в рабочую линию,
> гейт зелёный — 217 тестов). Осталось только **C3** (предматчевый выбор/буст).

- **C1** ✅ Схема `TechnologyDef` + `data/technologies.json` (анлоки/бонусы/стоимость/время).
- **C2** ✅ `technologyModule` + действие `technology.research`, состояние анлоков (`Player.technologies`).
- **C3** ⏳ Предматчевый выбор (config) + стартовые бусты.
- **C4** ✅ Бонусы тех на хуках (производство/скорость/бой) + гейт постройки юнитов/зданий.

## Блок D · Ядро: дипломатия `[core]`

- **D1** ✅ Состояние дипломатии в `GameState`: `diplomacy?: Record<pairKey, DiplomaticStance>`
  (`war`/`peace`/`pact`/`alliance`, симметрично, публично — не режется туманом). Чистые
  примитивы `state/diplomacy.ts` (`pairKey`/`getStance`/`setStance`/`DEFAULT_STANCE='war'`,
  дефолт сохраняет текущее FFA: разные владельцы = враги без модуля). В `delta`-META; 10 тестов.
- **D2** 🔒(D1) `diplomacyModule`: действия объявления; провайдит capability `diplomacy`
  (`getRelation` уже потребляется `combat.isHostile`); маппинг stance→relation; тесты.

## Блок E · Слой действий (Этап 2) `[act]` _(начат devin)_

- **E1** ⏳ Зод-схемы на каждый тип действия (валидация входа по типу).
- **E2** ⏳ Стор receipts с интерфейсом под персистентность (вместо in-memory).
- **E3** 🔒(E1) Интеграционный тест: невалидное / повтор по тому же id / несанкц.
  действие → безопасный отказ с кодом.

## Блок F · Сервер (Этап 3) `[srv]` _(опирается на `[act]`)_

- **F1** ⏳ Скелет Fastify + health-роут.
- **F2** 🔒(F1) Postgres JSONB: load/save `GameState`.
- **F3** 🔒(F1) Redis/BullMQ: будилка по `scheduled`-событиям (флот прибудет через N ч).
- **F4** 🔒(F1) WebSocket-слой: пуш diff'ов.
- **F5** 🔒(F2) Очередь действий per-player (последовательная обработка → нет double-spend).
- **F6** ✅ Фильтр видимости **перед** отправкой клиенту: `MatchRoom` рассылает
  per-player дельты от `visibleState` (+ сигнатуры/память отдельными полями), события
  тоже фильтруются по видимости; e2e-тест «враг скрыт + нет утечки `red_1` по проводу».
  Дальше: AOI-оптимизация, JWT (F7).
- **F7** 🔒(F4) JWT в WS-handshake.

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

## Кросс-каттинг

- **PERF-1** ✅ **Сведено и проверено** (ветка devin `engine-optimization`, влита):
  горячий путь планировщика (`kernel.ts`: `scheduled` отсортирован → `earliestDue` O(1)
  + бинарная вставка), route-кэш в `movement`, оптимизации `combat`/`orbit`/`economy`.
  **Детерминизм сохранён** (golden-RNG + 217 тестов зелёные).

## Блок SEC · AppSec / DevSecOps `[sec]`

> Трек безопасности — живёт рядом с продуктовым и раздаётся как задачи. База —
> `.gitlab-ci.yml` + `docs/security/pipeline.md`. Один кирпич = один сканер/правило/шаг.
> Глубокие роадмапы (задачи/подзадачи): `secure-sdlc-roadmap.md` (как строим безопасно) и
> `secure-environment-roadmap.md` (как безопасно эксплуатируем) — SEC/F-бирки сшиты с ними.

- **SEC-0** ✅ Базовый GitLab-пайплайн: SAST (Semgrep) + SCA (pnpm audit + osv-scanner)
  + секреты (Gitleaks) + Trivy fs + SBOM (Syft), ratcheting-гейт.
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
