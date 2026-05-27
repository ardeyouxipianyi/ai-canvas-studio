<h1 align="center">ChatGPT2API</h1>


<p align="center">ChatGPT2API 主要是对 ChatGPT 官网相关能力进行逆向整理与封装，提供面向 ChatGPT 图片生成、图片编辑、多图组图编辑场景的 OpenAI 兼容图片 API / 代理，并集成在线画图、号池管理、多种账号导入方式与 Docker 自托管部署能力。</p>

> [!NOTE]
> 这是基于原项目 `basketikun/chatgpt2api` 的改版分支，当前改版仓库为 [ardeyouxipianyi/chatgpt2api](https://github.com/ardeyouxipianyi/chatgpt2api)。改版重点放在网页画图体验、画布式图片创作、多人分享使用、用户数据隔离，以及 `3000` 统一网页/API 入口。

> [!WARNING]
> 免责声明：
>
> 本项目涉及对 ChatGPT 官网文本生成、图片生成与图片编辑等相关接口的逆向研究，仅供个人学习、技术研究与非商业性技术交流使用。
>
> - 严禁将本项目用于任何商业用途、盈利性使用、批量操作、自动化滥用或规模化调用。
> - 严禁将本项目用于破坏市场秩序、恶意竞争、套利倒卖、二次售卖相关服务，以及任何违反 OpenAI 服务条款或当地法律法规的行为。
> - 严禁将本项目用于生成、传播或协助生成违法、暴力、色情、未成年人相关内容，或用于诈骗、欺诈、骚扰等非法或不当用途。
> - 使用者应自行承担全部风险，包括但不限于账号被限制、临时封禁或永久封禁以及因违规使用等所导致的法律责任。
> - 使用本项目即视为你已充分理解并同意本免责声明全部内容；如因滥用、违规或违法使用造成任何后果，均由使用者自行承担。

> [!IMPORTANT]
> 本项目基于对 ChatGPT 官网相关能力的逆向研究实现，存在账号受限、临时封禁或永久封禁的风险。请勿使用你自己的重要账号、常用账号或高价值账号进行测试。

> [!CAUTION]
> 旧版本存在已知漏洞，请尽快升级到最新版本。公网部署时请尽量不要放置敏感信息，并自行做好访问控制与隔离。

## 快速开始

本改版推荐使用 Docker Compose 从源码构建运行。

### Docker 运行

当前改版仓库默认会从本地源码构建镜像，确保运行的是本改版而不是原项目镜像。

```bash
git clone https://github.com/ardeyouxipianyi/chatgpt2api.git
cd chatgpt2api
docker compose up -d
```

运行时配置会保存到 `data/config.json`。首次部署如果仍是默认密码，打开网页会先进入管理员密码设置页；设置完成后再进入系统。管理员密码会以哈希形式保存，不再明文写入运行配置。也可以在 `docker-compose.yml` 中通过 `CHATGPT2API_AUTH_KEY` 固定管理员密码。

- Web 面板：`http://localhost:3000`
- API 地址：`http://localhost:3000/v1`
- 数据目录：`./data`
- 运行时配置：`./data/config.json`

管理员可以在设置页创建普通用户密钥。普通用户密钥会按用户隔离画图历史、画布项目和图片任务，并记录调用次数、成功/失败次数、图片调用数、产出图片数与平均耗时。调用日志会自动脱敏常见 token、密钥、cookie、Authorization 等敏感内容。

### Windows 绿色版

不想安装 Docker、Python、Node 的用户，可以使用 Windows 绿色包。

绿色包的目标体验是：

```text
解压 -> 双击 start.bat -> 打开 http://localhost:3000
```

Cherry Studio / OpenAI 兼容接口填写：

```text
http://localhost:3000/v1
```

绿色包制作说明见 [WINDOWS_PORTABLE.md](WINDOWS_PORTABLE.md)。

### 本地开发

启动后端：

```bash
git clone git@github.com:ardeyouxipianyi/chatgpt2api.git
cd chatgpt2api
uv sync
uv run main.py
```

启动前端：

```bash
cd chatgpt2api/web
bun install
bun run dev
```

### 存储后端配置

支持通过环境变量 `STORAGE_BACKEND` 切换存储方式：

- `json` - 本地 JSON 文件（默认）
- `sqlite` - 本地 SQLite 数据库
- `postgres` - 外部 PostgreSQL（需配置 `DATABASE_URL`）
- `git` - Git 私有仓库（需配置 `GIT_REPO_URL` 和 `GIT_TOKEN`）

示例：使用 PostgreSQL

```yaml
environment:
  - STORAGE_BACKEND=postgres
  - DATABASE_URL=postgresql://user:password@host:5432/dbname
```

## 功能

### 改版增强

- 新增画布式图片创作：提示词、生成结果、编辑要求和参考图会形成节点链路，支持整理、定位、复制节点、删除画布和保存恢复。
- 画布支持从空白输入生成新节点，也支持选中已有编辑节点后复制当前编辑要求并重新生成分支。
- 画布内置反推提示词，可上传图片或使用当前图片节点，反推要求支持后端全局保存。
- 画图页和画布页支持图片任务取消、空结果重试、失败重试、图片预览放大、张数和比例控制。
- 普通用户密钥可作为独立用户使用，画布项目按用户隔离保存到后端。
- 开发环境提供 `3000` 统一入口：网页访问 `http://localhost:3000`，OpenAI 兼容 API 使用 `http://localhost:3000/v1`。
- 设置页增加大类配置折叠、R2 备份管理、用户密钥管理和反推提示词全局设置。

### API 兼容能力

- 兼容 `POST /v1/images/generations` 图片生成接口
- 兼容 `POST /v1/images/edits` 图片编辑接口
- 兼容面向图片场景的 `POST /v1/chat/completions`
- 兼容面向图片场景的 `POST /v1/responses`
- `GET /v1/models` 返回 `gpt-image-2`、`codex-gpt-image-2`、`auto`、`gpt-5`、`gpt-5-1`、`gpt-5-2`、`gpt-5-3`、`gpt-5-3-mini`、
  `gpt-5-mini`
- 支持通过 `n` 返回多张生成结果
- 支持 Codex 中的画图接口逆向，仅 `Plus` / `Team` / `Pro` 订阅可用，模型别名为 `codex-gpt-image-2`，如有需要可自行在其他场景映射回
  `gpt-image-2`，用于和官网画图区分；也就意味着同一账号会同时有官网和 Codex 两份生图额度

### 在线画图功能

- 内置在线画图工作台，支持生成、图片编辑与多图组图编辑
- 支持 `gpt-image-2`、`codex-gpt-image-2`、`auto`、`gpt-5`、`gpt-5-1`、`gpt-5-2`、`gpt-5-3`、`gpt-5-3-mini`、`gpt-5-mini` 模型选择
- 编辑模式支持参考图上传
- 前端支持多图生成交互
- 服务端保存图片会话历史，支持跨设备回看、删除和清空，并按登录身份隔离
- 支持服务端缓存图片URL

### 号池管理功能

- 自动刷新账号邮箱、类型、额度和恢复时间
- 轮询可用账号执行图片生成与图片编辑
- 遇到 Token 失效类错误时自动剔除无效 Token
- 定时检查限流账号并自动刷新
- 支持网页端配置全局 HTTP / HTTPS / SOCKS5 / SOCKS5H 代理
- 支持搜索、筛选、批量刷新、导出、手动编辑和清理账号
- 支持四种导入方式：本地 CPA JSON 文件导入、远程 CPA 服务器导入、`sub2api` 服务器导入、`access_token` 导入
- 支持在设置页配置 `sub2api` 服务器，筛选并批量导入其中的 OpenAI OAuth 账号

### 实验性 / 规划中

- `/v1/complete` 文本补全与流式输出已实现，但仍在测试，目前会出现对话重复的问题，请谨慎测试使用
- 详细状态说明见：[功能清单](./docs/feature-status.en.md)

## Screenshots

文生图界面：

![image](assets/image.png)

编辑图：

![image](assets/image_edit.png)

Cherry Studio 中使用，支持作为绘图接口接入：

![image](assets/chery_studio.png)

号池管理：

![image](assets/account_pool.png)

New Api 接入：

![image](assets/new_api.png)

## API

所有 AI 接口都需要请求头：

```http
Authorization: Bearer <auth-key>
```

<details>
<summary><code>GET /v1/models</code></summary>
<br>

返回当前暴露的图片模型列表。

```bash
curl http://localhost:8000/v1/models \
  -H "Authorization: Bearer <auth-key>"
```

<details>
<summary>说明</summary>
<br>

| 字段   | 说明                                                                                                         |
|:-----|:-----------------------------------------------------------------------------------------------------------|
| 返回模型 | `gpt-image-2`、`codex-gpt-image-2`、`auto`、`gpt-5`、`gpt-5-1`、`gpt-5-2`、`gpt-5-3`、`gpt-5-3-mini`、`gpt-5-mini` |
| 接入场景 | 可接入 Cherry Studio、New API 等上游或客户端                                                                          |

<br>
</details>
</details>

<details>
<summary><code>POST /v1/images/generations</code></summary>
<br>

OpenAI 兼容图片生成接口，用于文生图。

```bash
curl http://localhost:8000/v1/images/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <auth-key>" \
  -d '{
    "model": "gpt-image-2",
    "prompt": "一只漂浮在太空里的猫",
    "n": 1,
    "response_format": "b64_json"
  }'
```

<details>
<summary>字段说明</summary>
<br>

| 字段                | 说明                                                 |
|:------------------|:---------------------------------------------------|
| `model`           | 图片模型，当前可用值以 `/v1/models` 返回结果为准，推荐使用 `gpt-image-2` |
| `prompt`          | 图片生成提示词                                            |
| `n`               | 生成数量，当前后端限制为 `1-4`                                 |
| `response_format` | 当前请求模型中包含该字段，默认值为 `b64_json`                       |

<br>
</details>
</details>

<details>
<summary><code>POST /v1/images/edits</code></summary>
<br>

OpenAI 兼容图片编辑接口，用于上传图片并生成编辑结果。

```bash
curl http://localhost:8000/v1/images/edits \
  -H "Authorization: Bearer <auth-key>" \
  -F "model=gpt-image-2" \
  -F "prompt=把这张图改成赛博朋克夜景风格" \
  -F "n=1" \
  -F "image=@./input.png"
```

<details>
<summary>字段说明</summary>
<br>

| 字段       | 说明                                  |
|:---------|:------------------------------------|
| `model`  | 图片模型， `gpt-image-2`                 |
| `prompt` | 图片编辑提示词                             |
| `n`      | 生成数量，当前后端限制为 `1-4`                  |
| `image`  | 需要编辑的图片文件，使用 multipart/form-data 上传 |

<br>
</details>
</details>

<details>
<summary><code>POST /v1/chat/completions</code></summary>
<br>

面向图片场景的 Chat Completions 兼容接口，不是完整通用聊天代理。

```bash
curl http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <auth-key>" \
  -d '{
    "model": "gpt-image-2",
    "messages": [
      {
        "role": "user",
        "content": "生成一张雨夜东京街头的赛博朋克猫"
      }
    ],
    "n": 1
  }'
```

<details>
<summary>字段说明</summary>
<br>

| 字段         | 说明                |
|:-----------|:------------------|
| `model`    | 图片模型，默认按图片生成场景处理  |
| `messages` | 消息数组，需要是图片相关请求内容  |
| `n`        | 生成数量，按当前实现解析为图片数量 |
| `stream`   | 已实现，但仍在测试         |

<br>
</details>
</details>

<details>
<summary><code>POST /v1/responses</code></summary>
<br>

面向图片生成工具调用的 Responses API 兼容接口，不是完整通用 Responses API 代理。

```bash
curl http://localhost:8000/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <auth-key>" \
  -d '{
    "model": "gpt-5",
    "input": "生成一张未来感城市天际线图片",
    "tools": [
      {
        "type": "image_generation"
      }
    ]
  }'
```

<details>
<summary>字段说明</summary>
<br>

| 字段       | 说明                            |
|:---------|:------------------------------|
| `model`  | 响应中会回显该模型字段，但图片生成当前仍走图片生成兼容逻辑 |
| `input`  | 输入内容，需要能解析出图片生成提示词            |
| `tools`  | 必须包含 `image_generation` 工具请求  |
| `stream` | 已实现，但仍在测试                     |

<br>
</details>
</details>

## 社区支持

学 AI , 上 L 站：[LinuxDO](https://linux.do)

## Contributors

感谢所有为本项目做出贡献的开发者：

<a href="https://github.com/ardeyouxipianyi/chatgpt2api/graphs/contributors">
  <img alt="Contributors" src="https://contrib.rocks/image?repo=ardeyouxipianyi/chatgpt2api" />
</a>

## Star History

[![Star History Chart](https://api.star-history.com/chart?repos=ardeyouxipianyi/chatgpt2api&type=date&legend=top-left)](https://www.star-history.com/?repos=ardeyouxipianyi%2Fchatgpt2api&type=date&legend=top-left)
