# 离线物化协议 v1

`teamai materialize` 是面向编排器的确定性、离线 Skill 复制契约。它不会初始化 TeamAI、发现本地配置、刷新 Git 仓库、安装 Hook、修改 MCP 设置、读取凭据、访问网络服务，也不会直接写入任何 AI 工具目录。

更小的 `teamai-materialize` 可执行入口是规范的机器接口。发布的 `dist/materialize-bin.js` 是单个 ESM bundle：参数解析器、schema 校验器、TeamAI 许可证与内嵌依赖声明都已包含在文件内，运行时只导入 Node.js 内置模块，因此不需要 `node_modules`。主命令 `teamai materialize` 只是同一引擎的便捷包装，并保留 TeamAI 通用的帮助与参数解析行为。需要下述 JSON 诊断和退出码契约的编排器必须调用 `teamai-materialize`。

## 调用方式

```bash
teamai-materialize \
  --request /sandbox/request.json \
  --input-root /sandbox/input \
  --output-root /sandbox/output \
  --result /sandbox/result.json
```

四个路径都由调用方通过参数提供，请求 JSON 不能覆盖。request 和 input root 必须已经存在；output root 和 result file 必须不存在；四者不能相互包含或重叠。

调用方必须在私有文件系统沙箱中运行该进程，并保证没有并发的命名空间修改者。input tree 以及 output/result 的父目录不得包含攻击者可控的 nested mount、bind mount、FUSE mount 或 reparse mount；应把已验证的普通文件复制进沙箱，而不是挂载外部目录。物化模块本身不含网络或子进程代码，但应用层“不调用网络”不能替代操作系统沙箱。

协议 v1 的生产支持范围是具备 POSIX 文件系统语义的 macOS 与 Linux。路径会按 Windows 可移植性规则校验，但 Windows ACL 与 mode 的映射、目录持久化语义尚未完成专项验证；在取得该平台的一致性证据前，生产编排器必须在 Windows 上 fail closed。

## 请求

```json
{
  "schema": "teamai.materialize.request/v1",
  "operation": "copy-skills",
  "target": {
    "id": "codex",
    "layout": "flat-skill-root/v1"
  },
  "skills": [
    {
      "id": "systematic-debugging",
      "files": [
        {
          "path": "SKILL.md",
          "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          "size": 1234,
          "mode": "0644"
        },
        {
          "path": "find-polluter.sh",
          "sha256": "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
          "size": 4321,
          "mode": "0755"
        }
      ]
    }
  ]
}
```

输入隐式位于 `<input-root>/<skill-id>/<file-path>`，输出使用相同的扁平 Skill 根布局：`<output-root>/<skill-id>/<file-path>`。`target.id` 只是身份元数据；物化器不会决定 `.codex/skills`、`.agents/skills` 等真实项目路径。

请求采用严格契约：

- 拒绝未知字段、重复 JSON object key、不支持的 schema/operation/layout、重复条目和非规范排序；
- `target.id` 和每个 Skill `id` 必须是 1-64 个 ASCII 字符，并匹配 `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`；
- Skill 与文件必须按 UTF-8 字节序排列，并在大小写折叠和 Unicode NFC 规范化后仍可移植且无冲突；
- 每个 Skill 必须穷举整棵目录，并包含普通文件 `SKILL.md`；
- 路径只能使用 `/`；每个路径段最多 255 个 UTF-8 bytes，并拒绝绝对路径、空段、`.`/`..`、反斜杠、控制字符、Windows drive/UNC/alternate-stream 语法、保留名和尾随点/空格；
- 只接受普通目录和私有普通文件；拒绝符号链接、硬链接、类似 junction 的跳转、FIFO、socket 和 device；
- 文件模式只能是 `0644` 或 `0755`；复制过程保持字节完全一致，不补 frontmatter、不转换换行、不忽略文件、不解析也不执行 Skill 内容；
- 创建的所有 output 目录（包括 output root）模式均为 `0755`；
- `skills: []` 合法，但 input root 也必须为空，并产生经过验证的空 output root。

