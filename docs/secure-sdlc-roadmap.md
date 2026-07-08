# Цикл безопасной разработки (Secure SDLC) — технический roadmap

> **Направление:** как мы **строим** безопасно — безопасность, вшитая в процесс и в
> код (build-time + код-уровень), «сдвинутая влево». Парный артефакт —
> `secure-environment-roadmap.md` (как мы безопасно **эксплуатируем**: рантайм/инфра).
> Формат — кирпичики как в `backlog.md`/`cross-platform-roadmap.md`: **1 кирпич ≈ 1 PR ≈
> 1 сессия**, зона · статус · зависимости · «Готово, когда». Расширяет Блок **SEC**
> (`backlog.md`), не дублирует его.
> Статусы: ✅ готово · ⏳ можно брать · 🔒(dep) ждёт зависимость.

## Выбор рамок (decision record)

Литература сходится на «лёгкой» триаде для небольшой команды (не бюрократия):

- **NIST SSDF (SP 800-218)** — зонтик/чек-лист исходов SDLC. 4 семейства практик:
  **PO** (Prepare the Organization), **PS** (Protect the Software), **PW** (Produce
  Well-Secured Software), **RV** (Respond to Vulnerabilities). v1.1 — текущий финал;
  v1.2 — черновик (дек 2025). Задачи ниже промаркированы семейством `[PW]`/`[PS]`/…
- **OWASP ASVS 5.0** (май 2025) — стандарт **верификации** приложения. Целимся в
  **Level 2** (бэкенд с аккаунтами + игровой экономикой = «чувствительные данные +
  значимые транзакции»); **L3** — только для самых рискованных компонентов (авторизация,
  будущие платежи). ASVS 5.0 явно отказался от «L1 можно закрыть чёрным ящиком» —
  нужен доступ к исходникам/артефактам.
- **OWASP SAMM v2** — лёгкая ежегодная самооценка зрелости (5 бизнес-функций).
- **НЕ берём BSIMM** — он дескриптивный (бенчмарк против крупных программ), не даёт
  списка «сделай N вещей»; для команды 1–5 человек неактионабелен.
- **Security champion** — назначенная роль внутри команды (не отдельный отдел).

Принцип: threat modeling и проверки — **в PR, итеративно** (Threat Modeling Manifesto;
RTMP — «80% результата за 20% усилий»), а не разовый аудит.

## Текущая база (что уже даёт защиту — сверено по коду)

- **SEC-0 ✅** — пайплайн (GitHub Actions, `.github/workflows/security.yml`), **информационный /
  неблокирующий** (все сканеры `continue-on-error`, `pnpm audit … || true`): `pnpm run check`
  (lint+typecheck+test), `pnpm audit`, Semgrep + CodeQL SAST, Gitleaks + TruffleHog (секреты),
  osv-scanner (SCA, `pnpm-lock.yaml` + `mobile/package-lock.json`), Trivy fs/image, Syft SBOM
  (CycloneDX), zizmor (workflow-безопасность), OpenSSF Scorecard; агрегация всех находок в один
  отчёт (SARIF → Code Scanning + sticky PR-комментарий). Экшены пиннятся по SHA, образы —
  по тегу/`@sha256`; `permissions: {}` по умолчанию, права выдаются поджобно.
- **Детерминизм-инварианты** в ESLint (`eslint.config.js`): запрет `Math.random`/`Date.now`
  в `shared-core/src`.
- **Валидация на границе данных**: `parseGameData`/`safeParseGameData` (zod) — A05/A08.
- **Слой действий** (`@void/action-layer`): `validateActionEnvelope` (zod) + `authorizeActionEnvelope`
  (привязка к сессии) + `InMemorySequenceGate` (anti-replay/ordering) + receipts (идемпотентность)
  + стабильные `E_*`-коды, fail-secure.
- **Fail-secure редьюсер** (`kernel.ts`): `{ ok, code }`, caps `MAX_EVENTS_PER_STEP`/`MAX_ADVANCE_STEPS`.
- **Клиент**: `esc()` в прототипе; `parseClientMessage` type-guards + 32KB payload cap на сервере.

## Карта угроз игры (что моделируем) → уже закрыто инвариантами

