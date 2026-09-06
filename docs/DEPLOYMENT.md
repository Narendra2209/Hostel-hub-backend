# Deployment

Three CDK stacks, one Docker image, one static bundle, and a MongoDB Atlas
cluster that lives outside your AWS account. Everything below is real — the npm
commands exist in a `package.json`, the environment variables exist in
`lib/env.ts` or `the frontend repository (src/config.ts)`, and the resource names come
from `infrastructure/lib/*.ts`.

Follow the steps in order. Two of them are easy to get wrong in ways that
produce confusing failures, so they are called out as they arrive:

- **Step 3**, the Atlas allow-list. Skip it and the API hangs and times out.
- **Step 5**, filling in the secret. Do it carelessly and you wipe the generated
  `JWT_SECRET` and the Lambda refuses to boot.

---

## What gets created

| Stack | Name | Contains |
| --- | --- | --- |
| Network | `hostel-<stage>-network` | VPC across 2 AZs; public and private-with-egress subnets; NAT gateway(s) with **static Elastic IPs**; S3 gateway endpoint; Secrets Manager and CloudWatch Logs interface endpoints; the Lambda security group |
| Web | `hostel-<stage>-web` | Private S3 site bucket `hostel-<stage>-web-<account>`, CloudFront with Origin Access Control, security-headers policy, SPA 403/404 rewrites, optional WAF |
| Api | `hostel-<stage>-api` | Lambda container image (Next.js + Lambda Web Adapter) in the VPC, HTTP API Gateway with throttling and access logs, one Secrets Manager secret `hostel-<stage>/app`, two CloudWatch alarms |

There is **no database stack** — MongoDB Atlas is managed in Atlas, not in
CloudFormation. There is **no auth stack** — the application owns its accounts,
hashes its own passwords and signs its own session tokens. There is **no storage
stack** — resident photos and Aadhaar documents live in MongoDB GridFS, in the
same cluster as everything else.

Stages are `dev`, `staging` and `prod`; the prefix is always `hostel-<stage>`.
Sizing, retention, NAT gateway count, session lifetime and WAF are per-stage
defaults in `infrastructure/lib/config.ts`.

---

## 1. Prerequisites

- **An AWS account** and credentials able to create VPC, EC2 (NAT, Elastic IP),
  Lambda, ECR, API Gateway, S3, CloudFront, Secrets Manager, CloudWatch and IAM
  resources. `aws sts get-caller-identity` should show the right account.
- **AWS CLI v2**, **Node.js 20+**, **npm 10+**, and `jq` (used to merge the
  secret in step 5 without clobbering it).
- **Docker, running.** The API stack ships the Lambda as a container image built
  from `Dockerfile`. `cdk synth` only stages the build context, but
  `cdk deploy` performs a real `docker build` and pushes to ECR. No Docker
  daemon, no API deploy.
- **A MongoDB Atlas account.** Step 2 creates the cluster.
- `npm install` at the repository root — the CDK app runs from TypeScript source
  via `ts-node`.
- For a custom domain: an ACM certificate **in `us-east-1`** covering it, and a
  DNS zone you can point at the CloudFront distribution.

### CDK bootstrap

Once per account and region:

```bash
cd infrastructure
npm run cdk -- bootstrap aws://123456789012/ap-south-1
```

For **`stage=prod`** also bootstrap `us-east-1`. A CloudFront web ACL must live
there, so the whole web stack is pinned to `us-east-1` when WAF is enabled (the
prod default) and CDK needs a bootstrap stack in both regions:

```bash
npm run cdk -- bootstrap aws://123456789012/us-east-1
```

### Running the CDK CLI

Run CDK **from the `infrastructure/` directory** whenever you need context
flags. The root `npm run cdk` wrapper re-enters `npm run`, and npm swallows `-c`
before CDK ever sees it.

```bash
cd infrastructure
npm run cdk -- <command> [-c key=value …]
```

Context flags, read by `resolveConfig` in `infrastructure/lib/config.ts`:

