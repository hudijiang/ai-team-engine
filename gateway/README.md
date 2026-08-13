# 单租户 LLM Gateway（最小骨架）

浏览器不再持有供应商 raw key。前端只带 `GATEWAY_TOKEN`；密钥留在本机 Gateway 进程环境变量里。

这是**单租户控制平面的第一步**，不是多租户 SaaS，也没有生产 SLA。

运行记录可 `POST /api/runs` 后按 id 再读回（关页后**记录**仍在）。**不会**在关标签页后继续跑 Agent。

## 启动

```bash
export GATEWAY_TOKEN='replace-me'
export OPENAI_API_KEY='sk-...'
# 可选：ANTHROPIC_API_KEY / DEEPSEEK_API_KEY / DASHSCOPE_API_KEY / ZHIPU_API_KEY
export GATEWAY_PORT=8787
export GATEWAY_RPM=30
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

## 安全边界

| 已做 | 未做 |
|------|------|
| 上游主机白名单 | 关页后 Agent 继续执行 |
| 拒绝 127.0.0.1 / RFC1918 | 多租户 / 账单 |
| 拒绝客户端上传 raw key | TLS 终结（请放在本机或反向代理后） |
| 内存 RPM 限流 | 生产 SLA |
| 运行记录落盘（create/get/patch） | 关页后 Agent 继续执行 / 标准 MCP |

Gateway **代发**请求，因此必须防服务端 SSRF：未知主机与私网地址会 403。
