# Database selection

Choose from the application's access patterns and the user's existing resources. Avoid automatically purchasing an instance just because the backend exists.

- Static content, simple configuration files and user uploads belong in OSS when object replacement and object retrieval are sufficient. OSS does not provide relational queries or multi-record transactions.
- For ordinary SQL, joins and transactions, reuse an existing RDS MySQL/PostgreSQL database where possible. Give each project its own database/schema and least-privileged database user. Share instance cost when isolation and capacity allow it. A small provisioned instance can be more predictable than a serverless instance with a nonzero minimum; compare the current region's full recurring price, storage and backups before buying.
- Tablestore can be economical for key-oriented records and predictable primary-key/range access with variable traffic. Its SQL interface does not make it a drop-in PostgreSQL/MySQL replacement. Check required indexes and query costs before choosing it.
- FC local disk is temporary and per-instance. A SQLite file there is not durable. Mounting a network filesystem only to host SQLite adds concurrency and filesystem tradeoffs; it is not this package's default database path.

This CLI never purchases a database, changes its schema or silently migrates data. Supply an existing connection at deployment time:

```json
"backend": {
  "envFrom": { "DATABASE_URL": "APP_DATABASE_URL" },
  "vpcConfig": {
    "vpcId": "vpc-...",
    "vSwitchIds": ["vsw-..."],
    "securityGroupId": "sg-..."
  }
}
```

The snippet is merged with the rest of `backend`; it is not a complete configuration. `APP_DATABASE_URL` comes from the user's environment or CI secret store. Configure database network access and credentials separately. A small connection pool must account for all FC instances. FC supports VPC access alongside its managed public internet access, so a database does not by itself require a NAT gateway.

Current official references: [RDS billing](https://help.aliyun.com/zh/rds/product-overview/billing-overview/), [Tablestore billing](https://help.aliyun.com/zh/tablestore/product-overview/billing-overview), [FC network configuration](https://help.aliyun.com/zh/functioncompute/configure-network-settings), [FC runtime storage](https://help.aliyun.com/zh/functioncompute/terms-of-fc). Check current Chinese-site prices when advising on a purchase; do not quote expired promotional prices as ongoing cost.