| Угроза (STRIDE) | Контроль | Статус |
| --- | --- | --- |
| Подделка интентов (S/T) | server-authority: «клиент шлёт намерение, не состояние» | ✅ инвариант |
| Double-spend / TOCTOU гонка (T) | один авторитетный редьюсер на клоне + per-player очередь | 🟠 редьюсер ✅, очередь 🔒(srv) |
| Replay / abuse идемпотентности (S/R) | sequence-gate + receipts по `actionId` | ✅ (in-mem) |
| Утечка тумана = maphack (I) | `visibleState`-проекция **перед** отправкой | 🟢 ядро ✅, на отправке ✅ (F6: per-player дельты в `MatchRoom.broadcastState`) |
| Боты/фарм (DoS экономики) | rate-limit + аномалии + anti-multiaccount | 🔴 не реализовано |

---

## Фаза 0 · Governance и базлайн `[PO]`

### SD-0.1 · Цель ASVS L2 + threat-model-кадэнс `[docs][sec]` ⏳ — S
**Подзадачи:** зафиксировать цель верификации (ASVS L2 baseline, L3 для auth/платежей); назначить security champion; правило «security-relevant PR требует мини-threat-model».
**Готово, когда:** в `docs/` есть страница цели ASVS + чек-лист «когда нужен threat-model».

### SD-0.2 · SEC-1: триаж и baseline сканеров `[sec]` ⏳ — M
**Подзадачи:** разобрать находки Semgrep/osv/Trivy; подавить ложные **с обоснованием** (`.semgrepignore`/`.gitleaks.toml`/`.trivyignore`); разобранные сканеры → блокирующие на **новых** находках (diff-aware).
**Готово, когда:** baseline зафиксирован; новые находки блокируют PR, легаси-шум — нет. **Это бирка SEC-1.**

---

## Фаза 1 · Стандарты безопасного кода `[PW]` — клиент / бизнес-логика / БД

Это «безопасность клиента, БД и бизнес-логики» на уровне кода (рантайм-аспекты — в окружении).

### SD-1.1 · Валидация на каждой границе доверия `[core][act][srv]` ⏳ — M
**Цель:** только корректные данные входят в логику; allow-list, не deny-list; на сервере, рано.
**Подзадачи:** zod на каждом входе (данные ✅, конверт действий ✅, расширить на server-протокол/будущие HTTP-роуты); `z.strictObject()` где уместно; «значение из фикс-набора не совпало» → **высокий security-лог** (сигнал тампера); валидация ≠ авторизация (разные шаги).
**Готово, когда:** каждый недоверенный вход проходит zod до использования; есть тест «мусор → безопасный отказ».

### SD-1.2 · Вывод/экранирование — XSS в клиенте `[cli][proto]` 🔒(CP0.1) — M
**Цель:** ни одна недоверенная строка не попадает в опасный DOM-сток.
**Подзадачи:** дефолт — `textContent`, не `innerHTML`; для HTML — **DOMPurify**; включить **Trusted Types** (`require-trusted-types-for 'script'`) — кросс-браузерный Baseline с фев 2026 (FF148), на старых браузерах деградирует в no-op; запрет опасных стоков линтером (`eslint-plugin-no-unsanitized`); заметка: рендер на Canvas/WebGL/Pixi — **не** HTML-сток, но HUD/оверлеи и PixiJS DOM-overlay — сток.
**Готово, когда:** линт запрещает `innerHTML`-классы стоков; весь недоверенный вывод идёт через безопасный сток/санитайзер.

### SD-1.3 · Инъекции — БД `[srv]` 🔒(F2) — M
**Цель:** никакого построения запросов конкатенацией.
**Подзадачи:** только параметризованные запросы (`pg` `$1,$2`); для **jsonpath** — аргумент `vars` (PG 14+), не склейка пути; динамические идентификаторы (имена таблиц/колонок/ORDER) — allow-list или `pg-format` `%I`; помнить: JSON-операторы — вектор обхода WAF, защита = параметризация, не WAF; least-priv роль БД (детали — в окружении).
**Готово, когда:** нет ни одной строки запроса со склейкой; есть тест на инъекцию через JSON-значение.

### SD-1.4 · Prototype pollution и безопасная десериализация `[core]` ⏳ — S
**Цель:** закрыть `__proto__`/`constructor.prototype` через данные.
**Подзадачи:** zod **strip/strict** на границе уже срезает `__proto__`/лишние ключи — задокументировать как защиту; хранилища «ключ→значение» — `Map`/`Object.create(null)`, не литералы; рассмотреть `node --disable-proto=delete` на сервере; помнить, что сток — последующий deep-merge распарсенного.
**Готово, когда:** есть тест «вход с `__proto__`/`constructor` не загрязняет прототип».

