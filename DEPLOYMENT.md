# AI Team Engine — 部署与控制平面

> **状态（以仓库为准）**：已有**最小单租户 LLM Gateway**（`gateway/`，`npm run gateway`）：代调 chat、托管密钥、运行记录落盘。  
> 仍**没有** Docker、任务队列、关页后续跑 Agent。前端「后端模式」存储同步仍只是 `backendAdapter.js` 开关。

## 当前实际部署方式

本仓库是**浏览器单页应用**：

```bash
npm install
npm run dev      # 本地开发
npm run build    # 产出 dist/，可用任意静态托管
npm run preview
```

没有容器镜像、没有进程守护、没有服务端任务队列。关标签页即中断 **Agent 执行**；若 Gateway 已启动，运行**记录**可按 id 再读回。

### 数据存在哪

| 层 | 存什么 |
|----|--------|
| **IndexedDB** | 会话、消息、检查点、知识库全文；直连模式的完整供应商 API Key；Gateway 模式的访问 Token |
| **localStorage** | 去敏 bootstrap（启动用，不含完整密钥） |
| **内存** | 正在跑的 `CEOAgentRunner`、Abort 作用域 |
| **Gateway 磁盘** | `data/gateway-runs/runs.json` 运行记录（需 `npm run gateway`） |

「所有数据都在 localStorage」已过时。

直连模式由浏览器向用户填写的模型 URL 发送供应商 Key 与 Prompt；Gateway 模式由浏览器向本机 Gateway 发送 Token、模型 ID 与 Prompt，再由 Gateway 代发。前者不是服务端 SSRF；后者已按服务端 SSRF 边界使用固定 Provider 注册表、主机白名单与私网拒绝。

## 产品范围

- **当前**：单租户、本机 BYOK 或本机 Gateway。
- **后续仍只做单租户**：主路径可靠、运行记录、本机安全。
- **不规划**：对外 SaaS、多租户、跨租户账单。

## 最小单租户 Gateway（已落地骨架）

目标是先解除「浏览器持有 raw key」；关页即停仍在。详见 [gateway/README.md](./gateway/README.md)。

已具备：环境变量密钥、按明确 Provider 获取/填写模型 ID、`POST/GET/PATCH /api/runs`（revision）、未知 Provider 拒绝、请求体/上游超时与响应限制、CORS 可配置。默认绑定 127.0.0.1。

尚未具备：关页后继续跑 Agent、Docker。这些若做也只服务单租户，不会做成 SaaS。

大爆炸拆完 `ceoAgent.js` 再做 Gateway **不是**前置条件；门禁已抽到 `src/engine/gateController.js`，可继续增量拆阶段运行器。

### 推荐技术栈（草案）

| 层级 | 推荐 | 备选 |
|------|------|------|
| 语言 | Node.js 18+ | Python 3.11+ |
| 框架 | Express / Fastify | FastAPI |
| 数据库 | SQLite（单租户） | PostgreSQL（以后扩展） |
| 部署 | 反向代理 + 静态 `dist/` | Docker（实现后才写镜像） |

### API 草案（尚未实现）

以下仅为前端 `backendAdapter` / 协作层预留的形状，**对本仓库 `npm run build` 无对应服务**。

```
# 键值存储（可选；完整态仍应以检查点/会话 API 为准）
GET    /api/storage/:key
PUT    /api/storage/:key
DELETE /api/storage/:key

# 任务（持久执行）
GET    /api/tasks
POST   /api/tasks
PUT    /api/tasks/:id
DELETE /api/tasks/:id

# 模型代理（密钥托管后的主路径）
POST   /api/llm/chat

# Webhook / 定时：单租户稳定后再做
```

前端「配置 → 后端模式」若开启，会向 `backendUrl` 发带 Bearer 的存储请求，失败则降级本地 IndexedDB/bootstrap。没有对端时不要打开该开关。

## 安全（当前 Gateway 边界）

- 供应商密钥只存在 Gateway 进程环境变量；前端持静态 Gateway Token（尚无登录、短期会话或轮换服务）
- 模型与工具 URL **白名单**（此时才按服务端 SSRF 防护）
- 限流、审计不可关
- HTTPS；CORS 收紧到实际前端源
- 本阶段不做跨租户隔离设计也可以先上单用户

## 相关文档

- 定位与边界：[README.md](./README.md)
- 数据处理：[PRIVACY.md](./PRIVACY.md)
