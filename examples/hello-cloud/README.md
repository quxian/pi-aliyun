# 云端回声

一个不依赖数据库或第三方运行时包的前后端分离示例。浏览器发送一句话，HTTP 后端返回原文、服务端时间和请求编号，不保存消息。前端可直接上传 OSS，后端可直接打包到 FC。

## 本地运行

在本目录执行 `node build.mjs`。分别在两个终端启动：

```sh
LOCAL_DEMO_ORIGIN=http://127.0.0.1:8080 node dist/backend/server.mjs
python3 -m http.server 8080 --bind 127.0.0.1 --directory dist/frontend
```

打开 `http://127.0.0.1:8080`。本地构建默认访问 `http://127.0.0.1:9000`；也可通过 `DEMO_API_ORIGIN` 指定接口地址。

## 部署到阿里云

把此目录复制到一个持久的项目目录，不要在能力包安装缓存内保存项目、证书或账号配置。使用 `init --project pi-aliyun-<name> --config /项目路径/aliyun.json` 继承账号配置，再参考 `aliyun.example.json` 填写本示例的构建命令和产物路径；大陆地域的域名需已备案。

配置部署身份，详见[包的凭据说明](../../README.md#配置账号)。填写自己的证书联系邮箱，阅读并同意所选 CA 的协议后设置 `tls.acme.agreeToTerms: true`；已有证书也可删除 `acme` 配置并提供 PEM 文件。

在项目目录用已安装能力包的 CLI 执行：

```sh
node /path/to/pi-aliyun/skills/aliyun/scripts/cli.mjs doctor
node /path/to/pi-aliyun/skills/aliyun/scripts/cli.mjs plan
node /path/to/pi-aliyun/skills/aliyun/scripts/cli.mjs deploy
```

构建时会从 `aliyun.json` 读取后端域名，生成前端 `config.json`。没有构建依赖，也不需要给函数配置访问云资源的运行时角色。部署后打开前端发送消息，并访问后端 `/health` 检查链路。

配置把函数实例数上限设为 1，空闲时缩容到 0；OSS 存储、流量和函数调用仍按云服务规则计费。证书文件和账户密钥保存在项目的 `.aliyun/tls` 下，不能删除或上传到公开仓库。证书续期使用 CLI 的 `renew` 命令，本例不自动安装定时任务。
