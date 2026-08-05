# 游戏雷达 · AI 游戏推荐

> 不只是问“推荐什么游戏”，而是让一个有边界的推荐 Agent 理解你的游戏口味、查找真实游戏、验证候选并解释为什么推荐。

游戏雷达是一个基于 Next.js、LLM、GameBrain、Steam 和 Wikidata 的对话式游戏推荐项目。用户可以用自然语言描述想玩的游戏，也可以选择喜欢的游戏、平台和发售时间，系统会从真实数据源中检索候选，再由 Agent 动态选择搜索策略、筛选候选并生成个性化推荐。

## 为什么做这个项目

传统游戏推荐通常依赖固定标签或热门榜单，很难理解这样的需求：

- “我喜欢 Splatoon 3，但想找越新的第三人称射击游戏。”
- “我想要网易发行的动作游戏，但不要错误的同名 Steam 商店链接。”
- “我喜欢 Hades，想找玩法相近、但不是同一款的作品。”

本项目尝试把 LLM 的自然语言理解能力与真实游戏数据源结合起来：模型负责理解意图和规划搜索，数据源负责提供可验证的游戏事实，规则层负责执行平台、公司和发布时间等约束。

## 核心能力

- **Agent 驱动的检索**：Agent 会根据候选池选择 catalog、similar、franchise 或 newest 策略，不再只执行一条固定搜索语句。
- **真实数据验证**：候选来自 GameBrain、Steam 和 Wikidata，尽量避免编造或错误关联。
- **参考游戏画像**：通过 Suggest Games、Steam 和 Wikidata 分析喜欢游戏的类型、玩法、平台和发布时间。
- **动态约束**：支持平台、公司/发行商、发布时间、参考游戏和新鲜度偏好。
- **新作召回**：用户表达“越新越好”“最新”时，使用发布时间过滤、降序排序和系列词搜索。
- **相似游戏扩展**：Suggest Games 解析参考游戏后调用 Similar Games，并将结果真正加入候选池。
- **同名游戏防错**：Steam 商店链接只有在标题精确匹配并通过年份/公司信息验证后才会绑定。
- **可见执行状态**：前端通过 SSE 展示 Agent 当前阶段、检索策略、工具调用和候选统计，不展示模型原始思维链。
- **多层缓存**：Steam、GameBrain、喜好搜索、参考画像和 LLM 决策均有缓存或进行中请求合并。
- **可观测性**：记录 AI 请求、重试、失败、Token 用量、数据源网络请求和缓存命中情况。

## Agent 工作流程

~~~mermaid
flowchart TD
    A[用户自然语言需求] --> B[Intent Parser 与实体提取]
    B --> C[识别游戏、系列、公司、平台和发布时间约束]
    C --> D[Suggest Games 解析参考游戏]
    D --> E[建立参考游戏画像]
    E --> F[Agent 选择搜索策略]
    F --> G[catalog / similar / franchise / newest]
    G --> H[GameBrain + Steam + Wikidata]
    H --> I[候选池观察与缺口分析]
    I --> F
    I --> J[硬约束过滤和确定性预排序]
    J --> K[LLM 最终排序与质量复核]
    K --> L[评价、封面、价格和商店链接补全]
    L --> M[返回推荐结果]
~~~

推荐 Agent 是有边界的。默认 deep 模式最多运行 4 轮，Agent 不能无限调用外部 API。

### 搜索策略

| 策略 | 用途 |
|---|---|
| catalog | 根据自然语言需求进行语义搜索 |
| similar | 从用户喜欢的参考游戏扩展相似作品 |
| franchise | 搜索参考游戏的系列和续作 |
| newest | 使用发布时间过滤和降序排序寻找新作 |

每轮 Agent 都会看到结构化的 GameBrain 观察结果，例如候选数量、发售年份、类型、本轮新增候选和已执行策略，然后决定继续检索还是进入排序。

## 数据源

### GameBrain

GameBrain 是主要的游戏目录和语义检索来源，当前使用：

- Search Games：语义搜索、分页、平台过滤、发售时间排序
- Suggest Games：识别用户输入的具体游戏标题
- Similar Games：扩展参考游戏的相似作品

GameBrain 搜索遵守接口的分页上限，每页最多 10 个结果，并通过 .cache/gamebrain.json 做持久化缓存。

### Steam

Steam 用于：

- 验证游戏是否存在
- 验证商店标题和开发商/发行商
- 获取价格、折扣、平台、封面和评价
- 生成商店链接

Steam 搜索、详情和评价响应会缓存到 .cache/steam.json。同一个 URL 的并发请求会共享一个进行中的网络请求。