### SD-1.5 · ReDoS-гигиена `[core][act][srv]` ⏳ — S
**Подзадачи:** `eslint-plugin-regexp` rule `no-super-linear-backtracking` в гейт; запрет вложенных квантификаторов/безграничных `.*` вокруг альтернатив; ограничение длины входа; для пользовательских паттернов (если появятся) — движок без бэктрекинга (`re2`).
**Готово, когда:** линт ловит супер-линейные паттерны; известные regex в коде проверены.

---

## Фаза 2 · Статанализ и секреты `[PW]`

### SD-2.1 · Кастомные Semgrep-правила под инварианты ядра `[sec]` ⏳ — M
**Цель:** SEC-2. Усилить инварианты, что ESLint покрывает лишь частично.
**Подзадачи:** правила-баны: `Math.random(`/`Date.now(`/`new Date()` и Node-built-ins в `shared-core/src`; `$EL.innerHTML = $X`; склейка SQL (`$DB.query(\`...${$V}...\`)`); тесты правил через `semgrep --test` (`// ruleid:`/`// ok:`); diff-aware (`SEMGREP_BASELINE_COMMIT`).
**Готово, когда:** правила в пайплайне, протестированы, блокируют новые нарушения. **Это бирка SEC-2.**

### SD-2.2 · ESLint security-плагины + типизованные правила `[sec]` ⏳ — S
**Подзадачи:** `eslint-plugin-security` (с триажем шумных `detect-object-injection`/`detect-non-literal-fs-filename`), `eslint-plugin-no-unsanitized`; типозависимые `no-floating-promises`/`no-unsafe-*` (учесть стоимость type-aware линта).
**Готово, когда:** плагины включены, ложные сработки подавлены с обоснованием.

### SD-2.3 · CodeQL default setup `[sec]` ⏳ — S
**Подзадачи:** включить CodeQL default setup (JS/TS, без build-конфига) → alerts в code scanning; дополняет Semgrep (CodeQL не для проектных банов).
**Готово, когда:** CodeQL гоняется на PR, алерты видны.

### SD-2.4 · Секреты: Gitleaks + GitHub push protection `[sec]` ⏳ — S
**Подзадачи:** Gitleaks уже в CI (✅, SEC-0) — добавить pre-commit хук; включить **GitHub secret scanning + push protection** (серверный бэкстоп, ловит до попадания в репо); `.gitleaks.toml` allowlist с обоснованием.
**Готово, когда:** секрет не уходит ни локально (хук), ни в пуш (push protection), ни в CI (Gitleaks).

---

## Фаза 3 · Цепочка поставок `[PS]`

> Контекст 2025: волна компрометаций npm (chalk/debug — ~2 ч в реестре; самореплицирующийся
> червь Shai-Hulud 1.0/2.0, preinstall, >25k репо). Это прямо мотивирует контроли ниже.

### SD-3.1 · pnpm: блокировка lifecycle-скриптов + cooldown `[sec]` ⏳ — S
**Подзадачи:** pnpm 10 по умолчанию **блокирует** `preinstall`/`install`/`postinstall` — вести явный `onlyBuiltDependencies` allow-list; `minimumReleaseAge` (cooldown, в pnpm 11 дефолт 1440 мин) с `minimumReleaseAgeExclude` для хотфиксов; `--frozen-lockfile` в CI (дефолт в CI); `blockExoticSubdeps`.
✅ уже в коде: frozen-lockfile в CI — `security.yml` (`pnpm install --frozen-lockfile`) и `android.yml` (`npm ci` для `mobile/`). Остаётся `onlyBuiltDependencies` allow-list, `minimumReleaseAge`, `blockExoticSubdeps`.
**Готово, когда:** сборка скриптов — только из allow-list; новые версии «отлёживаются» сутки; lockfile-drift роняет CI.

### SD-3.2 · SCA-гейт + автообновления с политикой `[sec]` ⏳ — M
**Подзадачи:** osv-scanner (✅ в SEC-0) → PR-режим «только новые vulns»; Renovate/Dependabot с **cooldown** (`minimumReleaseAge`/`cooldown` ≥7–14 дней), группировкой, авто-мердж только patch/minor dev-deps после выдержки, security-update в обход cooldown; пин версий + пин GitHub Actions по SHA; ежеквартальная прополка зависимостей (минимализм — по CLAUDE.md).
✅ уже в коде: Dependabot настроен — `.github/dependabot.yml` (три экосистемы: npm `/`, npm `/mobile`, github-actions; еженедельно, dev-deps сгруппированы); osv-scanner уже покрывает `mobile/package-lock.json`; экшены пиннятся по SHA. Остаётся политика cooldown (`minimumReleaseAge`/`cooldown` ≥7–14 дней), авто-мердж patch/minor после выдержки, PR-режим «только новые vulns», ежеквартальная прополка.
**Готово, когда:** обновления идут с выдержкой и политикой; прямые зависимости ревьюятся.

