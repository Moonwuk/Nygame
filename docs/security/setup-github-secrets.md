# Настройка секретов и переменных в GitHub

Этот гайд поясняет, как правильно настроить CI/CD пайплайн в GitHub для безопасной работы.

## Чек-лист: что нужно сделать в GitHub UI

### 1. Настроить Protected Branch для `main`

**Путь:** Settings > Branches > Add rule

Правило для `main`:

- ✅ "Require a pull request before merging"
  - ✅ "Require status checks to pass before merging" (выбрать `ci` job)
  - ✅ "Require code reviews before merging" (требовать 1+ approvals)
  - ✅ "Dismiss stale pull request approvals"
- ✅ "Require branches to be up to date before merging"
- ✅ "Restrict who can push to matching branches" (only admins)

**Результат:** даже администраторы не могут напрямую push в `main`; только через PR с зелёными checks.

### 2. Настроить Repository Secrets (если требуются)

**Путь:** Settings > Secrets and variables > Actions > New repository secret

На данный момент проект **НЕ использует** внешние токены (AWS, Docker Hub, etc), но если будут:

```yaml
# Пример: если добавите AWS deploy
- name: Deploy to AWS
  uses: aws-actions/configure-aws-credentials@v4
  with:
    role-to-assume: ${{ secrets.AWS_ROLE_ARN }}
    aws-region: us-east-1

- run: aws s3 sync . s3://bucket/path
```

Тогда настроить:

```
Settings > Secrets and variables > Actions > New repository secret

Name: AWS_ROLE_ARN
Value: arn:aws:iam::123456789:role/github-actions-role
```

**Правило:** используйте OIDC (OpenID Connect) вместо долгоживущих токенов.

### 3. Environments (опционально, для production)

**Путь:** Settings > Environments > New environment

```
Name: production
Deployment branches: main only

Required reviewers: [your username]  # Требует ручного одобрения перед deploy
Secrets: [production-specific secrets]
```

## Текущее состояние проекта

### Что уже правильно настроено в `security.yml`:

✅ **Permissions — минимальные**
```yaml
permissions: {}  # Нет прав по умолчанию

jobs:
  check:
    permissions:
      contents: read  # Только читать

  report:
    permissions:
      contents: write  # Для создания commit comments
      pull-requests: write  # Для PR comments
```

✅ **Actions — SHA-пинены**
```yaml
- uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
  # ^— не @latest или @v7, а конкретный commit SHA
```

✅ **persist-credentials: false**
```yaml
- uses: actions/checkout@...
  with:
    persist-credentials: false  # Git credentials не остаются в .git/config
```

✅ **Переменные читаются через env**, не inline в run
```yaml
- name: example
  env:
    CHECK_OUTCOME: ${{ steps.check.outcome }}
  run: |
    echo "Status: $CHECK_OUTCOME"  # Безопасно, переменная не expand inline
```

### Что нужно улучшить (SEC-3):

⏳ **Docker images — пинить по sha256** (в процессе)
- Используйте скрипт: `./.github/scripts/update-image-digests.sh`
- Например: `zricethezav/gitleaks:v8.18.4` → `zricethezav/gitleaks@sha256:abc123...`

⏳ **Protected branch rule** (нужно сделать в UI GitHub вручную)
- Убедитесь, что `main` имеет правила выше

## Примеры: правильно vs неправильно

### ❌ НЕПРАВИЛЬНО: Secrets inline

```yaml
# ❌ ПЛОХО
- run: curl -H "Authorization: Bearer ${{ secrets.API_KEY }}" ...
  # API_KEY МОЖЕТ протечь в логах если curl упадёт
```

### ✅ ПРАВИЛЬНО: Secrets через env

```yaml
# ✅ ХОРОШО
- name: API call
  env:
    API_KEY: ${{ secrets.API_KEY }}
  run: curl -H "Authorization: Bearer $API_KEY" ...
  # API_KEY автоматически маскируется в логах
```

### ❌ НЕПРАВИЛЬНО: Action без SHA

```yaml
- uses: actions/setup-node@latest  # ❌ Может измениться в любой момент
- uses: actions/setup-node@v4      # ❌ Tag может быть переписан
```

### ✅ ПРАВИЛЬНО: Action с SHA

```yaml
- uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0
  # ^— конкретный commit SHA, immutable
```

### ❌ НЕПРАВИЛЬНО: Долгоживущие токены

```yaml
# ❌ ПЛОХО: Personal Access Token в secrets
env:
  GITHUB_TOKEN: ${{ secrets.PAT_TOKEN }}  # Жив 30 дней, может быть скомпрометирован
```

### ✅ ПРАВИЛЬНО: Автоматический токен

```yaml
# ✅ ХОРОШО
permissions:
  contents: read
  
# GitHub Actions автоматически генерирует ${{ secrets.GITHUB_TOKEN }}
# Жив только 1 час, одноразовый, уникален для каждого run
```

## Дополнительные слои защиты

### 1. Code owners (CODEOWNERS)

Файл `.github/CODEOWNERS`:

```
# Require review from security team for changes to workflows
.github/workflows/ @moonwuk/security

# Require review from release team for version files
package.json @moonwuk/release
```

### 2. Commit signing

Обязуйте все коммиты быть подписанными (GPG):

```
Settings > Branches > Branch protection rules > main
> ✅ Require commit signatures
```

### 3. Status checks

В branch protection:
- ✅ Require status checks to pass
  - Выбрать: `ci` (основной pipeline)
  - Выбрать: `security` (опционально, если хотите блокировать на sast/secret findings)

## Дальше: SEC-4, SEC-7

- **SEC-4:** SARIF aggregation → GitHub Code Scanning или DefectDojo
- **SEC-7:** Image signing (cosign) + SLSA provenance

---

**Вопросы или необходимые изменения?** Откройте PR или обновите этот документ.
