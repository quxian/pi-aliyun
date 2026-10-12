---
name: aliyun
description: Build and publish independent applications on Alibaba Cloud with OSS, FC HTTP backends, AliDNS, HTTPS and low-cost Tablestore databases. Reuse the configured deployment authorization; share resources only when explicitly requested, and consolidate genuinely new costs or permissions into one confirmation.
---

# Alibaba Cloud deployment

Use this package's CLI for static OSS frontends, FC HTTP backends, AliDNS, HTTPS and Tablestore. The CLI is `node <this skill directory>/scripts/cli.mjs`; it works from any project directory. Read [the package README](../../README.md) for installation, credential setup and configuration. It has no dependency on a host application or web framework. These supported deployment paths do not cover every Alibaba Cloud product; existing SQL connections are supported, but buying RDS or performing SQL migrations is not automated.

## Installed platform

Start with `platform` to read the operator profile at `~/.config/pi-aliyun/platform.json`. If absent, use the standalone setup below. Profile version 2 has no shared database instance. It stores account, region, DNS zone and deployment defaults, not credentials or blanket spending approval.

Read `authorization` in that profile for the operator's previously approved deployment and spending scope. Carry it across conversations: a new application within that scope does not require another approval. Only record or expand this text after the user actually approves that scope; never infer approval from available RAM permissions or a previous application's estimate. Ask once for the concrete delta when the intended deployment exceeds it.

Use `project-init --project pi-aliyun-<name>` to create a project under the profile's `projectRoot`. That path is an initialization default, not a deployment requirement: existing applications can stay in other persistent directories. Keep source, configurations and private keys outside disposable conversation workspaces, system temporary directories and the package installation. Initialize a project Git repository and ignore secrets.

Each application owns its bucket, function, database instance, runtime role and deployment configuration by default. A shared account, primary DNS zone, deployment identity and renewal service do not imply shared application resources. Reuse an application's own resources when updating it. Never connect a new application to another application's database merely because it exists or could save money. Share only when the user explicitly describes a common system or asks for sharing; record the owner and reason as described in [database choices](references/database.md).

The installed platform's protected FC authorizer creates or updates each application's runtime role and fixed data policy. Normal deployment can invoke it but cannot change its code or pass its privileged role. It accepts a project name and optional explicit sharing declaration, deriving resources within the approved namespace. A missing role or changed application database scope is an internal deployment step, not a recurring manual RAM request. Within the approved scope, diagnose authorization failures as deployment defects and repair or report their cause; never silently broaden the authorization.

## Choose the project shape

- Generate static HTML/CSS/JS for OSS. A framework requiring a server for every page needs a static export or a different hosting plan.
- Run the backend as one HTTP server in one FC Web function, listening on `0.0.0.0` and the configured port. Code and dependencies must work on the selected FC Linux x86_64 runtime.
- Read [database choices](references/database.md) before designing persistence. Infer queries and consistency requirements from the business. Prefer an application-owned CU-billed Tablestore SSD instance with zero reserved throughput for small online key/range workloads; consider HYBRID for latency-tolerant workloads. SQL joins, ORM compatibility, cross-table transactions, balances or stock consistency can require a relational database. Do not force those requirements into a generic JSON row. Existing SQL must also have an explicit ownership or sharing decision. FC local files are temporary.
- Use separate frontend/API subdomains under the configured AliDNS zone. Mainland OSS/FC domains require completed ICP filing. The CLI does not register domains, submit ICP applications or change registrar nameservers.

## Work with the CLI