| Flag | Environment fallback | Default | Meaning |
| --- | --- | --- | --- |
| `stage` | `STAGE` | `dev` | `dev`, `staging` or `prod`. Anything else is rejected. Drives every sizing and retention default and the `hostel-<stage>` prefix. |
| `account` | `CDK_DEPLOY_ACCOUNT`, `CDK_DEFAULT_ACCOUNT` | from your credentials | Target AWS account id. **Required for `prod`**, because the WAF-pinned web stack uses cross-region references. |
| `region` | `CDK_DEPLOY_REGION`, `CDK_DEFAULT_REGION` | `ap-south-1` | Target region for everything except the prod web stack. |
| `webDomainName` | — | none | Custom domain for the SPA. Also added to the API's CORS allow-list. Needs `certificateArn`. |
| `certificateArn` | — | none | ACM certificate ARN **in `us-east-1`**. Ignored unless `webDomainName` is also set. |
| `alarmEmail` | `ALARM_EMAIL` | none | Accepted by the config, but no SNS subscription is wired up yet — subscribe to the alarms in the CloudWatch console until it is. |
| `adminEmail` | `BOOTSTRAP_ADMIN_EMAIL` | none | Vestigial. It no longer creates any account — the first owner is created in the app (step 8). Ignore it. |

---

## 2. Create the Atlas cluster

Do this before deploying anything, but leave it half-configured on purpose: the
allow-list cannot be filled in until AWS has told you the NAT addresses.

1. In Atlas, create a project, then **Build a Cluster**. **M0 (free) is enough to
   start** and is a real replica set, which is what matters — the app writes each
   mutation and its audit row in one multi-document transaction, and MongoDB only
   offers transactions on a replica set. Every Atlas tier, M0 included, is one.
   Pick the region closest to your AWS region to keep the round trip short.

   > M0 has **no automated backups and no point-in-time restore**. It is fine for
   > evaluating the system and wrong for real financial records. Plan on M10 or
   > above before the first real payment is entered, and read "A bad schema push
   > or a bad write" under Rolling back before you decide otherwise.

2. **Database Access → Add New Database User.** Password authentication, a strong
   generated password, role `readWrite` on the application database (or
   `readWriteAnyDatabase` if you would rather not name it yet). Save the password
   in your password manager now — Atlas will not show it again.

   If the password contains `@ : / ? # [ ] %` or a space, **percent-encode it**
   before putting it in the connection string, or the URL will not parse.

3. **Network Access — leave it empty for now.** Do not add `0.0.0.0/0` "just to
   get going"; it is very easy to forget, and it is the control that step 3
   depends on. You will fill it in with two addresses in a moment.

4. Copy the connection string from **Connect → Drivers**. It looks like:

   ```
   mongodb+srv://<username>:<password>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
   ```

   Add the database name before the `?`, because `lib/env.ts` expects
   the connection string to name it:

   ```
   mongodb+srv://<username>:<password>@cluster0.xxxxx.mongodb.net/hostel?retryWrites=true&w=majority
   ```

   Keep this somewhere safe. It goes into Secrets Manager in step 5 and nowhere
   else — never into a file in the repository, never into a Lambda environment
   variable, never into a CI log.

---

## 3. Deploy the network stack and allow-list its addresses

**This is the step people skip, and skipping it produces a symptom that does not
look like a firewall problem: the API returns 500s and the logs show a MongoDB
server-selection timeout after 30 seconds.**

```bash
cd infrastructure
npm run cdk -- deploy hostel-prod-network -c stage=prod -c account=123456789012
```

Read the outputs:

```bash
aws cloudformation describe-stacks --stack-name hostel-prod-network \
  --query "Stacks[0].Outputs" --output table
```

You want **`AtlasAllowList`** — a comma-separated list of the NAT gateways'
Elastic IPs (one address for `dev` and `staging`, two for `prod`):

```
AtlasAllowList    13.234.56.78, 13.235.90.12
```

Now go to **Atlas → Network Access → Add IP Address** and add each one as a `/32`
entry, with a comment naming the stage:

```
13.234.56.78/32    hostel-prod NAT az1
13.235.90.12/32    hostel-prod NAT az2
```

### Why this matters

The database is on the public internet. Atlas requires TLS and a password, but a
password is a single secret, and a single secret can leak — into a screenshot, a
log line, a shell history, a backup of someone's laptop. The allow-list is the
second control: even holding the connection string, an attacker cannot use it
from anywhere except those two addresses.

