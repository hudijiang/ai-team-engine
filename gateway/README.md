# 单租户 LLM Gateway（最小骨架）

浏览器不再持有供应商 raw key。前端只带 `GATEWAY_TOKEN`；密钥留在本机 Gateway 进程环境变量里。

这是**单租户本机控制平面**。不规划多租户 SaaS，也不承诺生产 SLA。

运行记录可 `POST /api/runs` 后按 id 再读回（关页后**记录**仍在）。**不会**在关标签页后继续跑 Agent。

## 启动

```bash
export GATEWAY_TOKEN='replace-me'
export OPENAI_API_KEY='sk-...'
# 可选：ANTHROPIC_API_KEY / DEEPSEEK_API_KEY / DASHSCOPE_API_KEY / ZHIPU_API_KEY
export GATEWAY_PORT=8787
export GATEWAY_RPM=30
export GATEWAY_CORS_ORIGIN=http://localhost:5173
# 可选追加允许的公网主机（逗号分隔）。私网地址一律拒绝。
# export GATEWAY_ALLOW_HOSTS='api.example.com'

npm run gateway
```

健康检查：`GET http://127.0.0.1:8787/health`（JSON：`ok`、`role`、`persist`）

运行记录：

```bash
curl -s -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"objective":"demo","status":"running"}' \
  http://127.0.0.1:8787/api/runs

curl -s -H "Authorization: Bearer $GATEWAY_TOKEN" \
  http://127.0.0.1:8787/api/runs/<id>

curl -s -X PATCH -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"status":"waiting_for_config","checkpointType":"waiting_for_config"}' \
  http://127.0.0.1:8787/api/runs/<id>
```

## 前端

配置面板勾选 **使用本机单租户 Gateway**，填写：

- URL：`http://127.0.0.1:8787`
- Token：与 `GATEWAY_TOKEN` 相同

之后 `sendChat` 只 POST `/api/llm/chat`，body **不含** apiKey。

首次使用时，在供应商分组中点击“从 Gateway 获取模型”；若供应商没有模型列表接口，也可在该明确分组内手工添加模型 ID。随后在 CEO 卡片选择模型再发布目标。浏览器不会使用一个无法确认 Provider 的默认模型。

## 安全边界

| 已做 | 未做（仍单租户，不做 SaaS） |
|------|------|
| 上游主机白名单 | 关页后 Agent 继续执行 |
| 拒绝 127.0.0.1 / RFC1918 | 标准 MCP |
| 拒绝客户端上传 raw key | 公网裸绑定（请本机或反代） |
| 内存 RPM 限流 | 事务数据库 |
| 运行记录落盘（create/get/patch） | 生产 SLA |

运行记录更新带单调 `revision`，浏览器客户端遇到一次外部 revision 冲突会读取服务端版本后重试。磁盘 JSON 损坏时读取会失败关闭，不会用内存快照静默覆盖损坏文件；它仍不是事务数据库。

Gateway **代发**请求，因此必须防服务端 SSRF：未知主机、未知 Provider 与私网地址会拒绝。默认只监听 `127.0.0.1`，请经反向代理/TLS 再对外。

`GET /api/providers` 与 `GET /api/models?provider=` 使用服务端 Key 拉列表，浏览器不必保存供应商密钥。