1. `init --config aliyun.json` writes the [configuration template](assets/aliyun.example.json) without overwriting a file. Adapt builds, outputs, runtime, account, region, resource names and domains. Omit frontend or backend if unused. No secret values belong in this file.
2. `doctor` checks local prerequisites without resolving credentials or calling cloud APIs. `plan` shows desired writes, not a live diff. For persistence, add `database`, then run `db-plan` and read-only `db-inspect` to review ownership, schemas, runtime permissions and usage-based estimates. A missing application role or instance can be expected before the first deployment.
3. `build` performs configured local builds and checks upload artifacts. Use a self-contained backend directory with its production dependencies. Check that public outputs contain only public assets.
4. Complete implementation, local checks and a concrete resource plan. Reuse the user's existing permission and spending approval within its scope. If costs, services, terms or permissions genuinely exceed that scope, ask once with named resources, usage assumptions, purchase/recurring costs, exposure, runtime trust/data scope and the complete permission delta. Do not reapprove every application or table because its name or plan fingerprint changed. An estimate is not a bill cap, and the ability to execute a CLI does not authorize spending.
5. With an installed platform, `deploy` maintains the application's runtime role through the authorizer. Without one, `db-role` uses a separately authorized administrator identity to create or update the owned role and fixed data policy; apply the generated deployment statements or install the reusable platform. Keep deployment permissions separate from application runtime permissions. Platform installation or expansion is an administrator operation, not a per-application onboarding task.
6. When authorized, `deploy` builds, verifies the account through STS, provisions or checks application-owned resources, injects database connection metadata, and publishes the app and certificates. Existing bucket, function and database ownership must match. Explicit database sharing names the owner application and requires a nonempty reason. Unknown ownership or conflicting DNS stops deployment; diagnose partial completion before retrying.
7. Verify HTTPS and a real API. For persistence, authenticate, write a unique disposable record, read it back, redeploy once and confirm it survives. Preserve user records. Report actual verification and material gaps. Register HTTPS projects with `schedule` when continuing an authorized renewal service.

## Existing data and sharing

`database.shared = { "ownerProject": "pi-aliyun-owner", "reason": "User-requested common application system" }` makes the instance and physical table prefix follow the owner application; the consumer retains its own runtime role. Without this declaration, database resources belong to the current application. This setting deliberately creates a shared lifecycle, so do not add it without explicit intent. Standalone configurations may name a dedicated instance explicitly, but must still pass its ownership checks; a platform uses the deterministic application instance name.

Never point an existing application at a new empty database and call it migrated. `deploy` does not move data or delete databases. Treat an existing-data migration as a separate maintenance operation: pause every writer, make a private typed backup preserving timestamps, copy and verify row counts and hashes, switch while still in maintenance, then resume after application verification. Retain the source database and backup. See [migration considerations](references/database.md#迁移到应用独立实例).

## Permissions, HTTPS and runtime

`policy` prints standalone deployment permissions for administrator review. `platform-plan` includes the complete website and database deployment scope: OSS website buckets matching `pi-aliyun-*-<accountId>`, the configured DNS zone, FC, certificates, application instances/tables, runtime-role inspection/pass and invocation of the protected authorizer. Some FC/certificate operations are account-wide. The authorizer maintains only owned application policies and refuses unknown ownership or additional bindings. The ordinary deployment identity has no RAM administration. These controls do not isolate one Agent's deployment credentials from another process using the same identity.

Use existing PEM files or the README's ACME DNS-01 configuration. Reuse approved CA terms within their scope. OSS ownership verification creates and removes only its own temporary `_dnsauth` TXT record. `renew` updates certificates without rebuilding apps. Use `schedule --config <absolute config>` as the deployment service user; an administrator installs the shared Linux timer once with `install-renewal --user <service user> --registry <absolute path>`. Later applications only need registration. Verify the service and next run. Keep renewal configuration and keys outside package installations and upload directories. The timer logs failures; it does not provide notifications.

The cloud HTTP trigger is anonymous and the default FC URL is disabled. Implement application authentication before database access. Never put cloud keys in browser code or forward deployment credentials into an app. Applications use FC runtime credentials; business secrets enter through `backend.envFrom`.

Scale FC to zero, cap its instance quota and choose sensible request timeouts. Do not add keepalive, an always-running instance, NAT, Redis, API Gateway or another database without a business need. Work that outlives a request needs an asynchronous execution design.
