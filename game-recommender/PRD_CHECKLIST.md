# PRD MVP 验收清单

依据 `../AI游戏推荐网站_PRD模板_极简版.md`。

| 要求 | 实现位置 | 当前证据 |
| --- | --- | --- |
| 真实 AI + 真实游戏库推荐 | `lib/recommend.ts`、`lib/ai.ts` | DeepSeek/OpenAI 兼容接口与 Steam 实际请求通过；RAWG 实钥待配置 |
| RAWG 主库与 Steam 价格融合 | `lib/rawg.ts`、`lib/recommend.ts` | RAWG 契约测试通过；真实 RAWG 端到端待 Key |
| 每批 6 款 | `lib/recommend.ts` | 真实 Steam 降级接口返回 6 款 |
| 封面、名称、平台、推荐理由、简介、类型、标签、游玩方式、价格、发布时间、开发商、时长、评分 | `components/GameCard.tsx`、`components/GameModal.tsx` | 桌面端 DOM 与详情弹窗检查通过 |
| 匹配度、评分、发布时间、通关时长、价格排序 | `lib/game-utils.ts`、`components/ResultsView.tsx` | 5 类排序单元测试通过 |
| 换一批排除已推荐游戏 | `app/page.tsx`、`lib/recommend.ts` | 真实接口两批结果零重复 |
| 持续补充需求 | `components/ChatDock.tsx`、`app/page.tsx` | 完整对话发送并重建列表 |
| 新建对话/重置 | `app/page.tsx` | 清除状态并取消进行中的请求 |
| 刷新页面不丢失 | `app/page.tsx` | 浏览器刷新恢复 6 款结果及对话 |
| 站内详情弹窗和商店链接 | `components/GameModal.tsx` | 桌面端交互检查通过 |
| 移动端响应式 | 页面组件 Tailwind 断点 | 390×844 首页与结果布局检查通过 |
| Key 仅服务端持有 | 服务端 API 与 `lib/*.ts` | 浏览器端不读取 AI/RAWG 环境变量 |

## 自动检查

```bash
pnpm test
pnpm typecheck
pnpm build
```

## 最终未完成的外部验收

在 `.env.local` 配置 `RAWG_API_KEY` 后，运行真实 RAWG 请求，确认多平台、平均游玩时长、RAWG 评分及商店链接均来自线上响应。
