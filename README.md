# AIbum 智慧相册

本地可运行的参赛原型：多用户私人照片库、自动标签及人工修正、中文文搜图、图搜图。**不提供图文组合搜索。** 目标规模为每用户约 500 张，当前默认限制 500 张。照片只在本机处理，首次下载模型需要联网；服务运行时仅加载本地权重。

当前阶段：本地产品与验证。比赛截止日期：**2026-11-30**。华为云、CodeArts 与 Skills 实践属于下一阶段，尚未进行部署。

## 在当前电脑启动

服务启动一次后，保持运行窗口打开，然后访问 http://127.0.0.1:8000 。不要在第二个窗口重复启动同一个端口；如果出现 WinError 10048，说明端口已占用，先打开上述网址检查服务。可以执行 `./start.ps1`；它会检测 AIbum 是否已经运行，避免重复启动。

在项目目录打开 PowerShell 时，只复制下面这行命令，不包含 Markdown 反引号或 `D:\study\AIbum>` 终端提示符：

```powershell
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

若 8000 端口被别的程序占用，执行 `./start.ps1 -Port 8001`，然后访问 http://127.0.0.1:8001 。首次注册自己的账户后务必保存页面展示的恢复码。

现有 `.venv` 与 `models/chinese-clip` 已准备好。虚拟环境不能复制到另一台电脑使用。

## 新环境准备

建议 Python **3.12**（64 位）、至少 8 GB 内存。初次安装需给依赖、约 750 MB 模型与转换副本预留数 GB 空间；照片另计。CPU 可运行，无需付费模型 API。实际硬件和照片规模仍需测量。

Windows：

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe scripts\prepare_model.py
.\start.ps1
```

Linux/macOS（本地开发）：

```bash
python3.12 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python scripts/prepare_model.py
.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

模型来自官方 `OFA-Sys/chinese-clip-vit-base-patch16`。准备脚本固定到 `scripts/prepare_model.py` 中的已验证版本，将官方权重以 `weights_only=True` 加载后保存为 safetensors。下载失败后可重新执行；服务本身不会自动下载。没有模型时可上传、浏览及手动编辑，AI 分析失败会保留照片；准备模型、重启服务后在详情中点击“重新分析”。

## 使用流程

1. 注册并保存恢复码。照片、相册、标签和搜索结果按账户隔离。
2. 上传 JPG/PNG/WebP，支持多选逐张上传、进度、同用户去重。单图限 20 MiB、4000 万像素。
3. 后台完成分析后显示推荐标签。标签是有限词库的零样本建议，可以修改或清空；人工修改后，重新分析不覆盖人工标签。
4. **文搜图**：输入中文画面描述并点击搜索；**图搜图**：选择参考图后搜索，文字输入会停用。参考图不保存到照片库。详情中的“找相似”排除参考照片本身。
5. 相册、标签、收藏、地点和日期筛选可与任一种搜索一起使用。日期优先使用 EXIF 拍摄日期，缺失时回退 UTC 上传日期。地点手动填写；未实现 GPS 地理编码。
6. 勾选照片可批量收藏、移动和删除。删除需确认，立即从浏览与检索隐藏，后台清除原图、缩略图和关系记录。
7. “账户安全”支持修改密码与重新生成恢复码。修改/重置密码会撤销该用户全部会话。

### 密码找回

登录页“忘记密码”使用 **用户名＋恢复码＋新密码**。恢复码只显示一次，服务器仅保存摘要；使用后立即失效并生成新码。恢复码不是邮件验证码。目前未接 SMTP 邮箱找回。已登录时可凭当前密码重新生成恢复码。

若密码和恢复码都丢失，界面不会允许仅凭用户名接管账户。生产环境的人工身份核验流程及邮箱找回需要后续设计。

### 管理员

不内置通用管理员密码，也不自动把第一个注册者设为管理员。先正常注册，再由本机维护者运行：

```powershell
.\.venv\Scripts\python.exe scripts\manage.py make-admin 你的用户名
```

重新登录后出现“用户管理”。可以查看用户名、账户状态和照片数量，停用/启用普通用户；停用立即撤销会话。管理员也不能访问他人照片。页面禁止停用管理员。普通账户恢复启用也可通过 `scripts/manage.py activate 用户名` 执行。

## 验证

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.\.venv\Scripts\python.exe -m pytest -q
.\.venv\Scripts\python.exe scripts\smoke_model.py --download
```

