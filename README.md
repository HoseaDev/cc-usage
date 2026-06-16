# Claude Code Usage

在 VS Code 状态栏显示 **当前活动终端里 `claude` 会话所用账号** 的用量。

支持多账号:终端 A 跑的是 account1 的 claude,状态栏就显示 account1 的用量;切到跑
account2 的终端,就显示 account2。账号通过 `CLAUDE_CONFIG_DIR` 环境变量区分。

## 工作原理

1. 取 VS Code 当前活动终端的 shell 进程。
2. 遍历该 shell 的子孙进程树,找到正在运行的 `claude`。
3. 读取该进程的 `CLAUDE_CONFIG_DIR`(读不到则视为默认 `~/.claude`)。
4. 以该账号运行 `claude /usage`,把结果显示在状态栏(按账号缓存,避免频繁调用)。

状态栏示例:`🤖 account1: 7% ↺5h`(已用 7%,距重置约 5 小时)。
当前终端没有运行 claude 时显示 `🤖 Claude: 无会话`,不会猜测账号。

## 使用

- 鼠标悬停状态栏:查看完整 `/usage` 输出。
- 点击状态栏 / 命令面板 `Claude Code: Show Usage Detail`:在输出面板查看详情。
- 命令面板 `Claude Code: Refresh Usage`:手动刷新。

## 配置

| 设置 | 默认 | 说明 |
|------|------|------|
| `cc-usage.refreshInterval` | `30` | 刷新间隔(秒),同时是每个账号 `/usage` 结果的缓存有效期。 |

## 前提

- 已安装 Claude Code CLI(`claude` 在 PATH 中,或位于 nvm / homebrew 常见路径)。
- 多账号需通过 `CLAUDE_CONFIG_DIR` 环境变量区分;未设置时显示默认账号。

## 平台支持

| 平台 | 账号检测方式 | 状态 |
|------|--------------|------|
| macOS | `ps eww` 读进程环境 | 已验证 |
| Linux | 读 `/proc/<pid>/environ` | 应可用 |
| Windows | PowerShell 读进程环境块 | 尽力而为,建议真机验证 |

读不到进程账号时显示 `🤖 Claude: 账号未知`,不会猜测。

## 安装

```bash
code --install-extension cc-usage-0.2.0.vsix
```

或在 VS Code:扩展面板 → 右上 `...` → `Install from VSIX...`。
