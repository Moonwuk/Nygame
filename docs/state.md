# Состояние проекта — снапшот

> Живой «якорь контекста»: что готово, как работает, что дальше. Обновляется по
> мере разработки (после крупных изменений). Парные документы: `architecture.md`,
> `modulesystem.md`, `gdd.md`, `roadmap.md`, `metagame.md`, корневой `CLAUDE.md`.
>
> **Ветка:** `claude/awesome-bohr-ygnunp` · **PR #1** (draft).
> **Гейт:** `pnpm run check` (lint + typecheck + test). **Тесты: 127 зелёных.**

---

## 1. Что это

Void Dominion — мобильная/браузерная **real-time** (непрерывное wall-clock время,
24/7, асинхронная игра) 4X космо-стратегия в духе Bytro (Iron Order). Ставка —
**гибкое, расширяемое ядро**: новые механики/юниты/фракции добавляются **данными
и модулями**, не переписыванием логики.

Монорепо (pnpm workspaces):

- `packages/shared-core` — детерминированная, data-driven симуляция (**здесь вся
  работа сейчас**). Без сервера/БД/сети.
- `packages/server` — авторитетный сервер (Этап 3). Плейсхолдер.
- `packages/client` — React Native клиент (Этап 4). Плейсхолдер.
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
  kernel/        kernel.ts (createKernel/applyAction/advanceTo, шина/хуки/расписание), module.ts (контракт)
  state/         gameState.ts (типы GameState), orbit.ts (isBombarded)
  action/        types.ts (Action, Context, MatchConfig.timeScale/victory, ApplyResult/AdvanceResult, Rejection, timeScaleOf)
  data/          schemas.ts (zod-схемы + parseGameData, buildingLevel/buildingMaxLevel)
  rng/           rng.ts (sfc32)
  util/          clone.ts (deepClone/deepFreeze)
  modules/       economy, movement, sector, planetType, combat, construction, army, victory  (+ *.test.ts)
  examples/      skirmish.test.ts (демо-сценарий + SVG)
  index.ts       баррель (экспорт публичного API)
data/            manifest, resources, units, buildings, factions, events, sectors (.json)
docs/            architecture, modulesystem, roadmap, engineering-risks, gdd, metagame, state(этот)
prototype/       src/game.ts, src/main.ts (UI), src/smoke.ts, build.mjs, uitest.mjs, dist/ (артефакт, в .gitignore)
```

## 4. Модель состояния (`GameState`)

- `version {data, manifest}`, `time`, `rng`.
- `players: Record<id, Player>` — `Player.resources: ResourceBag` = **казна
  игрока** (производство копится сюда, содержание/стоимости списываются).
- `planets: Record<id, Planet>` — `owner|null`, `position{x,y}`, `links?`
  (лейны графа), `sectorType?`, `resources`, **`buildings: BuildingInstance[]`**
  (`{type, level, hp}`), `garrison: UnitStack[]` (наземная армия мира), `traits`.
- `fleets: Record<id, Fleet>` — `owner`, `location|null`, `movement|null`,
  `units: UnitStack[]` (корабли), **`landing?: UnitStack[]`** (перевозимая
  наземная армия = десант), **`orbit?: 'near'|'far'`**, **`bombarding?: boolean`**,
  `battleId?`.
- `battles: Record<id, Battle>` — `location`, `phase:'orbital'|'ground'`,
  `attacker/defender {ref: CombatantRef, owner}`, `round`. `CombatantRef` =
  `fleet` | `landing` | `garrison`.
- `scheduled: ScheduledEvent[]` `{id, at, type, payload, seq}`, счётчики
  `battleSeq`, `scheduleSeq`.
- `UnitStack {unit, count, hp?}` (поле `hp` — пул HP стека во время боя).

**Время:** все длительности — через `schedule(at,…)`; `timeScale` (MatchConfig)
делит реальные длительности (×1/×2/×4). `time.advanced` спаны дают накопление.

## 5. Модули ядра (что делают)

Порядок в кернелах обычно: `sector, planet-type, economy, movement, combat, construction, army`.

### economy (`economy`)

На `time.advanced`: **производство** каждого своего мира → казну владельца
(хук `economy.production`, масштаб по часам×timeScale); **содержание** юнитов/
гарнизонов — суточный дрейн из казны (clamp ≥0). **Бомбардируемый мир не
производит** (`isBombarded`). Действий нет.

### movement (`movement`)

Действие **`fleet.move {fleetId, to}`** — маршрут Дейкстрой по лейнам, многохоп,
планирует `fleet.arrival`; на узле эмитит `fleet.transit` (промежуточный) или
`fleet.arrived` (финал). Хук `fleet.speed` (скорость = по медленному кораблю).
Коды: `E_BAD_PAYLOAD, E_NO_FLEET, E_FORBIDDEN, E_FLEET_BUSY, E_SAME_LOCATION,
E_NO_DESTINATION, E_NO_ROUTE, E_FLEET_IMMOBILE`.

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

### combat (`combat`) — бой, орбиты, ПВО, бомбардировка

- На `fleet.arrived`/`fleet.transit`: фл­от встаёт на **far** орбиту;
  `engageFleets` авто-завязывает **орбитальный бой флот-vs-флот** при встрече
  враждебных флотов (прибытие само по себе **не** захватывает).
- `combat.tick` — почасовые раунды: атакующая сторона бьёт `attack`, стоящий
  защитник — `defense` (ответный огонь). Линии `front/mid/rear/artillery`, пул
  HP стека с переносом, `unit.died`. Урон через хук **`combat.damage`** (args:
  battleId, phase, location, attacker, defender). Исход → `battle.resolved`.
- Действие **`fleet.orbit {orbit:'near'|'far'}`** — смена орбиты (far гасит
  бомбардировку).
- Действие **`fleet.assault`** — с **near**: штурм гарнизона десантом (`landing`)
  или оккупация необоронённого враждебного мира. Победа десанта → `capturePlanet`
  (десант становится гарнизоном, `planet.captured`). Коды: `E_WRONG_ORBIT,
