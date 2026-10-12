# 数据库选择与配置

按查询、事务和持久化要求选择满足业务的低成本方案。每个应用默认拥有自己的数据库实例；只有用户明确要求组成同一个系统或共享数据时才共享。FC 临时磁盘不能保存长期数据。

| 业务需要 | 选择 |
| --- | --- |
| 不保存用户数据 | 不创建数据库 |
| 按用户、ID、时间范围读写，单行条件更新满足一致性 | 应用独立的 Tablestore CU 实例，在线应用通常选 SSD |
| 写多读少的日志、归档，能接受更高读取延迟 | 评估 CU 模式 HYBRID 的价格和延迟 |
| SQL/ORM、复杂关联、跨表事务、余额或库存一致性 | 满足业务的关系型数据库；不能只为低价强行使用 KV |

Tablestore 的 SQL 查询入口不等同于 MySQL 协议或关系型事务。其局部事务限于同一分区键；本包示例使用单行读写。个人收支记录和需要一致转账的账户系统并非同一种数据需求。[官方能力](https://help.aliyun.com/zh/tablestore/table-store-service/product-overview/what-is-tablestore)、[实例类型与限制](https://help.aliyun.com/zh/tablestore/table-store-service/product-overview/basic-concepts)。

## 费用

Tablestore 使用 CU 按量计费，预留读写为 0，不默认启用索引、复制、VCU、NAT 或额外备份服务。CU 实例没有额外实例购买费，按存储、实际读写和流量计费，因此小应用不必为了节省固定实例月租而共享实例。

`db-plan` 给出单价、核查日期和月用量假设，来源为[官方定价](https://www.aliyun.com/price/product#/ots/detail/otsbag)。它是公开价估算，不是实时账单或硬上限；不抵扣未核实的免费额度。沿用 `account.json` 中用户已确认的费用和权限范围，范围内直接部署，超出范围一次确认增量。

需要关系型数据库时，核对目标账号和地域的实际订单、最低计费及续费价格。Serverless 不等于无固定费用，不能只比较首购优惠。此版支持通过 `backend.envFrom` 接入已有 SQL 数据库，不自动购买 RDS、创建 SQL Schema 或执行 SQL 迁移。独立实例不符合预算时，应解释取舍，不能自行让无关应用共享。[RDS 费用构成](https://help.aliyun.com/zh/rds/product-overview/billable-items-billing-methods-and-pricing/)。

## Tablestore

在项目 `aliyun.json` 添加：

```json
"database": {
  "kind": "tablestore",
  "clusterType": "SSD",
  "tables": [{
    "name": "records",
    "primaryKey": [
      { "name": "owner", "type": "STRING" },
      { "name": "id", "type": "STRING" }
    ]
  }],
  "usage": {
    "storageGB": 0.1,
    "readCU": 100000,
    "writeCU": 10000,
    "internetGB": 0.1
  }
}
```

实例名按应用名生成：`pi-app-` 加 SHA256 前 8 位；表名前缀也由应用名派生。数据库归属必须匹配，不能接管其它应用的实例。`usage` 是月用量估计，不是配额；存储是平均存量，流量是公网下行，HTTP 请求数不直接等于 CU 数。按业务填写假设。

```sh
pi-aliyun db-plan --config aliyun.json
pi-aliyun deploy --config aliyun.json
```

`deploy` 使用部署身份创建或检查运行角色、实例和表，并注入连接变量。`db-setup` 可单独准备数据库，`db-inspect` 只读检查已有资源。无需逐项目手工创建 RAM 角色。

表永久保存（TTL=-1）、仅保留最新版本（maxVersions=1）、预留读写均为 0。重发版检查既有结构并保留数据，不自动变更主键、移动或删除数据。移除配置也不会删除云端资源。遇到实例或表数配额限制时处理配额，不悄悄合并应用。

需要共享时，在使用方的 `database` 中增加：

```json
"shared": {
  "ownerProject": "pi-aliyun-orders",
  "reason": "订单 API 与后台处理服务属于用户明确要求的同一个系统"
}
```

实例及物理表前缀随所有者应用，使用方仍保留自己的 FC 运行角色。共享带来共同的数据生命周期；同属一个阿里云账号不是共享理由。

## 运行权限与连接

部署身份直接管理应用角色和策略；这是一次授予的受信任管理权限，详见[账号配置](../../../README.md#配置账号)。应用运行角色只信任 FC，只能读写自身或明确共享表前缀的数据行，没有建表、删表或 RAM 管理权限。部署密钥始终留在部署环境，不交给业务应用。

CLI 注入非敏感变量 `TABLESTORE_INSTANCE`、`TABLESTORE_ENDPOINT` 和 JSON 对象 `TABLESTORE_TABLES`。默认使用需要 RAM 签名的 HTTPS 公网端点，数据库不公开读取；费用估算包含公网下行，小流量不额外引入 NAT。

Node 后端可使用 [tablestore-runtime.mjs](../assets/tablestore-runtime.mjs)，安装 `tablestore` 并采用示例的 `protobufjs` override。Debian 10 从每个 FC 请求取得新临时凭据，其它受支持运行时使用 FC 环境凭据；每次请求创建客户端，不缓存请求头凭据。先做业务鉴权，不回显请求头、SDK 错误或秘密。完整示例见[云端便笺](../../../examples/durable-notes/README.md)。
