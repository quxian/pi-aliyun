# pi-aliyun

供 [Pi](https://pi.dev/) 使用的独立能力包：将静态前端部署到阿里云 OSS，将普通 HTTP 后端部署到 FC 函数计算，并管理 AliDNS 域名解析、HTTPS 证书上传及可选的 ACME 自动签发与续期。

包内包含原生 `aliyun` skill、配置模板和可独立运行的 Node CLI，不依赖宿主应用，也不绑定前后端框架。

## 安装

```sh
pi install git:github.com/quxian/pi-aliyun
```

重新加载 Pi 的资源或开始新会话后，使用 `/skill:aliyun`。Skill 会通过安装目录的绝对路径调用脚本，业务项目不必安装一份部署依赖。

在支持 Pi 包的宿主中也可通过界面安装。例如 Client Pi 用户可进入「Agent 页面 → 能力包」，填入 `https://github.com/quxian/pi-aliyun`；这只是宿主的安装入口，不是包的运行依赖。

也可以克隆仓库后单独使用 CLI：

```sh
npm ci
node skills/aliyun/scripts/cli.mjs --help
```

需要 Node.js 22 或更高版本。仓库提交依赖锁文件。`npm run check` 使用本地临时目录和模拟云客户端做冒烟验证，不读取真实云凭据、不创建云资源。

依赖审计仍会报告 `acme-client` 间接依赖 `node-forge` 的[已知签名验证漏洞](https://github.com/advisories/GHSA-86w9-cpqp-85rv)。本包使用 `acme.crypto` 的原生加密实现和 Node `X509Certificate`，没有使用受影响的 forge 签名验证路径；这不等于依赖告警已修复，升级依赖时仍需复核。

## 配置和使用

在业务项目目录执行下列命令，将示例路径替换为实际安装路径：

```sh
node /path/to/pi-aliyun/skills/aliyun/scripts/cli.mjs init
node /path/to/pi-aliyun/skills/aliyun/scripts/cli.mjs doctor
node /path/to/pi-aliyun/skills/aliyun/scripts/cli.mjs plan
node /path/to/pi-aliyun/skills/aliyun/scripts/cli.mjs build
node /path/to/pi-aliyun/skills/aliyun/scripts/cli.mjs deploy
```

所有命令都接受 `--config path/to/aliyun.json`。JSON 内的文件路径以配置文件所在目录为基准。

- `init` 写入配置模板，已有文件不会被覆盖。
- `doctor` 检查本地配置和目录，不解析云凭据，也不验证云权限。
- `plan` 展示计划管理的资源和变更范围，不查询云端，不是实时差异比较。
- `build` 运行本地构建并检查产物，不修改云资源。
- `deploy` 构建后核对账号、部署前后端、配置域名和证书。
- `renew` 检查或续期证书并上传到现有域名，不重新构建业务代码。

[配置模板](skills/aliyun/assets/aliyun.example.json) 使用静态前端和已打包的 Node HTTP 后端作为示例，按实际项目调整：

| 字段 | 含义 |
| --- | --- |
| `accountId`、`region` | 字符串形式的目标账号 ID 和阿里云地域；写入前通过 STS 核对实际凭据所属账号 |
| `frontend.dir`、`frontend.build` | 包含 `index.html` 的静态产物目录；可选构建配置 `{cwd, command:[可执行文件, ...参数]}` |
| `frontend.bucket`、`frontend.domain` | 专用网站 Bucket 和前端子域名；首次部署使用全局唯一的新 Bucket 名 |
| `frontend.spa` | 找不到路径时以 HTTP 200 返回 `index.html`；普通多页网站可关闭 |
| `backend.codeDir`、`backend.build` | 含完整运行依赖的后端目录及可选本地构建命令 |
| `backend.runtime`、`backend.command`、`backend.port` | FC 自定义运行时、启动命令及参数；应用监听 `0.0.0.0` 和 `PORT` |
| `backend.cpu`、`memorySize`、`timeout`、`instanceConcurrency`、`maxInstances` | 资源规格、请求超时、单实例请求并发和实例数配额 |
| `backend.environment`、`backend.envFrom` | 非敏感固定变量，或“函数环境变量名 → 部署进程环境变量名”的映射 |
| `backend.role`、`backend.vpcConfig` | 可选的既有运行时 RAM 角色，以及 VPC、交换机、安全组配置 |
| `dns.zone`、`dns.ttl` | 当前账号 AliDNS 管理的既有域名区域；只管理子域名默认线路的 CNAME |
| `tls.certFile`、`tls.keyFile` | 覆盖已配置域名的 PEM 证书链和私钥文件 |

不需要某一端时，删除整个 `frontend` 或 `backend` 配置。命令使用参数数组，默认不经过 shell；业务确实需要时可以显式使用 shell。构建输出直接展示，因此构建脚本不应打印敏感信息。构建子进程会移除部署身份的阿里云凭据环境变量。

后端是包含自己全部路由的 HTTP 应用，不需要把每个路由改成一个云函数。示例使用 `custom.debian10` 及其内置 `/var/fc/lang/nodejs20/bin/node`。其它语言可使用对应内置执行文件，或将可执行程序打包到 `/code` 下。[运行时可用地域与内置程序](https://help.aliyun.com/zh/functioncompute/custom-runtime/)并不完全相同，本机运行时和原生模块不能直接当作 FC 运行环境。部署依赖需适配 Linux x86_64。

后端目录需要自包含：未打包进代码的生产依赖也放进该目录。脚本拒绝符号链接、跳过 `.bin`，压缩后 ZIP 上限为 60 MiB。这一版不部署容器镜像。

## 凭据和权限

部署身份由官方 Alibaba Cloud credentials SDK 解析，可使用环境变量 `ALIBABA_CLOUD_ACCESS_KEY_ID`、`ALIBABA_CLOUD_ACCESS_KEY_SECRET` 和可选的 `ALIBABA_CLOUD_SECURITY_TOKEN`，也支持 SDK 的外部凭据文件、OIDC 和实例 RAM 角色。通过用户的 shell、CI 密钥管理器或实例配置提供凭据，不要把密钥值写进聊天或项目 JSON。详见[官方凭据提供链](https://github.com/aliyun/credentials-nodejs)。

通过 Client Pi 使用时，凭据要放在运行 Client Pi 的服务进程环境或该服务用户可读的 SDK 凭据文件中；放在浏览器所在电脑的环境变量里不会传给服务器上的部署进程。实例 RAM 角色也绑定到实际执行部署的云主机。

使用限制到本项目资源的 RAM 身份。按对应官方 RAM 文档限定资源范围，所需操作包括：

- STS `GetCallerIdentity`：核对目标账号。
- OSS：读取/创建 Bucket、读取/写入标签、设置 ACL 和静态网站、上传对象、`PutCname`。不需要删除对象。
- OSS 证书托管还需要 `yundun-cert:DescribeSSLCertificatePrivateKey`、`yundun-cert:DescribeSSLCertificatePublicKeyDetail`、`yundun-cert:CreateSSLCertificate`，见 `PutCname` 文档。
- FC：读取/创建/更新函数、弹性策略和实例配额、HTTP 触发器、自定义域名；配置运行时角色时还需要传递该角色的权限。
- AliDNS：读取域名记录、添加/更新记录；启用 ACME 时还需要删除本次创建的 TXT 记录。

工具不会自动授予权限；账号需已开通所使用的云服务。FC 运行时角色与部署身份分开，应用通过运行时角色取得访问云服务的临时凭据。数据库密码等业务秘密使用 `backend.envFrom`，不要把部署凭据转交应用。这些业务值会写入 FC 环境变量，不会打印到 CLI 或保存到生成的本地产物。

## 域名和 HTTPS

使用 `app.example.com`、`api.example.com` 这样的两个子域名。该区域的权威 DNS 必须已经是 AliDNS。中国内地 OSS/FC 需完成适用的 ICP 备案和阿里云接入要求。工具不购买域名、不提交备案、不更改注册商的 NS，也不额外创建 CDN、ESA、API 网关或 NAT。

如果域名不在当前账号注册，OSS 可能要求单独验证所有权。出现 `NeedVerifyDomainOwnership` 时，按 OSS 官方流程完成 TXT 验证后重试；拥有 DNS 区域权限不会绕过这项验证。

默认提供 PEM 证书链和私钥文件。工具验证有效期、私钥匹配和域名覆盖，并直接上传到 OSS 和 FC。受管理的 FC 域名仅启用 HTTPS，HTTP 触发器默认公网 URL 被关闭。OSS 绑定域名支持 HTTPS，但工具不会自动禁用其 HTTP 访问。两个访问地址都以 HTTPS 返回。

需要工具签发和续期证书时，加入 `tls.acme`：

```json
"tls": {
  "certFile": "/persistent/my-app/tls/fullchain.pem",
  "keyFile": "/persistent/my-app/tls/privkey.pem",
  "acme": {
    "email": "operator@example.com",
    "accountKeyFile": "/persistent/my-app/tls/account.key",
    "agreeToTerms": true,
    "renewBeforeDays": 30
  }
}
```

仅在接受所选 CA 的条款后设置 `agreeToTerms`。默认使用 Let's Encrypt 正式服务，可用 HTTPS `directoryUrl` 指定其它 ACME 目录，例如测试环境。测试环境证书不受浏览器信任，不能用于正式公开访问。

签发通过 DNS-01：创建 TXT 验证记录、等待 DNS 生效，结束时只删除本次创建的记录 ID。有效证书在进入续期窗口之前直接复用。账号密钥和证书私钥以受限文件权限持久保存。

```sh
node /path/to/pi-aliyun/skills/aliyun/scripts/cli.mjs renew --config /path/to/project/aliyun.json
```

需要持续自动续期时，让部署主机的调度器每天执行这个命令。CLI 不会自己安装 cron 或云定时任务；调度器需要同一配置、凭据和持久密钥目录。密钥目录放在包安装目录、Git 和两个上传目录之外。如果进程在签发期间被强制结束，确认没有签发任务运行后，可能需要人工清理锁文件和临时 DNS TXT 记录。

## 发布行为与边界

OSS Bucket 中的网站文件公开可读。新 Bucket 带 `pi-aliyun-project` 标签，已有 Bucket 只有标签与当前项目匹配才会复用。FC 用函数描述中的项目标记检查归属。请使用专用资源名，不要指向无关的既有资源。如果创建成功但后续打标签或配置失败，先检查部分完成的资源再重试；不要对存有私密数据的 Bucket 绕过归属检查。

先上传资源文件，最后上传 HTML。HTML 和未识别出内容哈希的文件使用缓存再验证；文件名包含十六进制内容哈希的资源使用较长的不可变缓存。保留旧对象，让已打开的页面继续加载旧资源，之后再按实际需要清理。`.env*`、私钥扩展名、`.git`、`.aliyun` 等不会上传，但这不是完整的秘密扫描器，上传目录应当只包含已检查的构建产物。SPA 回退会对所有缺失对象返回 HTML，因此脚本路径错误也可能收到 HTML，排查时检查实际失败的资源请求。

FC 使用一个函数的 `LATEST` 版本，将最小实例数设为 0、设置实例数配额，并管理匿名 HTTP 触发器。业务鉴权仍由应用实现。CORS 仅允许配置的前端来源并支持凭据。发布会替换声明的函数环境变量，所需变量应完整写在 `environment` 或 `envFrom` 中；没有配置的高级 FC 设置不会被全面同步。

DNS 在每个配置的域名下管理一条默认线路 CNAME。已有单条 CNAME 可以更新为目标地址，其它记录类型或多条线路会使部署停止。发布按顺序执行，不是事务。失败后可能已有部分资源更新，修复原因再重试；工具没有自动破坏性回滚或资源删除命令。成功输出表示云 API 操作完成，不代表 DNS 已传播或业务正常，交付前检查实际访问地址和一个 API/健康接口。

数据库按需使用，工具不自动购买或执行迁移，详见[数据库选择与连接方式](skills/aliyun/references/database.md)。FC 本地磁盘是临时的。包不提供登录系统、数据库迁移执行器、任务队列、运行监控或费用硬上限。实例配额限制并行资源，不限制累计消费。FC 对有调用的函数小时存在最低计费，避免无必要的保活请求；估算费用时检查[当前 FC 计费](https://help.aliyun.com/zh/functioncompute/billing-overview-of-fc)、OSS 流量、数据库与证书条款。

## 实现依据

使用官方 FC 2023-03-30、AliDNS 2015-01-09、STS、credentials SDK 和 `ali-oss`。由于 OSS SDK 的便捷方法未暴露完整字段，[PutBucketWebsite](https://help.aliyun.com/zh/oss/developer-reference/putbucketwebsite/) 和 [PutCname](https://help.aliyun.com/zh/oss/developer-reference/putcname) 通过 SDK 的签名请求接口处理 SPA 状态码及证书字段；[FC 域名](https://help.aliyun.com/zh/functioncompute/configure-custom-domain-names)直接调用官方接口配置。
