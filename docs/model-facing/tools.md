<!--
mod 用 $.tool.register 注册的三个工具：说明（description）和参数（inputSchema）。
模型看到的名字是 mcp__refrain__search、mcp__refrain__read、mcp__refrain__submit。
search 和 read 设为始终可见（isDeferred: false，7.4）；说明各自不超过 4096 字符。
依据：design.md 4.7（参数、"什么时候查"）、4.8（主模型不能改记忆）、6.5（submit）、7.4。
要点：
- "什么时候查"和"不能改记忆"都写在 search 的说明里，主模型每次请求都能看到（7.4）。
- 主模型和书记员用同一份 search / read 说明；书记员的系统提示里另有它自己的用法（scribe-system.md）。
- submit 的说明只写给书记员；主模型调用会被拒绝（6.5、tool-results.md）。
状态：初稿（2026-10-25），已按 H14 场景走查和 H15 冷读者的意见修改。
-->

---

## search

**description：**

```
在这位用户以往和 Claude 的对话记录里检索。能搜三类东西：
- 知识（K12 这样的编号）：整理出来的长期知识，也就是会话开头"记忆"块里的那些条目。每个历史版本都能搜到，并标明是当前、旧版本还是已归档；不是"当前"的，说明它已经不成立了。
- 摘要（M34 这样的编号）：以往每段讨论的经过，按话题整理，每份几百字。
- 原文：以往的原始对话记录（地址形如 S3/T120#E1）。

什么时候查：
- 用户提到以前的工作、讨论或决定，而当前上下文里没有时。
- 问用户之前，先查一下是不是已经记过、讨论过。
- 需要当时的原话、数值、路径、命令、报错时：先找到对应的摘要或记录，再用 read 读原文。要说"你当时决定了……"之前，先追到用户的原话。
- 只在答案会改变你下一步怎么做时才查。不要把结果里列出的地址逐个打开。

怎么查：
- 写下原文里可能出现的词，或者直接写一句话："代理端口""之前那台服务器的配置"。按字面匹配，不区分大小写，只匹配内容，项目名不参与匹配；怎么分隔都可以，不需要特别的格式。结果按相关程度排：用到的词越多、越少见，排得越前，只中了一部分的也会列出。同一件事可能有几种说法（中英文、改名前后的叫法、近义词），一起写上："登录 login 鉴权"，多写只会让结果更全。
- 结果多时，前面的列全文，后面的只列标题或开头，再多的写明还有几条。要找的东西可能就在后面的标题里。
- 不填 query，就按时间列出最新的摘要，用来回答"最近做了什么"。
- 没搜到不代表没发生过：换个说法再搜，或者扩大 scope。
- 每条结果都带时间。同一件事有几份摘要时，以时间靠后的为准：前面写着"未确认""待定"的，后面可能已经定了。
- 结果里排在前面的摘要会直接带正文，很多时候搜一次就够；原始记录按所在的讨论分组，每组只露几条片段。

记忆是过去的记录，和当前的文件内容或用户刚说的话冲突时，以后者为准。

这些记忆由后台整理，Claude 不能直接修改，也不要用 Edit、Write 去改 ~/.refrain/ 下的文件（会被拒绝）。
- 用户让你"记住"某件事时，不需要写任何文件（包括 Claude Code 自带的记忆文件），后台会从对话里把它整理进记忆，简单确认即可。用户明确要求写进某个文件（比如 CLAUDE.md）时，照他说的做。
- 用户要求修改、删除或恢复某条记忆时：先用 read 读出这条的当前内容，在同一条回复里念给用户核对，并告诉用户"已记下，之后后台整理时会按你的话更新"。用户只纠正了一部分时，复述你理解的改法。
- 能做到的有限，答应用户时要如实说：摘要和原始对话改不了（写错的摘要，后台会补一份更正）；归档的知识不再出现在记忆块里，但仍能被检索到；密码、密钥这类凭据不会被记住。用户说"这个别记"时，后台不会把那件事写进记忆，但原始对话里仍有，能被检索到。
```

**inputSchema：**

```json
{
  "type": "object",
  "properties": {
    "query": { "type": "string", "description": "原文里可能出现的词，或者一句话；几种说法可以一起写上。结果按相关程度排。不填就按时间列出最新的摘要。" },
    "in": { "type": "string", "enum": ["summaries", "raw", "knowledge"], "description": "只搜某一类。不填就三类都搜。" },
    "scope": { "type": "string", "enum": ["session", "project", "all"], "description": "session 只搜当前会话，project 搜当前项目（默认；不在任何项目里时，指那些同样不属于任何项目的会话），all 搜所有项目（结果会标出每条来自哪个项目）。只在明确需要别的项目的内容时用 all。" },
    "limit": { "type": "integer", "description": "最多返回多少条，默认 10。" }
  }
}
```

## read

**description：**

