# Multi-stage build: the build stage has the full pnpm workspace and
# devDependencies (ts-builds/tsdown, TypeScript); the runtime stage only gets
# the compiled dist/ output and production dependencies, which keeps the
# deployed image small and out of reach of build tooling that has no business
# running in production.

FROM node:22-slim AS build
WORKDIR /app

# Matches the packageManager field in package.json (pnpm 11) so this build
# uses the exact same package manager version CI validates against.
RUN corepack enable

# Copy only what's needed to resolve dependencies first, so Docker's layer
# cache is reused on every rebuild that doesn't touch package.json/the
# lockfile -- avoids a full pnpm install on every source change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN CI=true pnpm install --frozen-lockfile

COPY tsconfig.json tsdown.config.ts ts-builds.config.json ./
COPY src ./src
RUN pnpm run build

FROM node:22-slim AS runtime
WORKDIR /app
RUN corepack enable

ENV NODE_ENV=production
# Cloud Run's default transport for this image; overridden to "stdio" is
# meaningless here since nothing is attached to this container's stdin, but
# left as an explicit env var (rather than hardcoded) so the same image can
# be run locally with `-e MCP_TRANSPORT=stdio` for a quick sanity check.
ENV MCP_TRANSPORT=http

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN CI=true pnpm install --frozen-lockfile --prod

COPY --from=build /app/dist ./dist

# Cloud Run injects PORT and expects the container to listen on it --
# http-transport.ts already reads process.env.PORT (default 8080).
EXPOSE 8080

CMD ["node", "dist/todo-index.js"]
