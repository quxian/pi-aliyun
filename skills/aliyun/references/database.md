# 数据库选择、创建和连接

从查询、事务和持久化要求决定数据库，先复用适合的已有资源，再选择新增成本最低、能满足要求的方案。不要用 FC 临时磁盘保存长期数据，也不要借用宿主应用内部的 SQLite 文件。

| 业务需要 | 默认选择 | 创建与连接 |
| --- | --- | --- |
| 无需保存用户数据 | 不创建数据库 | 静态内容放 OSS |
| 按用户/租户、ID、时间区间读取记录，单行条件更新能满足一致性 | Tablestore CU 模式，在线应用默认 SSD | CLI 创建实例和表，配置 FC 连接元数据，运行角色需管理员初始化 |
| 写多读少的日志、归档，能接受较高读取延迟 | Tablestore CU 模式 HYBRID | 同上；实例类型创建后不可直接修改 |
| SQL/ORM、复杂关联、跨表事务，或余额/库存等强一致业务 | 已有 RDS MySQL/PostgreSQL 优先 | 项目独立数据库和普通账号，FC 同地域 VPC，秘密通过 `backend.envFrom` 注入 |
| 必须新建关系型实例 | 核实 RDS 普惠年付与普通实例/Serverless 实际报价 | 先生成一次性费用/权限确认；此版 CLI 不下单 RDS，也不执行 SQL 迁移 |