That is the entire reason the Lambda runs inside a VPC. A Lambda with no VPC has
no stable outbound address, which forces Atlas to allow `0.0.0.0/0` and leaves
the password as the only thing standing between a leak and your data. Putting the
function in a private subnet behind a NAT gateway with a static Elastic IP gives
Atlas exactly one address to trust.

It is not free. See "What this costs" at the end.

You will also need to allow-list **your own machine** temporarily for step 6, and
remove it afterwards.

---

## 4. Deploy the remaining stacks

Order matters and CDK resolves it from `infrastructure/bin/app.ts`:

```
network → web → api
```

Web comes before api because the API's CORS allow-list (`FRONTEND_URL`) is built
from the site origin.

```bash
cd infrastructure
npm run cdk -- diff --all -c stage=prod -c account=123456789012
npm run cdk -- deploy --all -c stage=prod -c account=123456789012 --require-approval broadening
```

The first full deploy takes roughly 15–25 minutes; the CloudFront distribution
and the first Docker build and ECR push are the slow parts.

Collect the outputs:

```bash
aws cloudformation describe-stacks --stack-name hostel-prod-web \
  --query "Stacks[0].Outputs" --output table
aws cloudformation describe-stacks --stack-name hostel-prod-api \
  --query "Stacks[0].Outputs" --output table
```

You want `SiteBucketName`, `DistributionId`, `SiteUrl`, `ApiEndpoint`,
`ApiBaseUrl` and `AppSecretArn`.

> The prod web stack lives in `us-east-1` because WAF is enabled there; pass
> `--region us-east-1` to `describe-stacks` for that one.

The API is deployed but **not yet working** — its secret has no connection string
in it. The Lambda will start, fail with `The application secret has no
DATABASE_URL`, and log that. Step 5 fixes it.

---

## 5. Fill in the application secret

`infrastructure/lib/api-stack.ts` creates one Secrets Manager secret named
`hostel-<stage>/app` holding two keys:

| Key | Created as | Filled in by |
| --- | --- | --- |
| `JWT_SECRET` | a 64-character value **generated by CloudFormation** | nobody — leave it alone |
| `DATABASE_URL` | an **empty string** | you, now |

`JWT_SECRET` is generated inside CloudFormation precisely so that a strong value
exists from the first deploy and never passes through a shell, a terminal
history or a CI log. Your job is to add `DATABASE_URL` **without touching it**.

> **The mistake to avoid.** `put-secret-value` replaces the *entire* secret
> string. Running
> `aws secretsmanager put-secret-value --secret-id hostel-prod/app --secret-string '{"DATABASE_URL":"mongodb+srv://…"}'`
> silently deletes `JWT_SECRET`, and the next cold start dies with
> `The application secret has no JWT_SECRET` (`lambda-bootstrap.mjs`).
> If you have already done it, generate a replacement and follow "Rotating
> JWT_SECRET" below — everyone is signed out, but nothing is lost.

Read the current secret, merge, write it back:

```bash
STAGE=prod
SECRET_ID="hostel-${STAGE}/app"

# 1. Read what is there now.
current=$(aws secretsmanager get-secret-value \
  --secret-id "$SECRET_ID" \
  --query SecretString --output text)

# 2. Merge in DATABASE_URL, leaving every other key untouched.
#    Read the connection string from a prompt so it never enters shell history.
read -rs -p "Atlas connection string: " ATLAS_URL; echo
updated=$(printf '%s' "$current" | jq --arg url "$ATLAS_URL" '.DATABASE_URL = $url')

# 3. Write it back through a file, not an argument: anything passed as a CLI
#    argument is visible in `ps` to every other user on the machine.
umask 077
tmp=$(mktemp)
printf '%s' "$updated" > "$tmp"
aws secretsmanager put-secret-value --secret-id "$SECRET_ID" --secret-string "file://$tmp"
rm -f "$tmp"
unset ATLAS_URL current updated
```

Verify both keys are present, **without printing either value**:

```bash
aws secretsmanager get-secret-value --secret-id "hostel-${STAGE}/app" \
  --query SecretString --output text \
  | jq 'to_entries | map({ key: .key, set: (.value | length > 0) })'
```

```json
[
  { "key": "DATABASE_URL", "set": true },
  { "key": "JWT_SECRET", "set": true }
]
```

### Make the running Lambda pick it up

