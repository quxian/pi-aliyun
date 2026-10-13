# pi-aliyun

供 [Pi](https://pi.dev/) 使用的阿里云应用部署与维护能力包，也可独立使用 CLI。当前自动管理静态前端 OSS、HTTP 后端 FC、AliDNS、HTTPS 和 Tablestore；按业务需要启用。关系型数据库可接入已有连接，创建实例和管理 Schema 需另行实现对应产品流程。

**安装一次、配置账号授权一次，然后在批准范围内直接部署应用。** 先判断应用需要什么，再创建归该应用独立所有的资源，更新时复用。纯静态网站无需函数和数据库，纯计算 API 无需数据库或数据访问角色。共享资源需有明确需求；包、账号配置和业务项目各自独立。

## 安装

```sh
pi install git:github.com/quxian/pi-aliyun
```

重新加载 Pi 资源或开始新会话，使用 `/skill:aliyun`。

GitHub、Gitee 私有仓库也可以使用。先为**实际运行 Pi 的系统用户**配置 Git SSH 密钥或 HTTPS credential helper，再安装仓库地址。不要将 Token 或密码放进仓库 URL、聊天或项目配置；浏览器登录 GitHub 不会为服务器配置 Git 认证。

也可克隆仓库后运行 `npm ci`，再使用 `node /path/to/pi-aliyun/skills/aliyun/scripts/cli.mjs`。下文简写为 `pi-aliyun`。需要 Node.js 22 或以上；`npm run check` 做本地冒烟检查，不创建云资源。

### 可选：通过 Client Pi 安装

在「Agent 页面 → 能力包」填入 `https://github.com/quxian/pi-aliyun.git`，也支持已配置 Git 认证的私有仓库地址，如 `git@gitee.com:owner/pi-aliyun.git`。Client Pi 提供安装入口，本包独立于其源码和运行服务。

已与 Agent 约定开发并上线、且完成账号配置后，可以直接描述应用需求；Agent 应沿用现有授权完成交付。继续开发已有应用时，提供或沿用它的项目位置，新对话和新功能不会自动创建另一套应用资源。用户明确要求只讨论或只做本地开发时，按该范围执行。

## 配置账号

在 Client Pi 中使用时，从「连接 → 阿里云」完成浏览器授权并选择地域、域名即可，现有和新建 Agent 共用同一连接。服务器上的授权也使用同一流程：授权后若浏览器停在 localhost 地址，将完整回调地址填回连接页面。凭据由主机上的官方 CLI 和 SDK 管理；不要将凭据文件复制到对话或业务项目。Client Pi 使用 `PI_ALIYUN_ACCOUNT_FILE` 指定部署默认配置，`PI_ALIYUN_CONNECTION_FILE` 指定已连接的 OAuth profile，授权失效时在连接页面重新授权。

在部署服务用户的 `~/.config/pi-aliyun/account.json` 保存非敏感配置：

```json
{
  "version": 1,
  "accountId": "1234567890123456",
  "region": "cn-beijing",
  "zone": "example.com",
  "projectRoot": "/srv/projects",
  "acmeEmail": "operator@example.com",
  "acmeTermsAccepted": true
}
```

`projectRoot` 是新项目默认存放位置，由服务用户拥有；已有项目可留在其它持久目录。`acmeTermsAccepted` 只在用户已同意所选 CA 条款后设置，新应用继承这一同意。源码、项目配置、业务秘密和证书私钥不放在能力包安装目录或临时会话目录。需要代理访问证书服务时，可增加 `acmeProxyUrl`，例如 `http://127.0.0.1:7890`，不在 URL 中放密码。

凭据由官方 [credentials SDK](https://github.com/aliyun/credentials-nodejs) 读取：推荐为部署主机配置 RAM 角色，也可使用 SDK 凭据文件或环境变量 `ALIBABA_CLOUD_ACCESS_KEY_ID`、`ALIBABA_CLOUD_ACCESS_KEY_SECRET`，临时凭据再加 `ALIBABA_CLOUD_SECURITY_TOKEN`。SDK 默认凭据文件是该服务用户的 `~/.alibabacloud/credentials`，可用 `ALIBABA_CLOUD_CREDENTIALS_FILE` 指定其它路径；文件应只允许该用户读取。凭据属于**执行部署的主机和服务用户**，不是浏览器，也不写入上述 JSON。

```sh
pi-aliyun account
pi-aliyun policy --profile /path/to/account.json > deployment-policy.json
```

管理员将生成的完整策略授予部署身份一次，开通所用云服务。策略包含创建、查看、更新和删除应用资源，以及运行角色管理。证书列表、部署关系和删除接口要求账号级权限；程序只清理本应用域名和已记录指纹匹配的上传证书。同范围应用无需逐个手工配置 RAM；包更新需要新增权限时，先展示完整增量，经用户确认后更新这份正式策略。

**部署身份是受信任的管理身份。** 它能创建和修改 RAM 策略；角色和策略名称前缀不能约束策略正文，也不能作为防提权边界。仅将此身份交给受信任的部署环境；同一身份下的 Agent 或能取得实例凭据的进程不相互隔离。应用运行角色与它分开，只访问自己的业务数据，部署凭据绝不注入应用。

用户确认长期部署范围和按量费用后，把批准的产品、规格、地域、域名及费用范围原意记入 `account.json` 的 `authorization` 文本字段。Agent 跨对话读取并沿用，同范围内不重复询问；超出范围时一次确认增量。这个字段记录真实授权，不是账单硬上限，也不能由可用的云权限推断出消费授权。

## 开发和部署

```sh
pi-aliyun init --project pi-aliyun-myapp
cd /srv/projects/pi-aliyun-myapp
# 开发前后端，完善 aliyun.json
pi-aliyun doctor
pi-aliyun plan
pi-aliyun deploy
```

`init` 是唯一初始化入口，继承账号、地域、域名、低规格默认值和 CA 同意，不生成业务代码。为尚无部署配置的已有项目执行 `init --project pi-aliyun-myapp --config /path/to/project/aliyun.json`；已有 `.gitignore` 会保留。更新应用直接复用已有配置，`init` 会拒绝覆盖它。每个项目的 `aliyun.json` 使用相对于自身的路径；其它命令通过 `--config` 指向它。

| 配置 | 用途 |
| --- | --- |
| `project`、`accountId`、`region` | 应用名称和目标账号、地域 |
| `frontend.dir`、`frontend.build` | 静态产物目录和可选构建命令 `{cwd, command:[程序, 参数...]}` |
| `frontend.bucket`、`frontend.domain` | 应用专用 Bucket 和前端子域名 |
| `backend.codeDir`、`backend.build` | 包含全部生产依赖的后端产物和构建命令 |
| `backend.runtime`、`command`、`port` | FC 运行时、启动命令和监听端口 |
| `backend.cpu`、`memorySize`、`maxInstances` | 按业务和已批准费用范围选择的规格 |
| `backend.healthPath` | 默认 `/health`，无业务鉴权的只读健康接口，正常时返回 2xx，不暴露秘密或业务数据 |
| `backend.environment`、`envFrom` | 非敏感固定变量，以及函数变量到部署进程秘密变量的映射 |
| `database` | 应用独立数据库、表结构和用量估算，见[数据库说明](skills/aliyun/references/database.md) |
| `dns`、`tls` | AliDNS 区域、证书或 ACME 签发配置 |

模板包含前后端配置，部署前省略不需要的整个 `frontend` 或 `backend`；没有持久化需求就不配置 `database`。接手已有代码时，先核对业务行为与部署形态的适配。前端须为静态文件或框架的静态导出；后端保留普通 HTTP 服务形态，监听 `0.0.0.0` 和 `PORT`。后端及依赖须适配 FC Linux x86_64，不能直接上传本机原生模块；ZIP 上限 60 MiB。参考[无数据库示例](examples/hello-cloud/README.md)和[持久化示例](examples/durable-notes/README.md)。

前端 API 地址需在业务代码或构建配置中设为实际后端域名。前后端同时配置时，CLI 自动为 FC 触发器和自定义域名设置 CORS，允许配置中的 HTTPS 前端来源及 `Content-Type`、`Authorization` 请求头；应用避免重复写入冲突的 CORS 响应头，其它来源或自定义请求头需单独适配并验证。CORS 不代替业务鉴权。模板的目录、构建命令和运行时也需匹配实际项目。

`envFrom` 只读取部署进程的环境变量，不自动加载 `.env`。业务秘密应持久保存在产物目录外、已忽略的私有文件中（权限 0600），每次部署时加载，例如 `node --env-file=/path/to/private.env /path/to/pi-aliyun/skills/aliyun/scripts/cli.mjs deploy --config /path/to/project/aliyun.json`。普通更新复用既有秘密，不把变量缺失误当成需要重置口令；前端只使用公开配置。

`deploy` 自动构建、核对账号、准备资源和运行权限、发布代码、配置 DNS/HTTPS，再检查前端 HTTPS 与后端健康接口。非 2xx、证书或连接失败均返回失败，不会把上传成功等同于上线成功。最后由 Agent 验收真实业务；有持久化时验证鉴权读写与重新发布后数据保留。普通更新只验证受影响流程。

`doctor` 检查本地配置；`plan` 展示目标资源，不查询实时差异；`build` 只构建；`db-plan` 估算选定数据库的费用；`db-inspect` 只读检查数据库和角色；`db-setup` 单独执行部署已包含的数据库准备。

部署会保存不含秘密的 `.aliyun/resources.json`。重复发布复用本应用资源，归属冲突会停止；不会接管其它应用或删除数据库。同属一个系统或服务互相调用，不自动意味着共享数据库；共享须基于明确的数据共享需求并记录归属，详见[数据库说明](skills/aliyun/references/database.md)。

## 查看、排障与删除

```sh
pi-aliyun status --config /srv/projects/pi-aliyun-myapp/aliyun.json
pi-aliyun diagnose --config /srv/projects/pi-aliyun-myapp/aliyun.json
pi-aliyun verify --config /srv/projects/pi-aliyun-myapp/aliyun.json
pi-aliyun destroy --config /srv/projects/pi-aliyun-myapp/aliyun.json
# 用户明确要求删除该应用及数据后执行
pi-aliyun destroy --config /srv/projects/pi-aliyun-myapp/aliyun.json --confirm pi-aliyun-myapp
```

`status` 读取真实资源、DNS、数据库和证书状态；`diagnose` 加上本地检查和 HTTPS 检查，输出错误码、请求 ID 与排查方向，不输出业务响应正文、环境秘密或证书私钥。它不自动购买日志服务，也不修改应用。`verify` 可单独重新验收网络与健康接口。

不带 `--confirm` 的 `destroy` 只预览。确认执行后删除本应用 DNS、FC 域名和函数、OSS 对象及 Bucket、独立数据库、运行角色和策略、已记录的上传证书，并移除续期登记。数据库异步释放会等待并复核；失败时保留清单，修正原因后用同一命令继续。删除会永久清除云端数据，不自动备份。源码、配置和本地私有文件保留，由用户另行决定是否删除。

共享数据库在使用方删除时保留；所有者仍被其它应用权限策略引用时拒绝删除。额外域名或触发器、版本化 Bucket、自定义 VPC 等超出工具创建范围的资源，会在删除前报告需要单独处理。未知证书指纹或含其它域名的证书保留并列明。资源清单在部署过程中保存，包括证书指纹；不要先删除项目目录再要求工具清理云资源。

## 域名和 HTTPS

使用同一主域下不同的前端/API 子域。该域名的权威 DNS 应已交给 AliDNS；中国内地部署还需满足适用的 ICP 备案和接入要求。工具不购买域名、提交备案或更改注册商 NS。

可提供 `tls.certFile` 和 `tls.keyFile` 的 PEM 文件，也可让工具自动签发：

```json
"tls": {
  "certFile": ".aliyun/tls/fullchain.pem",
  "keyFile": ".aliyun/tls/privkey.pem",
  "acme": {
    "email": "operator@example.com",
    "accountKeyFile": ".aliyun/tls/account.key",
    "agreeToTerms": true,
    "renewBeforeDays": 30
  }
}
```

仅在用户同意 CA 条款后设置 `agreeToTerms`，既有同意可按范围沿用。默认使用 Let's Encrypt，通过 DNS-01 签发；OSS 域名验证也自动完成，只清理本次创建的临时 TXT 记录。有效证书直接复用，进入续期窗口再签发。私钥保存在持久私有目录，不提交 Git、不上传到前端或后端产物。

配置账号并启用 ACME 的项目在部署后自动登记续期；也可手动登记。Linux 管理员只需安装一次定时器：

```sh
# 部署服务用户执行
pi-aliyun schedule --config /srv/projects/pi-aliyun-myapp/aliyun.json
# 管理员执行；替换实际用户、清单路径和 CLI 路径
sudo node /path/to/pi-aliyun/skills/aliyun/scripts/cli.mjs install-renewal --user deploy-user --registry /home/deploy-user/.config/pi-aliyun/renewal.json
sudo systemctl start pi-aliyun-renew.service
systemctl list-timers pi-aliyun-renew.timer
```

每天按服务器时区 03:15–03:30 检查，以指定服务用户执行并复用其凭据和网络。日志见 `journalctl -u pi-aliyun-renew.service`；其它环境可每天运行 `renew-all --registry /path/to/renewal.json`。包升级保持安装路径；换路径后重新安装定时器。`destroy` 会移除该应用的续期登记。

## 运行边界

OSS 网站文件公开读取，部署会关闭应用专用 Bucket 的阻止公共访问开关，不修改账号级开关。Bucket 只放公开构建产物；工具跳过常见秘密文件，但不代替产物检查。FC HTTP 入口由应用实现鉴权，默认 FC 公网 URL 被关闭，发布的 API 自定义域名使用 HTTPS。OSS HTTPS 可用，但工具不强制禁用其 HTTP 访问。

发布不是云端事务；失败时可能已有部分资源完成，修正原因后重试。函数使用 `LATEST`，最小实例数为 0，部署会替换声明的环境变量。数据库和旧静态文件不会因重复发布被删除。工具不提供用户登录系统、监控告警或费用硬上限；实例配额只限制并发，不限制累计消费。

费用依据实际存储、请求和流量，核对 [FC 计费](https://help.aliyun.com/zh/functioncompute/billing-overview-of-fc)及[数据库费用说明](skills/aliyun/references/database.md)。数据库选型应保留业务所需的数据语义，超出当前自动化范围时按实际产品落实创建和维护流程。
