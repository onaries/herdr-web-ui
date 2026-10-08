# herdr web ui

<p align="center">
  <img src="public/icons/icon-192.png" alt="herdr web ui" width="100">
</p>

<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a>
</p>

<p align="center">
  <a href="https://herdrweb.dev/">官网</a> ·
  <a href="#install">安装</a> ·
  <a href="https://herdrweb.dev/demo/">体验演示</a> ·
  <a href="docs/guide.md#quick-start">快速入门</a> ·
  <a href="#faq">常见问题</a> ·
  <a href="#docs">文档</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-666666?labelColor=333333" alt="MIT 许可证"></a>
  <a href="https://github.com/devswha/herdr-web-ui/stargazers"><img src="https://img.shields.io/github/stars/devswha/herdr-web-ui?labelColor=333333&color=666666&logo=github" alt="GitHub 星标数"></a>
  <a href="https://github.com/devswha/herdr-web-ui/releases/latest"><img src="https://img.shields.io/github/v/release/devswha/herdr-web-ui?label=release&labelColor=333333&color=666666" alt="最新版本"></a>
  <a href="https://github.com/herdrdev/herdr"><img src="https://img.shields.io/badge/herdr-0.9.0%2B-666666?labelColor=333333" alt="herdr 0.9.0+"></a>
  <a href="docs/guide.md#on-your-phone"><img src="https://img.shields.io/badge/PWA-installable-666666?labelColor=333333" alt="可安装的 PWA"></a>
</p>

---

https://github.com/user-attachments/assets/db788c07-cd68-486d-8ce9-e676a2889c2d

<p align="center"><sub>Claude Code 在 herdr 终端中提问，浏览器和手机上显示同一个问题，在手机上点一下即可回答 · 实机录制，无剪辑</sub></p>

**在手机上使用 Claude Code 和 Codex。**