`lambda-bootstrap.mjs` reads the secret **once per execution environment**, on
cold start, and reuses it for every warm invocation. Containers that are already
warm keep the old (empty) value. Force a rollout by changing the function
configuration, which drains the existing execution environments:

```bash
aws lambda update-function-configuration \
  --function-name "hostel-${STAGE}-api" \
  --description "app secret updated $(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

The health endpoint reports the database specifically, and answers `503` with
`"database": false` when the connection is not working — which is exactly what
you will see until step 6 has created the collections:

```bash
curl -s "https://abc123.execute-api.ap-south-1.amazonaws.com/api/health" | jq
```

### What else the Lambda is configured with

Everything non-secret is a plain environment variable set by the API stack in
`infrastructure/lib/api-stack.ts`:

| Variable | Source | Read by |
| --- | --- | --- |
| `DATABASE_URL`, `JWT_SECRET` | the secret above, injected at cold start — never a Lambda environment variable | `lib/env.ts` |
| `SESSION_TTL_HOURS` | `config.sessionTtlHours` — 8 in prod, 12 elsewhere | `lib/env.ts` |
| `FRONTEND_URL` | the CloudFront origin (plus `http://localhost:5173` outside prod), comma-separated | `lib/env.ts` |
| `MAX_UPLOAD_MB` | `config.maxUploadMb` — 15 | `lib/env.ts` |
| `LOG_LEVEL` | `info` in prod, `debug` elsewhere | `lib/env.ts` |
| `APP_SECRET_ARN` | the ARN of `hostel-<stage>/app` | `lambda-bootstrap.mjs`, before Next starts |
| `AWS_LWA_*` | fixed values | the Lambda Web Adapter extension |

`lib/env.ts` is the authoritative list of what the application itself
reads; anything not set above falls back to the default declared there.

---

## 6. Apply the schema

There are **no migration files**. Prisma's MongoDB connector has no migration
engine and no migration history: `prisma db push` reads
`prisma/schema.prisma`, compares it with the live database, and creates
the collections and the declared indexes. Unique constraints *are* indexes on
MongoDB, so this step is what makes "one active resident per bed" and "one email
per user" actually enforced.

Run it from a machine whose IP is **allow-listed in Atlas** — your laptop, with a
temporary Network Access entry you remove afterwards, is the normal choice. Add
your current address first:

```bash
curl -s https://checkip.amazonaws.com   # -> add this as a /32 in Atlas
```

Then, from the repository root:

```bash
export DATABASE_URL='mongodb+srv://<username>:<password>@cluster0.xxxxx.mongodb.net/hostel?retryWrites=true&w=majority'
npm run db:push
```

`npm run db:push` runs `prisma db push` with `backend` as its working directory.
The Prisma CLI loads `.env` if that file exists, but a variable already
exported in your shell wins — so the `export` above is what takes effect, even on
a development machine with a local `.env` pointing at docker-compose.

Expect output naming the collections and indexes it created, then:

```
Your database indexes are now in sync with your Prisma schema.
```

**Remove your temporary Atlas Network Access entry when you are done.** The NAT
addresses from step 3 stay.

No seed step is needed: the settings document and the default expense categories
are created on first read, and the application is correct against an empty
database.

Confirm the API is healthy now:

```bash
curl -s "https://abc123.execute-api.ap-south-1.amazonaws.com/api/health" | jq
# { "status": "ok", "database": true, "timestamp": "…" }
```

---

## 7. Build and publish the frontend

The SPA is a static bundle and its configuration is compiled in at build time, so
it must be built **after** the API stack exists. It needs exactly one value —
`VITE_API_BASE_URL`, the `ApiBaseUrl` output of `hostel-<stage>-api`.
`the frontend repository (src/config.ts)` reads nothing else.

Read the names out of the stacks rather than typing them:

```bash
STAGE=prod
REGION=ap-south-1

API_BASE_URL=$(aws cloudformation describe-stacks --stack-name "hostel-${STAGE}-api" \
  --query "Stacks[0].Outputs[?OutputKey=='ApiBaseUrl'].OutputValue" --output text)

# The prod web stack lives in us-east-1 (WAF); drop --region for dev/staging.
SITE_BUCKET=$(aws cloudformation describe-stacks --stack-name "hostel-${STAGE}-web" \
  --region us-east-1 \
  --query "Stacks[0].Outputs[?OutputKey=='SiteBucketName'].OutputValue" --output text)

DISTRIBUTION_ID=$(aws cloudformation describe-stacks --stack-name "hostel-${STAGE}-web" \
  --region us-east-1 \
  --query "Stacks[0].Outputs[?OutputKey=='DistributionId'].OutputValue" --output text)

echo "$API_BASE_URL"; echo "$SITE_BUCKET"; echo "$DISTRIBUTION_ID"
```

