# 本地 MySQL 与 SaaS 启动

仅使用本地测试数据。不要连接宁波未来机械生产库，也不要导入生产数据。

## 一次性预配

1. 启动本机 MySQL，默认监听 `127.0.0.1:3306`。
2. 以本机 MySQL 管理员打开 `docs/local-saas-databases.sql`，将两个不同密码占位符替换为本机强密码后执行。它会创建相互独立的平台目录库 `bobo_saas_catalog_local` 和未来机械测试租户库 `bobo_tenant_future_machinery`，并为两库创建不同的应用账号。该脚本不含真实凭据，也不得对生产实例执行。
3. 未来机械测试库初始只包含空的 `app_state` 表。首次使用时，SaaS 程序会在其中写入其测试初始状态；平台数据库只保存租户目录、授权、会话和审计元数据。
4. 安装 Node.js LTS 和 pnpm，在本目录安装锁定依赖：

   ```powershell
   cd D:\WMR\lcb\未来网站改造\bobo-saas-commercial
   pnpm install --frozen-lockfile
   ```

## 启动

运行 `快速启动SaaS.cmd` 或在 PowerShell 执行：

```powershell
.\start-local-saas.ps1
```

首次运行会询问平台目录库和未来机械租户库的数据库密码、未来机械首位管理员姓名/手机号/密码，以及平台管理员凭据。应用只在独立租户库没有业务状态时创建该首位公司管理员和空白业务状态；不会从旧库或生产库复制数据。升级前的旧本地凭据文件会保留，首次改用双库时需要补录新目录库与租户库密码及首位公司管理员信息。后续凭据保存在 `%LOCALAPPDATA%\FutureMachinery\BoboSaaS\local-secrets.json`，使用当前 Windows 用户的 DPAPI 加密，双击启动不再询问。不要把凭据文件复制给其他用户或电脑。

默认平台库为 `bobo_saas_catalog_local`，未来机械测试租户库为 `bobo_tenant_future_machinery`，使用不同的数据库用户；端口默认 `3000`。如果连接参数不同，可使用 `-CatalogDatabase`、`-CatalogDatabaseUser`、`-TenantDatabase`、`-TenantDatabaseUser`、`-DatabaseHost`、`-DatabasePort` 和 `-AppPort` 覆盖。启动脚本首次补录本地 MySQL 预配管理员账号；仅在平台创建新公司时用于创建该租户的独立数据库和最小权限应用账号。预配管理员密码由当前 Windows 用户的 DPAPI 加密保存，不传给浏览器。新租户数据库名和账号由服务端根据随机租户 ID 生成；数据库路由元数据保存在平台目录，租户应用密码由本机保存的随机密钥派生，不以明文写入数据库。平台后台不会把用户输入当作数据库路由。

服务启动后访问：

- 工单系统：`http://localhost:3000/`
- 平台管理后台：`http://localhost:3000/platform-admin.html`
- 外协管理：`http://localhost:3000/outsourcing.html`
- 电视看板：`http://localhost:3000/tv.html`

平台后台凭据为首次启动时设置的账号密码。停止服务按 `Ctrl+C`。需要重设本机保存凭据时可运行 `重新设置启动凭据.cmd`。

## 安全边界

- 本地数据仅用于开发与隔离验证。SaaS 租户库与平台目录库分开，且各自使用独立应用账号；新租户通过平台后台创建时自动分配独立空库和只允许访问该库的应用账号。预配管理员只用于执行该流程的数据库 DDL 与授权。
- 保留 `%LOCALAPPDATA%\FutureMachinery\BoboSaaS\local-secrets.json` 中的 `tenantCredentialSecret`。它用于在每次启动时恢复新租户应用账号凭据；丢失或更改会导致已创建租户无法连接，需要受控恢复，不能用未来机械租户密码替代。
- 宁波未来机械现有生产库 `bobogd` / `future_orders` 不属于本地 SaaS 配置，禁止填写为平台目录库或租户库。生产数据迁移需要独立备份、字段/数量核对、恢复演练与单独授权，本地启动不会做迁移。
- 目前完成的是代码级路由和启动配置；尚未完成完整 API 越权审查、跨租户端到端测试、全端功能逐项回归、生产快照迁移和恢复演练。不要部署或导入生产数据。
