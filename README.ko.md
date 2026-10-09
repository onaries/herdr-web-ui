# herdr web ui

<p align="center">
  <img src="public/icons/icon-192.png" alt="herdr web ui" width="100">
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a> · <strong>한국어</strong>
</p>

<p align="center">
  <a href="https://herdrweb.dev/">웹사이트</a> ·
  <a href="#install">설치</a> ·
  <a href="https://herdrweb.dev/demo/">데모 체험</a> ·
  <a href="docs/guide.md#quick-start">빠른 시작</a> ·
  <a href="#faq">자주 묻는 질문</a> ·
  <a href="#docs">문서</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-666666?labelColor=333333" alt="MIT license"></a>
  <a href="https://github.com/devswha/herdr-web-ui/stargazers"><img src="https://img.shields.io/github/stars/devswha/herdr-web-ui?labelColor=333333&color=666666&logo=github" alt="GitHub stars"></a>
  <a href="https://github.com/devswha/herdr-web-ui/releases/latest"><img src="https://img.shields.io/github/v/release/devswha/herdr-web-ui?label=release&labelColor=333333&color=666666" alt="Latest release"></a>
  <a href="https://github.com/herdrdev/herdr"><img src="https://img.shields.io/badge/herdr-0.9.0%2B-666666?labelColor=333333" alt="herdr 0.9.0+"></a>
  <a href="docs/guide.md#on-your-phone"><img src="https://img.shields.io/badge/PWA-installable-666666?labelColor=333333" alt="Installable PWA"></a>
</p>

---

https://github.com/user-attachments/assets/d854dbb6-64bd-4eba-81c7-fbd3f525726b

<p align="center"><sub>하나의 Claude Code 세션을 herdr 터미널에서 브라우저의 터미널과 채팅으로, 이어서 폰으로. 폰에서는 새 워크트리를 바로 옆에 띄웁니다 · 실제 화면 녹화, 컷 없음</sub></p>

**Claude Code와 Codex를 폰에서.**

