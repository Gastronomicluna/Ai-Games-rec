# 玩什么 · AI 游戏推荐

根据用户的中文自然语言需求，从真实游戏数据库中检索候选，再由 AI 在已验证候选中生成推荐理由。

## 数据源

- RAWG：主游戏库，提供多平台、类型、标签、评分、封面和平均游玩时长。
- Steam：补充中文简介、当前国区价格、折扣和玩家评测。
- 未配置 RAWG Key 或 RAWG 暂时不可用时，会自动降级为 Steam 游戏库，核心推荐功能仍可使用。

## 本地运行

1. 复制 `.env.example` 为 `.env.local`。
2. 配置 `AI_BASE_URL`、`AI_API_KEY`、`AI_MODEL` 和 `RAWG_API_KEY`。
3. 安装并启动：

```bash
pnpm install
pnpm dev
```

生产构建：

```bash
pnpm build
pnpm start
```

## MVP 功能

- 每批最多 6 款真实游戏推荐。
- 按匹配度、评分、发布时间、通关时长和价格排序。
- 查看站内详情弹窗及外部商店链接。
- 持续补充需求、换一批和新建对话。
- 会话保存在浏览器本地。
- 桌面端优先并适配移动端。

## 验证

```bash
pnpm test
pnpm typecheck
pnpm build
```
