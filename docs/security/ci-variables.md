# CI-переменные и секреты: защита пайплайна

Безопасность пайплайна начинается с **защиты переменных окружения и секретов**.
GitHub Actions имеет встроенные механизмы для этого.

## Типы переменных в GitHub Actions

### 1. Regular variables (открытые)

```yaml
env:
  PUBLIC_VAR: value
```

Используйте для некритичных значений (версии, флаги, URLs).

### 2. Secrets (защищённые)

```yaml
env:
  SECRET_NAME: ${{ secrets.MY_SECRET }}
```

**Автоматически маскируются** в логах — невидимы даже в выводе.

### 3. Repository secrets

Настраиваются в GitHub UI: **Settings > Secrets and variables > Actions**

Доступны как `${{ secrets.SECRET_NAME }}` во всех workflows.

**Всегда используйте secrets для:**
- Токены (GitHub, API, Deploy)
- Ключи (SSH, API-ключи)
- Пароли
- Любые данные, которые не должны быть в логах

### 4. Environment secrets

Область видимости ограничена одной окружением (production, staging, etc).

Настраиваются в **Settings > Environments > [Name] > Secrets**.

## Методы маскирования (masking)

### Метод 1: встроенное маскирование Secrets

```yaml
- name: Use secret
  env:
    TOKEN: ${{ secrets.GITHUB_TOKEN }}
  run: |
    # TOKEN будет полностью заменён на *** в логах
    curl -H "Authorization: Bearer $TOKEN" https://api.example.com
```

**Результат в логе:**
```
curl -H "Authorization: Bearer ***" https://api.example.com
```

### Метод 2: явное маскирование в run

```yaml
- name: Explicit masking
  run: |
    echo "::add-mask::${{ secrets.API_KEY }}"
    # Все последующие выводы с этим значением будут заскрыты
```

### Метод 3: маскирование пользовательских значений

```bash
#!/bin/bash
# Задача: скрыть переменные в логах
SECRET_VALUE="something-sensitive"
echo "::add-mask::$SECRET_VALUE"
echo "Value is $SECRET_VALUE"  # В логах: "Value is ***"
```

## Protected branches и OIDC

### Protected branches (основной слой защиты)

В GitHub UI: **Settings > Branches > Branch protection rules > main**

Требуйте:
- ✅ "Require a pull request before merging"
- ✅ "Require status checks to pass before merging"
- ✅ "Require code reviews before merging"
- ✅ "Dismiss stale pull request approvals"
- ✅ "Require branches to be up to date before merging"

**Результат:** `security.yml` и другие pipeline не запускаются на push в `main`;
только на PR. Это предотвращает нежелательные изменения секретов/конфига.

### OIDC (OpenID Connect) вместо долгоживущих токенов

Используйте `${{ secrets.GITHUB_TOKEN }}` (автоматический) вместо PAT (Personal Access Token):

```yaml
# ❌ Плохо: долгоживущий токен
env:
  PAT: ${{ secrets.PAT_GITHUB }}

# ✅ Хорошо: автоматический GITHUB_TOKEN (1 час, одноразовый)
permissions:
  contents: read

steps:
  - uses: actions/upload-artifact@v4
    with:
      # GitHub Actions OIDC автоматически используется
```

Для доступа к внешним сервисам (AWS, GCP, Azure):

```yaml
- name: OIDC Token (AWS)
  uses: aws-actions/configure-aws-credentials@v4
  with:
    role-to-assume: arn:aws:iam::123456789:role/github-actions
    aws-region: us-east-1
```

## Least Privilege в security.yml

Текущий конфиг уже использует правильные permissions:

```yaml
permissions: {}  # По умолчанию нет прав

jobs:
  check:
    permissions:
      contents: read  # Только читать код
  
  report:
    permissions:
      contents: write  # Для commit comments
      pull-requests: write  # Для PR comments
      issues: write  # Для issue comments
```

Каждый job указывает **только** нужные permissions, не больше.

## Окружение и защита

Если используете Environments:

```yaml
jobs:
  deploy:
    environment: production  # требует утверждения
    runs-on: ubuntu-latest
```

Настройка в UI: **Settings > Environments > production**
- Required reviewers: 2 человека
- Secrets: доступны только в этом окружении

## Checklist безопасности пайплайна

- [ ] Все Action SHA-пинены (не `@latest` или `@v1.2.3`)
- [ ] Все Docker-образы SHA-пинены (не только по тегу)
- [ ] Используются `secrets.GITHUB_TOKEN`, а не PAT
- [ ] Секреты используются в `env:` (автоматическое маскирование)
- [ ] Нет хардкода токенов/ключей в коде
- [ ] Protected branches требуют green checks перед merge
- [ ] Permissions — минимальные для каждого job
- [ ] Логи проверены на утечку чувствительных данных
- [ ] Docker registry требует подпись образов (cosign)

## Дальше: SEC-7 (Supply-chain)

После обновления образов на sha256, следующий шаг (SEC-7):
- **Cosign** для подписи образов
- **SLSA provenance** для доказательства происхождения артефактов
- **Проверка подписей** на деплое