### SD-3.3 · Провенанс артефактов + проверка `[sec]` 🔒(SEC-5) — M
**Подзадачи:** npm provenance / **OIDC trusted publishing** (если публикуем пакеты); **SLSA**-провенанс (Build L2–L3 через hosted CI) + **cosign**/`actions/attest-build-provenance` для образов; `npm audit signatures`; OpenSSF **Scorecard**-экшен на PR. **Это бирки SEC-7 (+ часть SEC-5).**
**Готово, когда:** билд-артефакты/образы подписаны и проверяемы на деплое.

### SD-3.4 · SBOM в IR-поток `[sec]` ✅→⏳ — S
**Подзадачи:** SBOM уже генерится (Syft, SEC-0) — довести до **CycloneDX** для JS (`@cyclonedx/cyclonedx-npm`) и хранить артефактом; процедура «новый CVE → запрос по SBOM за секунды».
**Готово, когда:** на любой CVE отвечаем «затронуты ли мы» по SBOM.

---

## Фаза 4 · Threat modeling (лёгкий, в PR) `[PW]`

### SD-4.1 · Threat-model-as-code в репо `[docs][sec]` ⏳ — M
**Подзадачи:** выбрать as-code инструмент в духе репо (**Threagile** YAML или **OWASP pytm** Python) — модель в гите, отчёт в CI; начальная модель с DFD и trust boundaries (клиент↔WS↔сервер↔БД/Redis); занести игровые угрозы (таблица выше).
**Готово, когда:** модель лежит в репо, генерит отчёт, ревьюится.

### SD-4.2 · Кадэнс per-feature `[docs]` 🔒(SD-4.1) — S
**Подзадачи:** RTMP — добавлять угрозы только для функциональности текущего PR; ответ на угрозу — Mitigate/Eliminate/Transfer/Accept, актионабельно; модель живёт рядом с кодом.
**Готово, когда:** security-relevant PR обновляет модель.

---

## Фаза 5 · Ревью кода и гигиена коммитов `[PO][PS]`

### SD-5.1 · CODEOWNERS + защита ветки `[sec]` ⏳ — S
**Подзадачи:** CODEOWNERS на security-пути (`shared-core` инварианты, `action-layer`, `.github/`, будущие auth/SQL); защита `main` (обяз. ревью + обяз. статус-чеки = сделать сканеры required, линейная история); сам CODEOWNERS под овнером.
**Готово, когда:** изменения чувствительных зон требуют ревью владельца + зелёных сканеров.

### SD-5.2 · Pre-commit хуки + подпись коммитов `[sec]` ⏳ — S
**Подзадачи:** lefthook/husky (lint, secret-scan, формат) — как удобство, не граница; **подпись коммитов** (SSH/GPG) + правило «require signed commits»; «секреты никогда в репо» как правило.
**Готово, когда:** локальный быстрый барьер есть; неподписанные коммиты в `main` блокируются.

---

## Фаза 6 · Безопасность самого пайплайна `[PS]`

### SD-6.1 · SHA-пин экшенов и образов + least-priv токены `[sec]` ⏳ — M
**Подзадачи:** пин сторонних GitHub Actions по **полному commit SHA** (урок CVE-2025-30066 tj-actions: репойнт тега → дамп секретов в логи); пин scanner-образов по `sha256`; `permissions:` read-only по умолчанию, write — поджобно; masked/protected vars. **Это бирка SEC-3.**
✅ уже в коде (`security.yml`/`android.yml`): все экшены пиннятся по полному commit SHA; scanner-образы semgrep/trufflehog/zizmor — по `@sha256`-дайджесту (остальные — по версионному тегу); `permissions: {}` по умолчанию, write выдаётся поджобно. Осталось: `@sha256` для версионно-тегированных образов и masked/protected vars по мере появления секретов.
**Готово, когда:** ни один экшен/образ не по плавающему тегу; токены минимальны.

### SD-6.2 · OIDC вместо долгоживущих секретов `[sec]` 🔒(F1) — S
**Подзадачи:** при деплое/облаке — OIDC (`id-token: write`), без хранения облачных ключей в secrets; короткоживущие токены.
**Готово, когда:** деплой-джобы не хранят долгоживущих облачных ключей.

