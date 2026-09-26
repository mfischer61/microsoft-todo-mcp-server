# Deploying to Cloud Run

## Why Cloud Run (and not Cloud Functions / GKE / a VM)

- **Not Cloud Functions**: Cloud Functions doesn't support mounting a Cloud Storage bucket as a
  filesystem volume. The whole point of this deployment is that `token-store.ts` should not have
  to know it's talking to GCS — it just reads and writes a file. Cloud Functions would force
  either a real GCS client SDK integration or an external database, both bigger changes than
  the problem (cache one small JSON file across cold starts) justifies.
- **Not GKE**: a single small stateless HTTP server for one personal MCP integration doesn't need
  a Kubernetes control plane. GKE is the right call when you need custom networking, multiple
  services, or fine-grained scheduling — none of which apply here.
- **Cloud Run (gen2 execution environment)**: scales to zero when idle, bills per-request, takes
  a container image directly, and — the deciding feature for this project — natively supports
  [Cloud Storage FUSE volume mounts](https://docs.cloud.google.com/run/docs/configuring/services/cloud-storage-volume-mounts),
  so a bucket can be mounted at a path in the container's filesystem with zero application code
  written against the GCS API.

## Prerequisites

- A GCP project with billing enabled and the Cloud Run, Artifact Registry, and Cloud Storage
  APIs enabled.
- `gcloud` CLI authenticated (`gcloud auth login`) with a project set (`gcloud config set project
PROJECT_ID`).
- An Azure App Registration already set up (see the main README's "Azure App Registration"
  section) — you need `CLIENT_ID`, `CLIENT_SECRET`, and `TENANT_ID` regardless of where this runs.
- You've already run `pnpm run auth` once (locally) to produce an initial `tokens.json` — Cloud
  Run only refreshes an existing token, it doesn't perform the first interactive OAuth flow.

> **Note on gcloud syntax**: the flags below (`--add-volume`, `--add-volume-mount`,
> `--execution-environment`) reflect Cloud Run's GA Cloud Storage volume mount support. gcloud's
> flag surface does shift over time — run `gcloud run deploy --help` and diff against this file
> before you rely on it, especially if any command below errors with "unrecognized arguments".

## 1. Create the bucket for the token cache

```bash
export PROJECT_ID="your-gcp-project"
export REGION="us-central1"
export BUCKET_NAME="${PROJECT_ID}-mstodo-token-cache"

gcloud storage buckets create "gs://${BUCKET_NAME}" \
  --project="${PROJECT_ID}" \
  --location="${REGION}" \
  --uniform-bucket-level-access

# Seed it with the tokens.json you already produced locally via `pnpm run auth`.
# This is the ONLY manual token bootstrap step -- after this, refreshes keep
# the bucket up to date on their own.
gcloud storage cp ./tokens.json "gs://${BUCKET_NAME}/tokens.json"
```

## 2. Build and push the image

```bash
export IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/mstodo/microsoft-todo-mcp-server:latest"

gcloud artifacts repositories create mstodo \
  --repository-format=docker \
  --location="${REGION}" \
  --project="${PROJECT_ID}" 2>/dev/null || true # ok if it already exists

gcloud auth configure-docker "${REGION}-docker.pkg.dev"
docker build -t "${IMAGE}" .
docker push "${IMAGE}"
```

(Or skip the local Docker build entirely with `gcloud builds submit --tag "${IMAGE}"`, which
builds in Cloud Build instead of locally — that's what `deploy.sh` in this directory does.)

## 3. Deploy, with the bucket mounted as a volume

```bash
export SERVICE_NAME="microsoft-todo-mcp-server"
# Required: the HTTP transport won't start without these (see below).
export MCP_SHARED_SECRET="$(openssl rand -hex 24)"
export MCP_SECRET_PATH="$(openssl rand -hex 16)"

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
```

Two flags are load-bearing, not defaults left in by habit:

- **`--min-instances=1 --max-instances=1`**: pins the service to exactly one instance. The
  in-process refresh mutex added in `token-manager.ts` only protects one process from racing
  itself; it cannot stop two separate instances from both refreshing at once. Pinning to one
  instance is what makes that guarantee actually hold in production. It also means this
  deployment does not scale to zero and does not scale out under load — an acceptable tradeoff
  for a single personal task-management integration, not a decision to make silently on a
  service meant to handle real traffic.
- **`--allow-unauthenticated`**: lets hosted agents (claude.ai custom connectors) reach the
  service without Google IAM credentials. The app enforces its own gate instead: every `/mcp`
  request must send `Authorization: Bearer ${MCP_SHARED_SECRET}`, or call
  `/${MCP_SECRET_PATH}/mcp`, where the unguessable path is itself the credential (for connector
  UIs that can't set headers). The server refuses to start in HTTP mode if neither variable is
  set, and both must be at least 16 characters. `/healthz` stays open for Cloud Run's probes.
  Generate them with e.g. `openssl rand -hex 24`; `deploy.sh` does this for you and saves them
  to the gitignored `.cloudrun-secret` / `.cloudrun-path`. Note the secret path appears in
  Cloud Run request logs, so prefer the header when the client supports it.

## 4. Grant the runtime service account access to the bucket

```bash
export SERVICE_ACCOUNT=$(gcloud run services describe "${SERVICE_NAME}" \
  --project="${PROJECT_ID}" --region="${REGION}" \
  --format="value(spec.template.spec.serviceAccountName)")

gcloud storage buckets add-iam-policy-binding "gs://${BUCKET_NAME}" \
  --member="serviceAccount:${SERVICE_ACCOUNT}" \
  --role="roles/storage.objectUser"
```

`roles/storage.objectUser` grants read/write on objects but not bucket-level admin actions
(deleting the bucket, changing IAM) — the runtime only ever needs to read and overwrite one
object, so this is the least-privilege role that still works with FUSE writes.

## 5. Verify

```bash
export SERVICE_URL=$(gcloud run services describe "${SERVICE_NAME}" \
  --project="${PROJECT_ID}" --region="${REGION}" --format="value(status.url)")

curl "${SERVICE_URL}/healthz"
# {"status":"ok"}
```

Then point an MCP-over-HTTP-capable client at `${SERVICE_URL}/mcp`.

## Rolling back / rotating credentials

- **New Azure client secret**: `gcloud run services update "${SERVICE_NAME}" --update-env-vars
CLIENT_SECRET=...` — this doesn't touch the token cache, only how future refreshes authenticate.
- **Force re-auth from scratch**: delete `gs://${BUCKET_NAME}/tokens.json`, run `pnpm run auth`
  locally again, and re-upload it with the `gcloud storage cp` command from step 1.
- **Roll back a bad image**: `gcloud run services update-traffic "${SERVICE_NAME}" --to-revisions
PREVIOUS_REVISION=100` — standard Cloud Run revision rollback, nothing specific to this project.

See `service.yaml` in this directory for the same configuration expressed declaratively
(`gcloud run services replace service.yaml`), and `deploy.sh` for all of the above scripted
end-to-end.
