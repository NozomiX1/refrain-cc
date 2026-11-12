# refrain

给 Claude Code（CC）用的长期记忆插件。它让 CC 跨会话、跨项目地记住两类东西：**你是谁、喜欢怎么做**，以及**每个项目进行到哪了**，用来取代 CC 自带的 auto memory。

> refrain 是副歌：一首歌里反复回来的那段旋律。记忆也一样，每个新会话、每次压缩都会再回来一遍。

- **后台整理，不打扰干活。** 每攒够约 2 万字的对话，一个后台的"书记员"子 agent（Haiku）读一遍，写下摘要、更新知识和现状。主模型只干活，不写记忆。
- **每条记忆都有出处。** 知识标明是你的原话、推断还是观察，都能追到当初的那句话（`read K12`）。
- **压缩不调模型。** 手动 `/compact` 时，上文换成本会话的摘要加最近一段原样保留的对话，几毫秒完成；缓存过期后还能自动做一次空闲压缩，省掉一次全价重读。
- **开销看得见。** 状态栏显示书记员花了多少、占主会话的比例。

界面和记忆内容目前都是中文。

## 它怎么运转

```
你和 CC 对话
  │ 每轮结束：新内容攒够 2 万字？
  ▼
书记员（后台子 agent，Haiku，推理强度 high）
  │ 读这批对话 + 已有的知识、摘要、现状 → 交一份整理结果 → 校验不过就退回重交
  ▼
~/.refrain/memory.db：知识（带版本和出处）、摘要、现状、原文索引
  ├─► 新会话 / /clear / 压缩之后：简报（知识 + 现状）注入给主会话
  ├─► /compact：本会话的摘要 + 最近的原文，替换上文，不调模型
  └─► 主模型需要以前的细节时：search / read 检索摘要、知识和原文
```

详细设计见 [docs/design.md](docs/design.md)，一页总览见 [docs/overview.md](docs/overview.md)。

## 要求

- Claude Code 2.1.310（开发和验证都在这个版本上；插件用的是 CC 的 mod 接口，CC 升级后行为可能变，见 design.md 7.13 的自检清单）。
- Node.js ≥ 24，在 `PATH` 里能找到 `node`（核心程序直接运行 TypeScript，并用 Node 自带的 SQLite）。找不到时插件会提示一次，然后停用，CC 照常工作。
- 在 macOS 上开发和测试；Linux 应该可以，没测过。

## 安装

在 CC 里：

```
/plugin install refrain --marketplace NozomiX1/refrain-cc
```

按提示添加 marketplace（`y`），选一个作用域。配套的 `refrain-timer`（负责空闲压缩）会作为依赖一起装上。

装好以后：

- **auto memory 会被关掉。** 每个用到 refrain 的项目，第一次开会话时 refrain 会在项目的 `.claude/settings.local.json` 里写上 `autoMemoryEnabled: false`（保留文件里原有的内容），并提示一次，从下一个会话起生效。
- **CC 的自动压缩会被拦下。** 需要压缩时手动 `/compact`。原因：CC 自动压缩发生在一轮中间时，会把旧的记忆块放回上下文，和新的并存。
- **把 transcript 的保留天数调大。** CC 默认 30 天删除旧的 transcript；refrain 自己存了裁剪后的文字，出处和检索不受影响，但"读取未裁剪的原文"会失效。在 `~/.claude/settings.json` 里设 `"cleanupPeriodDays": 365`。

## 使用

不需要做什么：正常和 CC 对话，书记员会在后台整理。

- **`/refrain`**：打开面板，看当前的记忆和书记员的状态（最近一次整理、落后多少、花费）。
- **`/refrain resume`**：书记员连续失败 3 次后，这个会话的自动整理会暂停；修好原因后用它恢复。
- **改记忆**：直接在对话里说，比如"K12 记错了，应该是……""这条不要了"。书记员下次整理时会按你的话更新。主模型不能直接改记忆，你说"记住……"时它也不会去写文件。
- **查以前的事**：主模型会在需要时自己调用 `search` 和 `read`；你也可以直接让它查。

### 设置

在 `/config` 里能调 4 项：

| 设置 | 默认 | 说明 |
|---|---|---|
| 空闲压缩 | 开 | 缓存过期以后，下一次请求之前把上文换成交接 |
| 空闲压缩的上文下限 | 60000 token | 上文小于这个数时不做空闲压缩 |
| 书记员的触发量 | 20000 字 | 越小记得越及时，花费也越多 |
| 书记员用的模型 | haiku | 可选 sonnet，额度约是 Haiku 的 7 倍 |

### 状态栏

CC 不让插件直接往状态栏里写，所以要你在自己的状态栏脚本里接一下。[tools/statusline-refrain.sh](tools/statusline-refrain.sh) 读 CC 传给状态栏的 JSON，输出类似 `refrain ≈$0.42 3% 空闲` 的一段（需要 `jq`）。

只用它做整个状态栏：

```json
{ "statusLine": { "type": "command", "command": "/path/to/refrain/tools/statusline-refrain.sh", "refreshInterval": 3 } }
```

已经有自己的状态栏脚本的，在脚本里把 CC 给的输入转给它，拼到行尾：

```sh
input=$(cat)
# ……你原来的内容，假设拼在 $out 里……
seg=$(printf '%s' "$input" | /path/to/refrain/tools/statusline-refrain.sh)
printf '%s\n' "$out${seg:+ | $seg}"
```

书记员是在后台跑完的，CC 不会因此重画状态栏，所以要设 `refreshInterval`（秒）。

## 花费

书记员和你的前台会话**共用同一份订阅额度**（或 API 账单）。参考：Haiku（推理强度 high）整理一次约 $0.02（只算输入、缓存写入和输出，订阅额度大致这么扣），整理五天的密集讨论约 $1.5。状态栏里的 `≈$` 是按 API 价折算的，含缓存读取，和订阅额度不是一回事，见 [design.md 8.3](docs/design.md)。

## 数据和隐私

- 所有记忆都在本机的 `~/.refrain/`（数据库、日志、每天的备份），不上传到任何地方。只有书记员整理时，那一批对话会和平常一样发给模型。
- **不做脱敏。** 检索原文时可能带出你在对话里发过的密码。书记员的提示词禁止把凭据写进知识、现状和摘要，但这只是提示词，不是保证。
- 卸载插件不会删除 `~/.refrain/`，要删就手动删。

## 开发

```sh
npm install          # 只装 TypeScript 和 Node 的类型定义
npm test             # 核心程序的测试（node:test）
npm run test:mod     # mod 的测试（claude plugin test）
npm run check        # 核心程序的类型检查
npm run check:mod    # mod 和 refrain-timer 的类型检查
```

测试要在临时目录（`/tmp` 等）以外的检出上跑：测试拿仓库本身当项目，而临时目录按设计不算任何项目。

开发时用 `claude --plugin-dir /path/to/refrain --plugin-dir /path/to/refrain/timer` 加载。代码结构：

- `hooks/register.tsx`：mod，接 CC 的事件、注册工具和书记员、面板。
- `core/`：Node 核心程序，读原文、书记员的准备和校验、存储、简报和交接、检索。零依赖。
- `timer/`：refrain-timer。
- `docs/`：设计（[design.md](docs/design.md)）、设计演变（[evolution.md](docs/evolution.md)）、决策记录（`adr/`）、给模型看的文字（`model-facing/`）。
- `experiments/`：实验的脚本和结论。

## License

[MIT](LICENSE)
