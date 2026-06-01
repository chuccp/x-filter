# x-filter — X 评论过滤器

基于 BERT 模型的 X (Twitter) 垃圾评论检测与批量拉黑工具。通过 Chrome CDP 协议采集评论，使用微调的 BERT ONNX 模型识别垃圾评论，并自动拉黑发送者。

使用 **C# + Avalonia UI** 构建，单个可执行文件 ~27 MB，支持 Windows / macOS / Linux。

## 功能

- **Chrome 连接** — 通过 CDP（Chrome DevTools Protocol）连接本地 Chrome 浏览器
- **评论采集** — 输入推文链接，自动滚动加载并抓取所有评论
- **评论标注** — 键盘快捷键快速标注训练数据
- **模型训练** — 应用内一键训练 BERT 模型（需 Python）
- **自动拉黑** — 模型自动识别垃圾评论并批量拉黑发送者
- **名单拉黑** — 支持手动维护黑名单，导入/导出用户名列表批量拉黑
- **模型下载** — 支持从 Hugging Face Hub 下载预训练模型

## 拉黑操作流程（普通用户只需要看这里）

1. **下载安装包** — 从 [Releases](https://github.com/chuccp/x-filter/releases) 页面下载对应平台安装包
2. **启动 Chrome 调试模式** — 见下方 [开启 Chrome 远程调试](#开启-chrome-远程调试)
3. **连接 Chrome** — 在应用中点击连接
4. **下载模型** — 点击"下载模型"，输入 HuggingFace 模型路径（如 `chuccp/x-spam-classifier`）
5. **开始拉黑** — 粘贴推文链接，点击"扫描并拉黑"

## 工作原理

核心检测信号是 **评论与帖子的相关性**：与原文无关的评论很可能是垃圾内容。训练和推理时会将帖子原文和评论文本拼接为 `[POST] <帖子> [COMMENT] <评论>` 格式输入 BERT 模型。

ONNX 模型推理通过 `Microsoft.ML.OnnxRuntime` 在本地运行，无需 GPU。Python 仅用于训练模型。

```
采集评论 → 标注数据 → 导出 CSV → 训练 BERT（需 Python） → ONNX 模型 → 推理拉黑
```

## 环境要求

- **.NET 9 SDK** 或更高版本
- **Chrome 浏览器**（需开启远程调试，见下文）
- **Python >= 3.9**（仅训练/上传模型时需要，推理拉黑不需要）

## 快速开始

### 1. 克隆项目

```bash
git clone https://github.com/chuccp/x-filter.git
cd x-filter/XFilter
```

### 2. 开启 Chrome 远程调试

打开 Chrome 浏览器，在地址栏输入：

```
chrome://inspect/#remote-debugging
```

然后将 **"Allow remote debugging"** 切换为开启状态。

### 3. 运行

```bash
dotnet run --project src/XFilter.App
```

### 4. 发布（生成独立可执行文件）

```bash
# Windows
dotnet publish src/XFilter.App -c Release -r win-x64 -o publish/win-x64

# macOS
dotnet publish src/XFilter.App -c Release -r osx-x64 -o publish/osx-x64

# Linux
dotnet publish src/XFilter.App -c Release -r linux-x64 -o publish/linux-x64
```

发布后为单个自包含可执行文件，约 27 MB。

## 使用流程

**训练模式（管理员）：**

1. **连接 Chrome** — 确认 Chrome 已开启远程调试，点击连接
2. **采集评论** — 粘贴推文链接，设置滚动次数，开始抓取
3. **标注评论** — 使用键盘快捷键标注垃圾/正常评论
4. **导出数据** — 将标注数据导出为 CSV 文件
5. **训练模型** — 检查 Python 环境、安装依赖、启动训练

**拉黑模式（用户）：**

1. **连接 Chrome** — 同上
2. **下载模型** — 从 HuggingFace Hub 下载预训练模型
3. **拉黑操作** — 粘贴推文链接，选择"扫描并拉黑"（模型过滤），应用自动处理

## 训练模型

### 命令行训练

```bash
cd XFilter
python ../train.py --csv ../data/labeled.csv --output ../data/models/x-spam-classifier
```

参数说明：

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--csv` | 标注数据 CSV 文件路径 | 必填 |
| `--output` | 模型输出目录 | `data/models/x-spam-classifier` |
| `--model` | 预训练模型名称 | `bert-base-multilingual-cased` |
| `--epochs` | 训练轮数 | `5` |
| `--batch` | 批次大小 | `8` |
| `--lr` | 学习率 | `2e-5` |

## 项目结构

```
x-filter/
├── XFilter/                           # C# 解决方案
│   ├── XFilter.sln
│   └── src/
│       ├── XFilter.Core/              # 业务逻辑（无 UI 依赖）
│       │   ├── Cdp/                   # CDP WebSocket 客户端
│       │   ├── Data/                  # SQLite 数据库层
│       │   ├── Services/              # 核心服务（抓取、拉黑、下载、推理、训练）
│       │   ├── Tokenization/          # BERT WordPiece 分词器
│       │   ├── I18n/                  # 国际化
│       │   └── Models/                # 数据模型
│       ├── XFilter.UI/                # Avalonia UI 层
│       │   ├── ViewModels/            # MVVM ViewModel
│       │   ├── Views/                 # XAML 视图
│       │   └── Resources/I18n/        # 翻译文件
│       └── XFilter.App/               # 应用入口 + DI 容器
├── train.py                           # Python BERT 训练脚本
├── download_model.py                  # 预训练模型下载脚本
├── upload_to_hf.py                    # 模型上传到 HuggingFace
└── assets/                            # 图标
```

## 技术栈

| 层 | 技术 |
|---|------|
| 框架 | .NET 9 + Avalonia UI |
| 浏览器控制 | Chrome DevTools Protocol (WebSocket) |
| 数据库 | SQLite (Microsoft.Data.Sqlite) |
| 模型推理 | ONNX Runtime (Microsoft.ML.OnnxRuntime) |
| 模型训练 | HuggingFace Transformers + Optimum ONNX |
| 预训练模型 | bert-base-multilingual-cased |

## 开发

```bash
cd XFilter
dotnet run --project src/XFilter.App    # 运行
dotnet build                             # 构建
dotnet publish -c Release -r win-x64    # 发布
```

## 注意事项

- Chrome 远程调试端口默认 `9222`，可在设置中修改
- 评论按文本内容 SHA-256 去重
- 训练数据 CSV 格式：`text,post_text,label`
- 拉黑每个用户约需 2-3 秒，建议适度使用避免触发 X 限制
- ONNX 模型存储在 `%LOCALAPPDATA%/x-filter/models/` 目录

## License

MIT
