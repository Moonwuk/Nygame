# Закалка плейтест-контура — технический roadmap

> Заказ владельца (2026-07-18): четыре кирпича инфраструктурной зрелости — **TLS+домен**,
> **автодеплой**, **реплей-детерминизм в CI**, **fuzz/property-тесты ядра**. Этот док —
> исполняемый план: он **операционализирует** уже спроектированные кирпичи из
> `https-roadmap.md` (HTTPS-2.1 и остатки 1.1/4.2), `operations-roadmap.md` (подступ к
> OPS-1.1), `core-roadmap.md` (CR-0.2-лайт), `persistence-roadmap.md` (PE-1.1 — явно
> ОТЛОЖЕН), `secure-sdlc-roadmap.md` (SD-7.2 частично, SD-7.3 целиком) — не дублирует их,
> а связывает в последовательность. Все факты «текущего состояния» сверены с кодом
> (разведка 2026-07-18, файлы:строки). Формат — кирпичики: один кирпич ≈ один PR ≈ одна
> сессия. Зоны: `[ops]`·`[proto]`·`[srv]`·`[core]`.

---

## 0. Текущее состояние (сверено с кодом)

**TLS:** нигде не терминируется. `deploy/docker-compose.yml` выставляет голый
`8788:8788` (HTTP+WS); `deploy/setup-proxy.sh` — nginx на порту 95367 **plain HTTP**
(WebSocket Upgrade и `X-Forwarded-Proto` уже прописаны, HTTPS — закомментированная
заглушка); конфиги оперируют голым IP — домена нет. При этом ядро сервера к прокси
**почти готово**: `TRUST_PROXY` → Fastify trustProxy (`main.ts:297`), Origin-allowlist
на WS-upgrade (`wsServer.ts:195`), cookies не используются (ломаться нечему), клиент
уже авто-апгрейдит `ws://`→`wss://` на https-странице. Дыра: Docker-образ запускает
`prototype/netserver.mjs`, а тот **не проводит** `allowedOrigins`/`trustProxy` в
`createMultiplayerServer` (`netserver.ts:511-528`) — env-переменные в compose сейчас
ничего не включают.

**Деплой:** образ собирается на сервере (`build:` в compose), в registry не пушится
нигде (CI собирает только для trivy-скана и выбрасывает). Обновление — руками по SSH,
причём сгенерированный `update-dev.sh` **сломан для Docker**: `stop → git pull → start`
без `--build` перезапускает старый образ. `install-ubuntu.sh` клонирует не тот репозиторий
(`moongame.git`) и хардкодит IP владельца. Прецедент автодоставки уже есть: `android.yml`
на каждый push в main публикует APK в rolling-prerelease.

**Реплей:** ядро реплеябельно по построению (sfc32-RNG живёт в `GameState.rng`,
`applyAction`/`advanceTo` — чистые, `hashState()` с golden-тестом уже есть,
`emitStateHash`+desync-репорт в MatchRoom уже есть). Нет самого реплея: ни формата, ни
рекордера, ни раннера; квитанции хранятся **без** type/payload/времени, снапшот
перезаписывается — последовательность действий из стора не восстановить. Багхант
2026-07-10 уже ловил реальные классы реплей-дивергенций (BF-13 JSONB-пересортировка,
BF-22 coarse/fine-шаги) — точечными фиксами, без системного теста.

**Fuzz:** fast-check не установлен. Инварианты (немутация входа, детерминизм,
сериализуемость, непрерывность спанов) покрыты только **примерами**, не свойствами.
Готовая «вселенная» для генератора есть: `actionPayloadSchemas` (~45 типов действий),
`deepFreeze`, `buildStateFromMap`, фикстура `examples/skirmish.test.ts`.

---

## Блок A · TLS + домен `[ops]` `[proto]` `[srv]`

> Реализация [HTTPS-2.1](https-roadmap.md) + остатков HTTPS-1.1/4.2. Паттерн
> зафиксирован там же: TLS терминирует прокси, Node слушает plain на loopback.

- **TLS-1 · Домен + проверка портов** `[ops]` — S · **решение владельца**.
  Купить/назначить домен, A-запись на сервер; проверить, что 80/443 доступны снаружи.
  ⚠️ Нестандартный порт 95367 в текущих конфигах намекает на проброс/CGNAT — если 80/443
  закрыты у провайдера, ACME HTTP-01 не пройдёт; запасной путь: свой домен через
  Cloudflare + cloudflared-туннель (wss уже работает по HTTPS-3.2).
  **Готово:** `ping домен` → IP сервера; 80/443 отвечают.
