# 云端便笺

验证 OSS、FC 和 Tablestore 持久化。页面输入共享访问口令后可读写一条便笺；这是部署示例，不是多用户登录系统。仅保存验证文字，真实应用实现自己的身份与授权。

1. 将本目录复制到包安装目录外，复制 `aliyun.example.json` 为 `aliyun.json`，调整账号、资源名、域名和 TLS/ACME 配置。默认创建本应用自己的数据库实例；不要填入其它应用的实例地址。
2. 将包内 `skills/aliyun/assets/tablestore-runtime.mjs` 复制到项目 `backend/tablestore-runtime.mjs`。应用运行时只依赖自己的 `tablestore`，不依赖包安装路径。
3. 生成随机口令，放入部署进程 `PI_NOTES_TOKEN`；不要打印口令、写入前端或提交 Git。后端通过 `envFrom` 使用它。保留在部署主机的私有环境文件（0600），再次发布时加载。
4. 执行 `doctor`、`build`、`db-plan`、`db-inspect`。核对数据库估算、实例、项目表、独立 FC 角色和网站资源是否在已有授权范围内；只有真正新增费用或权限时才合并确认。已安装平台会自动维护运行角色，按[数据库流程](../../skills/aliyun/references/database.md)继续，无需逐项目保存审批文件。
5. 执行 `deploy` 和 `schedule`。打开 HTTPS 页面，输入口令并保存测试便笺；读取验证后再次 `deploy`，确认便笺仍可读。

`GET /health` 不访问数据库。`GET /note`、`PUT /note` 需要 `Authorization: Bearer <口令>`；PUT JSON 为 `{"text":"验证文字"}`。接口只读写一行、正文最多 4096 字节，没有扫描或公开写入口。需要对外公开的业务应补充限流。示例不删除表、实例或验证文字。

运行时辅助文件来自包的单一源文件，因此不在此目录重复维护，构建前先完成第 2 步。Node 依赖锁文件已提交，`build` 在后端执行 `npm ci --omit=dev --ignore-scripts`，前端无需构建工具。

已有数据需要更换实例时，不能只修改连接地址。按[迁移步骤](../../skills/aliyun/references/database.md#迁移到应用独立实例)暂停写入、备份、复制并比对数据，切换后再恢复写入；保留旧实例的数据。
