# Переход на HTTPS/WSS — операционный roadmap

> **Направление:** конкретный, посурфейсный план, как привести **работающий** сервер из
> `http://`/`ws://` к `https://`/`wss://`. Это **операционализация** уже спроектированных
> кирпичиков `secure-environment-roadmap.md` (**SE-1.2** TLS 1.3 + reverse-proxy, **SE-1.1**
> Cloudflare-край, **SE-1.3** скрытие origin, **SE-6.1** Origin-проверка/лимиты, **SE-7.1**
> HSTS/CSP) — не дублирует их, а раскладывает на шаги по реальным способам деплоя.
> Закрывает находку аудита **F-05** (`docs/security/audit-2026-06-27.md`).
> Формат — кирпичики как в `backlog.md`: зона · статус · зависимости · «Готово, когда».
> Статусы: ✅ сделано · ⏳ todo · 🔒(dep) заблокировано зависимостью.

## Принципы

1. **TLS терминирует reverse-proxy/край, не Node** (SE-1.2). Сервер остаётся plain-HTTP на
   loopback за прокси; публичный listener — только `https`/`wss`. In-process TLS (`https.createServer`)
   — лишь запасной путь там, где прокси невозможен.
2. **Никакого нешифрованного публичного трафика.** `ws://`/`http://` допустимы только для
   `localhost` (браузер считает loopback secure-context) и для **debug-LAN** профиля APK с явной меткой.
3. **Не доверяем клиентскому транспорту вслепую**, но доверяем прокси **явно и узко**: читаем
   `X-Forwarded-Proto`/`Host` только от своего прокси (увязать с host-header-находкой F-04 аудита).
