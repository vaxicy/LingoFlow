# LingoFlow 安装和使用指南

## 📦 已完成的功能

### ✅ 核心功能
1. **划词翻译** - 选中文本后显示浮动工具栏（Translate、Copy、Save）
2. **右键菜单** - 右键菜单集成翻译、保存、复制功能
3. **双语阅读模式** - 在原文下方显示翻译
4. **整页翻译** - 翻译网页主要内容
5. **悬停单词解释** - 鼠标悬停显示词义卡片
6. **收藏管理** - 保存单词和句子，支持搜索、删除、导出
7. **历史记录** - 保存翻译历史，支持搜索、删除、清空
8. **设置页面** - 配置目标语言、主题、开关等

### ✅ 技术实现
- Manifest V3 规范
- Vanilla JavaScript（无框架依赖）
- Chrome Storage Local（本地存储）
- 无后端、无登录、无服务器
- 支持中英文国际化
- 支持深色模式
- 可插拔翻译引擎架构

## 🚀 安装步骤

### 第一步：创建 PNG 图标

当前使用的是 SVG 图标，Chrome 需要扩展图标为 PNG 格式。

**方法一：使用提供的图标生成器**

1. 在浏览器中打开 `create-icons.html`
2. 点击 "Generate Icons" 按钮
3. 点击 "Download Icons" 按钮下载 PNG 文件
4. 将下载的 `icon16.png`、`icon48.png`、`icon128.png` 移动到 `icons` 文件夹

**方法二：使用命令行工具**

如果你有 ImageMagick 或 Inkscape：

```bash
# ImageMagick
magick convert icons/icon16.svg -background none icons/icon16.png
magick convert icons/icon48.svg -background none icons/icon48.png
magick convert icons/icon128.svg -background none icons/icon128.png

# Inkscape
inkscape --export-type=png --export-filename=icons/icon16.png -w 16 -h 16 icons/icon16.svg
inkscape --export-type=png --export-filename=icons/icon48.png -w 48 -h 48 icons/icon48.svg
inkscape --export-type=png --export-filename=icons/icon128.png -w 128 -h 128 icons/icon128.svg
```

**方法三：使用在线转换工具**

- 访问 https://cloudconvert.com/svg-to-png
- 上传三个 SVG 文件
- 下载并重命名为 `icon16.png`、`icon48.png`、`icon128.png`
- 放入 `icons` 文件夹

### 第二步：加载扩展到 Chrome

1. 打开 Chrome 浏览器
2. 在地址栏输入：`chrome://extensions/`
3. 右上角打开 "开发者模式"
4. 点击 "加载已解压的扩展程序"
5. 选择 `LingoFlow` 文件夹
6. 扩展安装成功！

## 🧪 测试功能

### 1. 测试弹出窗口
- 点击浏览器工具栏的 LingoFlow 图标
- 应该看到弹出窗口，包含：
  - Translate Page
  - Bilingual Mode
  - Restore Original
  - Vocabulary
  - History
  - Settings

### 2. 测试划词翻译
- 打开任意英文网站（如 https://example.com）
- 选中一段文本
- 应该看到浮动工具栏出现
- 点击 "Translate" 测试翻译功能
- 点击 "Copy" 测试复制功能
- 点击 "Save" 测试保存功能

### 3. 测试右键菜单
- 选中文本后右键点击
- 应该看到 "LingoFlow" 菜单
- 展开后有三个选项

### 4. 测试整页翻译
- 点击 LingoFlow 图标
- 点击 "Translate Page"
- 页面内容应该被翻译（当前使用 mock 翻译，显示 `[翻译] 原文`）

### 5. 测试双语模式
- 点击 LingoFlow 图标
- 点击 "Bilingual Mode"
- 页面应该显示原文和译文

### 6. 测试恢复原文
- 在翻译后
- 点击 "Restore Original"
- 页面应该恢复原始内容

### 7. 测试悬停翻译
- 鼠标悬停在英文单词上
- 应该显示词义卡片（当前只有少量词库）

### 8. 测试收藏页面
- 点击 LingoFlow 图标
- 点击 "Vocabulary"
- 应该打开收藏页面
- 测试搜索、删除、导出功能

### 9. 测试历史记录
- 点击 LingoFlow 图标
- 点击 "History"
- 应该打开历史记录页面
- 测试搜索、删除、清空功能