```
按编号或地址读取记忆里的一项。编号和地址都是全局唯一的：K、M 编号不分项目，跨项目也能直接读。地址形如 S3/T120#E1：S3 是第 3 个会话，T120 是这个会话的第 120 轮（从用户的一条消息到他的下一条消息之前；工具结果不算用户消息），E1 是这一轮里的第 1 条记录（一条消息、一次工具调用或一次工具结果各算一条）。
- K12：一条知识的当前内容、出处和修改历史，已归档的也能读。K12@2 读第 2 个版本。
- M34：一份摘要的全文和出处，末尾列出同一会话里时间上前后相邻的几份摘要的标题（只是时间相邻，不一定是同一个话题）。
- S3/T120#E1：一条原始记录。读到用户的话时，会在前面带上 Claude 上一条回复的末尾，因为"可以""就这样"这类回答要结合 Claude 当时的提议才看得懂。末尾注明这条记录被哪份摘要讲到。
- S3/T120：一整轮。S3/T118-T120：连续几轮，太长会提示从哪里接着读。

原始记录默认是裁剪过的：Claude 的长回复、工具的输入和输出只保留开头和结尾。需要被省略的中间部分（比如一段很长的报错）时，加 full: true 读未裁剪的原文。
```

**inputSchema：**

```json
{
  "type": "object",
  "properties": {
    "address": { "type": "string", "description": "要读的编号或地址，如 K12、K12@2、M34、S3/T120#E1、S3/T120、S3/T118-T120。" },
    "full": { "type": "boolean", "description": "读原始记录时，是否返回未裁剪的原文。默认 false。" }
  },
  "required": ["address"]
}
```

## submit

只给后台整理记忆的子 agent 用；主模型调用会被拒绝（返回内容见 tool-results.md）。

**description：**

```
仅供后台整理使用。和用户对话时一律不要调用，包括用户让你记住或整理记忆的时候。
提交这次整理的全部结果：摘要、对知识的操作、对现状的操作。格式和每个字段的写法见你的系统提示。
每次整理都必须调用一次。至少要有一份摘要；知识没有改动就交空列表，现状没有变化就交 null。
提交后会检查内容；不通过时会逐条列出问题，改好后整份重新提交，最多 3 次。
这次整理一次都没有用 search 或 read 时，第一次通过检查的提交会先停下，问你要不要查；不需要的话，只交 {"confirm": true}，就会保存那一份。
```

**inputSchema：**

```json
{
  "type": "object",
  "properties": {
    "summaries": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "title": { "type": "string" },
          "tags": { "type": "array", "items": { "type": "string" } },
          "body": { "type": "string" },
          "refs": { "type": "array", "items": { "type": "string" } }
        },
        "required": ["title", "body", "refs"]
      }
    },
    "knowledge": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "op": { "type": "string", "enum": ["create", "update", "archive"] },
          "id": { "type": "string", "description": "只用于 create：临时标签，如 new1，供同一次提交里引用这条新条目" },
          "code": { "type": "string" },
          "scope": { "type": "string", "enum": ["global", "project"] },
          "category": { "type": "string", "enum": ["rule", "understanding", "goal", "reference"] },
          "about_me": { "type": "boolean" },
          "epistemic": { "type": "string", "enum": ["quote", "inference", "observed"] },
          "pending": { "type": "boolean" },
          "body": { "type": "string" },
          "refs": { "type": "array", "items": { "type": "string" } },
          "reason": { "type": "string" }
        },
        "required": ["op", "refs", "reason"]
      }
    },
    "state": {
      "oneOf": [
        { "type": "null" },
        {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "op": { "type": "string", "enum": ["keep", "update", "close", "create"] },
              "no": { "type": "integer", "description": "上一版的序号；create 不写" },
              "type": { "type": "string", "enum": ["phase", "progress", "todo", "verify", "instruction"] },
              "body": { "type": "string" },
              "condition": { "type": ["string", "null"] },
              "refs": { "type": "array", "items": { "type": "string" } },
              "outcome": { "type": "string", "enum": ["done", "abandoned", "promoted"] },
              "reason": { "type": "string" },
              "to": { "type": "string" }
            },
            "required": ["op"]
          }
        }
      ]
    },
    "confirm": { "type": "boolean", "description": "只在提交停下来问你要不要查以前的记录、而你确认不需要时用：只写 {\"confirm\": true}，保存刚才那份。" }
  }
}
```

按 op 不同的必填字段（知识：create 要 scope、category 等，update 要 code、body，archive 要 code；现状：keep 只要 no，update 要 no、body，close 要 no、outcome，create 要 type、body），由校验代码检查，不写进 schema；三个顶层字段也不设成必填，因为确认时只交 `confirm`，缺了哪个由校验代码在回执里写明，免得 schema 太复杂；出错时回执里会写清楚缺了什么。