4. **HTTP→HTTPS редирект + HSTS** на крае (SE-7.1); `connect-src` CSP под `wss:` своего origin.
5. **Сертификаты — автоматизированный ACME** (Let's Encrypt) с авто-продлением и мониторингом
   истечения; в проде — никаких самоподписанных.
6. **Деградация без секретов в логах**: ошибки TLS/handshake → отказ со стабильным кодом, без деталей.

## Текущая база (факт — сверено с кодом)

| Поверхность                              | TLS сейчас          | Чем обеспечен                                                                            |
| ---------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------- |
| **Render** (`render.yaml`, Path D)       | ✅ `https`/`wss`    | TLS на крае Render; оверлей авто-подставляет same-origin `wss://` (`multiplayer.md:132`) |
| **cloudflared / ngrok туннель** (Path C) | ✅ `wss`            | TLS на крае туннеля (`multiplayer.md:110-118`)                                           |
| **VPS через `deploy/serve.sh`**          | ❌ `http`/`ws`      | `pnpm host` биндит `0.0.0.0:PORT` напрямую, без прокси                                   |
| **`docker run -p 8788:8788`**            | ❌ `http`/`ws`      | `Dockerfile` слушает 8788 plain (`ENV PORT=8788`)                                        |
| **LAN (Path A)**                         | ❌ `ws`             | прямой `ws://<LAN-IP>:8788`                                                              |
| **APK debug (Path B)**                   | ❌ `ws` (cleartext) | `mobile/capacitor.config.json`: `androidScheme:"http"`, `cleartext:true`                 |
| **Оверлей коннекта**                     | ✅ авто-upgrade     | на `https`-странице сам апгрейдит `ws://`→`wss://` (`multiplayer.md:193`)                |
| **Node-сервер**                          | ❌                  | `http.createServer` (`wsServer.ts:42`), анонсирует `ws://` (`wsServer.ts:123-126`)       |

**Вывод.** Управляемые/edge-поверхности (Render, туннель) **уже на HTTPS**. Гэп — self-hosted
(`docker run`/VPS), LAN, APK и приведение кода к единому стандарту (доверие прокси, редирект,
HSTS, сообщения о URL, мобильный cleartext).

## Карта на OWASP / SE-кирпичики

A02 (крипта в транзите) · A05 (misconfiguration) · A01 (доступ/Origin). Каждый кирпич ниже
помечен родительским SE-кирпичом, который он реализует.

---

## Фаза 0 · Архитектурное решение `[docs]`

### HTTPS-0.1 · Зафиксировать «TLS терминирует прокси» как стандарт `[docs]` ⏳ — S → SE-1.2

**Цель:** один задокументированный паттерн вместо разнобоя. **Решение:** публично — только
`https`/`wss` через reverse-proxy (Caddy/Nginx/Traefik) или managed-край (Render/Cloudflare);
Node слушает loopback plain-HTTP; in-process TLS — только запасной вариант.
**Готово, когда:** паттерн описан здесь и в `multiplayer.md`/`README`; все примеры деплоя ему следуют.

---

## Фаза 1 · Сервер готов жить за TLS-прокси `[srv]`

### HTTPS-1.1 · Доверие прокси: `X-Forwarded-Proto`/`Host` + Origin `[srv][sec]` ⏳ 🔒(F1) — M → SE-6.1, SE-1.2

**Цель:** корректно работать за терминирующим прокси, не доверяя заголовкам от кого попало.
**Подзадачи:**

- ввести флаг `TRUST_PROXY` (env); только при нём читать `X-Forwarded-Proto`/`X-Forwarded-Host`,
  иначе игнорировать (анти-spoofing, увязать с F-04: `baseUrl()` в `wsServer.ts:23-25`);
- опционально отклонять upgrade, если за прокси пришёл не-`https` форвард (`x-forwarded-proto !== 'https'`);
- **Origin-allowlist** на `handleUpgrade` (закрывает F-06/CSWSH, это часть SE-6.1) — список из env.
  **Готово, когда:** за прокси сервер видит верный протокол/хост; cross-origin upgrade отбивается; без прокси форвард-заголовки игнорируются.

### HTTPS-1.2 · (Опц.) In-process TLS как запасной путь `[srv]` ⏳ 🔒(HTTPS-1.1) — S → SE-1.2

**Цель:** дать `https.createServer` для сценариев без прокси (изолированный хост).
**Подзадачи:** если заданы `TLS_CERT`/`TLS_KEY` — поднимать `https`+`wss`, иначе как сейчас
`http`; `wsServer.ts` уже работает через `noServer:true` + `handleUpgrade`, так что смена базового
сервера локальна. **Не** делать основным путём (продление/хардненинг лучше у прокси).
**Готово, когда:** при заданных cert/key сервер слушает `wss` без прокси; по умолчанию поведение не меняется.

---

## Фаза 2 · Self-hosted / VPS: reverse-proxy с авто-TLS `[ops]`

### HTTPS-2.1 · Caddy/Nginx-пример с ACME перед сервером `[ops][sec]` ⏳ 🔒(домен) — M → SE-1.2

**Цель:** на VPS публичный `443/wss`, сервер — на `127.0.0.1`.
**Подзадачи:**

- добавить `deploy/Caddyfile` (Caddy = авто-Let's Encrypt из коробки) **или** `nginx.conf` + certbot;
  proxy `wss`→`http://127.0.0.1:$PORT`, заголовки `X-Forwarded-Proto`/`Host`;
- адаптировать `deploy/serve.sh`: биндить сервер на `127.0.0.1` (не `0.0.0.0`), публичный listener — прокси;
- health через `https`.
  **Готово, когда:** `https://<домен>/` и `wss://<домен>/matches/…` работают; прямой plain-порт сервера наружу не торчит.

### HTTPS-2.2 · Жизненный цикл сертификата `[ops][sec]` ⏳ 🔒(HTTPS-2.1) — S → SE-1.2

**Подзадачи:** ACME авто-продление (Caddy — само; certbot — таймер/cron); staging-эндпоинт ACME
для отладки (анти-rate-limit Let's Encrypt); мониторинг даты истечения (алерт за N дней, увязать с SE-8.2);
предусловие — домен и DNS (A/AAAA на VPS).
**Готово, когда:** сертификат продлевается без ручных действий; истечение мониторится.

---

## Фаза 3 · Managed/edge — формализовать уже работающее `[ops]`

### HTTPS-3.1 · Render: зафиксировать https-инвариант `[ops]` ✅ (работает) / ⏳ (формализация) — S → SE-1.2

**Факт:** Render даёт `https://<app>.onrender.com`, оверлей сам подставляет same-origin `wss://`.
**Подзадачи (формализация):** healthCheck по `https`; убедиться, что нет смешанного контента;
комментарий в `render.yaml`, что TLS — на крае Render.
**Готово, когда:** задокументировано; деплой проверен на отсутствие plaintext-путей.

### HTTPS-3.2 · Cloudflare/туннель: TLS на крае + скрытие origin `[ops][sec]` ✅ (туннель) / ⏳ (Cloudflare-перед-origin) — M → SE-1.1, SE-1.3

**Факт:** `cloudflared tunnel` уже даёт `wss`.
**Подзадачи:** для постоянного хостинга — Cloudflare перед origin (SE-1.1: WAF/DDoS/edge-rate-limit),
Cloudflare Tunnel/mTLS край→origin (SE-1.3), чтобы origin не светил публичный IP.
**Готово, когда:** постоянный домен идёт через Cloudflare; origin недостижим в обход края.

---

## Фаза 4 · Клиент и оверлей коннекта `[cli]`

### HTTPS-4.1 · `wss` по умолчанию + блок mixed-content `[cli][sec]` ✅ (частично) / ⏳ — S → SE-7.1

**Факт:** на `https`-странице оверлей авто-апгрейдит `ws://`→`wss://` (`multiplayer.md:193`).
**Подзадачи:** закрепить тестом; явно блокировать `ws://` к не-`localhost` хосту с понятной ошибкой
(вместо тихого mixed-content-блока браузера); CSP `connect-src 'self' wss://<домен>` (часть SE-7.1);
плейсхолдер в `prototype/build.mjs:354` — `wss://…` первым.
**Готово, когда:** на https-странице нельзя случайно подключиться по `ws://`; CSP разрешает только нужный `wss`.

### HTTPS-4.2 · Сообщения о URL: печатать `https`/`wss` `[cli][docs]` ⏳ — S

**Цель:** инструменты не должны подсказывать небезопасный URL как основной.
**Подзадачи:** `prototype/netserver.ts` (строки share/`raw ws`) и `prototype/doctor.mjs:102-113`
печатают `https`/`wss`-вариант как рекомендуемый (а `http`/`ws` — только явной пометкой «LAN/dev»);
обновить примеры в `multiplayer.md`.
**Готово, когда:** боевые/удалённые сценарии печатают `https`/`wss`; `http`/`ws` — только для localhost/LAN с меткой.

---

## Фаза 5 · Мобильная обёртка (Capacitor) `[cli]`

### HTTPS-5.1 · Убрать cleartext в release, отделить debug-LAN профиль `[cli][sec]` ⏳ 🔒(HTTPS-2.1/3.x) — M → SE-7.2

**Цель:** APK по умолчанию ходит только по `https`/`wss`.
**Подзадачи:**

- release-профиль: `androidScheme:"https"`, **убрать** `cleartext:true` (`mobile/capacitor.config.json:6-7`);
  Android `network_security_config.xml` без cleartext; iOS — ATS включён;
- debug-LAN профиль (для Path B) — **отдельный**, явно помеченный, с cleartext-исключением **только**
  для приватных диапазонов; не путать с release;
- проверить, что `usesCleartextTraffic` не утекает в release-манифест.
  **Готово, когда:** release-APK не делает cleartext-запросов; LAN-тест возможен только в явном debug-профиле.

---

## Фаза 6 · Локальная разработка `[srv]`

### HTTPS-6.1 · localhost остаётся `ws`, опц. mkcert для https-dev `[srv][docs]` ⏳ — S

**Цель:** не усложнять локалку.
**Подзадачи:** `ws://localhost:PORT` оставить (loopback = secure-context, браузеру ок); для тестов
PWA/secure-context на LAN — опциональный рецепт `mkcert` (локальный доверенный CA) + HTTPS-1.2;
документировать, что это **только** для dev.
**Готово, когда:** локальная разработка работает без TLS; есть опциональный https-dev рецепт.

---

## Фаза 7 · Приёмка и верификация `[sec]`

### HTTPS-7.1 · Проверка «нет plaintext, TLS корректен» `[sec]` ⏳ 🔒(2.x/3.x) — S → SE-1.2

**Подзадачи:**

- `testssl.sh`/SSL Labs по домену — цель A (TLS 1.3, без слабых шифров);
- DevTools: ноль mixed-content; `wss`-handshake работает в браузере и в APK;
- скан, что наружу **не** торчит plain-порт сервера (SE-1.2 «проверено сканом»);
- присутствует HSTS; `http`→`https` редиректит.
  **Готово, когда:** домен проходит A по testssl; нет смешанного контента; plain-порт закрыт; HSTS активен.

---

## Матрица перехода (что менять по каждой поверхности)

| Поверхность           | Сейчас          | Цель                         | Действие                                              |
| --------------------- | --------------- | ---------------------------- | ----------------------------------------------------- |
| Render                | https/wss ✅    | без изменений                | HTTPS-3.1 (формализация)                              |
| Туннель (cloudflared) | wss ✅          | без изменений                | HTTPS-3.2 (для постоянного — Cloudflare-перед-origin) |
| VPS (`serve.sh`)      | http/ws ❌      | https/wss за прокси          | HTTPS-2.1/2.2 + бинд на 127.0.0.1                     |
| `docker run`          | http ❌         | за прокси/край               | HTTPS-2.1 (compose с Caddy) или managed               |
| LAN (Path A)          | ws ❌           | ws только для dev            | HTTPS-6.1 (оставить с меткой)                         |
| APK (Path B)          | ws cleartext ❌ | wss в release                | HTTPS-5.1                                             |
| Оверлей               | авто-upgrade ✅ | + блок ws к не-localhost     | HTTPS-4.1                                             |
| Node-сервер           | http ❌         | plain за прокси / опц. https | HTTPS-1.1 (+1.2)                                      |

## Точечный список правок в коде/конфиге

- `packages/server/src/wsServer.ts:42` — `createServer` plain; `:23-25` `baseUrl()` host-header;
  `:58-72` upgrade без Origin-проверки; `:123-126` анонс `ws://`. → HTTPS-1.1/1.2, HTTPS-4.1.
- `Dockerfile:24` `ENV HOST=0.0.0.0`, `EXPOSE 8788` plain → за прокси (HTTPS-2.1).
- `deploy/serve.sh` — бинд `0.0.0.0` напрямую → `127.0.0.1` + прокси (HTTPS-2.1); + новый `deploy/Caddyfile`.
- `render.yaml` — добавить комментарий про edge-TLS, health по https (HTTPS-3.1).
- `mobile/capacitor.config.json:6-7` — `androidScheme:"http"`+`cleartext:true` → release без cleartext (HTTPS-5.1).
- `prototype/netserver.ts:125,146`, `prototype/doctor.mjs:102-113` — печать https/wss (HTTPS-4.2).
- `prototype/build.mjs:354` — плейсхолдер `wss://` первым (HTTPS-4.1).

## Последовательность

1. **HTTPS-0.1** (решение) → **HTTPS-1.1** (доверие прокси + Origin) — фундамент, без него остальное хрупко.
2. **HTTPS-2.1/2.2** (Caddy+ACME) — главный недостающий путь (self-hosted/VPS).
3. **HTTPS-4.1/4.2** (клиент/сообщения) и **HTTPS-3.1** (Render-формализация) — дёшево, сразу.
4. **HTTPS-5.1** (APK release без cleartext) — после того как есть стабильный `wss`-эндпоинт.
5. **HTTPS-7.1** (приёмка) — гейт перед «публично».
6. **HTTPS-3.2 / SE-1.1/1.3** (Cloudflare-перед-origin, HSTS-preload) — для постоянного публичного хостинга.

> **Зависимость от auth.** TLS закрывает транзит, но **не** аутентификацию: `wss` без JWT
> (**SE-0.1/F7**) по-прежнему позволяет занять чужой слот (находки F-01/F-02 аудита). HTTPS —
> необходимое, но не достаточное условие публичности; выкатывать связкой с SE-0.1 + SE-6.2.

## Чего НЕ делаем (анти-цели)

- Самоподписанные сертификаты в проде; отключение проверки сертификата где-либо.
- In-process TLS как основной путь (продление/хардненинг — забота прокси/края).
- `cleartext:true` в release-APK; cleartext-исключения шире приватных диапазонов.
- Доверие `X-Forwarded-*` без флага `TRUST_PROXY` (host/proto-spoofing).
- «Временный» публичный plain-порт сервера в обход прокси.
- Считать, что HTTPS = безопасно: без SE-0.1 (auth) и SE-6.2 (rate-limit) сервер всё ещё уязвим.

## Источники (сверять первоисточник, 2026)

`secure-environment-roadmap.md` SE-1._/6.1/7._ (родительский дизайн) · `architecture.md` §сеть/A02 ·
Let's Encrypt / ACME · Caddy (авто-TLS) / Nginx+certbot / Traefik · Cloudflare (edge-TLS/Tunnel/mTLS) ·
MDN: Secure Contexts, Mixed Content, HSTS · Capacitor Android `network_security_config` / iOS ATS ·
`mkcert` (локальный dev-CA) · `testssl.sh` / SSL Labs.
