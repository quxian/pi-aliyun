# pi-aliyun

供 [Pi](https://pi.dev/) 使用的阿里云部署能力包。把静态前端发布到 OSS、HTTP 后端发布到 FC，自动配置域名、HTTPS 和按业务选择的低成本数据库。

**安装一次、配置账号授权一次，然后直接部署应用。** 每个应用默认拥有自己的 Bucket、函数、数据库实例和运行角色；只有明确要求时才共享。包、账号配置和业务项目各自独立，不依赖 Client Pi 源码或特定前后端框架。

## 安装

```sh
pi install git:github.com/quxian/pi-aliyun
```

重新加载 Pi 资源或开始新会话，使用 `/skill:aliyun`。Client Pi 可在「Agent 页面 → 能力包」填入 `https://github.com/quxian/pi-aliyun.git`；这是安装入口，不是运行依赖。

GitHub、Gitee 私有仓库也可以使用。先为**实际运行 Pi 的系统用户**配置 Git SSH 密钥或 HTTPS credential helper，再安装仓库地址。Client Pi 接受例如 `git@gitee.com:owner/pi-aliyun.git`。不要将 Token 或密码放进仓库 URL、聊天或项目配置；浏览器登录 GitHub 不会为服务器配置 Git 认证。

也可克隆仓库后运行 `npm ci`，再使用 `node /path/to/pi-aliyun/skills/aliyun/scripts/cli.mjs`。下文简写为 `pi-aliyun`。需要 Node.js 22 或以上；`npm run check` 做本地冒烟检查，不创建云资源。

## 配置账号

在部署服务用户的 `~/.config/pi-aliyun/account.json` 保存非敏感配置：

```json
{
  "version": 1,
  "accountId": "1234567890123456",
  "region": "cn-beijing",
  "zone": "example.com",
  "projectRoot": "/srv/projects",
  "acmeEmail": "operator@example.com"
}
```

`projectRoot` 是新项目默认存放位置，由服务用户拥有；已有项目可留在其它持久目录。源码、项目配置、业务秘密和证书私钥不放在能力包安装目录或临时会话目录。需要代理访问证书服务时，可增加 `acmeProxyUrl`，例如 `http://127.0.0.1:7890`，不在 URL 中放密码。

凭据由官方 [credentials SDK](https://github.com/aliyun/credentials-nodejs) 读取：推荐为部署主机配置 RAM 角色，也可使用 SDK 凭据文件或环境变量 `ALIBABA_CLOUD_ACCESS_KEY_ID`、`ALIBABA_CLOUD_ACCESS_KEY_SECRET`，临时凭据再加 `ALIBABA_CLOUD_SECURITY_TOKEN`。SDK 默认凭据文件是该服务用户的 `~/.alibabacloud/credentials`，可用 `ALIBABA_CLOUD_CREDENTIALS_FILE` 指定其它路径；文件应只允许该用户读取。凭据属于**执行部署的主机和服务用户**，不是浏览器，也不写入上述 JSON。

```sh
pi-aliyun account
pi-aliyun policy --profile /path/to/account.json > deployment-policy.json
```

管理员将生成的完整策略授予选定的部署身份一次，开通所用云服务。策略覆盖约定账号、地域和域名下的网站资源、数据库实例和表，以及应用运行角色的创建、策略维护和向 FC 传递角色。后续 `deploy` 直接完成这些操作，无需逐个应用手工配置 RAM。

**部署身份是受信任的管理身份。** 它能创建和修改 RAM 策略；角色和策略名称前缀不能约束策略正文，也不能作为防提权边界。仅将此身份交给受信任的部署环境；同一身份下的 Agent 或能取得实例凭据的进程不相互隔离。应用运行角色与它分开，只访问自己的业务数据，部署凭据绝不注入应用。

用户确认长期部署范围和按量费用后，把批准的产品、规格、地域、域名及费用范围原意记入 `account.json` 的 `authorization` 文本字段。Agent 跨对话读取并沿用，同范围内不重复询问；超出范围时一次确认增量。这个字段记录真实授权，不是账单硬上限，也不能由可用的云权限推断出消费授权。

## 开发和部署

```sh
pi-aliyun project-init --project pi-aliyun-myapp
cd /srv/projects/pi-aliyun-myapp
# 开发前后端，完善 aliyun.json
pi-aliyun doctor
pi-aliyun plan
pi-aliyun deploy
```

`project-init` 创建独立项目目录与配置，不生成业务代码。部署时自动构建、核对账号、创建或检查资源、配置运行角色和数据库连接、发布代码并绑定 HTTPS。每个项目的 `aliyun.json` 使用相对于自身的文件路径；命令可通过 `--config /path/to/aliyun.json` 指向它。

| 配置 | 用途 |
| --- | --- |
| `project`、`accountId`、`region` | 应用名称和目标账号、地域 |
| `frontend.dir`、`frontend.build` | 静态产物目录和可选构建命令 `{cwd, command:[程序, 参数...]}` |
| `frontend.bucket`、`frontend.domain` | 应用专用 Bucket 和前端子域名 |
| `backend.codeDir`、`backend.build` | 包含全部生产依赖的后端产物和构建命令 |
| `backend.runtime`、`command`、`port` | FC 运行时、启动命令和监听端口 |
| `backend.cpu`、`memorySize`、`maxInstances` | 按业务和已批准费用范围选择的规格 |
| `backend.environment`、`envFrom` | 非敏感固定变量，以及函数变量到部署进程秘密变量的映射 |
| `database` | 应用独立数据库、表结构和用量估算，见[数据库说明](skills/aliyun/references/database.md) |
| `dns`、`tls` | AliDNS 区域、证书或 ACME 签发配置 |

不需要的一端可删除整个配置。前端必须是静态文件或框架的静态导出；后端保留普通 HTTP 服务形态，监听 `0.0.0.0` 和 `PORT`，无需每条路由拆成一个函数。后端及依赖须适配 FC Linux x86_64，不能直接上传本机原生模块；ZIP 上限 60 MiB。参考[无数据库示例](examples/hello-cloud/README.md)和[持久化示例](examples/durable-notes/README.md)。

`doctor` 检查本地配置；`plan` 展示目标资源，不查询实时差异；`build` 只构建；`db-plan` 估算数据库费用；`db-inspect` 只读检查数据库和角色；`db-setup` 单独执行部署已包含的数据库准备。正常主流程只需 `deploy`，完成后检查 HTTPS、真实 API；使用数据库时再验证一次读写及重发版后数据保留。

部署会保存不含秘密的 `.aliyun/resources.json`。重复发布复用本应用资源，归属冲突会停止；不会接管其它应用或删除数据库。共享必须明确声明，详见[数据库说明](skills/aliyun/references/database.md)。

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

每天按服务器时区 03:15–03:30 检查，以指定服务用户执行并复用其凭据和网络。日志见 `journalctl -u pi-aliyun-renew.service`；其它环境可每天运行 `renew-all --registry /path/to/renewal.json`。包升级保持安装路径；换路径后重新安装定时器。停用项目时从清单删除对应配置路径。

## 运行边界

OSS 网站文件公开读取，部署会关闭应用专用 Bucket 的阻止公共访问开关，不修改账号级开关。Bucket 只放公开构建产物；工具跳过常见秘密文件，但不代替产物检查。FC HTTP 入口由应用实现鉴权，默认 FC 公网 URL 被关闭，发布的 API 自定义域名使用 HTTPS。OSS HTTPS 可用，但工具不强制禁用其 HTTP 访问。

发布不是云端事务；失败时可能已有部分资源完成，修正原因后重试。函数使用 `LATEST`，最小实例数为 0，部署会替换声明的环境变量。数据库和旧静态文件不会因重复发布被删除。工具不提供用户登录系统、监控告警或费用硬上限；实例配额只限制并发，不限制累计消费。

当前自动创建范围为 OSS、FC、AliDNS/HTTPS 和 Tablestore。关系型数据库可通过 `envFrom` 接入，但本包不自动购买 RDS。不要仅为保持默认方案而强迫业务使用不适合的数据模型。费用依据实际存储、请求和流量，核对 [FC 计费](https://help.aliyun.com/zh/functioncompute/billing-overview-of-fc)及[数据库费用说明](skills/aliyun/references/database.md)。
