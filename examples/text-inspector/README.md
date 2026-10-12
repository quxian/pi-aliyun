# 文字计量台

一个独立的前后端分离项目：前端输入文本，后端返回字符数、去空白字符数、行数和 UTF-8 字节数，不保存文本，也不依赖数据库或第三方运行时包。字符使用 `Intl.Segmenter` 按字形统计。

复制此目录到包安装目录以外的持久项目目录。用 `init --project pi-aliyun-<name> --config /项目路径/aliyun.json` 继承账号配置，再参考 `aliyun.example.json` 设置本示例的构建命令与产物路径。证书协议及凭据按[包说明](../../README.md)配置。

```sh
node /path/to/pi-aliyun/skills/aliyun/scripts/cli.mjs deploy --config aliyun.json
node /path/to/pi-aliyun/skills/aliyun/scripts/cli.mjs schedule --config aliyun.json
```

已有部署角色覆盖本项目资源、域名已备案且每日续期定时器已经安装时，以上两步完成发布和续期登记，无需打开阿里云控制台。独立项目使用独立资源，不能复用其它项目的名称；遇到权限不足时按实际范围由管理员调整。

本地运行：执行 `node build.mjs`，然后分别启动 `LOCAL_TEXT_ORIGIN=http://127.0.0.1:8080 node dist/backend/server.mjs` 和 `python3 -m http.server 8080 --bind 127.0.0.1 --directory dist/frontend`，打开 `http://127.0.0.1:8080`。构建默认使用本目录 `aliyun.json` 的 API 域名；没有配置时使用 `http://127.0.0.1:9000`，也可通过 `TEXT_API_ORIGIN` 覆盖。
