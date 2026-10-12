# pi-aliyun

供 [Pi](https://pi.dev/) 使用的独立能力包：将静态前端部署到阿里云 OSS，将普通 HTTP 后端部署到 FC，并管理 AliDNS、HTTPS 自动签发/续期及低成本 Tablestore 数据库。

包内包含原生 `aliyun` skill、配置模板和可独立运行的 Node CLI，不依赖宿主应用，也不绑定前后端框架。一次配置部署身份和权限后，每个应用默认拥有自己的 Bucket、FC 函数、数据库实例、运行角色及部署配置；只有明确声明的业务关系才共享资源。账号、主域名和部署工具可以共用，应用不默认依赖彼此。

从[云端回声](examples/hello-cloud/README.md)开始可跑通无数据库部署；[文字计量台](examples/text-inspector/README.md)验证跨项目部署；[云端便笺](examples/durable-notes/README.md)验证持久化和重复发布后数据保留。

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

项目命令接受 `--config path/to/aliyun.json`。JSON 内的文件路径以配置文件所在目录为基准。

- `init` 写入配置模板，已有文件不会被覆盖。
- `doctor` 检查本地配置和目录，不解析云凭据，也不验证云权限。
- `plan` 展示计划管理的资源和变更范围，不查询云端，不是实时差异比较。
- `build` 运行本地构建并检查产物，不修改云资源。
- `deploy` 构建后核对账号、部署前后端、配置域名和证书。
- `renew` 检查或续期证书并上传到现有域名，不重新构建业务代码。
- `policy` 输出供管理员审核的跨项目 RAM 策略，不会自行修改授权。
- `schedule` 将项目配置登记到持久的续期清单；`renew-all` 检查清单内所有项目。
- `db-plan` 输出数据库、运行角色、完整权限增量及费用估算；`db-inspect` 只读检查当前资源并合并报告问题。
- `db-setup` 创建/检查应用独立数据库，`deploy` 也会执行这一步；没有逐项目指纹审批文件。
- `db-role` 是没有平台配置时的独立管理员入口；已安装平台的 `deploy` 会调用受控授权函数创建或更新应用运行角色。
- `platform` 查看当前环境的平台配置；`project-init --project pi-aliyun-name` 在独立持久目录创建项目配置。

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
| `database` | 可选的 Tablestore 实例、表主键和月用量估计；生成项目角色名并注入连接变量，详见[数据库流程](skills/aliyun/references/database.md) |
| `dns.zone`、`dns.ttl` | 当前账号 AliDNS 管理的既有域名区域；只管理子域名默认线路的 CNAME |
| `tls.certFile`、`tls.keyFile` | 覆盖已配置域名的 PEM 证书链和私钥文件 |

不需要某一端时，删除整个 `frontend` 或 `backend` 配置。命令使用参数数组，默认不经过 shell；业务确实需要时可以显式使用 shell。构建输出直接展示，因此构建脚本不应打印敏感信息。构建子进程会移除部署身份的阿里云凭据环境变量。

后端是包含自己全部路由的 HTTP 应用，不需要把每个路由改成一个云函数。示例使用 `custom.debian10` 及其内置 `/var/fc/lang/nodejs20/bin/node`。其它语言可使用对应内置执行文件，或将可执行程序打包到 `/code` 下。[运行时可用地域与内置程序](https://help.aliyun.com/zh/functioncompute/custom-runtime/)并不完全相同，本机运行时和原生模块不能直接当作 FC 运行环境。部署依赖需适配 Linux x86_64。

后端目录需要自包含：未打包进代码的生产依赖也放进该目录。脚本拒绝符号链接、跳过 `.bin`，压缩后 ZIP 上限为 60 MiB。这一版不部署容器镜像。

## 凭据和权限

部署身份由官方 Alibaba Cloud credentials SDK 解析，可使用环境变量 `ALIBABA_CLOUD_ACCESS_KEY_ID`、`ALIBABA_CLOUD_ACCESS_KEY_SECRET` 和可选的 `ALIBABA_CLOUD_SECURITY_TOKEN`，也支持 SDK 的外部凭据文件、OIDC 和实例 RAM 角色。通过用户的 shell、CI 密钥管理器或实例配置提供凭据，不要把密钥值写进聊天或项目 JSON。详见[官方凭据提供链](https://github.com/aliyun/credentials-nodejs)。

通过 Client Pi 使用时，凭据要放在运行 Client Pi 的服务进程环境或该服务用户可读的 SDK 凭据文件中；放在浏览器所在电脑的环境变量里不会传给服务器上的部署进程。实例 RAM 角色也绑定到实际执行部署的云主机。

部署身份应一次具备约定应用范围内完整、持续的部署权限，应用运行身份只取得自己的业务权限。OSS 可指定专用 Bucket，AliDNS 可指定域名区域；部分 FC 接口只支持账号级资源授权，不能仅凭函数名就认为已隔离权限。实例角色也不是 Agent 级隔离，同机有权访问实例元数据的进程可能取得相同权限。按对应官方 RAM 文档限定资源范围，所需操作包括：

- STS `GetCallerIdentity`：核对目标账号。
- OSS：读取/创建 Bucket、读取/写入标签、`PutBucketPublicAccessBlock`、设置 ACL 和静态网站、上传对象、`CreateCnameToken`、`PutCname`。不需要删除对象。
- OSS 证书托管还需要 `yundun-cert:DescribeSSLCertificatePrivateKey`、`yundun-cert:DescribeSSLCertificatePublicKeyDetail`、`yundun-cert:CreateSSLCertificate`，见 `PutCname` 文档。
- FC：读取/创建/更新函数、弹性策略和实例配额、HTTP 触发器、自定义域名；配置运行时角色时还需要传递该角色的权限。
- AliDNS：读取域名记录、添加/更新记录；启用 ACME 时还需要删除本次创建的 TXT 记录。

账号需已开通所使用的云服务。FC 运行时角色与部署身份分开，应用通过运行时角色取得访问云服务的临时凭据。数据库密码等业务秘密使用 `backend.envFrom`，不要把部署凭据转交应用。这些业务值会写入 FC 环境变量，不会打印到 CLI 或保存到生成的本地产物。

网站权限可执行 `policy --config aliyun.json > deployment-policy.json` 供管理员审核。OSS 限定到 `pi-aliyun-*-账号ID` 网站 Bucket，AliDNS 限定到 `dns.zone`，FC 和证书保留所需账号级授权，不包含 RAM 管理权。没有平台时，数据库授权需逐项目初始化；长期管理多个项目应安装下述平台。新项目使用不同的资源名和域名；标签防止误用，不构成 Agent 身份隔离。

## 一次安装，跨项目部署

平台配置与项目都在能力包外；不使用任何聊天产品的接口、账号或会话 ID。相同 CLI 可用于终端、CI 或任意 Agent。环境管理员准备服务用户的 `~/.config/pi-aliyun/platform.json`：

```json
{
  "version": 2,
  "accountId": "1234567890123456",
  "region": "cn-beijing",
  "zone": "example.com",
  "projectRoot": "/srv/projects",
  "authorizerFunction": "pi-aliyun-authorizer",
  "deployerRole": "pi-aliyun-deployer",
  "acmeEmail": "operator@example.com"
}
```

`projectRoot` 是 `project-init` 默认创建项目的持久目录，应当由服务用户拥有；已有项目可放在其它持久目录，不要求搬进它。不要把源码和配置放在临时聊天目录、系统临时目录或包安装目录。此配置不含密钥，不代表用户已批准所有未来费用。`project-init` 根据它生成配置，但仍需完成构建命令、数据库定义和域名冲突检查。平台配置 v2 不含共享 `instance`；已有数据需要迁移时单独停写、备份并验证，不能只修改连接地址。ACME 条款同意应沿用用户已批准的范围，不能仅因配置了邮箱就自动同意。

用户确认长期使用范围后，将原意记入可选的 `authorization` 文本字段，包括允许的产品、规格、地域、域名和按量费用范围。Agent 每次读取平台配置即可沿用这份授权，同范围内新建应用不再询问；超出时只确认增量。该字段记录真实授权，不是自动获得授权或限制账单的开关。

管理员首次安装：

`deployerRole` 是配置凭据时选定且已存在的执行身份，例如 ECS 实例角色；平台安装先检查该角色，不猜测它的信任关系或应绑定的机器。

```sh
pi-aliyun platform-plan --profile platform.json
pi-aliyun platform-bundle --profile platform.json --output platform-bundle
# 用户审核上面生成的具体权限、函数规格和新增费用后：
pi-aliyun platform-bootstrap --profile platform.json --bundle platform-bundle --fingerprint <已批准指纹>
```

最后一步使用管理员身份的官方 SDK 凭据链，安装完整的 `PiAliyunPlatformDeploy` 策略：约定名称的网站 Bucket、FC、指定 DNS 主域、HTTPS 证书，以及约定地域的 `pi-app-*` CU 实例和其中的 `pi_pi_aliyun_*` 表。部署身份可以检查并向 FC 传递 `pi-db-pi-aliyun-*` 角色、调用授权函数，无需另找旧策略补齐权限。业务实例在部署应用时按需创建，平台安装本身不提前创建业务数据库。实例名按应用名确定性生成，归属标记须匹配；默认没有跨应用共享实例。

授权函数无 HTTP 触发器，只通过 RAM 签名的 FC API 调用。它接受项目名和可选的显式共享声明，固定生成只信任 FC 的角色，以及目标实例内对应表前缀的数据行读写策略；拒绝调用方提供账号、策略、信任实体或执行代码。仅授权函数拥有指定前缀的 RAM 创建/绑定及策略版本维护能力；它检查角色、策略的管理描述和绑定，只更新本工具拥有的固定数据策略，拒绝未知归属或额外绑定。版本达到上限时仅删除非默认旧版本，保留当前默认版本供回退；不能删除角色、管理用户或密钥。部署身份被显式拒绝修改授权函数和传递其高权限角色。管理员更新授权函数需要重新审核；升级 Agent 中的包不会自动改动授权函数。

安装后必须用**普通部署身份**验证：调用授权函数成功；更新授权函数被拒绝；把授权函数角色传给业务函数被拒绝；两个项目运行角色不能读对方的表。若云端保护未生效，不得接受平台安装完成，应由管理员修正后再开放。函数资源级授权参见 [FC 权限表](https://help.aliyun.com/en/functioncompute/policies-and-sample-policies)。

授权函数默认 0.1 vCPU、256 MiB、最多 1 实例、最低 0、并发 1、60 秒超时，无定时调用、日志服务或保活。只有应用角色缺失或固定数据策略需要更新时调用，普通更新检查现有角色后跳过它。FC 对有调用的小时设最低计费，费用按实际用量计算，见 [FC 计费](https://help.aliyun.com/zh/functioncompute/billing-overview-of-fc)。RAM 策略范围不是消费硬上限。

后续项目流程为 `project-init` → 开发和构建 → 核对已有授权和费用范围 → `deploy` → 真实读写与重发版验证 → `schedule`。范围内的新项目不再人工创建角色、复制 RAM JSON 或保存逐项目审批文件。用户已批准持续部署和相应用量费用时直接继续；真正新增费用、服务条款或超出权限范围时，把具体资源、费用假设及完整权限增量一次列清楚。CLI 可执行不等于用户已批准消费。更换账号、地域、数据库种类或扩大资源权限时，先重新审核平台范围。同一部署身份能管理多个项目；单个项目的运行角色只读写自己的表，这不等于不同 Agent 的部署身份隔离。

前端 Bucket 只放可公开的网站文件。OSS 新建 Bucket 默认阻止公共访问，部署会关闭本项目专用 Bucket 的这一开关，再设置公共读；不会修改账号级开关。如果账号级策略阻止公共访问，部署会失败，需要管理员按实际网站托管需求处理。参见 [OSS 静态网站托管](https://help.aliyun.com/zh/oss/user-guide/hosting-static-websites)。

## 域名和 HTTPS

使用 `app.example.com`、`api.example.com` 这样的两个子域名。该区域的权威 DNS 必须已经是 AliDNS。中国内地 OSS/FC 需完成适用的 ICP 备案和阿里云接入要求。工具不购买域名、不提交备案、不更改注册商的 NS，也不额外创建 CDN、ESA、API 网关或 NAT。

OSS 要求验证所有权时，CLI 会调用 [CreateCnameToken](https://help.aliyun.com/zh/oss/developer-reference/createcnametoken/)，在 AliDNS 创建 `_dnsauth` TXT 记录，等待 OSS 验证后完成域名和证书绑定，并删除本次创建的 TXT 记录。已有的 TXT 记录不会被删除。验证超时会明确失败，检查权威 DNS 后可重试；无需进入 OSS 控制台手动绑定。

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

部署主机直连证书服务不稳定时，可在 `tls.acme.proxyUrl` 填入该主机可用的 HTTP(S) 代理地址，例如 `http://127.0.0.1:7890`。此设置只影响证书服务请求，阿里云 SDK 仍使用原有网络配置；URL 不接受用户名或密码。定时续期读取同一项目配置，因此不依赖交互终端的代理环境变量。

签发通过 DNS-01：创建 TXT 验证记录、等待 DNS 生效，结束时只删除本次创建的记录 ID。有效证书在进入续期窗口之前直接复用。账号密钥和证书私钥以受限文件权限持久保存。

```sh
node /path/to/pi-aliyun/skills/aliyun/scripts/cli.mjs renew --config /path/to/project/aliyun.json
```

需要持续自动续期时，在持久的 Linux 部署主机上使用内置 systemd 入口。先以实际部署服务用户登记项目，再由管理员安装一次定时器：

```sh
# 部署服务用户执行；默认清单为 ~/.config/pi-aliyun/renewal.json
node /path/to/pi-aliyun/skills/aliyun/scripts/cli.mjs schedule --config /persistent/my-app/aliyun.json

# 管理员执行；替换用户和清单路径
sudo node /path/to/pi-aliyun/skills/aliyun/scripts/cli.mjs install-renewal --user deploy-user --registry /home/deploy-user/.config/pi-aliyun/renewal.json

# 验证一次执行和下次调度
sudo systemctl start pi-aliyun-renew.service
systemctl list-timers pi-aliyun-renew.timer
journalctl -u pi-aliyun-renew.service
```

定时器按服务器时区每天 03:15–03:30 检查，停机错过后会补跑；证书进入续期窗口才重新签发。每个项目单独运行，一个失败不会阻止其它项目，整体失败会记录到 systemd 日志。这不是告警通知服务。续期以指定的非 root 用户运行，需要与部署相同的凭据、网络访问和持久密钥目录。

以后新增项目只需以同一服务用户执行 `schedule`，不必重新安装定时器。清单仅存配置文件绝对路径，重复登记不会重复执行；停用项目时从清单删除对应路径。包升级需保持安装路径不变；换路径后重新执行 `install-renewal`。其它系统或 CI 可每天调用 `renew-all --registry /persistent/renewal.json`。

项目、续期清单和密钥均放在包安装目录与 Git 之外，密钥也不能在两个上传目录内。如果进程在签发期间被强制结束，确认没有签发任务运行后，可能需要人工清理锁文件和临时 DNS TXT 记录。

## 发布行为与边界

OSS Bucket 中的网站文件公开可读。新 Bucket 带 `pi-aliyun-project` 标签，已有 Bucket 只有标签与当前项目匹配才会复用。FC 用函数描述中的项目标记检查归属。请使用专用资源名，不要指向无关的既有资源。如果创建成功但后续打标签或配置失败，先检查部分完成的资源再重试；不要对存有私密数据的 Bucket 绕过归属检查。

先上传资源文件，最后上传 HTML。HTML 和未识别出内容哈希的文件使用缓存再验证；文件名包含十六进制内容哈希的资源使用较长的不可变缓存。保留旧对象，让已打开的页面继续加载旧资源，之后再按实际需要清理。`.env*`、私钥扩展名、`.git`、`.aliyun` 等不会上传，但这不是完整的秘密扫描器，上传目录应当只包含已检查的构建产物。SPA 回退会对所有缺失对象返回 HTML，因此脚本路径错误也可能收到 HTML，排查时检查实际失败的资源请求。

FC 使用一个函数的 `LATEST` 版本，将最小实例数设为 0、设置实例数配额，并管理匿名 HTTP 触发器。业务鉴权仍由应用实现。CORS 仅允许配置的前端来源并支持凭据。发布会替换声明的函数环境变量，所需变量应完整写在 `environment` 或 `envFrom` 中；没有配置的高级 FC 设置不会被全面同步。

DNS 在每个配置的域名下管理一条默认线路 CNAME。已有单条 CNAME 可以更新为目标地址，其它记录类型或多条线路会使部署停止。FC 尚未识别新 CNAME 或 OSS 尚未识别验证 TXT 时，工具会等待并重试最多约两分钟；其它错误立即报告。发布按顺序执行，不是事务。失败后可能已有部分资源更新，修复原因再重试；工具没有自动破坏性回滚或资源删除命令。成功输出表示云 API 操作完成，不代表 DNS 已全面传播或业务正常，交付前检查实际访问地址和一个 API/健康接口。

数据库先选能满足业务的低成本方案，在已有费用及权限授权范围内自动创建应用独立的 Tablestore CU 实例和表、验证结构并配置 FC，重复发布保留数据。仅在明确声明 `database.shared.ownerProject` 和 `reason` 时使用该应用拥有的实例和表。现有 SQL 连接使用 `backend.envFrom`，也须明确资源独立或共享关系；此版不自动下单 RDS 或执行 SQL 迁移，详见[数据库流程](skills/aliyun/references/database.md)。FC 磁盘是临时的。当前自动部署范围是静态 OSS 前端、FC HTTP 后端、AliDNS/HTTPS 和 Tablestore，不代表支持阿里云全部产品。包不提供登录系统、任务队列、运行监控或费用硬上限。实例配额限制并行资源，不限制累计消费。FC 对有调用的函数小时存在最低计费，避免保活请求；估算时检查[FC 计费](https://help.aliyun.com/zh/functioncompute/billing-overview-of-fc)、OSS 流量、数据库及证书条款。

## 实现依据

使用官方 FC 2023-03-30、AliDNS 2015-01-09、STS、credentials SDK 和 `ali-oss`。由于 OSS SDK 的便捷方法未暴露完整字段，[PutBucketWebsite](https://help.aliyun.com/zh/oss/developer-reference/putbucketwebsite/) 和 [PutCname](https://help.aliyun.com/zh/oss/developer-reference/putcname) 通过 SDK 的签名请求接口处理 SPA 状态码及证书字段；[FC 域名](https://help.aliyun.com/zh/functioncompute/configure-custom-domain-names)直接调用官方接口配置。