### 10. 测试设置页面
- 点击 LingoFlow 图标
- 点击 "Settings"
- 应该打开设置页面
- 测试所有配置选项

## 📝 当前限制

### 翻译功能
- **当前使用 Mock 翻译器**：显示 `[翻译] 原文`
- 需要集成真实的翻译 API（Google Translate、DeepL 等）

### 词库
- **悬停翻译词库有限**：只有少量示例单词
- 需要集成完整的词典数据库

### DOM 处理
- 基础实现，可能需要优化
- 某些复杂网页可能显示不正常

## 🔧 下一步开发

### 1. 集成真实翻译 API

在 `js/content.js` 中，找到 `TranslationEngine` 对象：

```javascript
const TranslationEngine = {
  activeEngine: 'mock',

  engines: {
    mock: { /* 当前使用 */ },
    google: { /* 待实现 */ },
    deepl: { /* 待实现 */ }
  },

  async translate(text, targetLang) {
    // 在这里集成真实 API
  }
};
```

### 2. 扩展词库

在 `js/content.js` 中，找到 `lookupWord` 函数：

```javascript
lookupWord(word) {
  const dict = {
    'hello': '你好',
    'world': '世界',
    // 添加更多单词
  };

  return dict[word.toLowerCase()] || null;
}
```

### 3. 优化 DOM 处理

在 `js/content.js` 中，修改 `DOMProcessor` 对象以更好地处理各种网页结构。

## 📁 项目结构

```
LingoFlow/
├── manifest.json              ✅ 扩展配置
├── popup.html                ✅ 弹出窗口
├── popup.js                  ✅ 弹出窗口逻辑
├── css/
│   ├── popup.css             ✅ 弹出窗口样式
│   ├── content.css           ✅ 内容脚本样式
│   ├── options.css           ✅ 设置页面样式
│   ├── vocabulary.css        ✅ 收藏页面样式
│   └── history.css           ✅ 历史页面样式
├── js/
│   ├── background.js         ✅ 后台脚本
│   ├── content.js            ✅ 内容脚本
│   ├── popup.js              ✅ 弹出窗口逻辑
│   ├── options.js            ✅ 设置页面逻辑
│   ├── vocabulary.js         ✅ 收藏页面逻辑
│   └── history.js            ✅ 历史页面逻辑
├── pages/
│   ├── options.html          ✅ 设置页面
│   ├── vocabulary.html       ✅ 收藏页面
│   └── history.html          ✅ 历史页面
├── icons/                    ⚠️ 需要创建 PNG 图标
│   ├── icon16.svg
│   ├── icon48.svg
│   ├── icon128.svg
│   ├── icon16.png           (需要创建)
│   ├── icon48.png           (需要创建)
│   └── icon128.png          (需要创建)
├── _locales/                ✅ 国际化
│   ├── en/
│   └── zh_CN/
├── create-icons.html          ✅ 图标生成工具
├── README.md                 ✅ 项目说明
└── INSTALL.md                ✅ 安装指南
```

## 🎯 核心设计理念

### 1. 不破坏网页原始结构
- 翻译前保存原文到 `state.originalContent`
- 所有翻译操作都可恢复
- 对已经翻译的节点不再重复翻译

### 2. 可插拔翻译引擎
- 预留多种翻译引擎接口
- 方便后续集成真实 API
- 当前使用 Mock 翻译器完成基础流程

### 3. 用户体验优先
- 简洁、现代的 UI 设计
- 参考 Raycast、Linear、Notion 风格
- 圆角、轻量、不打扰阅读

### 4. 隐私优先
- 无登录、无后端、无数据收集
- 所有数据本地存储
- 不依赖任何外部服务

## 🐛 常见问题

### 1. 扩展加载失败
- 确保 `icons` 文件夹中有 PNG 图标
- 检查 `manifest.json` 格式是否正确
- 查看 Chrome 扩展页面的错误信息

### 2. 划词翻译不工作
- 确保不在 `chrome://` 或 `chrome-extension://` 页面
- 检查内容脚本是否正确加载
- 查看浏览器控制台错误信息

### 3. 弹出窗口显示不正常
- 检查 `popup.html`、`popup.css`、`popup.js` 是否正确加载
- 确保文件路径正确

## 📞 支持

如有问题或建议，请查看 `README.md` 或联系开发者。

---

**祝你使用愉快！🎉**
