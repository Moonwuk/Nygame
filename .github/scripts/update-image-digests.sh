#!/bin/bash
# Update docker image digests in security.yml to latest sha256 hashes
# Usage: ./.github/scripts/update-image-digests.sh

set -e

SECURITY_YML=".github/workflows/security.yml"
TEMP_FILE=$(mktemp)

if [ ! -f "$SECURITY_YML" ]; then
  echo "Error: $SECURITY_YML not found"
  exit 1
fi

cp "$SECURITY_YML" "$TEMP_FILE"

# Define images that need sha256 pinning: TAG-only
declare -A IMAGES=(
  ["zricethezav/gitleaks"]="v8.18.4"
  ["ghcr.io/google/osv-scanner"]="v1.9.1"
  ["aquasec/trivy"]="0.58.2"
  ["anchore/syft"]="v1.20.0"
)

get_digest() {
  local image=$1
  local tag=$2

  echo "Fetching digest for $image:$tag..." >&2

  # Try docker first (requires local docker)
  if command -v docker &>/dev/null; then
    docker pull "$image:$tag" >/dev/null 2>&1 && \
    docker inspect --format='{{index .RepoDigests 0}}' "$image:$tag" 2>/dev/null | cut -d'@' -f2 && \
    return 0
  fi

  # Fallback to skopeo if docker unavailable
  if command -v skopeo &>/dev/null; then
    skopeo inspect "docker://$image:$tag" --format '{{.Digest}}' 2>/dev/null | sed 's/^sha256://' && \
    return 0
  fi

  # Last resort: GitHub API for ghcr.io
  if [[ $image == ghcr.io/* ]]; then
    local repo="${image#ghcr.io/}"
    curl -s "https://ghcr.io/v2/$repo/manifests/$tag" \
      -H "Accept: application/vnd.oci.image.manifest.v1+json" 2>/dev/null | \
      grep -o '"digest":"sha256:[^"]*' | sed 's/"digest":"//' && \
      return 0
  fi

  echo "⚠️  Could not fetch digest for $image:$tag" >&2
  return 1
}

echo "Updating image digests in $SECURITY_YML..."
echo ""

for image in "${!IMAGES[@]}"; do
  tag=${IMAGES[$image]}
  digest=$(get_digest "$image" "$tag" 2>/dev/null) || digest="<digest-here>"

  if [ "$digest" != "<digest-here>" ]; then
    echo "✓ $image:$tag → sha256:${digest:0:12}..."

    # Replace in file: image:tag with image@sha256:digest
    # Escape special chars for sed
    image_escaped=$(printf '%s\n' "$image" | sed -e 's/[\/&]/\\&/g')
    tag_escaped=$(printf '%s\n' "$tag" | sed -e 's/[\/&]/\\&/g')
    digest_escaped=$(printf '%s\n' "$digest" | sed -e 's/[\/&]/\\&/g')

    # Replace all occurrences: image:tag → image@sha256:digest
    sed -i "s/$image_escaped:$tag_escaped/$image_escaped@sha256:$digest_escaped/g" "$TEMP_FILE"
  else
    echo "⚠️  Could not fetch digest for $image:$tag"
  fi
done

echo ""
echo "Updated file: $TEMP_FILE"
echo "Changes:"
diff -u "$SECURITY_YML" "$TEMP_FILE" || true

echo ""
read -p "Apply changes? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
  mv "$TEMP_FILE" "$SECURITY_YML"
  echo "✓ Updated $SECURITY_YML"

  # Update the pinning date comment
  date_comment="pinned from their :latest on $(date +%Y-%m)"
  sed -i "s/pinned from their :latest on [0-9-]*/pinned from their :latest on $(date +%Y-%m)/g" "$SECURITY_YML"
  echo "✓ Updated pinning date comment"
else
  rm "$TEMP_FILE"
  echo "Cancelled."
fi