- **TLS-2 · Провести защиту в прототипный хост** `[proto]` — S · ✅ (2026-07-21).
  `netserver.ts`: `allowedOrigins` и `trustProxy` (env `TRUST_PROXY=1`) прокинуты в
  `createMultiplayerServer` + CSWSH-warning как в `main.ts`. Живая проверка на
  собранном хосте с `ALLOWED_ORIGINS`: чужой Origin → 403, отсутствующий → 403,
  разрешённый → 101.
- **TLS-3 · Caddy в compose** `[ops]` — M · 🔒(TLS-1, TLS-2).
  Новый `deploy/Caddyfile` (`<домен> { reverse_proxy server:8788 }` — авто-ACME и
  WebSocket из коробки, логирование query-строки отключить — `?token=`/`?ticket=` не
  должны течь в логи); compose: сервис caddy (80/443 + volume сертификатов), server-порт
  → `127.0.0.1:8788:8788`, env `TRUST_PROXY=1` и `ALLOWED_ORIGINS=https://<домен>,
  http://localhost` (⚠️ Origin Capacitor-webview проверить на живом APK ДО включения —
  allowlist отклоняет и отсутствующий Origin, иначе APK-игроки молча получат 403).
  `install-ubuntu.sh` не трогать (возможно, стоит на живом сервере) — чинится в ADEP-0.
  **Готово:** `wss://<домен>/matches/proto` работает из браузера и APK.
- **TLS-4 · Reject non-https за прокси + печать wss** `[srv]` `[proto]` — S · 🔒(TLS-3).
  `wsServer.ts`: при `trustProxy` и `x-forwarded-proto !== 'https'` → rejectUpgrade
  (+ тест); netserver за прокси печатает `https/wss`-URL как основной.
  **Готово:** тест зелёный; в консоли хоста — wss-ссылка.
- **TLS-5 · Приёмка + доки** `[ops]` — S · 🔒(TLS-3).
  testssl/SSL Labs ≥ A, ноль mixed-content, 8788 снаружи закрыт; статусы ✅ в
  `https-roadmap.md` (там же поправить устаревшие строки netserver), `launch-runbook.md`.
  HTTPS-5.1 (release-APK без cleartext) — отдельный следующий кирпич после стабильного wss.

⚠️ TLS ≠ авторизация: на публичном плейтесте связка с `AUTH_JWT_SECRET`+`SEAT_LOCK=1`
(уже дефолт compose) обязательна — прописано в `https-roadmap.md`.

## Блок B · Автодеплой `[ops]` `[sec]`

> **Решение: GHCR-push из CI + pull-таймер на сервере.** Отсев альтернатив: ssh-action —
> сервер за домашним NAT, пришлось бы открывать SSH в интернет с ключом в GitHub;
> webhook — то же + новая attack-surface, а distroless-контейнер без shell не пересоберёт
> себя; watchtower — монтирует docker.sock в сторонний привилегированный контейнер,
> против hardening-постуры (SE-5). Pull-таймер — outbound-only (работает за NAT),
> ~30 строк bash. GHCR вместо build-on-server — деплоится ровно тот образ, что прошёл
> гейт и trivy-scan.

- **ADEP-0 · Починить текущий update-путь** `[ops]` — S · ✅ (2026-07-21).
  `install-ubuntu.sh`: генерируемый `update-dev.sh` теперь `pull → docker compose
  build → restart` (пересборка при живом сервере — минимум даунтайма; раньше
  `moongame update` перезапускал СТАРЫЙ образ); `REPO_URL` — каноничный
  `Moonwuk/MoonGame.git` и переопределяем окружением (старый lowercase-URL работал
  через регистронезависимость GitHub — гигиена, не поломка); IP/порты — env-переменные
  с автоопределением INTERNAL_IP; генерируемый `server.env` — релизная постура
  `GATE=1, SEAT_LOCK=1` (как в compose). README-тексты про «10–15 сек без
  пересборки» заменены честными. ⚠️ На уже установленном сервере владельца новый
  `update-dev.sh` появится после однократного ручного `git pull` + пересоздания
  скрипта (или пере-прогона установщика) — сам себя он не обновит.