E_ORBIT_CONTESTED, E_NO_TROOPS, E_OWN_PLANET, E_NO_PLANET, E_FLEET_BUSY,…`.
- Действие **`fleet.bombard {on}`** — тумблер бомбардировки (near, враждебный
  мир, есть корабли; `E_NO_SHIPS`).
- На `time.advanced` — **орбитальный тик** (`runOrbital`): (а) **ПВО** —
  гарнизонный `aaDamage` бьёт по враждебному флоту на **near** орбите, **если
  нет наземного штурма** (иначе ПВО просто обороняет гарнизон как наземный
  юнит); до **far** не достаёт; обнулённый флот уничтожается. (б)
  **Бомбардировка** — каждый бомбящий флот эмитит `planet.bombarded
{planetId, power, owner}` (`power = Σ attack × 0.5 × часы`).

### construction (`construction`) — здания + наземная стройка

- Действия **`building.construct`**, **`building.upgrade`**, **`unit.build
{count}`** — оплата вперёд из казны, отложенное завершение через
  `construction.complete` (`buildTimeHours`×timeScale). Одно здание каждого типа
  на планету; юниты идут в гарнизон. Коды: `E_BAD_PAYLOAD, E_NO_PLANET,
E_FORBIDDEN, E_UNKNOWN_BUILDING/UNIT, E_ALREADY_BUILT, E_NO_BUILDING,
E_MAX_LEVEL, E_INSUFFICIENT, E_BOMBARDED`.
- На `construction.complete`: добавляет здание/уровень/юнитов **если ещё владеешь
  планетой** (иначе вложение сгорает); **под бомбардировкой — пауза** (re-defer).
- Хук `combat.damage`: **бонус обороны гарнизона** = сумма `defenseBonus`
  зданий (наземная фаза). На `combat.round` (наземный штурм) и на
  `planet.bombarded` — **износ/разрушение зданий** (`building.destroyed`).
- События: `construction.started, building.constructed/upgraded/destroyed,
unit.built`.

### army (`army`) — разделение флота и наземной армии + транспорт

Действия **`army.load`** / **`army.unload {fleetId, unit, count}`** — перекладка
наземных юнитов между гарнизоном и трюмом флота, в пределах **вместимости**
(`Σ cargoCapacity` кораблей; груз занимает `cargoSize`). Корабли (`domain:space`)
возить нельзя. Коды: `E_NO_CAPACITY, E_NO_ARMY, E_NOT_GROUND, E_FLEET_BUSY,
E_FORBIDDEN, E_NO_PLANET, E_UNKNOWN_UNIT, E_BAD_PAYLOAD`. События `army.loaded/
unloaded`.

**Общий запрос:** `isBombarded(state, planetId)` (`state/orbit.ts`) — есть ли
враждебный бомбящий флот на near; используют economy и construction.

### victory (`victory`) — победа и счёт

`victoryModule` слушает `time.advanced`, `planet.captured`, `fleet.destroyed`,
`battle.resolved`, `unit.built`; пересчитывает `GameState.match.scores` и завершает
матч событием `match.ended`. Условия: доминирование по доле планет (по умолчанию
60%, настраивается `MatchConfig.victory.dominationPercent`), уничтожение соперников,
лимит счёта (`scoreLimit`) и тайм-аут (`endsAt`, победитель = лучший счёт; ничья =
`winner:null`).

## 6. Данные (`data/*.json`, версия `0.1.0`)

- **resources:** `credits, metal, biomass, dark_matter, artifacts, premium_shard`.
- **units** (схема `UnitDef`): `domain('space'|'ground')`, `stats{attack, defense,
speed, hp, range, cargoCapacity, cargoSize, aaDamage}` (+ любые доп. числа),
  `line, traits, abilities, cost, buildTimeHours, upkeep`. Есть: `scout_drone,
cruiser, siege_lance(artillery,range), dropship(cargoCapacity 12), militia,
drop_infantry, tank(cargoSize 3), orbital_aa(aaDamage), infected_cruiser,
reanimated_drone`.
- **buildings** (`BuildingDef`): `cost, buildTimeHours, produces, hp,
defenseBonus, upgrades[{…}], traits`. Есть: `mine_t1, mine_t2, shipyard,
biomass_pit, barracks, spaceport, fort` (форт — 3 уровня: HP 35→50→65,
  defenseBonus 0.35→0.50→0.65).
- **sectors:** `empty_space(+скорость), asteroid_field(−скорость/+живучесть),
nebula`.
- **factions:** `vanguard, swarm, necromancer` (пока флейвор/трейты).
- **events:** `reanimate_on_kill, infect_planet, void_anomaly` (правила
  trigger→effect; движок трейтов пока не построен).

## 7. Прототип (`prototype/`)

`pnpm run prototype` → esbuild собирает всё (ядро + zod + UI) в один
self-contained `dist/void-dominion.html` (открывается с диска, без сервера).

- **Реальное ядро** в браузере: `createKernel([sector, planet-type, economy, movement,
combat, construction, army, fleetLaunch])`, тик в реальном времени (скорость ⏸/▶/⏩).
  Миры размечены типами (terran/barren/oceanic/volcanic/gas_giant) — карточка планеты
  показывает тип и его бонусы (prod/def), `netIncome` учитывает множитель производства.
- **Прототип-модуль `fleet.launch {planetId}`** (`game.ts`, не в ядре) — поднимает
  флот из гарнизона (корабли→`units`, наземные→`landing`). Кандидат в ядро.
- **UI — тактический пульт (DEFCON-вайб):** векторно-каркасный стиль на чёрном.
  - **Карта = радарный планшет:** панорамируемая координатная сетка (двигается/
    масштабируется с камерой), редкие звёзды-тики, слабый радарный «sweep», лёгкие
    скан-линии (CSS). **Планеты — wireframe-кольца** с неоновым свечением (glow),
    ядро-точка, крестовые тики-блипы, пунктирное кольцо «сенсорной дальности», форт =
    гекс-контур; выделение — вращающиеся target-скобки. **Флоты — светящиеся
    chevron-ы** по курсу со «следом» из затухающих точек. Бой — пульсирующее красное
    кольцо.
  - **HUD минималистичный, моноширинный, неоновые тонкие линии:** верхняя планка
    (callsign-ромб, читалки ресурсов `MTL/CRD/WLD/FLT` с `+N/h` из `netIncome`,
    индикатор угрозы **DEFCON 5→1** по числу боёв), левая рейка-иконки, нижняя
    карточка-досье в рамке, терминальный лог `>`. Палитра: cyan (свои) / red (враг) /
    фосфорный зелёный (chrome) на near-black.
  - **Камера pan/zoom** (тащить / колесо / pinch / двойной тап-сброс); **адаптив**
    (мобайл/десктоп, media-queries, DPR-чёткость, тач). `netIncome` считает прирост.
- **Орбитальные контролы игрока в панели флота** (выводят механику ядра, а не
  стопгап): спуск/подъём орбиты (`fleet.orbit` near/far), переключатель
  **бомбардировки** (`fleet.bombard`), ручной **штурм** (`fleet.assault`), и
  **погрузка/высадка наземной армии** между гарнизоном своей планеты и трюмом флота
  (`army.load`/`army.unload`). Ошибочные приказы кратко логируются (`✖ code`).
- **Стопгап (сужен):** авто-спуск+штурм (`autoEngage`) остался **только для ИИ**
  (вражеские флоты), чтобы давление сохранялось; флоты игрока теперь полностью
  ручные. `fleet.launch` — пока прототип-модуль.
- Валидаторы: `src/smoke.ts` (Node-сценарий ядра) и `uitest.mjs` (headless-DOM
  прогон UI-бандла).

## 8. Метаигра (north-star)

Два контура: обычные сессии (малая карта) + AvA-битвы за сектора мета-галактики
(корпорации, очки влияния, мета-шпионаж). Зафиксировано в **`docs/metagame.md`**.
Ключ: сессионное ядро — движок обоих контуров; мета-слой — сервер (Этап 3+).
Сейчас **не строим**.

## 9. Статус

**✅ Готово (Этап 1, ядро):** микроядро/шина/хуки/манифест; seeded RNG +
golden; модель времени `advanceTo`; экономика (казна + содержание); карта
(лейны + Дейкстра) и движение; **типы секторов** и **типы планет** (производство/
оборона через хуки, data-driven); бой (раунды, линии, attack/defense); **двухфазный
захват орбита→десант**; **орбиты near/far + ручной штурм + бомбардировка (заморозка
производства) + орбитальное ПВО**; **здания** (инстансы, уровни/апгрейд, HP, бонус
обороны, разрушение); **разделение флота и наземной армии + транспорт (load/unload)**;
**победа и счёт** (`victoryModule`: domination/elimination/score/timeout, `match.ended`);
играбельный прототип с тактическим векторно-радарным UI + ручными орбитальными
контролами и типами планет.

**⏳ Дальше — план эволюции ядра** (каждый этап = модуль + data, kernel не трогаем):

1. ✅**Победа и счёт** (`victoryModule`) — сделано: scoreboard + `match.ended` по
   доминированию, уничтожению соперников, лимиту счёта и тайм-ауту.
2. **Туман войны** (`visibilityModule` + проекция `visibleState`) — видимость по
   сенсорам/разведке; готовит редактирование состояния на сервере.
3. ✅ **Типы планет** — сделано (этот заход).
4. **Фракции** — стартовые лоадауты + уникальные юниты/пассивы (зависят от типов планет).
5. **Древо технологий** — предматчевый выбор + внутриматчевые разблоки/бонусы.
6. Опц. **движок трейтов** (если фракции/тех дадут дублирование); **дипломатия**
   (война/мир/альянс — мост к мете).
7. Затем **UI-стадия**, **Этап 2** (action-layer/персистентность), **Этап 3**
   (сервер + мета-галактика), **Этап 4** (RN-клиент).

**⚠️ Известные стопгапы/долги:**

- Прототип: орбитальные контролы (near/far, bombard, assault, load/unload) теперь в
  UI игрока; `autoEngage` остался только для ИИ; ПВО считается в ядре, но отдельной
  индикации в UI пока нет; `fleet.launch` — пока прототип-модуль.
- Бой: оккупация необоронённого мира оставляет десант на борту (мир без гарнизона);
  флот-только-десант (без кораблей) выигрывает наземный бой, но **не захватывает**
  (releaseOrDestroyFleet удаляет пустой флот раньше capturePlanet) — редкий кейс.
- Стройка: два одинаковых заказа до завершения спишут ресурсы дважды (идемпотентность
  — зона Этапа 2 action-layer).
- Один предсуществующий ESLint-warning в `skirmish.test.ts` (лишний `eslint-disable
no-console`), не падает гейт.

## 10. Команды и качество

```bash
pnpm install
pnpm run check       # lint + typecheck + test (гейт; 127 тестов)
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