Tablestore 的 SQL 查询入口不等同于 MySQL 协议和事务语义。局部事务只在同一分区键内；本包的 Node 宽表创建/连接示例使用单行读写，未封装局部事务。个人收支记录可按用户及日期组织；转账、余额一致性或复杂报表应重新判断，不能仅因为应用名叫“账本”就固定选它。[官方模型与能力](https://help.aliyun.com/zh/tablestore/table-store-service/product-overview/what-is-tablestore)、[实例类型和限制](https://help.aliyun.com/zh/tablestore/table-store-service/product-overview/basic-concepts)。

## 极低成本配置

使用 CU 按量模式，不创建 VCU 计算资源，不配置预留读写，不默认启用多元索引、全局索引、跨地域复制、NAT 或额外备份服务。高性能型也没有额外实例购买费；存量数据、实际读写和公网下行仍会计费。容量型更便宜，但官方不建议用于对访问延迟敏感的在线场景。

`db-plan` 保存核查日期、[官方定价页](https://www.aliyun.com/price/product#/ots/detail/otsbag)、单价、用量假设及计算结果。它是公开价估算，不是实时询价。购买或扩大范围前检查账号和地域的价格；免费额度在未核实前不抵扣。CU 模式没有整体费用硬上限；应用必须鉴权、限制正文、分页和查询范围，并按实际流量限流。FC 实例数上限不能限制每月账单。

关系型数据库不要因为名字包含 Serverless 就默认购买。当前[官方 RDS 活动](https://www.aliyun.com/activity/database/bestoffers)有 99 元/年的起价（需核实账号资格、地域、规格、续费条件及最终订单）；多个合适的小项目可共享实例，各用独立库/账号。API 普通报价不保证享受活动价。RDS Serverless 可能有最低计算计费与持续的存储费用，暂停不等于零费用。[RDS 费用构成](https://help.aliyun.com/zh/rds/product-overview/billable-items-billing-methods-and-pricing/)。

## Tablestore 配置

在项目 `aliyun.json` 中增加：

```json
"database": {
  "kind": "tablestore",
  "instance": "pi-data-ssd",
  "clusterType": "SSD",
  "tables": [{
    "name": "records",
    "primaryKey": [{ "name": "owner", "type": "STRING" }, { "name": "id", "type": "STRING" }]
  }],
  "usage": { "storageGB": 0.1, "readCU": 100000, "writeCU": 10000, "internetGB": 0.1 }
}
```

`usage` 是每月估计，不是配额。storageGB 是月平均存量，internetGB 是月公网下行。CU 按官方规则计算，不能把所有 HTTP 请求一律当作一个 CU。未填写时采用上述演示用量，Agent 必须结合业务调整并告知假设。

一个专用实例可容纳多个项目，默认实例名为 `pi-data-ssd` / `pi-data-hdd`。实例必须有本包的管理描述，不能自动接管其它实例。物理表名加入由项目名和哈希组成的前缀；新表永久保存（TTL=-1）、仅保留最新版本（maxVersions=1）、0 预留 CU。复用时验证主键、版本、TTL、预留和二级索引设置；不自动改结构或删数据。改主键需另做数据迁移。移除配置不会删除云端表。达到表数/实例数配额时先清点，不随意建更多实例。

```sh
node /path/to/pi-aliyun/skills/aliyun/scripts/cli.mjs db-plan
node /path/to/pi-aliyun/skills/aliyun/scripts/cli.mjs db-inspect
# 一次性获得用户对费用、网络和全部权限变化的确认后：
node /path/to/pi-aliyun/skills/aliyun/scripts/cli.mjs db-approve --fingerprint <已确认计划的指纹>
# 单独授权的管理员运行一次，或在 RAM 应用 db-plan 的角色和策略：
node /path/to/pi-aliyun/skills/aliyun/scripts/cli.mjs db-role
# 普通部署身份；也可直接 deploy，一并创建数据库并发布应用：
node /path/to/pi-aliyun/skills/aliyun/scripts/cli.mjs db-setup
node /path/to/pi-aliyun/skills/aliyun/scripts/cli.mjs deploy
```

`db-inspect` 只读，合并报告角色与数据库权限问题。缺少写权限时仍可能在创建阶段失败，它不是 RAM 权限模拟器。`db-approve` 只保存操作者已取得的用户确认，不验证聊天身份，不代表云端限额；Agent 不能自行为未确认计划运行它。确认文件在项目 `.aliyun/database-approval.json`（0600），不随升级丢失、不进 Git。账号、地域、函数、表配置、用量或授权范围变化会使指纹失效。

## 权限与运行凭据

`db-plan.access` 给出角色、信任策略、数据策略和部署权限增量：

- 管理员创建只信任 FC 的项目角色，仅附加该项目表前缀的读写策略；没有建表、删表、其它数据库或 RAM 管理权。
- 部署角色需要实例列表/详情/创建、本项目前缀的建表/查结构、读取上述角色/策略及仅向 FC 传递该角色的 `PassRole`。不增加 RAM 管理权，也不需要业务数据读写权。
- 更新已有部署策略时追加这些语句，保留其它项目；不要拿某个项目的完整 `policy` 覆盖其它项目的数据库授权。

`db-role` 自动化管理员的创建/绑定操作，拒绝覆盖不同的已有角色或策略；它不会替普通部署身份提升权限。没有管理员 API 身份时，首次授权需管理员通过控制台或其它已授权入口完成。新项目的独立角色可能需新增授权；与项目费用一起确认。以后同一项目在已批准范围内发布不再重复确认。

应用使用 FC 临时凭据；部署凭据始终留在部署主机。CLI 注入非敏感变量 `TABLESTORE_INSTANCE`、`TABLESTORE_ENDPOINT` 和 JSON 对象 `TABLESTORE_TABLES`。默认使用需 RAM 签名的 HTTPS 公网端点（数据并非公开可读），避免仅为小流量引入 VPC/NAT；估算包含公网下行。

Node 应用可复制 [tablestore-runtime.mjs](../assets/tablestore-runtime.mjs)，自行安装 `tablestore`，采用示例中修复过的 `protobufjs` override。Debian 10 从每个 FC 请求头取得新临时凭据；其它受支持运行时使用 FC 环境凭据。每次请求创建客户端，不缓存请求头凭据。业务鉴权在数据库访问前完成；不回显请求头、SDK 错误或秘密。[FC 上下文说明](https://help.aliyun.com/zh/functioncompute/fc/context-and-log-format-1)。

完整开发与持久化验证见[云端便笺](../../../examples/durable-notes/README.md)。需要 SQL 时，Agent 在已批准的 RDS 上创建独立库/普通用户、执行迁移和验证 VPC；现有连接通过 `backend.envFrom` 注入。不能把“生成连接变量”报告为已经创建了 RDS。
