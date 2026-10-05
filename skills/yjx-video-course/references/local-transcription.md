# 本地转写与依赖配置

进入音频获取、转换或本地语音转写路线前读取。字幕可用且质量足够时，直接使用字幕，不要求预装整套工具。本文件提供跨平台配置路径，不代表当前机器或所有平台已经实测通过。

## 按路线探测

先确认当前操作系统、CPU 架构、可用内存、磁盘空间及任务输出目录。检查当前 PATH 和明确的已配置工具路径；未找到只能报告“当前环境未发现”，不要断言全机没有安装。

| 依赖 | 用途 | 需要条件 |
| --- | --- | --- |
| `ffmpeg` | 音频解码、转换和必要片段提取 | 处理本地音频时 |
| `ffprobe` | 核对音轨、时长和转换产物 | 获取或转换音频时 |
| `whisper-cli`，来自 `whisper.cpp` | 本地 ASR，输出带时间转写 | 字幕不可用或重要内容需要音频补证时 |
| 兼容的多语言 GGML 模型 | 提供 ASR 权重 | 运行本地转写时，模型不随 CLI 自动就绪 |
| `yt-dlp` | 下载平台支持且获授权的音频或字幕 | 获取路径需要时；不是浏览器字幕读取的前置依赖 |
| Python 或构建工具 | Python 安装 `yt-dlp`，或源码构建 `whisper.cpp` | 仅对应安装路线需要；不是所有环境的必备项 |

macOS/Linux 的只读探测：

```sh
command -v ffmpeg
command -v ffprobe
command -v whisper-cli
command -v yt-dlp
```

Windows PowerShell 的只读探测：

```powershell
Get-Command ffmpeg, ffprobe, whisper-cli, yt-dlp -ErrorAction SilentlyContinue
```

对找到的工具读取版本及帮助，例如 `ffmpeg -version`、`ffprobe -version`、`whisper-cli -h`、`yt-dlp --version`。`whisper-cli` 不在 PATH 时，用实际可执行文件路径读取帮助；记录安装包版本或源码提交。不同版本的格式和参数可能不同，以当前 `-h` 与匹配版本的官方文档为准。

## 安装与权限

优先复用已安装且适配的工具及模型。安装、升级或模型下载前说明包、来源、目标位置、下载量和磁盘/内存/计算成本，取得覆盖这些行为的授权；没有授权时先报告缺口。不得因用户要求生成课程就默认授予安装、上传或付费权限。

下列命令是授权后的配置参考，不是读取此文档时自动执行的步骤。不要覆盖已有安装或在工作区外写入未经确认的位置。包管理器本身不存在时，也先报告并说明安装路线。

### macOS

Homebrew 已安装且获授权时：

```sh
brew install ffmpeg whisper.cpp
```

仅下载路线需要 `yt-dlp` 时另行安装：

```sh
brew install yt-dlp
```

Homebrew 的 `whisper.cpp` 包仍需另备模型。Apple Silicon 可以使用支持 Metal 的构建，Intel 或其他构建可用 CPU；不承诺特定加速方式、实时速度或内存需求。

### Linux

先核对发行版及包管理器。Debian/Ubuntu 在有安装授权和管理员权限时，可从系统仓库安装音频工具：

```sh
sudo apt-get install ffmpeg
```

检查实际包是否包含 `ffprobe`；其他发行版使用其官方仓库说明，不照搬 `apt-get`。`whisper.cpp` 可使用与架构匹配的可信发行包，或按下述源码构建路线。选择 CPU 构建不要求配置 CUDA；需要加速时只按实际硬件与官方后端说明准备额外依赖。

### Windows

