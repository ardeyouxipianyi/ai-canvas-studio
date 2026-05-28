# chatgpt2api 画布创作版

这是基于原开源项目 [basketikun/chatgpt2api](https://github.com/basketikun/chatgpt2api) 二次改造的版本，当前维护仓库为 [ardeyouxipianyi/chatgpt2api](https://github.com/ardeyouxipianyi/chatgpt2api)。

本改版保留 OpenAI 兼容图片接口能力，同时重点强化网页端的图片创作体验：把原来的单次画图页面升级为画布式工作流，支持从提示词生成图片、把结果落到画布、继续基于图片编辑、形成分支链路，并把画布、图片、日志和用户数据保存到服务端。

> 免责声明：本项目仅用于个人学习、技术研究与非商业交流。请自行确认使用方式符合相关服务条款和所在地法律法规。不要将重要账号、常用账号或高价值账号用于测试。

## v2.1.0 重点变化

- 首页定位调整为“画布创作版”，项目说明改为当前改版仓库与原项目关系。
- 网页主导航简化为“画布创作”和“设置”，原“画图”入口已合并到画布工作流。
- 号池管理、图片管理、日志管理整合进设置工作台，设置页面改为更接近画布页的视觉风格。
- 删除注册机功能与 `/api/register` 相关前后端入口，备份配置中注册机数据默认关闭并保留兼容字段。
- 画布节点布局继续优化：生成结果默认出现在提示词/编辑节点下方，多结果并排展示，连接线更偏向统一出线与分支关系表达。
- 画布工具继续增强：节点收藏、节点对比、当前画布导出、图片预览放大、上游路径高亮、选中节点操作收敛。
- 号池刷新改为带进度的后台任务展示，避免大批量账号刷新时页面不可见进度。
- 调用日志、图片任务、画布项目、图片会话继续按登录身份隔离并保存到服务端，便于多设备访问同一服务端数据。
- Windows 绿色版、Docker 部署和 `3000/v1` OpenAI 兼容接口保持支持。

## 适合什么场景

- 需要一个网页端图片创作工作台，而不是只通过 API 调用画图。
- 需要把提示词、参考图、生成结果和多次修改关系保存在一个画布里。
- 需要把 Cherry Studio、New API 等客户端接入 OpenAI 兼容图片接口。
- 需要把服务部署到自己的服务器，并让不同用户使用独立数据。
- 需要管理较多 ChatGPT 账号 Token，并做额度刷新、状态检查和失败切换。

## 快速启动

### Docker Compose

```bash
git clone https://github.com/ardeyouxipianyi/chatgpt2api.git
cd chatgpt2api
docker compose up -d
```

启动后访问：

```text
网页地址：http://localhost:3000
OpenAI 兼容接口：http://localhost:3000/v1
运行数据目录：./data
运行配置文件：./data/config.json
```

首次部署时，如果还没有设置管理员密码，网页会先进入管理员密码设置页。设置完成后再进入系统。管理员密码会以哈希形式保存到服务端数据目录，不再明文写入运行配置。

### Windows 绿色版

不想安装 Docker、Python、Node 的用户，可以下载 Release 中的 Windows 绿色压缩包。

使用方式：

```text
解压 -> 双击 start.bat -> 打开 http://localhost:3000
```

Cherry Studio / OpenAI 兼容接口填写：

```text
http://localhost:3000/v1
```

绿色包制作说明见 [WINDOWS_PORTABLE.md](WINDOWS_PORTABLE.md)。

### 本地开发

后端：

```bash
uv sync
uv run main.py
```

前端：

```bash
cd web
npm install
npm run dev
```

开发环境默认仍会通过统一入口访问网页与后端接口。

## 核心功能

### 画布创作

- 提示词、编辑要求、图片结果都会成为画布节点。
- 文生图结果默认落在提示词节点下方。
- 选中图片节点后，可以继续编辑并生成新的分支。
- 支持多图参考、多张结果并排、节点复制、删除、重试、下载、收藏、对比。
- 支持整理画布、定位节点、节点导航、路径高亮和图片放大预览。
- 支持保存和恢复画布项目，服务端按用户隔离存储。
- 支持反推提示词：上传图片或使用画布中图片节点，让后端通过同一图片接口生成反推提示词。

### OpenAI 兼容接口

主要接口：

```text
GET  /v1/models
POST /v1/images/generations
POST /v1/images/edits
POST /v1/chat/completions
POST /v1/responses
POST /v1/messages
```

所有 API 请求都需要鉴权：

```http
Authorization: Bearer <你的密钥>
```

常用客户端填写：

```text
Base URL: http://你的服务器地址:3000/v1
API Key: 管理员密钥或普通用户密钥
```

### 号池管理

- 支持导入、搜索、筛选、批量删除、批量刷新账号信息和额度。
- 支持本地 Token、CPA JSON、远程 CPA、sub2api 等导入方式。
- 支持刷新任务进度显示，适合账号数量较多的场景。
- 支持成功率、失败次数、额度、恢复时间、冷却等因素参与账号选择。
- 支持无效账号自动移除和限流账号恢复检查。

### 设置工作台

设置页整合了原分散管理页面：

- 基础设置：代理、图片任务参数、全局提示词、反推提示词、备份策略。
- 号池管理：账号、额度、刷新、导入导出。
- 图片管理：服务端生成图片查看、筛选、下载、删除、标签。
- 日志管理：调用日志、错误日志、单条日志复制，便于排查问题。

注册机功能已在 v2.1.0 删除。

### 多用户与服务端数据

- 管理员可以创建普通用户密钥。
- 普通用户密钥可作为独立用户使用网页和 API。
- 图片会话、画布项目、图片任务、调用统计按用户隔离。
- 管理员可以查看和管理全局配置、号池、日志和备份。

### 备份与迁移

- 支持导出配置、日志、图片任务、图片会话、画布项目、账号快照、用户密钥快照和图片文件。
- 默认导出会脱敏敏感内容。
- 需要完整迁移时，可显式选择包含敏感数据。
- R2 备份支持加密后保留敏感数据；未加密备份默认不包含敏感信息。

## 部署建议

- 单机自用：Docker Compose 或 Windows 绿色版。
- 服务器部署：建议用 Docker Compose，并将 `./data` 目录持久化。
- 对外访问：可以用反向代理或 Cloudflare Tunnel 暴露 `3000` 端口。
- 不建议直接公开没有访问控制的后台地址；请先设置管理员密码，并为他人创建普通用户密钥。

## 数据位置

默认 JSON 存储：

```text
./data/config.json
./data/logs.json
./data/image_tasks.json
./data/image_conversations.json
./data/image_canvas_projects.json
./data/images/
```

支持通过环境变量切换存储后端：

```text
STORAGE_BACKEND=json
STORAGE_BACKEND=sqlite
STORAGE_BACKEND=postgres
STORAGE_BACKEND=git
```

PostgreSQL 示例：

```yaml
environment:
  - STORAGE_BACKEND=postgres
  - DATABASE_URL=postgresql://user:password@host:5432/dbname
```

## Windows 绿色版打包

发布者需要先准备：

```text
runtime/python/
runtime/node/
```

然后执行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/windows/package-portable.ps1
```

生成目录：

```text
dist/chatgpt2api-windows-portable/
```

将该目录压缩为 zip 后即可发布。

## 与原项目的关系

本仓库不是原项目的官方版本，而是基于原项目能力做的画布创作版改造。主要方向是：

- 保留 OpenAI 兼容 API。
- 强化网页端图片创作与画布工作流。
- 增强多用户、服务端保存、备份迁移、日志排查和部署体验。
- 移除不再维护的注册机功能，降低管理界面复杂度。

原项目地址：[basketikun/chatgpt2api](https://github.com/basketikun/chatgpt2api)