### Wikidata / Wikipedia

Wikidata 作为跨平台和主机游戏的备用数据源，用于补充开发商、发行商、平台、类型、玩法和发售日期。

Wikipedia 主要用于最终选中游戏的简介和图片补全，不作为唯一的公司归属判断依据。

## 推荐约束

系统将用户条件分为不同强度：

- **硬约束**：明确的平台、公司/发行商、发布时间范围和排除项。
- **强偏好**：射击、合作、单人、RPG、越新越好等。
- **软偏好**：第三人称、难度、游玩时长、价格等数据不完整的特征。

这样可以避免把数据源不完整的类型标签当成绝对事实。例如某款游戏虽然被数据源标为 Action，但仍可能符合用户要求的射击体验；它会进入候选池，再由 Agent 和最终排序模型综合判断。

## 缓存与性能

| 缓存 | 默认 TTL | 位置/范围 |
|---|---:|---|
| GameBrain Search / Suggest / Similar | 7 天 | .cache/gamebrain.json |
| Steam 搜索、详情、评价 | 6 小时 | .cache/steam.json |
| 喜好游戏搜索 | 24 小时 | .cache/game-search.json |
| 参考游戏画像 | 7 天 | .cache/reference-profiles.json |
| Agent 决策 | 15 分钟 | 当前 Node 进程内存 |
| 最终排序 | 5 分钟 | 当前 Node 进程内存 |

缓存特性：

- 相同查询会复用结果；
- 相同查询的并发请求会合并；
- 上游异常产生的空结果不会被长期持久化；
- 推荐结果本身不会被永久缓存，用户修改偏好后仍会重新排序；
- .cache/ 已加入 Git 忽略列表。

## 前端 Agent 状态

推荐请求使用 Server-Sent Events 推送执行进度。页面默认只显示：

~~~text
正在推荐中  ⟳
~~~

点击后可以展开：

- 需求解析
- 参考游戏画像
- Agent 搜索策略
- GameBrain / Steam / Wikidata 工具调用
- 候选数量和过滤结果
- LLM 排序与详情补全

系统不会向用户展示模型的原始隐藏思维链，只展示可验证的执行阶段和工具结果摘要。

## 技术栈

| 层 | 技术 |
|---|---|
| Web 框架 | Next.js 15 + React 19 |
| 语言 | TypeScript |
| 样式 | Tailwind CSS 4 |
| 图标 | Lucide React |
| LLM | OpenAI 兼容接口，默认支持 DeepSeek 等模型 |
| 游戏数据 | GameBrain API、Steam Store API、Wikidata |
| 测试 | Node.js Test Runner + TypeScript strip types |
| 包管理 | pnpm |

## 快速开始

### 环境要求

- Node.js 20+
- pnpm
- 一个 OpenAI 兼容的 LLM 接口
- GameBrain API Key（推荐配置）

### 安装

~~~bash
pnpm install
~~~

复制环境变量模板：

~~~bash
# macOS / Linux
cp .env.example .env.local

# Windows PowerShell
Copy-Item .env.example .env.local
~~~

编辑 .env.local：

~~~env
# OpenAI-compatible LLM endpoint
AI_BASE_URL=https://your-relay-host
AI_API_KEY=sk-xxx
AI_MODEL=deepseek-v4-flash
AI_FAST_MODEL=deepseek-v4-flash

# GameBrain API
GAMEBRAIN_API_KEY=
~~~

启动开发服务器：

~~~bash
pnpm dev
~~~

默认访问：

~~~text
http://localhost:3000
~~~

### 推荐质量配置

默认使用 deep 模式：

~~~env
RECOMMEND_QUALITY=deep
~~~

deep 模式会使用更大的实体提取、Agent 规划和最终排序预算，并进行一次最终质量复核。

如果更关注响应速度，可以使用：

~~~env
RECOMMEND_QUALITY=balanced
~~~

调整 Agent 轮数：

~~~env
RECOMMEND_MAX_AGENT_TURNS=4
~~~

允许范围为 2～5。

### 可选缓存配置

~~~env
GAMEBRAIN_CACHE_PATH=.cache/gamebrain.json
GAMEBRAIN_MIN_REQUEST_INTERVAL_MS=1050
STEAM_CACHE_PATH=.cache/steam.json
STEAM_CACHE_TTL_MS=21600000
GAME_SEARCH_CACHE_PATH=.cache/game-search.json
GAME_SEARCH_CACHE_TTL_MS=86400000
REFERENCE_PROFILE_CACHE_PATH=.cache/reference-profiles.json
REFERENCE_PROFILE_CACHE_TTL_MS=604800000
~~~

