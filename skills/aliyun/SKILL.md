---
name: aliyun
description: Deploy and maintain applications on Alibaba Cloud using OSS, FC, AliDNS, HTTPS and Tablestore. Create only needed resources, independently per application, reuse standing authorization, and confirm costs or permissions only outside the approved scope.
---

# Alibaba Cloud deployment

Use `node <this skill directory>/scripts/cli.mjs` from the business project. The CLI manages static frontends on OSS, HTTP backends on FC, AliDNS/HTTPS and Tablestore. Existing SQL connections can use `backend.envFrom`; SQL provisioning and schema changes require product-specific work. Preserve the application's data semantics when choosing infrastructure.

Read the relevant reference when needed: [account setup](../../README.md#配置账号) for missing configuration or credentials, [deployment configuration](../../README.md#开发和部署) for new or changed deployment settings, [database choices](references/database.md) when designing or changing persistence, and [HTTPS](../../README.md#域名和-https) for certificate setup or renewal. Routine updates can use the existing project and account configuration directly.

## Authorization and ownership

Read `account` if the configured account and its `authorization` are not already in context. Reuse the user's approved products, specifications, region, domains and spending scope across applications and conversations. Record or expand it only after actual approval. A new application name needs no new approval within that scope. Present any real expansion as one concrete cost and permission delta; available RAM rights alone do not authorize spending.

Create only resources the application needs. A static site needs no backend or database; a compute-only API needs no database or data-access role. Each required business resource belongs to its application and is reused for updates. Shared account settings, DNS zone, deployment identity and renewal service are account infrastructure, not shared business data. Share a database only for an explicitly requested data-sharing requirement; record its owner and concrete purpose in `database.shared`. Being part of one system or calling another service does not by itself require shared storage.

The deployment identity is a trusted management identity with RAM policy management rights; name prefixes are not a privilege-escalation boundary, and processes using that identity are not isolated. Never forward deployment credentials into application code, functions, frontend files or logs. Managed database applications receive a separate FC runtime role limited to their own or explicitly shared data.

## Develop and publish

1. Identify the application's frontend, API, authentication and persistence needs. For existing code, preserve its behavior and check how it fits the supported deployment shape before changing its architecture. Choose the lowest-cost database meeting actual queries and consistency requirements; omit it when unnecessary. FC local files are temporary.
2. For a new application, use `init --project pi-aliyun-<name>`. For existing source without deployment configuration, add `--config <project>/aliyun.json`. Reuse an existing configuration for updates. Keep source, config and private files in a persistent project directory outside the package installation and temporary workspaces; use Git with secrets ignored.
3. Declare only needed components in `aliyun.json`. OSS serves public static files; FC runs an HTTP server listening on `0.0.0.0` and the configured port, with Linux x86_64 production dependencies. A backend needs a read-only, unauthenticated health endpoint returning 2xx without sensitive data. Use `backend.envFrom` for business secrets and enforce application authorization before accessing protected data. For Tablestore, use fresh FC runtime credentials as described in the database reference.
4. Run relevant local checks. Review `doctor` and `plan` for new or changed deployment configuration, and `db-plan` for changed database usage assumptions. These commands do not simulate live permissions. `deploy` builds, checks the account, prepares declared resources and runtime permissions, publishes code and configures DNS/HTTPS; separate `build`, `db-setup` or `schedule` calls are unnecessary in the normal deployment path.
5. Require the built-in HTTPS and configured backend health checks to pass, then verify the relevant business flow. On first delivery or a persistence/deployment change, verify authenticated write/read and data survival across one redeploy when persistence is used. Use disposable records and preserve user data. Routine updates need only affected checks. For multiple independent apps, check distinct resource ownership and runtime data scope. Report what was actually verified.

Use low resource specifications within the approved scope, with zero minimum FC instances and a small instance cap. Add paid components only for an actual need. An instance cap does not limit cumulative spending.

## Inspect, maintain or remove

For cloud state use `status`; for local/cloud/HTTPS problems use `diagnose`; to rerun network acceptance use `verify`. Unknown ownership or conflicting DNS stops deployment. Inspect the error and partial completion before retrying. Missing permissions within the approved scope are account setup defects to resolve using the existing authorization, not a new application approval. Upload success alone is not deployment acceptance.

Use `renew` for certificates without rebuilding. Configured ACME projects register for renewal during deployment; install the renewal timer once per deployment host and retain its service identity, registry and private keys. Reuse the user's approved CA terms. See the HTTPS reference when setting up this facility or resolving certificate issues.

When the user explicitly requests deleting an application and its data, follow [deletion](../../README.md#查看排障与删除): preview with `destroy --config <path>`, then execute with `--confirm <exact-project-name>`. No repeated account approval is needed. Deletion permanently removes owned cloud data without automatic backup; shared dependencies and ownership blockers must be resolved first. Keep the project and resource manifest until completion, retry partial failures with the same command, and report retained local files or unowned certificates. Do not broaden deletion to unrelated resources or use real user data to test deletion.
