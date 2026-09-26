#!/usr/bin/env bash
# End-to-end deploy script matching deploy/README.md step by step. This is a
# convenience wrapper, not a black box -- read README.md first; every command
# here is explained in more detail there.
set -euo pipefail

: "${PROJECT_ID:?Set PROJECT_ID to your GCP project}"
: "${REGION:=us-central1}"
: "${CLIENT_ID:?Set CLIENT_ID (Azure App Registration)}"
: "${CLIENT_SECRET:?Set CLIENT_SECRET (Azure App Registration)}"
: "${TENANT_ID:=organizations}"

BUCKET_NAME="${BUCKET_NAME:-${PROJECT_ID}-mstodo-token-cache}"
SERVICE_NAME="${SERVICE_NAME:-microsoft-todo-mcp-server}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/mstodo/microsoft-todo-mcp-server:latest"

# The /mcp endpoint is gated by a shared secret (see src/http-transport.ts).
# Generated once and reused from these gitignored files on later deploys, so
# redeploying doesn't break an already-configured Claude connector.
random_secret() { head -c 64 /dev/urandom | od -An -tx1 | tr -d ' 
' | head -c "$1"; }
if [ -z "${MCP_SHARED_SECRET:-}" ]; then
  [ -f .cloudrun-secret ] || random_secret 48 > .cloudrun-secret
  MCP_SHARED_SECRET="$(cat .cloudrun-secret)"
fi
if [ -z "${MCP_SECRET_PATH:-}" ]; then
  [ -f .cloudrun-path ] || random_secret 32 > .cloudrun-path
  MCP_SECRET_PATH="$(cat .cloudrun-path)"
fi

echo "== 1/5: bucket for the token cache =="
if ! gcloud storage buckets describe "gs://${BUCKET_NAME}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://${BUCKET_NAME}" \
    --project="${PROJECT_ID}" --location="${REGION}" --uniform-bucket-level-access
fi

if [ -f ./tokens.json ]; then
  echo "Seeding bucket with local tokens.json (run 'pnpm run auth' first if this doesn't exist yet)"
  gcloud storage cp ./tokens.json "gs://${BUCKET_NAME}/tokens.json"
else
  echo "WARNING: no local tokens.json found -- skipping seed. The deployed service will report" \
    "'Not authenticated' until gs://${BUCKET_NAME}/tokens.json exists."
fi

echo "== 2/5: artifact registry repo (idempotent) =="
gcloud artifacts repositories create mstodo \
  --repository-format=docker --location="${REGION}" --project="${PROJECT_ID}" 2>/dev/null || true

echo "== 3/5: build image via Cloud Build (no local Docker required) =="
gcloud builds submit --project="${PROJECT_ID}" --tag "${IMAGE}" .

echo "== 4/5: deploy, with the bucket mounted as a volume =="
gcloud run deploy "${SERVICE_NAME}" \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --image="${IMAGE}" \
  --execution-environment=gen2 \
  --add-volume=name=token-cache,type=cloud-storage,bucket="${BUCKET_NAME}" \
  --add-volume-mount=volume=token-cache,mount-path=/mnt/token-cache \
  --set-env-vars="MCP_TRANSPORT=http,MSTODO_TOKEN_FILE=/mnt/token-cache/tokens.json,CLIENT_ID=${CLIENT_ID},CLIENT_SECRET=${CLIENT_SECRET},TENANT_ID=${TENANT_ID},MCP_SHARED_SECRET=${MCP_SHARED_SECRET},MCP_SECRET_PATH=${MCP_SECRET_PATH}" \
  --min-instances=1 \
  --max-instances=1 \
  --allow-unauthenticated \
  --port=8080

echo "== 5/5: grant the runtime service account access to the bucket =="
SERVICE_ACCOUNT=$(gcloud run services describe "${SERVICE_NAME}" \
  --project="${PROJECT_ID}" --region="${REGION}" \
  --format="value(spec.template.spec.serviceAccountName)")

gcloud storage buckets add-iam-policy-binding "gs://${BUCKET_NAME}" \
  --member="serviceAccount:${SERVICE_ACCOUNT}" \
  --role="roles/storage.objectUser"

SERVICE_URL=$(gcloud run services describe "${SERVICE_NAME}" \
  --project="${PROJECT_ID}" --region="${REGION}" --format="value(status.url)")

echo ""
echo "Deployed: ${SERVICE_URL}"
echo "Verify with: curl ${SERVICE_URL}/healthz"
echo ""
echo "Claude connector URL (no header needed):"
echo "  ${SERVICE_URL}/${MCP_SECRET_PATH}/mcp"
echo "Or, if the client can send headers:"
echo "  URL:    ${SERVICE_URL}/mcp"
echo "  Header: Authorization: Bearer <contents of .cloudrun-secret>"