[herdr](https://github.com/herdrdev/herdr)를 브라우저와 폰에서 쓰는 클라이언트입니다. 컴퓨터에서 돌아가는 에이전트 세션을 그대로, 데스크톱에서든 폰에서든 채팅으로 읽고 답합니다. 필요할 때는 터미널로 넘어갑니다.

<table>
  <tr>
    <td width="50%" valign="top">
      <a href="https://github.com/user-attachments/assets/32ca9aa4-960f-4629-9fb5-17c12ba35c80"><img src="docs/media/readme/terminal.webp" width="100%" alt="실제 화면 녹화. 브라우저의 Chat에 Claude Code의 답이 보이고, Terminal을 클릭하면 같은 pane이 Claude Code 자체의 터미널로 바뀌며 src/server.test.ts에 &quot;unknown refund is 404&quot; 테스트를 추가한 수정이 보입니다. 폰에서는 tests 탭의 터미널에서 키 바의 ↑로 bun test를 불러오고 키 바의 Enter로 실행합니다: 5 pass, 0 fail."></a>
      <br><b>라이브 터미널로 바꾸기</b>
      <br><sub>클릭 한 번이면 채팅이 그 pane의 실제 터미널로 바뀌고, 폰에서는 키 바의 ↑로 테스트 명령을 불러와 바로 옆 Enter로 다시 실행합니다.</sub>
    </td>
    <td width="50%" valign="top">
      <a href="https://github.com/user-attachments/assets/22d10639-9aa6-4953-a5f3-a1b743f4053b"><img src="docs/media/readme/layout.webp" width="100%" alt="실제 화면 녹화. 브라우저에 herdr의 레이아웃이 보입니다. 사이드바의 워크스페이스 네 개는 각 줄 끝에 에이전트 상태를 보여 주고(Claude가 일을 마친 checkout-api는 초록 점, Codex가 작업 중인 web-dashboard는 도는 호, infra와 release는 표시 없음), checkout-api에는 payments와 dev 탭이 있습니다. dev 탭을 클릭하면 첫 pane인 tests에 bun test의 4 pass가 보이고, 탭의 pane 메뉴에 분할된 두 pane인 tests와 git이 나오며, git을 클릭하면 git log가 보이고 checkout-api 줄에 git이 표시됩니다. 폰에서 ☰를 누르면 같은 상태의 같은 워크스페이스 네 개가 열리고, checkout-api를 탭하면 Claude의 채팅이 열립니다: &quot;What does this repo do? Answer in one line.&quot;와 그 답."></a>
      <br><b>브라우저 속 herdr 레이아웃</b>
      <br><sub>워크스페이스, 탭, 분할 pane과 에이전트마다의 상태가 그대로: 탭을 클릭하고, 분할의 pane을 고르고, 폰에서는 워크스페이스를 바꿉니다.</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <a href="https://github.com/user-attachments/assets/b228a2b8-6db5-4546-a15b-972056000cab"><img src="docs/media/readme/alerts.webp" width="100%" alt="실제 화면 녹화. 브라우저에서 Claude가 checkout-api 작업을 하는 동안 폰은 다른 워크스페이스의 터미널을 보고 있습니다. Claude가 어떤 요청 제한을 쓸지 묻자 폰에 &quot;checkout-api Needs input&quot; 알림이 내려오고, 탭하면 질문이 카드로 열립니다. 브라우저에서는 checkout-api 줄과 Agents 아래 그 줄에 빨간 물음표가 표시되고, 같은 카드가 채팅에서 기다립니다."></a>
      <br><b>에이전트가 부르면 바로 알기</b>
      <br><sub>다른 워크스페이스를 보고 있어도 Claude가 물으면 알림이 내려오고, 한 번 탭하면 질문이 열립니다.</sub>
    </td>
    <td width="50%" valign="top">
      <a href="https://github.com/user-attachments/assets/a193b426-259c-47d9-bd73-10acc2594265"><img src="docs/media/readme/attach.webp" width="100%" alt="실제 화면 녹화. 폰에서 checkout-api의 빈 채팅이 &quot;What should Claude do in checkout-api?&quot;라고 묻습니다. + 버튼으로 합계가 $NaN으로 보이는 영수증 스크린샷을 첨부하면 경로가 들어가고, &quot;Fix this, with a test.&quot;를 입력해 보냅니다. 스크린샷이 담긴 메시지가 폰과 데스크톱 채팅에 나타나는 동안 카메라가 뒤로 빠졌다가 데스크톱 채팅으로 다가갑니다. 전체 영상에서는 이어서 Claude가 src/routes/receipt.ts와 src/server.ts를 읽는 첫 명령을 실행합니다."></a>
      <br><b>폰에서 스크린샷 보내기</b>
      <br><sub>+ 버튼으로 pane 폴더에 올리고 경로를 넣어 줍니다. Claude가 이미지를 읽습니다.</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <a href="https://github.com/user-attachments/assets/bc419d3e-ebda-4fb5-acc5-e498609559fe"><img src="docs/media/readme/open.webp" width="100%" alt="실제 화면 녹화. 브라우저의 터미널에서 Claude Code가 bench/p95.svg를 작성했습니다. 답에 있는 경로를 클릭하면 파일 뷰어에 차트가 열리고, 폰 채팅의 같은 경로를 탭하면 전체 화면으로 열립니다."></a>
      <br><b>에이전트가 만든 결과물 열기</b>
      <br><sub>터미널의 경로를 클릭하거나 채팅의 경로를 탭하면 그 자리에서 파일이 열립니다.</sub>
    </td>
    <td width="50%" valign="top">
      <a href="https://github.com/user-attachments/assets/150a4c9d-7667-4f63-ba56-8f91e6a25878"><img src="docs/media/readme/worktree.webp" width="100%" alt="실제 화면 녹화. 폰에서 checkout-api의 ⋯ 메뉴 → New worktree를 누르면 브랜치 worktree/clear-field-23e0이 미리 채워진 양식이 열리고, Claude Code를 고른 뒤 Create worktree를 탭합니다. 카메라가 브라우저로 옮겨 가면 checkout-api 폴더가 열려 있고 그 아래에 새 체크아웃이 Claude로 표시되어 붙어 있습니다. 이어서 그 줄은 worktree-clear-field-23e0 위에 Claude Code로 표시되고, Agents 목록에는 네 번째 에이전트로 추가됩니다."></a>
      <br><b>두 번째 에이전트로 갈라지기</b>
      <br><sub>폰에서 ⋯ → New worktree: 브랜치는 미리 채워져 있고, 에이전트를 고르면 첫 번째 옆에서 시작합니다.</sub>
    </td>
  </tr>
</table>

<p align="center"><sub>모든 클립은 데스크톱과 폰을 동시에 녹화한 실제 동작이며, 실제 속도로 컷 없이 담았습니다. 누르면 전체 영상을 볼 수 있습니다.</sub></p>

- **채팅과 터미널을 pane 하나에** — Claude Code, Codex, omp, omo, gjc, pi의 대화 기록과 herdr가 식별한 OpenCode 2와 Devin CLI 세션을 보여 주고, 클릭 한 번이면 라이브 터미널로 넘어갑니다. 에이전트가 일하는 동안 다음 메시지를 써 두면 다음 턴에 들어가고, Send now로 바로 보낼 수도 있습니다. [지원 에이전트 →](docs/guide.md#supported-agents)
- **탭 한 번으로 승인** — 승인 요청, 질문, 계획 메뉴가 카드로 뜹니다. 답을 보내기 전에 그 질문이 아직 유효한지 확인합니다.
- **내가 필요할 때 알림** — 모든 pane의 상태를 실시간으로 보여 주고, 앱을 보고 있을 때는 알림이 위에서 내려오며, 에이전트가 입력을 기다리거나 일을 끝내면 앱이 닫혀 있어도 푸시 알림을 보냅니다.
- **폰에 설치해서 쓰기** — 키보드 위에 키 바(Esc, Tab, Ctrl, Alt, Shift, Enter, 방향키)가 붙은 PWA입니다. 키 순서를 바꾸거나 나만의 키 조합을 Settings(설정)에서 추가할 수 있습니다. Tailscale 주소는 QR 코드로 받아 갑니다. [폰 설정 →](docs/guide.md#on-your-phone)
- **말로 입력하기** — 채팅이나 터미널 입력 줄에 받아쓰기로 입력합니다. 한국어와 영어를 섞어 말해도 됩니다. 에이전트에게 보내기 전에 글자를 확인할 수 있고, 받아쓰기는 내 OpenAI 키나 브라우저의 음성 인식을 씁니다.
- **작업 방식은 그대로** — 에이전트는 herdr가 관리하고, 이 앱은 거기에 연결만 합니다. 에이전트를 멈추지 않고 Settings(설정)에서 업데이트하며, 업데이트마다 무엇이 바뀌는지 패치 노트로 보여 줍니다. 새 탭과 worktree는 행의 ⋯ 메뉴에서 만듭니다. [전체 기능 →](docs/guide.md#features)

---

<a id="install"></a>

## 설치

```bash
curl -fsSL https://herdrweb.dev/install.sh | sh
```

Linux(x64, arm64)와 macOS를 지원합니다. herdr 0.9.0 이상, Bun 1.4 이상, Node 18 이상 중 없는 것을 현재 사용자 계정에 설치한 뒤, 앱을 herdr 플러그인으로 설치합니다. 이미 설치된 herdr가 0.9.0보다 오래됐다면 herdr를 직접 업데이트하고 다시 시작한 다음 설치 스크립트를 다시 실행하세요. 기본 수신 주소를 쓰고 Tailscale이 켜져 있으면, HTTPS 설정이 끝났을 때 tailnet 주소와 QR 코드가 나옵니다. 자신의 기기는 원래 코드 없이 들어갑니다. `tailscale serve`가 로그인을 알려 주기 때문입니다. 그래도 자신의 폰이 페어링을 요구받는다면 `HERDR_WEB_TAILSCALE_SERVE_ONLY=1`을 설정하면 로그인이 하나뿐인 tailnet에서는 코드 없이 들어갈 수 있습니다. 단, 공용 프록시나 터널 등 다른 경로로 이 포트에 접근할 수 있다면 설정하지 마세요 ([접근과 안전](docs/guide.md#access-and-safety)).

<p align="center">
PowerShell에서 Windows x64용으로 설치하려면:

```powershell
irm https://herdrweb.dev/install.ps1 | iex
```

[Git for Windows](https://git-scm.com/download/win)가 필요합니다. 없는 herdr와 Bun을 현재 사용자 계정에 설치한 뒤 같은 플러그인을 설치합니다. Node나 WSL은 필요 없습니다. 폰에서 쓰려면 herdr에서 **Phone setup**을 여세요. herdr가 Windows에서 터미널 attach를 지원하기 전까지 Windows 터미널은 입력은 되고 격자 크기는 고정된 [화면 미러](docs/remote-pcs.md#windows-pcs)로 보입니다.

<p align="center">
  <img src="docs/screenshots/install.png" width="720" alt="설치 스크립트 출력: Bun, Node, herdr 플러그인이 설치되고 tailscale serve가 앱을 공개한 뒤 폰용 QR 코드가 나옵니다.">
</p>

필요한 도구가 이미 있다면 플러그인만 설치해도 됩니다.

```bash
herdr plugin install devswha/herdr-web-ui
```

herdr가 실행 중인 상태에서 **[localhost:7317](http://localhost:7317)**을 여세요. pane을 고르거나 **New workspace**로 에이전트를 시작합니다. 폰에서 쓰려면 설치 스크립트가 보여 준 QR 코드를 찍고 앱을 홈 화면에 추가하세요. [빠른 시작 →](docs/guide.md#quick-start)

서버는 기본적으로 `127.0.0.1`에서만 받습니다. 다른 기기에서 접속하려면 [폰 설정](docs/guide.md#on-your-phone)과 [접근과 보안](docs/guide.md#access-and-safety)을 보세요.

<a id="faq"></a>

## 자주 묻는 질문

**Claude Code나 Codex를 폰에서 쓸 수 있나요?**

네. 컴퓨터의 [herdr](https://github.com/herdrdev/herdr) pane에서 에이전트를 실행하면, 이 앱이 같은 pane을 폰 브라우저에 보여 줍니다. 에이전트의 기록은 채팅으로, 승인과 질문은 탭해서 답하는 카드로 나오고, 라이브 터미널로도 바로 넘어갈 수 있습니다. PWA로 홈 화면에 설치되며, 에이전트가 사용자를 기다리면 푸시 알림을 보냅니다. [폰 설정 →](docs/guide.md#on-your-phone)

**채팅 화면은 어떤 에이전트를 지원하나요?**

Claude Code, Codex, omp, omo, gjc, pi는 각자의 세션 파일에서 읽습니다. OpenCode 2는 herdr가 보고한 세션을 OpenCode 데이터베이스에서 읽으며, 홈 화면이나 1.x 저장소에서는 라이브 터미널을 표시합니다. Devin CLI는 `devin --resume <id>`처럼 herdr나 실행 중인 프로세스가 세션을 알려 줄 때 채팅으로 보이고, 그냥 `devin`으로 띄우면 라이브 터미널로 보입니다. 그 밖의 프로그램은 라이브 터미널과 상태로 보입니다. [지원 에이전트 →](docs/guide.md#supported-agents)

**herdr의 TUI를 대체하나요?**

아니요. 둘 다 같은 터미널에 동시에 붙으므로, pane은 책상에서도 브라우저에서도 폰에서도 그대로 살아 있습니다. 멈추거나 넘겨줄 것이 없습니다. [TUI와 브라우저 →](docs/guide.md#faq)

**Tailscale이 꼭 필요한가요?**

아니요. Tailscale, SSH 터널, VPN이나 직접 설정한 HTTPS 프록시로 PC에 접속할 수 있습니다. 앱 설치와 푸시 알림에는 HTTPS나 localhost 같은 보안 컨텍스트가 필요하며, 기본 화면은 LAN의 일반 HTTP 주소로도 열 수 있습니다. [다른 방법 →](docs/guide.md#faq)

**코드나 대화가 내 컴퓨터 밖으로 나가나요?**

세션 파일은 각 에이전트가 실행되는 PC에 남고, 내용은 연결한 브라우저로 전송됩니다. 이 앱 자체의 클라우드 중계나 계정 서비스는 없습니다. 선택 기능인 음성 입력은 녹음을, 텍스트 다듬기를 쓰면 텍스트도 설정된 제공업체로 보내며, 사용량 표시를 켜면 제공업체 API에 접속합니다. 업데이트, 원격 PC 설정, 푸시 알림도 외부 서비스에 접속할 수 있습니다. 앱은 설치될 때와 업데이트될 때마다 익명 카운트를 보냅니다(버전, OS, 설치 방식, 무작위 ID이며 IP 주소는 저장하지 않습니다). **Settings → About → Anonymous usage counts**에서 보내는 내용을 보고 끌 수 있습니다. 에이전트 자체의 모델 연결은 해당 에이전트 설정에 따릅니다. [데이터 전송과 접근 →](docs/guide.md#faq)

**Windows에서도 되나요?**

네. Windows x64에서 WSL 없이 됩니다. herdr가 Windows에서 터미널 attach를 지원하기 전까지 터미널은 입력이 되는 고정 격자의 [화면 미러](docs/remote-pcs.md#windows-pcs)입니다.

**collie, roamgate, herdr-remote와 무엇이 다른가요?**

이들도 herdr를 폰이나 브라우저에서 쓰는 클라이언트입니다. 이 앱은 에이전트의 기록을 직접 읽어서, pane이 터미널 출력이 아니라 작업이 턴마다 접힌 채팅으로 보이고, 다른 PC는 사이드바에서 SSH로 붙습니다. 터널은 제공하지 않고 herdr만 다룹니다. tmux나 zellij, diff, Telegram, 바로 쓰는 터널이 필요하면 다른 쪽이 더 맞습니다. [전체 비교 →](docs/guide.md#faq)

**Happy, Paseo, CloudCLI UI와 무엇이 다른가요?**

그 프로젝트들은 에이전트 세션을 시작하거나 관리하는 자체 방식을 제공합니다. 이 앱은 이미 실행 중인 herdr pane을 보여 주므로 TUI와 브라우저에서 같은 터미널을 계속 사용할 수 있습니다. herdr를 쓰지 않는다면 해당 프로젝트들의 배포 방식과 지원 에이전트를 비교해 보세요. [전체 비교 →](docs/guide.md#faq)

<a id="docs"></a>

## 문서

[사용자 가이드](docs/guide.md)부터 보세요: [빠른 시작](docs/guide.md#quick-start) · [지원 에이전트](docs/guide.md#supported-agents) · [기능](docs/guide.md#features) · [폰](docs/guide.md#on-your-phone) · [원격 PC](docs/remote-pcs.md) · [접근과 보안](docs/guide.md#access-and-safety) · [설정](docs/guide.md#configuration) · [키보드 단축키](docs/guide.md#keyboard-shortcuts) · [FAQ](docs/guide.md#faq).

더 자세히: [동작 방식](docs/guide.md#how-it-works) · [채팅 기록](docs/chat-mode-audit.md) · [터미널 흐름 제어](docs/terminal-flow-control.md) · [앱 업데이트](docs/app-updates.md) · [변경 기록](CHANGELOG.md).

문서는 영어로 쓰여 있습니다.

<a id="thanks"></a>

## 감사

[herdr](https://github.com/herdrdev/herdr) 위에서 만들었고, [chatmux](https://github.com/devswha/chatmux)에서 영감을 받았으며, [xterm.js](https://xtermjs.org), [React](https://react.dev), [Bun](https://bun.sh), [Lucide](https://lucide.dev)를 사용합니다.

기여해 주신 모든 분께 감사드립니다. 특히 [@Yoonwoo-Ha](https://github.com/Yoonwoo-Ha)님께 감사드립니다.

<a id="agent-instructions"></a>

## 에이전트용 안내

누군가의 설치를 돕고 있다면 [INSTALL.md](INSTALL.md)를 따르세요. 저장소를 바꿀 때는 [CONTRIBUTING.md](CONTRIBUTING.md), [리뷰 규칙](.github/REVIEW.md), [AGENTS.md](AGENTS.md)를 따르세요.

<a id="development"></a>

## 개발

```bash
git clone https://github.com/devswha/herdr-web-ui.git
cd herdr-web-ui
bun install

bun run server      # API + WebSocket, :7317
bun run dev         # Vite, :5173 (다른 터미널에서 실행)
```

```bash
bun run typecheck
bun run test:unit   # herdr 없이 실행
bun test           # 격리된 herdr 테스트 세션
bun run test:ui    # 브라우저 회귀 테스트
```

변경을 보내려면 [CONTRIBUTING.md](CONTRIBUTING.md)를, 테스트·미디어·릴리스는 [개발 문서](docs/development.md)를, UI 규칙은 [DESIGN.md](DESIGN.md)를 보세요. 보안 문제는 [SECURITY.md](SECURITY.md)에 따라 비공개로 알려 주세요.

<a id="license"></a>

## 라이선스

[MIT](LICENSE). Copyright © 2026 devswha.
