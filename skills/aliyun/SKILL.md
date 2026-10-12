---
name: aliyun
description: Build and deploy applications on Alibaba Cloud with OSS, FC, AliDNS, HTTPS and low-cost databases. Reuse configured account authorization, give each application independent resources, and ask once only for costs or permissions outside the approved scope.
---

# Alibaba Cloud deployment

Use `node <this skill directory>/scripts/cli.mjs` from the business project. This package is independent of the host application and web framework. Read [README](../../README.md) for installation, private repositories, credentials, configuration and certificate renewal.

## Account and ownership

Start with `account` to read `~/.config/pi-aliyun/account.json`. It stores account, region, DNS zone, project directory and certificate defaults, not secrets. Read its `authorization` for the user's standing permission and spending scope; reuse that scope across conversations. Record or expand it only after actual user approval. A new application name does not require another approval. When a requirement exceeds the scope, present the concrete cost and permission delta once. Available RAM rights do not themselves authorize spending.

If account setup is missing, prepare the profile and use `policy --profile <path>` to produce the complete deployment policy. The administrator grants it to the deployment identity once. Explain concisely that this is a trusted management identity with RAM policy creation and update rights: name prefixes do not constrain policy contents or prevent privilege escalation. Processes using the same identity are not isolated from each other.

Use `init --project pi-aliyun-<name>` for a new application. Keep source, configuration and private files in a persistent project directory outside the package installation and temporary conversation workspace. Initialize Git and ignore secrets. For an existing project use the same `init` with `--config <project>/aliyun.json`; keep its source and ignore rules. Do not copy a placeholder configuration from an example over the account defaults.

Each application owns its bucket, function, database instance, runtime role and deployment configuration. Reuse those resources for its updates. A shared account, primary DNS zone, deployment identity or renewal service does not make business resources shared. Share resources only when the user explicitly requests it or describes the applications as one system; record the owner and reason using [database configuration](references/database.md).

## Develop and publish

1. Infer the application's actual frontend, API, authentication and persistence needs from the request. Use static files or a static framework export for OSS. Run the backend as one HTTP server on FC, listening on `0.0.0.0` and the configured port. Bundle production dependencies for the selected Linux x86_64 runtime.
2. Read [database choices](references/database.md) before designing persistence. Select the lowest-cost option that meets queries and consistency requirements. The usual small key/range workload fits an application-owned CU Tablestore instance with zero reserved throughput. SQL joins, ORM compatibility and cross-table transactions may require a relational database; do not force them into generic JSON rows. FC local files are temporary.
3. Implement a read-only unauthenticated `/health` returning 2xx (or set `backend.healthPath`), without secrets or business data. Complete `aliyun.json` with build commands, output directories, domains and any database schema. Never store secret values in it. Use `backend.envFrom` for business secrets; implement application authentication before database access.
4. Run local checks, `doctor` and `plan`; use `db-plan` for database cost assumptions. These are not live permission simulations. `db-inspect` can check existing resources; missing resources are expected before first deployment. Reuse the approved account and cost scope; ask only for an actual expansion, with the full delta together.
5. Run `deploy`. It builds, verifies the account, directly prepares runtime roles and databases with the deployment identity, uploads the app and configures DNS/HTTPS. `db-setup` is available for database-only preparation; it is already part of deployment. Do not add a manual role-creation or per-project approval step.
6. `deploy` must pass built-in HTTPS and backend health verification. Then verify a real business API. On first delivery or a persistence/deployment change, write and read a disposable authenticated record, redeploy once and verify it survives. Routine updates need only relevant business checks. Preserve ordinary user records and report what was actually verified. If validating multiple independent apps, also check their distinct resource ownership and runtime data scope.

Use `status` to inspect actual cloud resources, `diagnose` for local/cloud/HTTPS findings, and `verify` to rerun acceptance. Missing resources, errors and verification failures must be reported accurately; do not claim an app is online merely because upload succeeded.

Unknown resource ownership or conflicting DNS stops deployment. Diagnose the actual error and any partial completion before retrying. Within the approved scope, missing cloud permissions are setup defects to resolve, not reasons to ask the user to reapprove the same application. Do not silently grant permissions beyond the approved account setup.

## Runtime and operations

The trusted deployment identity creates resources and maintains application roles. Each FC application receives its own runtime role and access only to its own or explicitly shared table data. Never forward deployment credentials into a function, browser, project file or log. Use the runtime helper's fresh FC credentials and perform business authentication first.

Use separate frontend/API subdomains under the configured AliDNS zone. Mainland deployment requires appropriate ICP filing; the CLI does not buy domains or file registrations. Reuse approved CA terms; `deploy` automatically handles ownership verification and certificate signing, and registers configured ACME projects for renewal. Install the Linux renewal timer once using the README, then keep its service identity, registry and private keys persistent. `renew` updates certificates without rebuilding; `schedule` can register projects explicitly.

Default to zero minimum FC instances and a small instance cap within the approved specs. Avoid keepalive, NAT, Redis, API Gateway or additional databases without a business need. An instance cap is not a monthly spending cap. The package does not delete persistent data on redeployment or automatically purchase RDS.

## Remove an application

Use `destroy --config <path>` first: it is read-only and reports ownership blockers and retained resources. Once the user has explicitly requested deletion of this application and its data, execute `destroy --config <path> --confirm <exact-project-name>`. That request authorizes the business action; do not ask for the same account permission again. The CLI checks ownership and shared dependencies before writes, deletes the app's cloud resources, removes renewal registration and waits for asynchronous database release. Retry the same command after a partial failure. Keep the local project until verification finishes. Do not delete actual application data to test this command.

The CLI preserves the local source, secrets and config, and reports certificates it cannot establish ownership of. Report these retained items. Resources outside this tool's supported lifecycle require a concrete plan; do not silently broaden the deletion or delete by account-wide name substring.