Build:

```bash
npm run build:shared
VITE_API_BASE_URL="$API_BASE_URL" npm run build  # in the frontend repository    # -> the frontend repository's dist/
```

Everything in a `VITE_*` variable ships to the browser and is public by
definition. There is nothing secret left to put there — the Cognito pool id,
client id and auth mode are gone along with Cognito.

Upload in two passes, assets first. Everything except `index.html` is
content-hashed, so it can be cached forever; `index.html` is the only file that
names the new assets, so publishing it first would hand users an index pointing
at assets that have not landed:

```bash
aws s3 sync the frontend repository's dist/ "s3://${SITE_BUCKET}" \
  --exclude 'index.html' \
  --cache-control 'public,max-age=31536000,immutable'

aws s3 cp the frontend repository's dist//index.html "s3://${SITE_BUCKET}/index.html" \
  --cache-control 'no-cache, no-store, must-revalidate' \
  --content-type 'text/html; charset=utf-8'
```

No `--delete`: the previous build's hashed assets stay behind so a browser
holding the old `index.html` keeps working while the deploy lands.

Invalidate only the shell — the hashed assets are new paths CloudFront has never
cached:

```bash
aws cloudfront create-invalidation \
  --distribution-id "${DISTRIBUTION_ID}" \
  --paths '/index.html'
```

Open the `SiteUrl` output to confirm.

> `.github/workflows/deploy-web.yml` does all of this on a push to `main`. Copy
> `SiteBucketName`, `DistributionId` and `ApiBaseUrl` into that stage's GitHub
> environment as `WEB_SITE_BUCKET`, `WEB_DISTRIBUTION_ID` and
> `VITE_API_BASE_URL`.

---

## 8. First sign-in

There is no user to create in AWS. Cognito is gone; accounts are documents in
MongoDB and the application creates the first one itself.

1. Open `SiteUrl`.
2. The app calls `GET /api/auth/status`. Because the `users` collection is empty
   it answers `needsBootstrap: true`, and the SPA shows a **setup screen** rather
   than a login form.
3. Fill in your name, email, the hostel's name, and a password. The policy is at
   least 10 characters with a lowercase letter, an uppercase letter and a digit
   (`shared/src/schemas/auth.ts`). Use something long; this is the
   account that can do everything.
4. Submitting posts to `POST /api/auth/bootstrap`, which creates the account as
   `OWNER` and signs you straight in.

That endpoint is anonymous by necessity — there is nobody to authenticate as yet
— so "the users collection is empty" is the only thing protecting it, and the
service re-checks that inside the transaction. **The moment the first account
exists it starts answering 409 and can never be used again.** In practice that
means the window between step 7 and this step is the one moment a stranger who
finds the URL could claim the owner account. It is short; do this immediately
after publishing the site, and check the account list afterwards if the site was
reachable for any length of time.

Everyone else is invited from **Settings**: an owner adds a name, email and role
(`ADMIN`, `MANAGER` or `VIEWER`), and the API returns a **one-time temporary
password shown exactly once** — it is not stored in plaintext, not written to the
audit trail and not recoverable. Pass it to the person over a channel you trust.
They are forced to change it on first sign-in. If someone loses their password an
owner issues a new temporary one from the same screen; there is no email delivery
in this deployment, so there is no self-service reset link.

Roles live on the User document and are read from the database on **every**
request, so a demotion takes effect immediately rather than when a token expires.
Repeated failed sign-ins lock an account for `LOGIN_LOCKOUT_MINUTES`.

---

## 9. Routine redeploys

```bash
cd infrastructure

# API code change - rebuilds and pushes the container image, updates the function
npm run cdk -- deploy hostel-prod-api -c stage=prod -c account=123456789012

# Infrastructure change - always diff first
npm run cdk -- diff --all -c stage=prod -c account=123456789012
```

Frontend changes need only step 7 again (build, sync, invalidate).