### SD-6.3 · Агрегация находок (SARIF) `[sec]` ⏳ — S
**Подзадачи:** SARIF из всех сканеров → GitHub Code Scanning / DefectDojo (единая панель, трекинг). **Это бирка SEC-4.**
**Готово, когда:** находки в одной панели с историей.

---

## Фаза 7 · Тестирование безопасности `[PW][RV]`

### SD-7.1 · Расширить abuse-тесты слоя действий `[act]` ⏳ — S
**Подзадачи:** к существующим (spoof/replay/dedup/out-of-order) добавить: переполнение/边界 payload, кросс-матч/кросс-сессия, гонки идемпотентности.
**Готово, когда:** каждый класс злоупотреблений покрыт тестом с кодом отказа.

### SD-7.2 · Фаззинг валидаторов и парсеров `[core][srv]` ⏳ — M
**Подзадачи:** фаззинг `parseGameData`/`parseClientMessage`/конверта действий случайным/злонамеренным входом; сток падений в регресс.
**Готово, когда:** фаззер гоняется в CI (короткий бюджет) и не находит крашей.

### SD-7.3 · Property-based тесты детерминизма `[core]` ⏳ — M
**Подзадачи:** свойства «`applyAction` не мутирует вход», «один seed → один результат», «`applyDelta∘diffState = id`» под рандомизированными входами (fast-check).
**Готово, когда:** свойства зелёные на N случайных прогонов.

---

## Фаза 8 · Верификация и реакция `[RV]`

### SD-8.1 · ASVS L2 self-verification `[docs][sec]` 🔒(SD-0.1) — L
**Подзадачи:** пройти ASVS 5.0 L2-чек-лист по приложению; зафиксировать gaps как кирпичики; L3 — для auth/платежей.
**Готово, когда:** есть заполненный ASVS L2-отчёт с трекингом разрывов.

### SD-8.2 · DAST против живого сервера `[sec]` 🔒(F1) — M
**Подзадачи:** добавить ZAP baseline-джобу в `.github/workflows/security.yml` против `@void/server` (GitLab-пайплайн с готовым шаблоном удалён — стартуем с нуля). **Это бирка SEC-6.**
**Готово, когда:** ZAP гоняется по живому серверу, находки триажатся.

### SD-8.3 · Процесс реакции на уязвимости `[docs]` ⏳ — S
**Подзадачи:** `SECURITY.md` (как сообщить); SLA реагирования; root-cause-анализ каждой найденной уязвимости (RV — системная починка, не точечная); полный проход OWASP Top-10 = **SEC-8** (Этап 7).
**Готово, когда:** есть disclosure-канал и регламент реакции.

---

## Последовательность

- **Сразу (дёшево, высокий эффект):** SD-0.2 (триаж/baseline), SD-3.1 (lifecycle+cooldown), SD-2.1 (Semgrep-инварианты), SD-2.4 (push protection), SD-6.1 (SHA-пин).
- **Код-уровень (по мере роста клиента/БД):** Фаза 1 — SD-1.2 с клиентом (CP0.1), SD-1.3 с БД (F2).
- **Процесс:** Фазы 4–5 параллельно; Фаза 6 — с появлением деплоя; Фаза 8 — к Stage 3+.
- **Соответствие SEC:** SEC-1→SD-0.2, SEC-2→SD-2.1, SEC-3→SD-6.1, SEC-4→SD-6.3, SEC-5/7→SD-3.3, SEC-6→SD-8.2, SEC-8→SD-8.3.

## Чего НЕ делаем (анти-цели)

BSIMM-бенчмаркинг; тяжёлый разовый аудит вместо непрерывного; security-театр (метрики ради метрик); блокирующие сканеры на легаси-шуме (только diff-aware на новом); самописная крипта; доверие WAF вместо параметризации.

## Источники (ключевые, проверять первоисточник перед цитированием)

NIST SSDF SP 800-218 · OWASP ASVS 5.0 · OWASP SAMM v2 · OWASP Threat Modeling / Cheat Sheets
(Input Validation, XSS, SQLi, Prototype Pollution) · Threat Modeling Manifesto · Threagile /
OWASP pytm · Semgrep / CodeQL / eslint-plugin-security / no-unsanitized / eslint-plugin-regexp ·
Gitleaks / GitHub push protection · pnpm supply-chain (10/11 lifecycle, minimumReleaseAge) ·
OSV-Scanner · SLSA / Sigstore-cosign / npm provenance · OpenSSF Scorecard · Renovate/Dependabot
cooldown · DOMPurify · Trusted Types (Baseline фев 2026) · инциденты polyfill.io, chalk/debug,
Shai-Hulud, tj-actions CVE-2025-30066.
