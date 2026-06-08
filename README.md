# AI Canvas Studio

这是一个画布式 AI 图片创作工作台，当前维护仓库为 [ardeyouxipianyi/ai-canvas-studio](https://github.com/ardeyouxipianyi/ai-canvas-studio)。

本项目基于原开源项目 [basketikun/chatgpt2api](https://github.com/basketikun/chatgpt2api) 二次改造而来，但当前产品边界已经收束为独立的网页画布工具。感谢原项目作者和贡献者提供的基础代码与思路。

原项目采用 MIT License。本仓库继续保留原 MIT 许可证文本和版权声明，二次开发部分同样按仓库内 [LICENSE](LICENSE) 发布。

本改版当前定位为“画布式 AI 图片创作工作台”：把原来的单次画图页面升级为画布式工作流，支持从提示词生成图片、把结果落到画布、继续基于图片编辑、形成分支链路，并把画布、图片、日志和用户数据保存到服务端。

从 Provider 解耦版本开始，画布生成、编辑、反推提示词统一通过后台配置的“模型服务 / Provider”调用图片 API。首批支持 OpenAI Compatible 图片 API；本项目不再提供对外 OpenAI 兼容 API 代理。

## 当前版本

`0.1.0` 是独立仓库的初始版本，重点是把项目定位从旧的 API 代理收束为网页画布工作台。

## 当前开发主线

- 画布是产品主体，`/api/image-tasks/*` 是网页内部任务接口。
- 设置页新增“模型服务”，可配置 OpenAI Compatible Provider、模型、Base URL、API Key 和超时。
- 画布节点会记录 provider、模型和尺寸，便于同一画布里回溯不同服务生成的结果。
- 号池管理、注册机、Cherry Studio 对外 API 代理等旧能力已退出当前产品主线；当前界面重点收束到模型服务、画布、图片资产、日志和备份迁移。

> 免责声明：本项目仅用于个人学习、技术研究与非商业交流。请自行确认使用方式符合相关服务条款和所在地法律法规。不要将重要账号、常用账号或高价值账号用于测试。

## 0.1.0 初始能力

- 画布创作：提示词、编辑要求、生成结果会形成可保存的节点工作流。
- Provider 解耦：生图服务和反推服务可分别配置默认模型服务。
- OpenAI Compatible 上游：支持配置 Base URL、API Key、模型、超时、模型获取和连接测试。
- 图片任务：统一走内部 `/api/image-tasks/*`，记录 Provider、模型、尺寸、耗时、宽高和失败原因。
- 图片资产：生成结果进入服务端图片管理，可查看、下载、打标签并回溯画布来源。
- 设置工作台：模型服务、图片管理、日志管理、备份迁移和用户密钥统一收进设置中心。
- 多用户数据：管理员可创建普通用户密钥，画布、任务、图片和日志按用户隔离。
- 对外 API 代理关闭：不再提供 `/v1/*` OpenAI 兼容接口，旧号池、注册机和 Cherry Studio 代理能力不进入当前主线。

## 适合什么场景

- 需要一个网页端图片创作工作台，而不是只通过 API 调用画图。
- 需要把提示词、参考图、生成结果和多次修改关系保存在一个画布里。
- 需要在网页画布里接入可配置的 OpenAI Compatible 图片 API，而不是把项目当作对外 API 代理。
- 需要把服务部署到自己的服务器，并让不同用户使用独立数据。
- 需要把模型服务、画布项目、图片资产、日志和备份迁移统一放在服务端管理。

## 快速启动

### Docker Compose

```bash
git clone https://github.com/ardeyouxipianyi/ai-canvas-studio.git
cd ai-canvas-studio
docker compose up -d
```

启动后访问：

```text
网页地址：http://localhost:3000
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

### 模型服务 / Provider

- 支持在网页设置中新增、编辑、删除、启用和设置默认 Provider。
- 首批支持 OpenAI Compatible 图片 API，可配置 Base URL、API Key、模型和超时。
- 支持测试连接和获取模型列表，模型列表会持久化缓存到服务端。
- Provider 会记录最近成功、最近失败、失败摘要、耗时和成功/失败计数，方便排查服务质量。
- API Key 等敏感字段只保存在后端，前端只显示是否已配置，不回传明文。

### 设置工作台

设置页整合了原分散管理页面：

- 基础设置：代理、图片任务参数、全局提示词、反推提示词、备份策略。
- 模型服务：OpenAI Compatible Provider、模型、Base URL、API Key、超时、连接测试和模型列表获取。
- 图片管理：服务端生成图片查看、筛选、下载、删除、标签。
- 日志管理：调用日志、错误日志、单条日志复制，便于排查问题。

注册机功能已在 v2.1.0 删除。

### 多用户与服务端数据

- 管理员可以创建普通用户密钥。
- 普通用户密钥可作为独立用户使用网页画布。
- 图片会话、画布项目、图片任务、调用统计按用户隔离。
- 管理员可以查看和管理全局配置、模型服务、日志和备份。

### 备份与迁移

- 支持导出配置、日志、图片任务、模型服务、图片会话、画布项目、用户密钥快照和图片文件。
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
./data/image_providers.json
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
dist/ai-canvas-studio-windows-portable/
```

将该目录压缩为 zip 后即可发布。

## 与原项目的关系

本仓库不是原项目的官方版本，而是基于 [basketikun/chatgpt2api](https://github.com/basketikun/chatgpt2api) 的二次开发版本。感谢原项目作者和社区贡献者提供的开源基础。

原项目采用 MIT License，本仓库保留原版权声明和许可证文本。使用、分发或二次开发本项目时，请继续遵守仓库内 [LICENSE](LICENSE) 的要求，保留相关版权与许可声明。

当前改造方向是：

- 以画布式 AI 图片创作为主线，Provider 配置为画布调用图片服务的核心入口。
- 对外 OpenAI 兼容 API 已关闭，画布只使用内部 `/api/*` 接口和后台 Provider。
- 强化网页端图片创作与画布工作流。
- 增强多用户、服务端保存、备份迁移、日志排查和部署体验。
- 移除不再维护的注册机功能，降低管理界面复杂度。

原项目地址：[basketikun/chatgpt2api](https://github.com/basketikun/chatgpt2api)