首次 `--download` 下载两张公开文档示例图到 `tmp/samples`；后续直接运行 `scripts/smoke_model.py` 即可离线复测。测试使用临时账户和数据库，不写入正式 `data/`。模型报告在 `docs/模型冒烟测试.json`。API 流程测试使用确定性替身，与真实模型结果分开记录。

两张照片上的通过结果不是完整准确率；500 条合成向量的排名耗时不是 500 张真实照片全流程或多用户并发压测。见 `docs/测试与验收.md`。

## 目录与接口

```text
app/                   后端、数据库、模型和后台任务
web/                   可替换的 HTML/CSS/JavaScript 前端
scripts/               模型准备、真实模型验证、本地管理员工具
tests/                 账户、照片、搜索和安全流程测试
docs/                  需求、规划、验证和交接记录
data/                  正式数据库与用户照片（不入 Git）
models/                模型权重（不入 Git）
tmp/                   测试素材和隔离数据（不入 Git）
```

API 结构见 http://127.0.0.1:8000/openapi.json ，交互文档为 `/docs`（文档 UI 使用外部 CDN，离线时可直接读取 OpenAPI JSON）。写请求带 `X-AIbum-Request: 1`，使用同源 Cookie 身份验证。不得将照片目录直接作为静态网站发布。

核心接口：`/api/auth/*`、`/api/photos`、`/api/photos/{id}`、`/api/photos/{id}/file`、`/api/photos/{id}/retry`、`/api/photos/{id}/similar`、`/api/search`、`/api/albums`、`/api/tags`、`/api/admin/users`。`/api/search` 是 multipart 请求，只能提供 text 或 image 之一。

## 配置与维护

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| AIBUM_DATA_DIR | 项目下 data | 私有照片和 SQLite 数据目录 |
| AIBUM_MODEL_PATH | models/chinese-clip | 本地模型目录 |
| AIBUM_DEVICE | cpu | 可按 PyTorch 环境选择 cuda |
| AIBUM_ALLOWED_HOSTS | localhost,127.0.0.1,testserver | Host 白名单，多个用逗号分隔 |
| AIBUM_SECURE_COOKIE | 0 | 云部署配置 HTTPS 后设为 1 |

当前使用单进程 Uvicorn＋一个后台分析线程，**不要加 `--workers` 多进程参数**。后台任务状态持久化，重启会恢复处理中任务。SQLite 使用短连接及 WAL；用户照片不写入日志。

备份：先停止服务，再同时复制整个 `data/`。恢复时指向备份副本启动，检查账户、照片、原图和检索后再切换。不要只备份数据库而丢掉 `photos/`，也不要把测试用 `tmp/browser-data` 当作正式数据。崩溃发生在文件已落盘、数据库尚未提交的极小窗口可能留下孤立文件，当前未做自动垃圾回收；备份时保留它们，避免误删。

## 开源和比赛交付

原创代码采用 MIT 许可证，见 `LICENSE`。模型、依赖、用户提供论文、需求文档与测试图片不因本项目许可证而改变原许可。开源前按 `docs/开源与参赛准备.md` 检查；不要上传私有照片、密码、恢复码、云密钥、模型权重或论文全文。

继续开发前先读 `docs/交接记录.md`，再读 `docs/确认需求与交付计划.md`。后续工作优先级：真实照片评估 → 队伍前端设计 → CodeArts/华为云部署 → 演示材料。
