# 玩什么 · AI 游戏推荐

> 告诉 AI 你现在的游戏口味，从真实游戏库里为你挑出下一款心头好。

一个基于 LLM + RAWG + Steam 的游戏推荐网站。用户用自然语言描述需求，系统从真实游戏数据库中检索候选，再由 AI 排序并撰写个性化推荐理由。

## 功能

- **对话式推荐**：自然语言描述需求，边聊边改，持续迭代
- **真实游戏数据**：从 RAWG（48 万+ 游戏）和 Steam 实时检索，不编造
- **多平台支持**：Steam / PSN / NS 平台偏好切换，自动筛选对应平台游戏
- **灵活数量**：每批可选 6 / 10 / 15 / 20 款，按匹配度、评分、价格等多维度排序
- **喜好搜索**：输入游戏名实时搜索并添加为偏好，支持 Steam + RAWG 双源
- **详情弹窗**：站内查看游戏完整信息，附商店跳转链接
- **图片代理**：DNS-over-HTTPS 代理 RAWG 封面图，国内网络正常加载
- **会话持久化**：浏览器 localStorage，刷新不丢失
- **响应式**：桌面端优先，移动端适配

## 技术栈

| 层 | 技术 |
|---|---|
| 框架 | Next.js 15 + React 19 |
| 语言 | TypeScript |
| 样式 | Tailwind CSS 4 |
| 图标 | Lucide React |
| AI | OpenAI 兼容接口（DeepSeek 等） |
| 游戏数据 | RAWG API + Steam Store API（公开） |
| 包管理 | pnpm |

## 推荐流水线

```
用户输入 → LLM生成搜索计划 → RAWG/Steam并行搜索候选
    → 平台过滤 → LLM评分排序 → 数据补全 → 输出推荐列表
```

详细四步：
1. **搜索计划**（快模型）：分析对话，生成 15-20 个候选游戏标题 + 3-5 个类型关键词
2. **候选搜集**（6 路并发）：RAUG（上限 40）+ Steam（上限 50），按平台偏好过滤
3. **AI 排序**（推理模型）：针对每款候选打分并写一句推荐理由
4. **数据补全**（并行）：补充详情、评价、价格、商店链接

## 本地运行

```bash
# 安装依赖
pnpm install

# 复制环境变量模板
cp .env.example .env.local

# 编辑 .env.local，填入你的 API Key
# AI_BASE_URL=   # OpenAI 兼容中转地址
# AI_API_KEY=    # API Key
# AI_MODEL=      # 推理模型（如 deepseek-v4-pro）
# AI_FAST_MODEL= # 快模型（如 deepseek-v4-flash）
# RAWG_API_KEY=  # https://rawg.io/apidocs 免费注册

# 启动开发服务器
pnpm dev
```

生产构建：

```bash
pnpm build
pnpm start
```

## 验证

```bash
pnpm test          # 单元测试（游戏排序 + RAWG API）
pnpm typecheck     # TypeScript 类型检查
pnpm build         # 生产构建
```

## 项目结构

```
app/
  api/
    recommend/     # POST - AI 推荐（长时运行，max 120s）
    search-games/  # GET  - 游戏搜索（Steam + RAWG 并行，2min 缓存）
    image-proxy/   # GET  - 图片代理（支持 DNS-over-HTTPS）
  page.tsx         # 主页面（状态管理 + localStorage 持久化）
  layout.tsx       # 根布局
  globals.css      # 全局样式 + 品牌色变量

components/
  HomeView.tsx         # 首页：输入框 + 搜索 + 平台选择 + 数量选择
  ResultsView.tsx      # 结果页：排序 + 卡片网格 + 骨架屏
  GameCard.tsx         # 游戏卡片：封面、推荐理由、标签、评分、价格
  GameModal.tsx        # 详情弹窗：完整信息 + 商店链接
  GameSearchInput.tsx  # 游戏搜索：自动补全 + 芯片选择
  ChatDock.tsx         # 对话栏：持续对话 + 历史记录
  PixelLogo.tsx        # 像素风 Logo

lib/
  recommend.ts   # 推荐核心：搜索计划 → 候选搜集 → AI 排序 → 补全
  rawg.ts        # RAWG API 客户端（含 DNS-over-HTTPS 回退）
  steam.ts       # Steam Store API 客户端（商店搜索、详情、评价）
  ai.ts          # LLM 调用封装（OpenAI 兼容）
  doh-fetch.ts   # DNS-over-HTTPS 通用工具
  game-utils.ts  # 游戏排序（匹配度/评分/价格/时长/发布时间）
  types.ts       # TypeScript 类型定义

tests/
  game-utils.test.mjs  # 排序逻辑测试
  rawg.test.mjs        # RAWG API 契约测试
```

## 部署

项目为标准 Next.js 应用，可部署到 Vercel、Railway 或自托管。

⚠️ **注意**：AI 推荐调用耗时较长（50-120 秒），需确保部署平台支持长时运行的 API 函数。Vercel 免费版超时仅 10 秒，需升级 Pro（$20/月）或使用 Railway（$5/月，支持 300s 超时）。

环境变量需在部署平台配置，`.env.local` 不会被提交到 Git。
