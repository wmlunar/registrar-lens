# RegistrarLens

RegistrarLens 是一个静态、隐私优先的域名注册商解析工具。它直接使用 IANA RDAP 引导数据和注册局的权威 RDAP 服务，支持单个或批量查询、结果追溯与 CSV 导出；不需要账号、API Key、数据库或自建查询后端。

[在线使用](https://wmlunar.github.io/registrar-lens/) · [报告问题](https://github.com/wmlunar/registrar-lens/issues)

> gTLD（如 `.com`、`.net`、`.org`）的 RDAP 数据通常更规范，解析相对可靠。ccTLD 的字段和开放程度差异较大，本项目只能尽力返回结果，**不承诺覆盖所有域名**。

## 功能

- 单个域名与批量域名查询
- 从 URL 或域名输入中提取并规范化域名
- 查询真实的权威 RDAP 数据，而不是在注册商清单中做字符串匹配
- 解析注册商名称、IANA Registrar ID、查询来源和失败原因
- 在浏览器中生成并下载 CSV
- 纯静态部署，无项目自有查询服务器
- 无运行时依赖、无 API Key

## 本地运行

无需安装项目依赖。克隆仓库后，在项目根目录任选一种方式启动静态服务器：

```bash
python -m http.server -d public 8000
```

或：

```bash
npx serve public
```

随后打开 `http://localhost:8000`。请通过本地 HTTP 服务器访问，不建议直接双击 `public/index.html`，因为浏览器对 ES modules 和跨域请求有额外限制。

运行测试需要 Node.js 22 或更高版本：

```bash
npm test
```

## 工作原理

```text
用户浏览器
  ├─ 获取 IANA DNS RDAP Bootstrap
  ├─ 按顶级域选择权威注册局 RDAP 服务
  ├─ 查询 /domain/{domain}
  ├─ 从 registrar entity / publicIds 解析注册商信息
  └─ 在本地展示并导出 CSV
```

项目没有通用代理服务，也不提供公共批量查询 API。查询流量从使用者的浏览器直接发出，有助于把运行成本和数据留存降到最低。

## 数据来源

- [IANA RDAP Bootstrap Service Registry](https://data.iana.org/rdap/dns.json)：把顶级域映射到对应的权威 RDAP 服务。
- 各注册局或运营方公开的 RDAP 响应：提供域名实体及其注册商信息。
- RDAP 标准：[RFC 9082](https://www.rfc-editor.org/rfc/rfc9082) 与 [RFC 9083](https://www.rfc-editor.org/rfc/rfc9083)。

RegistrarLens 不维护一份声称完整的注册商结果数据库；每次未命中本地浏览器缓存的查询以权威 RDAP 响应为准。

## 隐私

- 无账号、无统计脚本、无项目自有数据库。
- 域名列表、查询结果和 CSV 生成均在浏览器端处理。
- 为完成查询，浏览器会向 IANA 和相应的 RDAP 服务发送请求；这些第三方会看到访问者 IP、请求域名以及常规 HTTP 元数据，并适用其各自的隐私政策。
- 浏览器可能在本地保存缓存。清除该站点的浏览器数据即可移除。
- 如果你不希望第三方 RDAP 服务看到批量请求，请勿提交敏感域名列表。

## 已知限制

- 部分 ccTLD 不公开注册商、没有 IANA Registrar ID，或使用非标准结构。
- 某些 RDAP 服务未开放浏览器跨域访问（CORS），即使该域名存在也可能查询失败。
- 权威服务可能限速、超时、暂时不可用，批量查询尤其容易触发限制。
- 域名输入规范化不能替代完整的公共后缀判断；特殊私有后缀可能无法按预期处理。
- 注册商名称、IANA ID 和域名状态取决于上游数据质量与更新时间。
- 查询结果仅供信息参考，不构成域名权属、法律状态或合规证明。

遇到失败时，请查看界面给出的失败原因和 RDAP 来源，稍后重试，或直接访问对应注册局的查询服务核验。

## 免费部署

### GitHub Pages

仓库自带 GitHub Actions 工作流。推送到 `main` 后，它会先运行测试，再把 `public/` 作为 Pages 站点发布。

首次部署前，在仓库的 **Settings → Pages → Build and deployment** 中把 Source 设为 **GitHub Actions**。此后无需构建服务器或长期运行的进程。

### Cloudflare Pages

在 Cloudflare Pages 中连接此仓库，并使用以下设置：

- Framework preset：`None`
- Build command：留空
- Build output directory：`public`

静态版本通常可在免费额度内长期运行。实际额度和平台政策可能变化，请以服务商当前规则为准。

## 项目结构

```text
public/index.html       静态页面入口
public/styles.css       响应式界面样式
public/theme.js         首屏主题初始化
public/app.js           查询交互与 CSV 导出
public/rdap.js          零依赖 RDAP 查询核心
tests/                  Node.js 离线单元测试
.github/workflows/      持续集成与 Pages 发布
```

当前产品入口是 `public/`。原有 Flask 原型和静态注册商快照已从当前版本移除，需要时仍可从 Git 历史中查看。

## 贡献

欢迎提交问题、测试用例和改进。开始前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)；安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。

## 许可证

本项目采用 [Apache License 2.0](LICENSE)。