从 [whisper.cpp 官方 Releases](https://github.com/ggml-org/whisper.cpp/releases) 选择匹配架构与后端的发行包，解压到获授权位置；音频工具采用 [FFmpeg 下载页](https://ffmpeg.org/download.html) 指向的 Windows 构建，确认同时包含 `ffmpeg.exe` 和 `ffprobe.exe`。FFmpeg 官网主要发布源码，不能把所有二进制分发站说成官方制作。

优先使用实际绝对路径，或仅在当前任务进程配置 PATH，不默认修改全局环境。PowerShell 调用带空格的可执行文件路径使用 `& $WHISPER_CLI`；不是 Unix 的 `./build/bin/whisper-cli`。若发行包不可用，可在具备 Git、CMake 和 Visual Studio C++ 构建工具的环境按源码路线构建。

### 源码构建备用路线

只有选择源码路线时才检查 Git、CMake 和适配的 C/C++ 编译器。CMake 要满足所选版本及内置 `ggml` 的要求，不能只看顶层配置；本次核对的内置 `ggml` 要求至少 3.14。获取 [官方源码](https://github.com/ggml-org/whisper.cpp) 的选定 release/tag，记录版本和提交；在获授权的独立工具目录内，进入源码根目录后运行：

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release
```

Unix 单配置构建通常位于 `build/bin/whisper-cli`，Windows 多配置构建通常位于 `build/bin/Release/whisper-cli.exe`。实际定位可执行文件再设置路径，不把“构建命令结束”当成 CLI 可用。Windows 编译时使用相应开发者环境；构建缺少依赖时报告具体原因，不擅自安装整套工具链。

### yt-dlp 的条件依赖

按照 [官方安装与依赖说明](https://github.com/yt-dlp/yt-dlp#installation) 选择平台发行二进制或包管理器。部分独立二进制自带 Python；选择 Python 安装路线时，先核对当前要求：截至本次文档核对，CPython 需要 3.10+，PyPy 需要 3.11+。不要假设系统 `python3` 满足要求。

Python 路线使用已确认的兼容解释器和独立虚拟环境，再安装 `yt-dlp`；不为这条可选路径更改系统默认 Python。YouTube 完整支持还可能需要官方文档中的 JavaScript 运行时等条件依赖，按当前平台检查，不把它们强加给所有 Bilibili 任务。

## 模型准备

按 [官方模型说明](https://github.com/ggml-org/whisper.cpp/blob/master/models/README.md) 取得与 CLI 兼容的 GGML 权重。该说明列出项目维护者托管的模型及校验值；记录模型名称、来源、实际文件路径和校验结果。

- 中文或混合语言使用多语言模型；名称带 `.en` 的模型仅适用于英语。不能照抄官方英语示例的默认 `base.en` 和默认英语参数。
- 优先复用兼容的已有模型。新配置可从多语言 `small` 开始评估，而非默认下载最大模型；当前官方表列 `small` 约 466 MiB，实际下载及内存成本以所选文件和构建为准。
- 从官方说明给出的来源下载到获授权模型目录，不把模型放进技能包或提交 Git。Unix 源码目录可用 `sh ./models/download-ggml-model.sh small`，Windows PowerShell 可用 `& ".\models\download-ggml-model.cmd" small`；其他安装路线从官方说明指向的模型文件页下载指定权重。这些脚本不会自动验哈希，而且可能跳过已存在的残缺文件。
- 按选定文件页或版本模型表的校验算法与预期值核对一致性，优先使用文件页的 SHA256：macOS 为 `shasum -a 256 "$WHISPER_MODEL"`，Linux 为 `sha256sum "$WHISPER_MODEL"`，PowerShell 为 `Get-FileHash -Algorithm SHA256 $WHISPER_MODEL`。不能把模型表中的 SHA1 值当作 SHA256；不匹配则停止使用并报告。文件存在不等于有效，`for-tests-` 空模型不能用于真实转写。
- 实际加载模型并输出转写后才记为可用。资源不足时局部验证更小的兼容模型或 CPU 路线；需要新的模型下载仍遵守授权，不偷偷转向云端。

## 音频获取与转换

先确认获取路径与权限。已有本地视频、用户提供音频或浏览器获授权的媒体资源均可作为候选；某一条下载路径失败不证明视频无音频。播放器缓冲的一个媒体分片不等于完整音轨。

使用 `yt-dlp` 时，先用当前版本的元数据查询确认目标视频与分集，再选择音频格式；限定单个目标，例如使用 `--no-playlist`，但仍回读实际身份，不假设这个参数在所有平台都能锁定分集。默认不下载整个合集，不读取或导出浏览器 Cookie、凭据和会话存储；遇到登录限制按主文件处理。

下列本地命令假定已将变量设为真实路径：`COURSE_AUDIO` 是本集原始媒体，`COURSE_WAV` 是任务输出目录中的新 WAV，`WHISPER_CLI` 是实际 CLI，`WHISPER_MODEL` 是已校验模型，`COURSE_LANGUAGE` 是已确认语言代码，`COURSE_TRANSCRIPT` 是未使用的输出前缀。路径含空格时保持引号；变量尚未确认时不能直接执行。

先取得结构化音轨与时长信息：

```sh
ffprobe -v error -show_entries format=duration:stream=index,codec_type,codec_name,sample_rate,channels -of json "$COURSE_AUDIO"
```

确认第一条音轨是目标语音后，转换为兼容的 16 kHz、单声道、16-bit PCM WAV；多音轨时将 `-map 0:a:0` 改为实际确认的目标音轨：

```sh
ffmpeg -n -i "$COURSE_AUDIO" -map 0:a:0 -vn -ar 16000 -ac 1 -c:a pcm_s16le "$COURSE_WAV"
```

`-n` 保留已有文件。转换后用 `ffprobe` 重新核对格式和时长；常见编码尾差需记录，明显缺失不能当成完整视频音轨。默认不裁掉静音、加速或拼接，避免丢失原时间对应；确需片段处理时记录偏移，按 [证据记录与自动审核](evidence-audit.md) 换算锚点。

## 本地转写与产物验收

根据当前 CLI 的帮助确认参数。中文音频设 `COURSE_LANGUAGE=zh`，其他音频使用已确认的语言或明确选择 `auto`；不要为转写默认加英语翻译参数 `-tr`。

Unix shell 示例：

```sh
"$WHISPER_CLI" -m "$WHISPER_MODEL" -f "$COURSE_WAV" -l "$COURSE_LANGUAGE" -osrt -oj -of "$COURSE_TRANSCRIPT"
```

Windows PowerShell 使用普通 PowerShell 变量，而非 `$env:` 或 Unix shell 赋值语法；参数相同：

```powershell
& $WHISPER_CLI -m $WHISPER_MODEL -f $COURSE_WAV -l $COURSE_LANGUAGE -osrt -oj -of $COURSE_TRANSCRIPT
```

如需执行前述 `ffprobe` 和 `ffmpeg` 命令，PowerShell 也使用其对应变量和实际命令路径。CLI 输出前缀应位于已存在的本集输出目录，执行前确认对应 `.srt` 和 `.json` 不会覆盖已有材料；产物已存在时先判断能否复用，不能把旧产物当成刚成功的新产物。

运行后检查：

1. 确认实际模型加载、识别过程和退出信息；GPU 后端不适配时，先检查该版本支持的 CPU 参数，例如 `-ng`，不临时安装未知驱动。
2. 读取本次 SRT/JSON，确认非空、含可解析的文本和起止时间。JSON 按当前版本结构化解析；核对时间字段单位，不把毫秒当秒。
3. 核对来源身份、音轨时长、首尾及明显空缺，局部产物加回原视频偏移。
4. 将字幕骨架送回主文件的重要性复核与自动审核流程。ASR 成功或存在时间戳不等于课程结论正确，静音处的幻觉也不能直接引用。

若仍无可用产物，记录当前环境、实际工具/模型版本、尝试路径和具体失败，保留已确认的证据。不要通过通用知识补写内容。

## 官方依据与验证范围

工具信息核对于 2026-10-05；安装时仍须对照所选版本帮助和官方发布页。这里只记录配置依据，不声称本次已安装、转写或验证所有操作系统。

- [whisper.cpp 平台、构建与音频说明](https://github.com/ggml-org/whisper.cpp)
- [CLI 参数与输出实现](https://github.com/ggml-org/whisper.cpp/blob/master/examples/cli/cli.cpp)
- [模型语言、来源、大小与校验](https://github.com/ggml-org/whisper.cpp/blob/master/models/README.md)
- [多语言 small 模型文件及 SHA256](https://huggingface.co/ggerganov/whisper.cpp/blob/main/ggml-small.bin)
- [内置 ggml 的构建要求](https://github.com/ggml-org/whisper.cpp/blob/master/ggml/CMakeLists.txt)
- [Homebrew whisper.cpp 包与模型说明](https://formulae.brew.sh/formula/whisper.cpp)
- [yt-dlp 安装及条件依赖](https://github.com/yt-dlp/yt-dlp#dependencies)
- [FFmpeg 获取方式](https://ffmpeg.org/download.html) 与 [ffprobe 结构化输出](https://ffmpeg.org/ffprobe.html)