- **ADEP-1 · CI публикует образ в GHCR** `[sec]` — M.
  Новый `.github/workflows/deploy.yml`: push в main → build → push
  `ghcr.io/moonwuk/nygame-server:latest` + `:<sha>`; логин через `GITHUB_TOKEN`
  (`permissions: packages: write` — без долгоживущих секретов, в духе SD-6.2), экшены
  SHA-пинить (SD-6.1). ⚠️ Пакет — **приватный**: образ содержит весь исходник
  (`COPY . .`), публикация пакета = публикация кода приватного репо.
  **Готово:** пакет в GHCR обновляется на каждый push в main.
- **ADEP-2 · Compose переходит на `image:`** `[ops]` — S · 🔒(ADEP-1).
  `image: ghcr.io/...:latest` в сервисе server, `build:` остаётся fallback'ом;
  `server.env.example` — место под read-only PAT (`read:packages`).
  **Готово:** `docker compose pull server` тянет свежий образ.
- **ADEP-3 · Pull-таймер на сервере** `[ops]` — M · 🔒(ADEP-2).
  `deploy/autoupdate.sh`: login → `compose pull server` → digest сменился → `up -d
  server` → `docker image prune -f` (диск на домашнем сервере конечен); systemd
  `moongame-update.timer` (5 мин) + выключатель `AUTODEPLOY=0` в server.env — выкатка
  посреди вечернего матча рвёт WS (матч выживает: durable-Postgres + seat-tickets, но
  графцфул-drain — это OPS-1.1, не здесь).
  **Готово:** push в main → сервер обновился сам в течение ~5 минут; откат =
  `compose pull` конкретного `:<sha>`.
- **ADEP-4 · Доки + ручные шаги** `[ops]` — S · 🔒(ADEP-3).
  `deploy/README.md`: секция «Автодеплой» + обязательные ручные шаги (видимость
  GHCR-пакета, выдача PAT, ротация — прецедент pages.yml показал, что шаг вне репо
  молча ломает конвейер); `state.md` по факту.

## Блок C · Реплей-детерминизм в CI `[core]` `[srv]`

> CR-0.2-лайт из `core-roadmap.md`: формат + раннер + самосогласованный CI-тест.
> Durable-журнал действий (PE-1.1) и аудит-реплей продакшен-матчей (GI-1.3) — **отдельные
> кирпичи после**, здесь только фундамент. Хэш и его golden уже есть (`state/hash.ts`).

- **RPL-1 · Формат + чистый раннер** `[core]` — M.
  `packages/shared-core/src/replay/replay.ts`: `ReplayLog { initial: GameState;
  config; steps: [{at, action?}] }` (шаг без action = чистый advance); `runReplay(...)
  → {state, hash, failures}` — внутри ровно real-time flow `advanceTo → applyAction`.
  Раннер fail-secure сверяет пин версии данных/манифеста/config — реплей с другим
  бандлом обязан отказать, а не тихо разойтись. Тест: скриптованный матч напрямую vs
  через runReplay — хэши равны; вариант с JSONB-эмуляцией
  (`JSON.parse(JSON.stringify())` + пересортировка ключей initial) — анти-BF-13.
- **RPL-2 · Рекордер в MatchRoom** `[srv]` — S · 🔒(RPL-1).
  Опция `record` в MatchRoom, вызов после успешного применения в
  `applyAndBroadcast`/`commitApply` — покрывает и серверные действия
  (`submitServerAction`: ИИ, Хранитель). ⚠️ Записывать **эффективный** `ctx.now`
  (`Math.max(serverNow, state.time)` — `matchRoom.ts:898`), иначе реплей законно
  разойдётся.
- **RPL-3 · CI-тест record→replay→hash** `[srv]` — M · 🔒(RPL-2).
  `replayDeterminism.test.ts`: in-memory room, скриптованная партия на несколько игровых
  дней (движение/бой/захват/стройка — RNG и schedule работают по-настоящему), запись →
  `runReplay` → хэши равны; плюс прогон реплея с другим членением advance (один прыжок
  vs почасовые тики) — анти-BF-22; плюс сверка `failures` (одинаковый хэш не должен
  маскировать одинаково-сломанный прогон). Самосогласованный (live vs его же реплей) —
  не хрупкий к баланс-правкам; попадает в `pnpm test` → ci.yml без правок workflow.
- **RPL-4 · Доки** `[docs]` — S · 🔒(RPL-3). `core-roadmap.md` CR-0.2 → частично ✅,
  `metrics-roadmap.md` KPI «хеш прогона» → green, `state.md`.
