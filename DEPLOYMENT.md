# AI Team Engine - 后端部署指南

## 概述

AI Team Engine 默认为纯前端应用，所有数据存储在浏览器 `localStorage`。当需要以下能力时，可部署后端服务：

- 🔐 API Key 服务端安全托管（避免暴露在浏览器中）
- 💾 任务数据持久化（跨设备访问）
- 🔔 Webhook 通知集成
- ⏰ 定时任务调度
- 👥 多人实时协作

## 推荐技术栈

| 层级 | 推荐方案 | 备选方案 |
|------|---------|---------|
| **语言** | Node.js 18+ | Python 3.11+ |
| **框架** | Express.js | FastAPI |
| **数据库** | SQLite（轻量） | PostgreSQL（生产） |
| **实时通信** | WebSocket (ws) | Socket.IO |
| **部署** | Docker + Nginx | PM2 + Caddy |

## API 接口规范

### 键值存储

```
GET    /api/storage/:key          → 读取存储
PUT    /api/storage/:key          → 写入存储（Body: JSON）
DELETE /api/storage/:key          → 删除存储
```

### 任务管理

```
GET    /api/tasks                 → 获取任务列表
POST   /api/tasks                 → 创建新任务
PUT    /api/tasks/:id             → 更新任务状态
DELETE /api/tasks/:id             → 删除任务
```

### Webhook

```
POST   /api/webhooks              → 注册 Webhook
GET    /api/webhooks              → 获取 Webhook 列表
DELETE /api/webhooks/:id          → 删除 Webhook
```

### 定时任务

```
POST   /api/schedules             → 创建定时任务（cron 表达式）
GET    /api/schedules             → 获取定时任务列表
DELETE /api/schedules/:id         → 删除定时任务
```

### WebSocket 消息类型

```
agent:update          → 同步 Agent 状态变化
message:new           → 同步新消息
workspace:objective   → 同步目标变更
cursor:move           → 同步用户光标位置
```

## 前端切换后端模式

在前端应用「配置」面板中：

1. 填写 `后端地址`（如 `https://api.example.com`）
2. 填写 `API Key`
3. 开启 `使用后端模式`

开启后，所有存储操作将同步到后端，同时保留 localStorage 缓存作为离线降级。

## Docker 部署示例

```bash
# 构建前端
npm run build

# 构建 Docker 镜像
docker build -t ai-team-engine .

# 运行
docker run -d -p 3000:3000 \
  -e DATABASE_URL=sqlite:./data/app.db \
  -v ./data:/app/data \
  ai-team-engine
```

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 服务端口 | `3000` |
| `DATABASE_URL` | 数据库连接串 | `sqlite:./data/app.db` |
| `JWT_SECRET` | JWT 签名密钥 | - |
| `CORS_ORIGIN` | 允许的前端域名 | `*` |

## 安全建议

- 生产环境务必设置唯一的 `JWT_SECRET`
- 限制 `CORS_ORIGIN` 为实际前端域名
- 使用 HTTPS 传输
- API Key 加密存储到数据库，前端不再明文存储
