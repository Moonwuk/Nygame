# Матрица готовности — Void Dominion

> Снимок состояния `main`, сверенный с кодом/тестами/`roadmap.md` (не по памяти).
> Обновлять при заметных сдвигах. Подробный нарратив — [`state.md`](state.md);
> план сборки — [`roadmap.md`](roadmap.md).

**Гейт:** ✅ зелёный · `pnpm run check` (lint + typecheck + test) · **886 passed / 4 skipped / 88 файлов тестов**.

## Этапы сборки

| Этап | Статус | Что готово | Осталось |
|---|---|---|---|
| **0 · Каркас** | ✅ Готово | Монорепа (pnpm workspaces), TS strict, ESLint (+правила детерминизма), Prettier, Vitest, CI-гейт, lockfile, `data/*.json` + zod | — |
| **1 · Ядро** (`shared-core`) | ✅ Готово | 21 модуль (ниже), микроядро + `advanceTo`, детерминизм (sfc32 + golden), fail-secure | **EFX-1** — универсальный движок трейтов/эффектов (backlog; трейты читаются точечно) |
| **2 · Слой действий** (`action-layer`) | ✅ Готово и подключено | envelope-валидация, gate (validate→payload→authorize→dedup→sequence), idempotency-квитанции, per-session `clientSeq`, стабильные коды; **вшит в сервер** | — |
| **3 · Сервер** | 🚧 Крит-путь закрыт | Fastify WS (`/health`·`/ready`·`/metrics`·drain), MatchRoom + `LazyRoomRegistry` (N матчей, гибернация, 24/7), `GET /matches` (+archive), commit-before-broadcast + durable Postgres/in-memory, туман-на-отправке, **JWT-рукопожатие**, action-gate (под флагом), dev create/join + join-токены, offline-планировщик | **OIDC-идентичность**, **envelope-клиент**, мультипроцессный масштаб |
| **4 · Клиент** (`client`) | 🚧 В работе | view-models `welcomeScreen`/`matchHud`, токены темы, `MultiplayerClient`-адаптер; **CP0.1 — каркас веб-клиента (Vite/PWA-first)** | Рендер карты/HUD (CP0.2), сетевой транспорт (CP1.x), PWA-оболочка |
| **5–7 · Цикл / Контент / Закалка** | ⏳ Запланировано | — | Всё |
| **Метаигра** (AvA-сектора, корпорации, мета-шпионаж) | 🌌 Отложено надолго (по решению) | Зафиксирована в `metagame.md` | Не раньше зрелого Этапа 3+ |

## Ядро — модули (все ✅, покрыты тестами)

kernel + `advanceTo` · movement (Дейкстра по лейнам) · **combat / orbital / artillery / intercept** (распил монолита, PR #100) · construction + buildings (уровни/HP/оборона/разрушение) · economy (+содержание) · army (domain, load/unload, десант) · victory/счёт · technology (сессионное древо) · planetType · sector · faction · hero · market · scientist · station · **espionage** (SPY-1/SPY-2, PR #102) · visibility (туман: identify + radar + память + anti-leak) · diplomacy (war/peace/pact/alliance) · captureOnArrival.

## Прототип (играбельный слайс, throwaway — 16 файлов тестов)

Движение/лейны + task-группы · бой + двухфазный захват · экономика + постройки + апгрейд · дипломатия-меню · чат коалиции + **пинги (коалиция / ЛС игроку)** · эскадрильи (вылет/топливо/патруль) · **цепочки команд** (пауза-на-отказе, план на карте, правка по шагу, 🔁 — PR #101) · дивизии/формации + мобилизация + наземный бой · артиллерия (режимы огня) · герои (грейды/респаун/модули) · радар/туман · **орбитальное AA как здание** + наземная оборона захвата · **шпионаж** играбелен · налоги/рынок · in-app APK-обновление · Back закрывает слои UI.

## Инфраструктура

- CI `security.yml`: `pnpm check` + `pnpm audit` + сканеры (Semgrep/CodeQL/Trivy/OSV/Gitleaks/TruffleHog/zizmor) — **информационный/не-блокирующий**.
- CI `android.yml`: сборка APK.

## Главные пробелы / блокеры

1. **Шов Stage 2↔3↔4:** сервер-гейт готов, но **envelope-клиент не подключён** → action-gate под флагом. Первый барьер к «честному онлайну».
2. **Клиентский app-shell (Этап 4):** идёт с CP0.1 (каркас Vite/PWA); играбельный UI пока только в прототипе (throwaway).
3. **OIDC-идентичность** (сейчас dev-grade mint JWT).
4. **EFX-1** — движок эффектов в ядре (трейты читаются точечно).
5. **Мультипроцессный масштаб сервера.**
6. **Метаигра / AvA-сектора** — отложено надолго.
