# Image Pinning и обновление sha256-дайджестов

Все scanner-образы в `security.yml` должны быть пинены по `sha256`-дайджесту, а не по тегу.
Это обеспечивает **воспроизводимость** и предотвращает **supply-chain атаки** через замену образа.

## Как получить sha256-дайджест образа

### Способ 1: используя docker (локально)

```bash
# Стандартный способ для любого образа
docker pull IMAGE:TAG
docker inspect IMAGE:TAG --format='{{index .RepoDigests 0}}'

# Пример:
docker pull zricethezav/gitleaks:v8.18.4
docker inspect zricethezav/gitleaks:v8.18.4 --format='{{index .RepoDigests 0}}'
# Output: zricethezav/gitleaks@sha256:abc123...
```

### Способ 2: используя skopeo (без Docker)

```bash
skopeo inspect docker://IMAGE:TAG --format '{{.Digest}}'

# Пример:
skopeo inspect docker://aquasec/trivy:0.58.2 --format '{{.Digest}}'
# Output: sha256:abc123...
```

### Способ 3: используя GitHub Container Registry API

```bash
# Для ghcr.io образов
curl -s "https://ghcr.io/v2/OWNER/REPO/manifests/TAG" \
  -H "Accept: application/vnd.oci.image.manifest.v1+json" | jq '.config.digest'
```

## Текущий статус пинов в security.yml

| Образ | Статус | Примечание |
|-------|--------|-----------|
| `semgrep/semgrep` | ✅ sha256 | Пинен по дайджесту |
| `zricethezav/gitleaks` | ⚠️ TAG | `v8.18.4` — нужен sha256 |
| `trufflesecurity/trufflehog` | ✅ sha256 | Пинен по дайджесту |
| `ghcr.io/google/osv-scanner` | ⚠️ TAG | `v1.9.1` — нужен sha256 |
| `aquasec/trivy` | ⚠️ TAG | `0.58.2` — нужен sha256 (используется 2 раза) |
| `anchore/syft` | ⚠️ TAG | `v1.20.0` — нужен sha256 (используется 2 раза) |
| `ghcr.io/zizmorcore/zizmor` | ✅ sha256 | Пинен по дайджесту |

## Процесс обновления дайджестов

1. **Получить новый дайджест** для версии образа (см. методы выше)
2. **Заменить в security.yml**: `image:tag` → `image@sha256:xxx`
3. **Обновить дату комментария** (line 23): `pinned from their :latest on 2026-07`
4. **Запустить pipeline** локально для проверки
5. **Коммитить с сообщением**: `sec: update scanner image digests`

## Почему это безопасно?

- **Immutability**: образ с дайджестом не может быть заменён (даже если tag будет перетегирован)
- **Audit trail**: в коммите видно, когда и на какую версию был обновлён образ
- **Supply-chain integrity**: защита от MITM и взлома registry

## Рекомендация

Обновляйте дайджесты **ежемесячно** или при выпуске новой версии сканера
для получения свежих правил обнаружения. Это не требует переписывания логики
сканирования, только обновления базы знаний.