A **schema change** needs `npm run db:push` (step 6) run from an allow-listed
machine. Because MongoDB is schemaless, ordering is more forgiving than it was
with SQL — but be deliberate anyway, and use expand-then-contract:

1. Add the new field to `schema.prisma`, push it, deploy code that writes both.
2. Backfill.
3. Remove the old field from the schema and the code in a *later, separate*
   release.

`db push` will drop an index the schema no longer declares. It refuses anything
it classifies as data loss unless `--accept-data-loss` is passed, and nothing in
this repository passes it.

`.github/workflows/deploy-api.yml` automates the CDK deploy on a push to `main`,
and keeps `db push` behind a manual `apply_schema` input plus a protected
environment with a required reviewer. Note that a GitHub-hosted runner draws a
different egress IP on every run, so that job only works from a self-hosted
runner inside the VPC; otherwise run step 6 by hand.

---

## Rolling back

**A failed stack update rolls itself back.** CloudFormation reverts to the last
good template automatically. Check `describe-stack-events` for the *first*
failure — not the last — fix it, and deploy again.

**A bad application release.** The Lambda image is built from source, so a
rollback is a redeploy of the previous commit:

```bash
git checkout <previous-tag-or-sha>
npm ci
cd infrastructure
npm run cdk -- deploy hostel-prod-api -c stage=prod -c account=123456789012
```

**A bad frontend release.** Rebuild the previous commit and re-run step 7. The
site bucket is not versioned, so the previous bundle is not recoverable from S3 —
keep the tagged commit, or keep the `dist/` directory from the last good build.

**A bad schema push, or a bad write.** This is where the honesty is owed.

- There is **no down migration and no history**. `db push` is not versioned; you
  cannot replay it backwards.
- Most of it is recoverable anyway. Removing a field from `schema.prisma` does
  not delete the stored data — Prisma simply stops reading it — so rolling the
  *code* back finds it again. A dropped index is re-created by pushing the
  previous schema.
- What is not recoverable is deleted or overwritten documents, and **MongoDB has
  no foreign keys**, so the referential guards this system relies on — "a
  building with residents cannot be deleted", "a resident with payments is
  archived, not removed" — are enforced **only in the service layer**
  (`lib/services/*.service.ts`). A script, a Studio session or a
  `mongosh` prompt bypasses all of them. That is a real backstop the PostgreSQL
  version had and this one does not.
- So backups are the recovery path, and **M0 has none**. On M10 or above, Atlas
  keeps continuous cloud backups and supports point-in-time restore: Atlas →
  Backup → Restore, into a **new** cluster, then inspect it and copy back what is
  needed. Never point the application at a restored cluster without checking it.

**Tearing down a stage.** Only ever safe for `dev`, where `retainData` is false:

```bash
npm run cdk -- destroy --all -c stage=dev
```

For `staging` and `prod` the secret and the site bucket are `RETAIN` —
deliberately. Removing them is a manual, deliberate act. Destroying the AWS
stacks does **not** touch Atlas: delete the cluster in Atlas if you mean to.

---

## Rotating secrets

### JWT_SECRET — the "sign everybody out" lever

`JWT_SECRET` signs every session token (HS256, `lib/auth/jwt.ts`).
Changing it makes every existing token fail verification, so **every user is
signed out immediately** and simply sees the login screen again. Nothing else is
affected; no data changes. Use it when a token may have leaked, or when someone
who should not have access still holds a valid session.

`lib/env.ts` requires at least 48 characters in production and refuses
to boot on the development placeholder.

