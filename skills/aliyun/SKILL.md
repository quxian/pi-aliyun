---
name: aliyun
description: Deploy a project's static frontend to Alibaba Cloud OSS and HTTP backend to Function Compute, including AliDNS domains, HTTPS certificates and existing database connections. Use when building or publishing projects on the user's Alibaba Cloud account.
---

# Alibaba Cloud deployment

Use this package's deterministic CLI for OSS, FC, AliDNS and TLS. The CLI is `node <this skill directory>/scripts/cli.mjs`; it works from any project directory. Read [the package README](../../README.md) for installation, credential setup and configuration. The package has no dependency on the host application or a particular web framework.

## Choose the project shape

- Generate static HTML/CSS/JS for OSS. A framework requiring a server for every page needs a static export or a different hosting plan.
- Run the backend as one ordinary HTTP server in one FC Web function, listening on `0.0.0.0` and the configured port. Keep business routes together. Code and dependencies must work on the selected FC Linux x86_64 runtime.
- Keep durable data outside the function filesystem. Reuse an existing database connection via `backend.envFrom`; choose a database only if the application's query and transaction needs require one. No database is purchased by this CLI. Read [database choices](references/database.md) when data persistence is needed.
- Use separate frontend/API subdomains under one AliDNS zone, in the configured account. Mainland OSS/FC domains require completed ICP filing. The CLI does not register domains, file ICP applications or change registrar nameservers.

## Work with the CLI

1. `init --config aliyun.json` writes the [configuration template](assets/aliyun.example.json) without overwriting a file. Adapt actual build commands, static output, backend code directory, runtime, account, region, resource names and domains. Omit frontend or backend if unused. No secret values belong in this file.
2. `doctor --config aliyun.json` checks local prerequisites without resolving credentials or calling cloud APIs. `plan` shows desired writes, not a live cloud diff. Review that the named resources are intended for this project.
3. `build` runs the configured local build commands and checks upload artifacts without cloud mutations. It rejects symlinks and excludes credential-like files. Use a self-contained backend output directory; copy production dependencies there if they are not bundled.
4. When deployment is authorized, `deploy` builds, verifies the credential account through STS, provisions/updates the named resources and uploads the certificate. The public-read bucket and function must be new or managed by this project. Existing unrelated resources and conflicting DNS records cause a stop. An interrupted deployment may be partial; fix the cause and rerun once, rather than retrying indefinitely.
5. Verify the deployed frontend and one real API or health endpoint after DNS becomes effective. Report the actual result and any unverified part. A successful control-plane request alone does not prove the application works.

For HTTPS, use existing PEM files or the README's ACME DNS-01 configuration. `renew` checks/renews and uploads certificates without rebuilding applications. It does not install a scheduler; only set up recurring execution when the user requests it. Keep certificate/account key files outside upload directories and package installations.

The HTTP trigger is anonymous at the cloud boundary and the default FC URL is disabled. Implement the application's authentication and authorization in its HTTP server. Do not put cloud keys in browser code; use FC's runtime role for cloud access. Deployment credentials follow the official SDK chain and are distinct from the application's environment.

Defaults scale FC to zero and cap its instance quota. Do not add keepalive requests, an always-running instance, NAT, Redis, API Gateway or a new database without a business need. Set sensible per-request timeouts; work that must outlive a response needs a proper asynchronous execution path.