默认上限为 256 个 Skill、8,192 个文件、8,192 个目录、单文件 16 MiB、总内容 256 MiB、相对路径最多 1,024 个 UTF-8 bytes 和 32 个路径段；JSON request 上限为 4 MiB。

## 成功结果

成功时退出码为 `0`、stdout 为空，并以 `0600` 模式创建 result file：

```json
{
  "operation": "copy-skills",
  "outputSha256": "...",
  "requestSha256": "...",
  "resultSha256": "...",
  "schema": "teamai.materialize.result/v1",
  "skills": [],
  "status": "succeeded",
  "target": {
    "id": "codex",
    "layout": "flat-skill-root/v1"
  }
}
```

数组稳定排序；结果不包含时间戳、PID、用户名、HOME、环境变量值或绝对路径。`requestSha256` 是规范 request JSON 的哈希，`outputSha256` 是声明的 Skill/file manifest 哈希，`resultSha256` 是去掉自身字段后的规范成功结果哈希。

哈希原像使用紧凑 canonical JSON：object key 按 UTF-8 字节序排列，array 保持协议要求的规范顺序，整数采用 ECMAScript `JSON.stringify` 序列化，字符串采用 ECMAScript `JSON.stringify` 转义并编码为 UTF-8；不包含无意义空白或尾随换行。精确定义如下：

- `requestSha256 = SHA-256(canonical-json(request))`；
- `outputSha256 = SHA-256(canonical-json({"schema":"teamai.materialize.output/v1","skills":result.skills}))`；
- `resultSha256 = SHA-256(canonical-json(移除 resultSha256 后的成功结果))`。

所有摘要均为小写十六进制 SHA-256；result file 末尾的换行不属于任何哈希原像。

空 Skill 清单的规范测试向量如下：

```text
request 原像：{"operation":"copy-skills","schema":"teamai.materialize.request/v1","skills":[],"target":{"id":"codex","layout":"flat-skill-root/v1"}}
requestSha256：dada6529910cce5a440eab65b0c2ccb407825c8b3786101992d63cf37effffa3
output 原像：{"schema":"teamai.materialize.output/v1","skills":[]}
outputSha256：aa4288df4afde3f5c7d0826d6d66590db4d49ce35f0804ca5aa7e4795b577e6c
```

调用方在发布前仍必须独立重扫 output，逐项验证路径、字节哈希、大小和模式。TeamAI fork 的精确 commit 与 `dist/materialize-bin.js` 原始字节的 SHA-256 应在协议之外固定。如果把制品复制到 npm package 之外，调用方必须保留 ESM 分类（例如将字节完全相同的副本命名为 `.mjs`）。

## 失败行为

任一错误都会让整棵 output root 失效。可以保留部分 staging 用于排查，但不得复用或发布；TeamAI 不会静默回退其他 renderer。

当 result 路径已通过安全校验且可以创建时，会写入失败结果：

```json
{
  "error": {
    "code": "MATERIALIZE_INTEGRITY_MISMATCH",
    "message": "Input file hash does not match the request"
  },
  "schema": "teamai.materialize.result/v1",
  "status": "failed"
}
```

诊断信息只在 stderr 输出一行有界 JSON，不包含沙箱绝对路径。稳定退出类别如下：

| 退出码 | 含义 |
|---|---|
| `0` | 完整验证成功 |
| `1` | I/O 或未分类物化失败 |
| `2` | 请求、路径、排序或资源上限不合法 |
| `3` | 输入目录不合法或完整性不匹配 |
| `4` | output 或 result 已存在 |
| `70` | 独立 CLI 启动失败 |

如果参数解析失败、request/result 拓扑不安全或 result 已存在，result file 可能不会生成；非零进程退出始终是权威失败信号。

## 明确不做的事情

协议 v1 不渲染 Rules、Agents、Hooks、MCP、环境设置、Docs、sources、analytics 或 TeamAI 内置内容，不应用 role/tag，也不读取 `teamai.yaml`。这些能力继续属于交互式 `init`/`pull` 流程；未来如需纳入物化，必须新增经过评审的协议版本。
