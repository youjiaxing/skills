# 取图入口

本参考用于已选择隔离观察的取图，只包装来源已经允许的能力，不改变来源身份、访问授权、画质门槛或证据覆盖。直接读图不要求运行这些路径输出包装。读取宿主当前 API 文档后再调用；以下代码使用已支持这些接口的 CUA 宿主，其他宿主先核对等价能力。

## 浏览器截图

在 `cua_repl` 内完成取图和落盘，仅打印路径元数据；`outputPath` 是调用方提供的新运行目录文件路径：

```javascript
var bytes = await tab.getScreenshot({emit: false});
var fs = await import('node:fs/promises');
await fs.writeFile(outputPath, bytes, {flag: 'wx', mode: 0o600});
nodeRepl.write({path: outputPath, bytes: bytes.length});
```

由当前浏览器文档提供的截图接口返回字节并允许关闭自动展示时才能使用这种方式。保存后的原图再交图片准备脚本，不调用 `emitImage`，再按 `SKILL.md` 第 3 节分流（单次 ≤ 3 张、UI 交互或地图核验由当前控制代理直接调用 `view_image`；≥ 4 张、超长图 `tiles` 全文转录或大批量提取派发隔离视觉子代理）。

## 页面图片资产

页面提供 `pageAssets` 时，先读取该能力文档并列出实际资产，再用已观察的资产 ID 导出本地文件：

```javascript
var assets = await tab.capabilities.get('pageAssets');
var inventory = await assets.list();
// observedAssetId 来自此次 inventory；bundle 返回本地路径。
var bundle = await assets.bundle({inventoryId: inventory.id, assetIds: [observedAssetId]});
nodeRepl.write(bundle);
```

保持与当前页面、来源 URL 的对应；不猜资源 ID，不迁移登录态或绕过访问限制。导出是否可用需逐入口确认，本机页面能导出不代表受限网站也能成功。临时 bundle 只清理本任务创建的文件，原始来源文件按调用方生命周期保留。

## 视频、消息和 App

- 视频复用来源技能的解码帧脚本，保留身份、时间、原生尺寸与已有画质审核。内部 canvas data URL 只在代码内解码落盘，向模型的最终工具输出只保留路径和元数据；调试时也不打印中间像素。
- QQ 图片先完成消息资源身份与下载校验，再准备输入副本；保留下载原图及原有 MD5，压缩副本使用自己的 SHA，不替换来源身份。
- 飞书当前消息和明确引用的图片沿既有资源接口落盘，保持绑定范围、消息 ID 与图片 key 的对应；只交付已授权的必要本地图片给视觉任务。
- iPhone 复用 `observe --purpose visual --screenshot-output ... --output ...`，或现有 `screenshot --output ...` 的路径输出；操作、锁、凭据页和恢复门禁由原技能持有，见 [手机适配](iphone.md)。

接入后核对一次实际工具输出，确认取图脚本没有直接向会话标准输出打印 Base64/data URL 或含原始截图字节的完整工具响应包。无法运行的平台/来源保留未验收状态。
