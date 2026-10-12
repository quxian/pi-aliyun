# 云端便笺

验证 OSS、FC 和 Tablestore 持久化。页面输入共享访问口令后可读写一条便笺；这是部署示例，不是多用户登录系统。仅保存验证文字，真实应用实现自己的身份与授权。

1. 将本目录复制到包安装目录外，用 `init --project pi-aliyun-<name> --config /项目路径/aliyun.json` 继承账号配置，再参考 `aliyun.example.json` 设置本示例的构建、产物、`envFrom` 和 `database`。默认创建本应用自己的数据库实例；不要填入其它应用的实例地址。
2. 将包内 `skills/aliyun/assets/tablestore-runtime.mjs` 复制到项目 `backend/tablestore-runtime.mjs`。应用运行时只依赖自己的 `tablestore`，不依赖包安装路径。
3. 生成随机口令，放入部署进程 `PI_NOTES_TOKEN`；不要打印口令、写入前端或提交 Git。后端通过 `envFrom` 使用它。保留在部署主机的私有环境文件（0600），再次发布时加载。
4. 执行 `doctor`、`plan` 和 `db-plan`，核对声明资源及用量是否在已有授权范围内，只有超出范围时才合并确认增量。需要检查已有数据库时使用 `db-inspect`；首次部署前实例和角色尚未创建属于正常情况。
5. 执行 `deploy`，自动完成构建、数据库及运行角色准备、发布和 ACME 续期登记。打开 HTTPS 页面，输入口令并保存测试便笺；读取验证后再次 `deploy`，确认便笺仍可读。部署主机的续期定时器按[包说明](../../README.md#域名和-https)一次安装。

`GET /health` 不访问数据库。`GET /note`、`PUT /note` 需要 `Authorization: Bearer <口令>`；PUT JSON 为 `{"text":"验证文字"}`。接口只读写一行、正文最多 4096 字节，没有扫描或公开写入口。需要对外公开的业务应补充限流。示例不删除表、实例或验证文字。

运行时辅助文件来自包的单一源文件，因此不在此目录重复维护，构建前先完成第 2 步。Node 依赖锁文件已提交，`build` 在后端执行 `npm ci --omit=dev --ignore-scripts`，前端无需构建工具。
