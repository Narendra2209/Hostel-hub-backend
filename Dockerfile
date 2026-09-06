# Hostel Hub API - Lambda container image.
#
# Next.js is built with `output: 'standalone'` and run behind the AWS Lambda Web
# Adapter, which translates API Gateway events into ordinary HTTP requests
# against the Next server on port 4000. The same image runs unchanged under
# `docker run -p 4000:4000`, so what is tested locally is what ships.
#
# Build context is this repository's root:
#   docker build -t hostel-api .

# ---------------------------------------------------------------- deps
FROM node:22-slim AS deps
WORKDIR /app

# OpenSSL is required by Prisma's query engine.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy only the manifests first so a code change does not bust the npm cache.
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY infrastructure/package.json ./infrastructure/

RUN npm ci --ignore-scripts

# ---------------------------------------------------------------- build
FROM deps AS builder
WORKDIR /app

COPY . .

# The shared contract package compiles to dist/ before anything imports it.
RUN npm run build --workspace @hostel/shared

# Generate the Prisma client, then build Next. A build-time DATABASE_URL is
# required by the schema but never connected to - the real one is resolved from
# Secrets Manager at runtime by lambda-bootstrap.mjs.
ENV DATABASE_URL="mongodb://build:build@localhost:27017/build"
ENV NEXT_TELEMETRY_DISABLED=1
RUN npx prisma generate && npx next build

# ---------------------------------------------------------------- runtime
FROM node:22-slim AS runner
WORKDIR /var/task

RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# The Lambda Web Adapter runs as an extension and proxies the function's
# invocation to a normal HTTP server inside the container.
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:0.9.0 /lambda-adapter /opt/extensions/lambda-adapter

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=4000 \
    HOSTNAME=0.0.0.0 \
    AWS_LWA_PORT=4000 \
    AWS_LWA_READINESS_CHECK_PATH=/api/health

# Next's standalone output already contains the traced subset of node_modules.
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# Prisma's engine is a native binary that file tracing can miss; copy the
# generated client explicitly so a cold start never fails looking for it.
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma/client ./node_modules/@prisma/client

# The Secrets Manager client used by the bootstrap below.
COPY --from=builder /app/node_modules/@aws-sdk ./node_modules/@aws-sdk
COPY --from=builder /app/node_modules/@smithy ./node_modules/@smithy

# The schema, so `prisma db push` can be run from this image if ever needed.
# MongoDB has no migration files - indexes are applied by db push.
COPY --from=builder /app/prisma ./prisma

COPY lambda-bootstrap.mjs ./lambda-bootstrap.mjs

# Run as a non-root user.
RUN groupadd --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid nodejs nextjs \
    && chown -R nextjs:nodejs /var/task
USER nextjs

EXPOSE 4000

# The bootstrap resolves DATABASE_URL and JWT_SECRET from Secrets Manager, then
# hands over to the Next standalone server.
CMD ["node", "lambda-bootstrap.mjs"]
