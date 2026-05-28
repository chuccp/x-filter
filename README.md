# x-filter — X 评论过滤器

基于 BERT 模型的 X (Twitter) 垃圾评论检测与批量拉黑工具。通过 Chrome CDP 协议采集评论，使用微调的 BERT 模型识别垃圾评论，并自动拉黑发送者。

## 功能概览

- **Chrome 连接** — 通过 CDP（Chrome DevTools Protocol）连接本地 Chrome 浏览器
- **评论采集** — 输入推文链接，自动滚动加载并抓取所有评论
- **评论标注** — 键盘快捷键（S=垃圾 / N=正常）快速标注训练数据
- **模型训练** — 应用内一键训练 BERT 模型，支持导出 CSV 训练数据
- **自动拉黑** — 模型自动识别垃圾评论并批量拉黑发送者，支持流式逐条处理
- **名单拉黑** — 支持手动维护黑名单，导入/导出用户名列表批量拉黑
- **模型下载** — 支持从 Hugging Face Hub 下载预训练模型

## 工作原理

核心检测信号是 **评论与帖子的相关性**：与原文无关的评论很可能是垃圾内容。训练和推理时会将帖子原文和评论文本拼接为 `[POST] <帖子> [COMMENT] <评论>` 格式输入 BERT 模型，让模型学习帖子-评论之间的关系。

```
采集评论 → 标注数据 → 导出 CSV → 训练 BERT → ONNX 模型 → 推理拉黑
```

## 环境要求

- **Node.js** >= 18
- **Chrome 浏览器**（需开启远程调试，见下文）
- **Python** >= 3.9（仅训练/下载模型时需要，应用内置便携 Python 下载功能）
- **Windows** / macOS / Linux

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 开启 Chrome 远程调试

启动 Chrome 时添加参数：

**Windows:**
```cmd
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
```

**macOS:**
```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
```

**Linux:**
```bash
google-chrome --remote-debugging-port=9222
```

### 3. 启动应用

```bash
npm run dev    # 开发模式（Vite + Electron，支持热更新）
npm run start  # 直接启动 Electron
```

### 4. 使用流程

**训练模式（管理员）：**

1. **连接 Chrome** — 确认 Chrome 已开启远程调试，点击连接
2. **采集评论** — 粘贴推文链接，设置滚动次数，开始抓取
3. **标注评论** — 使用 S/N 键快速标注垃圾/正常评论，支持批量标注
4. **导出数据** — 将标注数据导出为 CSV 文件
5. **训练模型** — 一键安装 Python 依赖、启动训练，支持 GPU 加速

**拉黑模式（用户）：**

1. **连接 Chrome** — 同上
2. **拉黑操作** — 粘贴推文链接，选择"扫描并拉黑"（模型过滤）或"全部拉黑"（不过滤）
3. 应用自动滚动加载评论、模型实时预测、逐条拉黑垃圾评论发送者

## 训练模型

### 应用内训练

在"训练模型"页面：

1. 检查 Python 环境（或使用应用内置的便携 Python 下载功能）
2. 选择标注好的 CSV 数据文件
3. 点击"开始训练"
4. 训练完成后自动加载 ONNX 模型

### 命令行训练

```bash
python train.py --csv data/labeled.csv --output data/models/x-spam-classifier
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
├── main.js                          # Electron 主进程入口
├── index.html                       # SPA 页面（所有视图静态 HTML）
├── vite.config.js                   # Vite 构建配置
├── train.py                         # Python BERT 训练脚本
├── src/
│   ├── main/                        # 主进程模块
│   │   ├── cdp-manager.js           # CDP WebSocket 客户端
│   │   ├── database.js              # SQLite 数据库（sql.js）
│   │   ├── model-manager.js         # ONNX 模型加载/推理
│   │   ├── x-scraper.js             # 评论抓取逻辑
│   │   ├── x-blocker.js             # 自动拉黑逻辑
│   │   └── ipc/                     # IPC 处理器（按功能拆分）
│   │       ├── cdp.js
│   │       ├── scrape.js
│   │       ├── labels.js
│   │       ├── model.js
│   │       ├── block.js
│   │       ├── training.js
│   │       └── app.js
│   ├── renderer/                    # 渲染进程
│   │   ├── app.js                   # SPA 路由
│   │   ├── ui.js                    # UI 工具函数
│   │   ├── i18n.js                  # 国际化
│   │   └── views/                   # 视图模块
│   │       ├── connection.js        # Chrome 连接
│   │       ├── admin-collect.js     # 评论采集
│   │       ├── admin-label.js       # 评论标注
│   │       ├── admin-export.js      # 数据导出
│   │       ├── admin-train.js       # 模型训练
│   │       ├── admin-settings.js    # 设置
│   │       ├── user-block.js        # 模型拉黑
│   │       └── user-blocklist.js    # 名单拉黑
│   └── i18n/                        # 翻译文件
│       ├── en.json
│       └── zh-CN.json
├── scripts/                         # 辅助脚本
│   └── download_model.py            # Hugging Face 模型下载
└── data/                            # 数据目录（gitignore）
    ├── labeled/                     # 标注数据 CSV
    └── models/                      # 训练输出模型
```

## 技术栈

| 层 | 技术 |
|---|------|
| 框架 | Electron |
| 构建 | Vite |
| 浏览器控制 | Chrome DevTools Protocol (WebSocket) |
| 数据库 | SQLite (sql.js) |
| 模型推理 | ONNX Runtime (@xenova/transformers) |
| 模型训练 | HuggingFace Transformers + Optimum ONNX |
| 预训练模型 | bert-base-multilingual-cased |

## 开发

```bash
npm run dev      # 启动开发服务器
npm run build    # 构建安装包
npx prettier --write .  # 格式化代码
```

代码格式化配置：单引号、80 字符行宽、2 空格缩进。

## 注意事项

- Chrome 远程调试端口默认 `9222`，可在设置中修改
- 评论按文本内容 SHA-256 去重，不会重复入库
- 训练数据 CSV 格式：`text,post_text,label`（post_text 可选）
- 拉黑每个用户约需 2-3 秒（定位元素 → 打开菜单 → 确认），建议适度使用避免触发 X 限制
- ONNX 模型存储在 Electron userData 目录下