## API

### POST /api/recommend

推荐接口默认返回 JSON；当请求头包含以下内容时，会以 SSE 推送进度：

~~~http
Accept: text/event-stream
~~~

请求字段包括：

~~~json
{
  "messages": [{"role":"user","content":"我想玩双人合作游戏"}],
  "platforms": ["steam"],
  "count": 6,
  "releaseFilter": "all",
  "favoriteGames": ["It Takes Two"],
  "excludeKeys": ["gamebrain:123"]
}
~~~

### GET /api/search-games

喜好游戏自动补全接口，使用 Steam + Wikidata，并带有前端、内存和磁盘缓存。

~~~text
/api/search-games?q=Hades&limit=20
~~~

### 其他接口

- GET /api/health：健康检查
- GET /api/image-proxy：代理 GameBrain、Steam、Wikimedia 等外部图片
- GET /api/game-placeholder：生成游戏封面占位图

## 项目结构

~~~text
app/
  api/
    recommend/       推荐 API，支持 JSON / SSE
    search-games/    喜好游戏搜索和自动补全
    image-proxy/     外部图片代理
    game-placeholder/占位封面生成
    health/          健康检查
  page.tsx           页面状态、会话持久化和 SSE 消费

components/
  HomeView.tsx       首页输入和偏好选择
  ResultsView.tsx    结果页、排序、筛选和 Agent 日志
  AgentTracePanel.tsx
                     可折叠的 Agent 执行阶段面板
  GameCard.tsx       游戏推荐卡片和图片回退
  GameModal.tsx      游戏详情弹窗
  GameSearchInput.tsx
                     喜好游戏自动补全
  ChatDock.tsx       结果页持续对话

lib/
  recommend.ts       推荐 Agent、工具执行、候选池和最终排序
  recommend-intent.ts
                     意图、实体、发布时间和新鲜度解析
  game-knowledge.ts  参考游戏联网画像和画像缓存
  gamebrain.ts       GameBrain 客户端、分页、Suggest、Similar、缓存和限流
  steam.ts           Steam 搜索、详情、评价、缓存和同名校验
  wikidata.ts        Wikidata / Wikipedia 数据客户端和缓存
  ai.ts              OpenAI 兼容接口、重试和 Token 指标
  llm-cache.ts       Agent 决策和最终排序短期缓存
  recommend-preferences.ts
                     平台、发布时间和对话处理
  game-utils.ts      结果排序工具
  types.ts           共享类型定义

tests/
  agent-tool-flow.integration.test.mjs
                     Agent 工具链集成测试
  ai.test.mjs        LLM 重试和 Token 指标
  gamebrain.test.mjs GameBrain 分页、Suggest、Similar、缓存
  llm-cache.test.mjs LLM 缓存和并发合并
  recommend-intent.test.mjs
                     意图、发布时间和标题归一化
  steam.test.mjs     Steam 持久化缓存和同请求合并
  wikidata.test.mjs  Wikidata 数据解析
  game-utils.test.mjs
                     结果排序
~~~

## 验证

~~~bash
pnpm typecheck
pnpm test
pnpm build
~~~

当前测试覆盖意图解析、GameBrain 工具链、Steam 缓存、LLM 缓存、发布时间边界、图片/数据客户端和排序逻辑。

## 生产部署

构建并启动：

~~~bash
pnpm build
pnpm start
~~~

部署时需要：

1. 配置 .env.local 中的服务端环境变量；
2. 确保部署平台支持 Node.js 运行时；
3. 确保推荐 API 能运行足够长时间，推荐请求可能包含多轮 Agent 和外部数据源请求；
4. 如果使用多实例部署，建议把 LLM 缓存和 .cache/ 迁移到 Redis 或共享存储；
5. 不要提交 .env.local 和 API Key。

## 数据与配额说明

- 使用 GameBrain 时请遵守其官方 API 条款和项目配额；
- GameBrain 的分页、缓存和请求间隔用于减少重复请求和配额消耗；
- Steam 接口为公开商店接口，但仍应控制并发和缓存时间；
- Wikidata / Wikipedia 数据可能缺少平台、公司或发布时间字段，系统会将这些信息作为证据而不是绝对事实；
- 任何外部数据源都可能有延迟或错误，推荐链路会尽量通过多个来源交叉验证。

## 当前设计原则

~~~text
先解析意图，再选择工具；
先获取证据，再做硬约束过滤；
先建立候选池，再进行 AI 排序；
只向用户展示可验证的推荐过程，不暴露原始隐藏思维链。
~~~