- **RPL-5 · Durable action-log** `[srv]` — L · 🔒(RPL-3) · **отдельный кирпич, не в
  этом заходе** = PE-1.1: append-only лог в Postgres, реплей читает из стора —
  разблокирует GI-1.3 (аудит-реплей подозрительного матча, откат при эксплойте).

## Блок D · Fuzz/property-тесты ядра `[core]`

> SD-7.3 целиком + мусорная часть SD-7.2 из `secure-sdlc-roadmap.md`. ⚠️ zod v4:
> мосты типа zod-fast-check таргетят v3 — arbitraries пишем руками (схемы простые).

- **FUZZ-1 · fast-check + testkit** `[core]` — S.
  fast-check в root devDeps; `testkit/arbitraries.ts`: arbitrary действий (типы — из
  ключей `actionPayloadSchemas`, валидные payload'ы для ~10 базовых типов + отдельный
  «мусорный» arbitrary), состояния — поверх `buildStateFromMap` + мини-GameData.
- **FUZZ-2 · Property-suite applyAction** `[core]` — M · 🔒(FUZZ-1).
  Свойства: (а) на `deepFreeze(state)` **никогда не бросает** (валидный или мусорный
  payload — только `ok:false` со стабильным `/^E_[A-Z_]+/`, вплоть до `E_INTERNAL`);
  (б) двойной прогон → одинаковый `hashState` (один seed → один результат);
  (в) `hashState(s) === hashState(JSON.parse(JSON.stringify(s)))` после действий;
  (г) `state.scheduled` остаётся `(at,seq)`-сортированным.
  ⚠️ Семантические свойства — только на gate-валидных payload'ах
  (`isValidActionPayload`): ядро по контракту получает уже провалидированное (инвариант
  №5 CLAUDE.md), сырой мусор проверяет только «no throw».
- **FUZZ-3 · Property-suite advanceTo** `[core]` — M · 🔒(FUZZ-1).
  Непрерывность спанов `time.advanced` на `[state.time, now]`; split-эквивалентность
  (advanceTo(t₁)→t₂ ≡ advanceTo(t₂) по хэшу); финальное `time === ctx.now` при
  `partial !== true`; модуль-бомба → `failures` растут, таймлайн не клинит.
- **FUZZ-4 · Property applyDelta∘diffState = id** `[core]` — S · 🔒(FUZZ-1).
  Под рандомными парами состояний по `hashState` — третий пункт SD-7.3.
- **FUZZ-5 · Доки** `[docs]` — S · 🔒(FUZZ-2..4). SD-7.3 → ✅, SD-7.2 → частично ✅.

Бюджет: numRuns 50–200, короткие последовательности — `pnpm run check` не должен
распухнуть; при падении fast-check печатает seed (репро детерминирован). Найденное
свойствами реальное (например, мутация общего `ctx.data`) — фиксить отдельным кирпичом,
не ослаблять свойство. RNG-алгоритм не трогать — golden сторожит реплеи.

---

## Последовательность

1. **ADEP-0** — первым: чинит сломанный сегодня update-путь, 15 минут ценности.
2. **Блок A (TLS)** — плейтест получает `wss://домен` и рабочий Origin-allowlist.
   Блокер TLS-1 — решение владельца (домен).
3. **Блок B (автодеплой)** — push в main → сервер обновился сам.
4. **Блоки C и D** — независимы от A/B и друг от друга, зона `[core]`/`[srv]` — можно
   вести параллельной сессией в любой момент (не пересекаются с deploy-файлами).

## Решения, которые нужны от владельца

1. **Домен** (TLS-1): какой; и если у провайдера закрыты 80/443 — согласие на путь
   через Cloudflare (DNS там + cloudflared, сертификат не нужен вовсе).
2. **GHCR** (ADEP-1): подтвердить приватность пакета; выдать fine-grained PAT
   `read:packages` для сервера (единственный долгоживущий секрет схемы, ротация — в
   runbook).
3. **Окно автодеплоя** (ADEP-3): обновлять сразу (5-мин таймер) или только в тихие часы.

## Статус реализации

_Пока не начато. Отмечать ✅ по кирпичам здесь + зеркалить в связанных роадмапах
(https / core / secure-sdlc / metrics) и `state.md` — по правилу «код сначала, доки после»._