[herdr](https://github.com/herdrdev/herdr) 的浏览器与手机客户端。无论在电脑还是手机上，都能以聊天方式阅读并回复你电脑上正在运行的同一批智能体会话，需要时可切换到终端。

<table>
  <tr>
    <td width="50%" valign="top">
      <a href="https://github.com/user-attachments/assets/33ed2183-9b94-4677-8980-edd90d45750a"><img src="docs/media/readme/terminal.webp" width="100%" alt="实机录制。浏览器的聊天里是 Claude Code 的回复；点击 Terminal 后，同一个窗格显示为 Claude Code 自己的终端，可以看到它在 src/server.test.ts 中添加测试“unknown refund is 404”的修改。在手机上 tests 标签页的终端里，按键栏的 ↑ 调出 bun test，输入行的 Enter 按钮运行它：5 pass，0 fail。"></a>
      <br><b>切换到实时终端</b>
      <br><sub>点一下，聊天就变成该窗格真正的终端；在手机上，按键栏的 ↑ 调出测试命令，再按 Enter 重新运行。</sub>
    </td>
    <td width="50%" valign="top">
      <a href="https://github.com/user-attachments/assets/ac8dbf34-5c27-441b-8e49-e3850eac0c27"><img src="docs/media/readme/layout.webp" width="100%" alt="实机录制。浏览器显示 herdr 的布局：侧边栏中的四个工作区及其智能体状态（checkout-api DONE、web-dashboard RUN、infra READY、release），以及 checkout-api 的标签页 payments 和 dev。点击 dev 标签页显示它的第一个窗格，bun test 结果为 4 pass；该标签页的窗格菜单列出分屏的两个窗格 tests 和 git，点击 git 显示其 git log。在手机上，☰ 打开同样的四个工作区和相同的状态，轻点 checkout-api 打开 Claude 的聊天：“What does this repo do? Answer in one line.”及其回答。"></a>
      <br><b>浏览器里的 herdr 布局</b>
      <br><sub>工作区、标签页、分屏窗格，以及每个智能体的状态都在：点一下标签页，选择分屏中的窗格，在手机上切换工作区。</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <a href="https://github.com/user-attachments/assets/804ed0e1-54e6-4c1a-9d87-bd769a970315"><img src="docs/media/readme/alerts.webp" width="100%" alt="实机录制。浏览器中 Claude 正在处理 checkout-api，手机停在另一个工作区的终端上。Claude 提问要用哪种限流时，手机上弹出“checkout-api Needs input”提醒，点一下即以卡片打开问题；浏览器的 Needs you 下也列出 checkout-api 和同一张卡片。"></a>
      <br><b>智能体需要你时，立刻知道</b>
      <br><sub>即使在看别的工作区，Claude 一提问就会弹出提醒，点一下即可打开它的问题。</sub>
    </td>
    <td width="50%" valign="top">
      <a href="https://github.com/user-attachments/assets/25e55478-354b-4c5d-a33a-c1158f4b819a"><img src="docs/media/readme/attach.webp" width="100%" alt="实机录制。在手机上用回形针附加一张显示 $NaN 的收据截图并插入其路径，然后发送“Fix this, with a test.”；电脑的聊天中出现带图片的同一条消息，Claude 从读取 src/routes/receipt.ts 开始。"></a>
      <br><b>从手机发送截图</b>
      <br><sub>回形针把它上传到窗格的文件夹并插入路径，Claude 会读取这张图。</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <a href="https://github.com/user-attachments/assets/b410d41c-a822-47fe-94a5-88becab9b235"><img src="docs/media/readme/open.webp" width="100%" alt="实机录制。在浏览器的终端里，Claude Code 已写出 bench/p95.svg；点击该路径会在文件查看器中打开图表，在手机聊天中轻点同一路径则全屏打开。"></a>
      <br><b>打开智能体生成的文件</b>
      <br><sub>在终端里点击路径，或在聊天里轻点路径，文件就地打开。</sub>
    </td>
    <td width="50%" valign="top">
      <a href="https://github.com/user-attachments/assets/3a50f082-d13a-4a88-b2a4-7bc050e8a47a"><img src="docs/media/readme/worktree.webp" width="100%" alt="实机录制。在手机上点 checkout-api 行的 ⋯ 菜单 → New worktree，表单中已填好分支 worktree/clear-forest-3580；选择 Claude Code 作为智能体并点 Create worktree 后，浏览器中 checkout-api 下出现一个新行，变为 Claude Code 并显示 READY。"></a>
      <br><b>分出第二个智能体</b>
      <br><sub>在手机上点 ⋯ → New worktree：分支已自动填好，选一个智能体，它就在第一个旁边启动。</sub>
    </td>
  </tr>
</table>

<p align="center"><sub>每段片段都是同时录制电脑和手机的真实操作，实时、无剪辑。点击可播放完整视频。</sub></p>

- **聊天与终端，共用一个窗格** — 阅读 Claude Code、Codex、omp、omo、gjc 和 pi 的原生会话记录，以及 herdr 识别出的 OpenCode 2 会话，一键切换到实时终端。智能体工作时可以先写好下一条消息，它会在下一轮发出，也可以用 Send now 立即发送。[支持的智能体 →](docs/guide.md#supported-agents)
- **轻点即可批准** — 审批请求、问题和计划菜单会显示为卡片，发送回答前会先确认提示仍然有效。
- **需要你时及时提醒** — 实时显示每个窗格的状态；应用打开时提醒会从顶部滑下；智能体需要输入或完成任务时发送推送通知，即使应用已关闭也能收到。
- **安装到手机** — PWA 在键盘上方提供按键栏（Esc、Tab、Ctrl、Alt、Shift、Enter 和方向键），可在 Settings（设置）中调整顺序或添加自定义组合键；Tailscale 地址以二维码显示。[手机设置 →](docs/guide.md#on-your-phone)
- **开口代替打字** — 在聊天或终端输入行中语音输入，韩语和英语混说也能识别；文字只放进输入框，由你决定何时发送。使用你自己的 OpenAI API 密钥，或浏览器自带的语音识别。
- **沿用现有工作流** — 智能体由 herdr 管理，本应用负责连接；在 Settings（设置）中更新应用，无需停止智能体，每次更新带来的变化以更新说明列出。新标签页和 worktree 可从行的 ⋯ 菜单创建。[全部功能 →](docs/guide.md#features)

---

<a id="install"></a>

## 安装

```bash
curl -fsSL https://herdrweb.dev/install.sh | sh
```

支持 Linux（x64、arm64）或 macOS。安装程序会为当前用户补齐 herdr 0.9.0+、Bun 1.4+ 和 Node 18+ 依赖，然后将应用安装为 herdr 插件。如果已安装的 herdr 低于 0.9.0，请先自行更新并重启 herdr，再重新运行安装程序。使用默认监听地址且 Tailscale 正在运行时，HTTPS 配置成功后会提供 tailnet 内的访问地址和二维码。你自己的设备本来就能免验证码进入：`tailscale serve` 会告知你的登录名。如果你的手机仍被要求配对，设置 `HERDR_WEB_TAILSCALE_SERVE_ONLY=1` 后，在只有一个登录名的 tailnet 上也能免验证码进入；但仅限于没有公共代理或隧道等其他途径能访问此端口的情况（[访问与安全](docs/guide.md#access-and-safety)）。

<p align="center">
Windows x64 请在 PowerShell 中运行：

```powershell
irm https://herdrweb.dev/install.ps1 | iex
```

需要 [Git for Windows](https://git-scm.com/download/win)。安装程序会为当前用户补齐 herdr 和 Bun，然后安装同一个插件，无需 Node 或 WSL。要在手机上使用，请在 herdr 中打开 **Phone setup**。在 herdr 支持 Windows 终端附加之前，Windows 上的终端是一个可以输入、网格固定的[屏幕镜像](docs/remote-pcs.md#windows-pcs)。

<p align="center">
  <img src="docs/screenshots/install.png" width="720" alt="安装程序输出：安装 Bun、Node 和 herdr 插件，然后通过 tailscale serve 提供应用访问地址，并显示供手机扫描的二维码。">
</p>

已经安装了所需依赖？只需安装插件：

```bash
herdr plugin install devswha/herdr-web-ui
```

在 herdr 运行时，打开 **[localhost:7317](http://localhost:7317)**。选择一个窗格，或点击 **New workspace（新建工作区）** 启动智能体。要在手机上使用，请扫描安装程序提供的二维码，并将应用添加到主屏幕。[快速入门 →](docs/guide.md#quick-start)

服务器默认监听 `127.0.0.1`。如需从其他设备访问，请参阅[手机设置](docs/guide.md#on-your-phone)和[访问与安全](docs/guide.md#access-and-safety)。

<a id="faq"></a>

## 常见问题

**可以在手机上使用 Claude Code 或 Codex 吗？**

可以。在电脑上的 [herdr](https://github.com/herdrdev/herdr) 窗格里运行智能体，本应用就会在手机浏览器中显示同一个窗格：智能体自己的会话记录显示为聊天，审批和提问显示为可点按回答的卡片，随时可以切换到实时终端。它可以作为 PWA 安装到主屏幕，并在智能体需要你时发送推送提醒。[手机设置 →](docs/guide.md#on-your-phone)

**聊天视图支持哪些智能体？**

Claude Code、Codex、omp、omo、gjc 和 pi 直接从各自的会话文件读取。OpenCode 2 会从 OpenCode 自己的数据库读取 herdr 报告的会话；处于主屏幕或使用 1.x 数据库时则显示实时终端。其他程序显示实时终端和状态。[支持的智能体 →](docs/guide.md#supported-agents)

**它会取代 herdr 自带的 TUI 吗？**

不会。两者同时连接到同一批终端，所以窗格在桌面、浏览器和手机上都保持实时。不需要停止或交接任何东西。 [TUI 与浏览器 →](docs/guide.md#faq)

**必须使用 Tailscale 吗？**

不必。Tailscale、SSH 隧道、VPN 或自行配置的 HTTPS 代理都可以提供访问电脑的通路。安装应用和推送提醒需要 HTTPS 或 localhost 等安全上下文；基本浏览也可以使用局域网中的普通 HTTP 地址。[其他方式 →](docs/guide.md#faq)

**我的代码或对话会离开我的电脑吗？**

会话文件保留在运行各个智能体的电脑上，内容会发送到你连接的浏览器。本应用没有自有的云端中继或账号服务。可选的语音输入会把录音发送给配置的服务商；启用文字整理时也会发送文本。启用用量显示后，会连接服务商的 API。更新、远程电脑设置和推送提醒也可能连接外部服务。智能体自身如何连接模型，取决于它的配置。[数据传输与访问 →](docs/guide.md#faq)

**支持 Windows 吗？**

支持，在 Windows x64 上无需 WSL。在 herdr 支持 Windows 终端附加之前，终端是一个可以输入、网格固定的[屏幕镜像](docs/remote-pcs.md#windows-pcs)。

**它与 collie、roamgate、herdr-remote 有什么不同？**

这些项目也提供 herdr 的手机或浏览器客户端。本应用直接读取智能体自己的会话记录，所以窗格显示的是按轮次折叠工作过程的聊天，而不是终端输出；其他电脑可以从侧边栏通过 SSH 加入。它不自带隧道，也只支持 herdr：如果你需要 tmux 或 zellij、差异查看、Telegram 或开箱即用的隧道，其他几个更合适。[完整对比 →](docs/guide.md#faq)

**它与 Happy、Paseo、CloudCLI UI 有什么不同？**

这些项目有各自启动或管理智能体会话的方式。本应用使用你已经运行的 herdr 窗格，让 TUI 和浏览器继续访问同一个终端。如果你不使用 herdr，可以比较这些项目的部署方式和智能体支持情况。[完整对比 →](docs/guide.md#faq)

<a id="docs"></a>

## 文档

从[用户指南](docs/guide.md)开始：[快速入门](docs/guide.md#quick-start) · [支持的智能体](docs/guide.md#supported-agents) · [功能](docs/guide.md#features) · [手机](docs/guide.md#on-your-phone) · [远程电脑](docs/remote-pcs.md) · [访问与安全](docs/guide.md#access-and-safety) · [配置](docs/guide.md#configuration) · [键盘快捷键](docs/guide.md#keyboard-shortcuts) · [常见问题](docs/guide.md#faq)。

深入了解：[工作原理](docs/guide.md#how-it-works) · [聊天记录](docs/chat-mode-audit.md) · [终端流量控制](docs/terminal-flow-control.md) · [应用更新](docs/app-updates.md) · [更新日志](CHANGELOG.md)。

## 致谢

本项目基于 [herdr](https://github.com/herdrdev/herdr) 构建，灵感来自 [chatmux](https://github.com/devswha/chatmux)，并使用了 [xterm.js](https://xtermjs.org)、[React](https://react.dev)、[Bun](https://bun.sh) 和 [Lucide](https://lucide.dev)。

感谢所有贡献者，包括 [@Yoonwoo-Ha](https://github.com/Yoonwoo-Ha)。

## 智能体操作指南

正在协助他人安装应用？请遵循 [INSTALL.md](INSTALL.md)。修改仓库时，请遵循 [CONTRIBUTING.md](CONTRIBUTING.md)、[审查规则](.github/REVIEW.md)和 [AGENTS.md](AGENTS.md)。

## 开发

```bash
git clone https://github.com/devswha/herdr-web-ui.git
cd herdr-web-ui
bun install

bun run server      # API + WebSocket on :7317
bun run dev         # Vite on :5173; run in a second terminal
```

```bash
bun run typecheck
bun run test:unit   # no herdr needed
bun test           # isolated herdr test session
bun run test:ui    # browser regression checks
```

提交改动请参阅 [CONTRIBUTING.md](CONTRIBUTING.md)，测试、媒体素材和发布流程请参阅[开发文档](docs/development.md)，界面规范请参阅 [DESIGN.md](DESIGN.md)。安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。

## 许可证

[MIT](LICENSE)。Copyright © 2026 devswha.
