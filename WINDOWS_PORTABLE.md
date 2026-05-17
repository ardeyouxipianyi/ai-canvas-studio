# Windows 绿色版说明

这个方案面向不想安装 Docker、Python、Node 的用户。

最终用户只需要：

1. 下载 Windows 绿色包
2. 解压
3. 双击 `start.bat`
4. 打开 `http://localhost:3000`

Cherry Studio / OpenAI 兼容接口填写：

```text
http://localhost:3000/v1
```

## 绿色包结构

```text
chatgpt2api-windows-portable/
├─ start.bat
├─ stop.bat
├─ app/
│  ├─ main.py
│  ├─ config.example.json
│  ├─ config.json
│  ├─ data/
│  ├─ web_dist/
│  └─ python_packages/
└─ runtime/
   ├─ python/
   │  └─ python.exe
   └─ node/
      └─ node.exe
```

运行时主要使用 `runtime/python`。

`runtime/node` 主要用于打包阶段构建网页；如果 `app/web_dist` 已经构建好，最终用户启动时通常不需要 Node 常驻运行。

## 制作绿色包

发布者先准备运行环境：

```text
runtime/python/
runtime/node/
```

然后在项目根目录执行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/windows/package-portable.ps1
```

生成目录：

```text
dist/chatgpt2api-windows-portable/
```

把这个目录压缩成 zip 后发给用户即可。

## 用户启动

用户解压后双击：

```text
start.bat
```

停止服务时双击：

```text
stop.bat
```

## 注意

- 发布前请检查 `app/config.example.json`，不要放真实账号、真实 token、真实密钥。
- 用户自己的数据会放在 `app/data/`。
- 默认端口是 `3000`。
- 如果端口被占用，先运行 `stop.bat`，或者关闭占用 `3000` 端口的程序。
