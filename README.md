# AI Canvas Studio

AI Canvas Studio 是一个画布式 AI 图片创作工作台。它把提示词、参考图、生成结果和后续编辑组织成可保存、可回溯的画布节点，让图片创作不再只是一条一次性的调用记录。

当前版本：`0.3.0`

仓库地址：[ardeyouxipianyi/ai-canvas-studio](https://github.com/ardeyouxipianyi/ai-canvas-studio)

## 主要能力

- 画布创作：提示词、编辑要求、生成结果都会成为画布节点。
- 画布操作：支持撤销、重做、框选、多节点对齐、整理、定位和导出。
- 图片生成：通过后台配置的模型服务调用 OpenAI Compatible 图片 API。
- 图片编辑：支持基于已有图片继续编辑，形成分支创作链路。
- 反推提示词：可单独配置反推服务，用于从图片生成提示词描述。
- 图片资产库：生成和编辑结果会保存到服务端图片管理中，便于查看、下载、标签和回溯来源。
- 多用户数据隔离：普通用户密钥对应独立用户数据，画布、图片、任务和日志按用户隔离。
- 服务端保存：画布项目、模型服务、图片任务、图片文件、日志和配置都会保存在服务端数据目录。
- 备份迁移：支持导出和导入配置、模型服务、画布、图片资产、日志和用户密钥。

## v0.3.0 更新

- 画布新增撤销、重做、Shift 框选和多节点居中对齐。
- 抽出画布核心几何与选择逻辑，后续工具能力更容易扩展。
- 图片资产删除时会同步标记关联画布节点，避免画布静默断图。
- 发布质量门槛升级，前端构建恢复 TypeScript 检查，发布脚本测试命令修正。

## 模型服务

设置页中的“模型服务”是画布调用 AI 图片能力的核心入口。

当前支持 OpenAI Compatible 图片 API，可配置：

- 名称
- 模型
- Base URL
- API Key
- 超时秒数

系统会区分两个默认服务：

- 生图服务：用于文生图、图生图和图片编辑。
- 反推服务：用于图片反推提示词。

模型服务支持获取模型列表、连接测试和 API Key 后端保存。前端默认不回显明文 API Key，需要在编辑时主动点击显示。

## 快速启动

### Docker Compose

```bash
git clone https://github.com/ardeyouxipianyi/ai-canvas-studio.git
cd ai-canvas-studio
docker compose up -d
```

启动后访问：

```text
http://localhost:3000
```

默认数据目录：

```text
./data
```

首次部署时，网页会引导设置管理员密码。管理员密码会以哈希形式保存到服务端数据目录。

### Windows 绿色版

下载 Release 中的 Windows 绿色压缩包后：

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

Windows 本地开发也可以直接运行：

```text
双击 .start-dev.cmd
```

或在 PowerShell 中运行：

```powershell
powershell -ExecutionPolicy Bypass -File .start.ps1
```

## 画布工作流

1. 在画布底部输入提示词。
2. 选择生图服务、模型、张数和比例。
3. 生成结果会自动落到画布中，成为图片节点。
4. 选中图片节点后，可以继续输入编辑要求生成分支。
5. 图片节点支持复制、编辑、重试、下载、收藏、对比和删除。
6. 画布可以撤销、重做、框选、批量对齐、保存、恢复、整理和定位节点。

## 图片资产

所有生成和编辑结果都会进入服务端图片资产库。

图片资产会记录：

- 文件路径
- 宽高
- Provider
- 模型
- 提示词
- 来源画布节点
- 任务 ID
- 创建用户
- 标签

图片管理支持查看、筛选、下载、删除和从图片回溯画布来源。

## 数据位置

默认使用 JSON 文件保存数据：

```text
./data/config.json
./data/image_providers.json
./data/image_tasks.json
./data/image_canvas_projects.json
./data/image_conversations.json
./data/images/
./data/logs.json
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

## 备份与迁移

设置页支持导出和导入运行数据。

可备份内容包括：

- 系统配置
- 模型服务
- 画布项目
- 图片资产
- 图片任务
- 日志
- 用户密钥

默认导出会脱敏敏感内容。需要完整迁移时，可以显式选择包含敏感数据。

## 部署建议

- 单机自用：Docker Compose 或 Windows 绿色版。
- 服务器部署：建议使用 Docker Compose，并持久化 `./data` 目录。
- 对外访问：建议放在反向代理或 Cloudflare Tunnel 后面。
- 安全建议：先设置管理员密码，再为其他人创建普通用户密钥。

## 开源协议与致谢

本项目基于开源项目 [basketikun/chatgpt2api](https://github.com/basketikun/chatgpt2api) 二次开发而来。感谢原项目作者和贡献者提供的基础代码与思路。

原项目采用 MIT License。本仓库继续保留原 MIT 许可证文本和版权声明，二次开发部分同样按仓库内 [LICENSE](LICENSE) 发布。

使用、分发或二次开发本项目时，请继续保留相关版权与许可声明。

## 免责声明

本项目仅用于个人学习、技术研究与非商业交流。请自行确认使用方式符合相关服务条款和所在地法律法规。