```bash
STAGE=prod
SECRET_ID="hostel-${STAGE}/app"

new_secret=$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")

current=$(aws secretsmanager get-secret-value --secret-id "$SECRET_ID" \
  --query SecretString --output text)

# Merge - DATABASE_URL must survive, exactly as JWT_SECRET had to in step 5.
updated=$(printf '%s' "$current" | jq --arg s "$new_secret" '.JWT_SECRET = $s')

umask 077; tmp=$(mktemp); printf '%s' "$updated" > "$tmp"
aws secretsmanager put-secret-value --secret-id "$SECRET_ID" --secret-string "file://$tmp"
rm -f "$tmp"; unset new_secret current updated

# Drain warm containers so the new key is actually in use.
aws lambda update-function-configuration \
  --function-name "hostel-${STAGE}-api" \
  --description "jwt rotated $(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

For a single compromised account you do not need this: an owner resetting that
user's password bumps their `tokenValidFrom`, which invalidates only their
sessions.

### The Atlas database password

Rotating this the obvious way causes an outage between changing the password and
updating the secret. Avoid it by rolling through a second user:

1. **Atlas → Database Access → Add New Database User.** Same `readWrite` role,
   new strong password, a name like `hostel_app_2`.
2. Build the new connection string and merge it into `DATABASE_URL` using the
   same read-merge-write from step 5 (it preserves `JWT_SECRET`).
3. Force a cold start with `aws lambda update-function-configuration --description …`.
4. Confirm: `curl .../api/health` returns `"database": true`.
5. Only then **delete the old database user** in Atlas. Deleting it is what
   actually revokes the old credential — changing its password would too, but
   deleting leaves nothing to guess.

Remember to percent-encode any of `@ : / ? # [ ] %` in the password.

If a connection string leaks, the allow-list from step 3 buys you the time to do
this calmly — it is not usable from outside those addresses. Rotate anyway.

---

## What this costs

The NAT gateway is the price of the fixed egress address that makes the Atlas
allow-list possible, and it is the largest line item by far. Rough monthly
figures at `ap-south-1` on-demand rates, before any data transfer — check the
AWS pricing pages for current numbers:

| Item | dev / staging | prod |
| --- | --- | --- |
| NAT gateway | 1 × ~USD 32 | 2 × ~USD 32 = ~USD 64 |
| Elastic IP (charged even while in use) | 1 × ~USD 4 | 2 × ~USD 4 = ~USD 8 |
| Secrets Manager + CloudWatch Logs interface endpoints (2 endpoints × 2 AZs) | ~USD 29 | ~USD 29 |
| Lambda, API Gateway, S3, CloudFront at hostel-sized traffic | a few dollars | a few dollars |
| **Floor, before traffic** | **~USD 65/month** | **~USD 100/month** |
| MongoDB Atlas | M0: free | M10: from ~USD 57/month |

Two honest observations:

- Roughly half the AWS bill exists to give Atlas one IP address to trust. If you
  decide that is not worth it, the alternative is a Lambda outside the VPC with
  Atlas open to `0.0.0.0/0` — that removes the NAT, the Elastic IPs and the
  interface endpoints, and leaves the database password as the only control.
  That is a defensible choice for a `dev` stage and a bad one for real data.
- `prod` runs two NAT gateways so a single-AZ failure cannot take the API
  offline. If an hour of downtime during an AZ event is acceptable, set
  `natGateways: 1` for prod in `infrastructure/lib/config.ts` and remember to
  remove the second address from the Atlas allow-list.

---

## Monitoring

| Where | What |
| --- | --- |
| `/aws/lambda/hostel-<stage>-api` | Structured JSON application logs — one `requestId` ties a request together; tokens, connection strings and password hashes are redacted |
| `/aws/apigateway/hostel-<stage>-api` | Access logs: request id, source IP, method, path, status, latency |
| Alarm `hostel-<stage>-api-5xx` | Lambda errors over 5 minutes (threshold 5 in prod, 20 elsewhere) |
| Alarm `hostel-<stage>-api-throttles` | Any Lambda throttling |
| X-Ray | Active tracing is on for the API function |
| Atlas → Metrics | Connections, operation latency, and the M0 storage limit |
| In-app audit log | Every mutation, written in the same transaction as the change it records |

Both CloudWatch alarms currently have no action attached; subscribe them to an
SNS topic (or wire `alarmEmail` through) before relying on them to page anyone.

### When something is wrong, in order

1. `curl <ApiBaseUrl>/health` — `"database": false` means the API is up and
   MongoDB is not.
2. If the database is unreachable: check **Atlas → Network Access** still lists
   every address from the `AtlasAllowList` output. A `cdk destroy`/redeploy of
   the network stack allocates new Elastic IPs and this is the step that gets
   forgotten.
3. Check the Lambda log for `The application secret has no DATABASE_URL` or
   `no JWT_SECRET` — a secret write that replaced instead of merged (step 5).
4. Check **Atlas → Metrics → Connections**. Lambda concurrency multiplies
   connections; M0 caps them at 500.
