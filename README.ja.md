# herdr web ui

<p align="center">
  <img src="public/icons/icon-192.png" alt="herdr web ui" width="100">
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <strong>日本語</strong> · <a href="README.ko.md">한국어</a>
</p>

<p align="center">
  <a href="https://herdrweb.dev/">公式サイト</a> ·
  <a href="#install">インストール</a> ·
  <a href="https://herdrweb.dev/demo/">デモを試す</a> ·
  <a href="docs/guide.md#quick-start">クイックスタート</a> ·
  <a href="#faq">よくある質問</a> ·
  <a href="#docs">ドキュメント</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-666666?labelColor=333333" alt="MIT ライセンス"></a>
  <a href="https://github.com/devswha/herdr-web-ui/stargazers"><img src="https://img.shields.io/github/stars/devswha/herdr-web-ui?labelColor=333333&color=666666&logo=github" alt="GitHub スター数"></a>
  <a href="https://github.com/devswha/herdr-web-ui/releases/latest"><img src="https://img.shields.io/github/v/release/devswha/herdr-web-ui?label=release&labelColor=333333&color=666666" alt="最新リリース"></a>
  <a href="https://github.com/herdrdev/herdr"><img src="https://img.shields.io/badge/herdr-0.9.0%2B-666666?labelColor=333333" alt="herdr 0.9.0+"></a>
  <a href="docs/guide.md#on-your-phone"><img src="https://img.shields.io/badge/PWA-installable-666666?labelColor=333333" alt="インストール可能な PWA"></a>
</p>

---

https://github.com/user-attachments/assets/db788c07-cd68-486d-8ce9-e676a2889c2d

<p align="center"><sub>herdr のターミナルで Claude Code が確認を求め、同じ質問がブラウザとスマートフォンにも表示。スマートフォンで 1 回タップして回答 · 実際の動作を収録、カットなし</sub></p>

**Claude Code と Codex を、スマートフォンから。**

[herdr](https://github.com/herdrdev/herdr) のブラウザ・スマートフォン向けクライアントです。自分のコンピューターで実行中の同じエージェントセッションを、パソコンでもスマートフォンでもチャットで読んで返答できます。必要なときはターミナルも使えます。

<table>
  <tr>
    <td width="50%" valign="top">
      <a href="https://github.com/user-attachments/assets/33ed2183-9b94-4677-8980-edd90d45750a"><img src="docs/media/readme/terminal.webp" width="100%" alt="実際の動作の録画。ブラウザのチャットに Claude Code の返答が表示され、Terminal をクリックすると同じペインが Claude Code 自身のターミナルになり、src/server.test.ts にテスト「unknown refund is 404」を追加した編集が見えます。スマートフォンでは tests タブのターミナルで、キーバーの ↑ で bun test を呼び出し、入力行の Enter ボタンで実行すると 5 pass、0 fail になります。"></a>
      <br><b>ライブターミナルに切り替える</b>
      <br><sub>クリック 1 回でチャットがそのペインの本物のターミナルに切り替わり、スマートフォンではキーバーの ↑ でテストのコマンドを呼び出して、Enter で再実行します。</sub>
    </td>
    <td width="50%" valign="top">
      <a href="https://github.com/user-attachments/assets/ac8dbf34-5c27-441b-8e49-e3850eac0c27"><img src="docs/media/readme/layout.webp" width="100%" alt="実際の動作の録画。ブラウザに herdr のレイアウトがそのまま表示されます。サイドバーに 4 つのワークスペースと各エージェントの状態（checkout-api DONE、web-dashboard RUN、infra READY、release）、checkout-api のタブ payments と dev。dev タブをクリックすると最初のペインの bun test（4 pass）が表示され、タブのペインメニューには分割された 2 つのペイン tests と git が並び、git をクリックするとその git log が表示されます。スマートフォンでは ☰ で同じ 4 つのワークスペースが同じ状態で開き、checkout-api をタップすると Claude のチャット（「What does this repo do? Answer in one line.」とその答え）が開きます。"></a>
      <br><b>herdr のレイアウトをブラウザで</b>
      <br><sub>ワークスペース、タブ、分割ペイン、そして各エージェントの状態がそのまま。タブをクリックし、分割のペインを選び、スマートフォンからワークスペースを切り替えます。</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <a href="https://github.com/user-attachments/assets/804ed0e1-54e6-4c1a-9d87-bd769a970315"><img src="docs/media/readme/alerts.webp" width="100%" alt="実際の動作の録画。ブラウザで Claude が checkout-api の作業をしている間、スマートフォンは別のワークスペースのターミナルを表示しています。Claude がどのレート制限にするか質問すると、スマートフォンに「checkout-api Needs input」の通知が降りてきて、タップすると質問がカードで開きます。ブラウザでも Needs you の下に checkout-api が同じカードとともに表示されます。"></a>
      <br><b>エージェントに呼ばれたらすぐ分かる</b>
      <br><sub>別のワークスペースを見ていても、Claude が質問すると通知が降りてきて、タップ 1 回で質問が開きます。</sub>
    </td>
    <td width="50%" valign="top">
      <a href="https://github.com/user-attachments/assets/25e55478-354b-4c5d-a33a-c1158f4b819a"><img src="docs/media/readme/attach.webp" width="100%" alt="実際の動作の録画。スマートフォンでクリップから $NaN と表示されたレシートのスクリーンショットを添付するとパスが挿入され、「Fix this, with a test.」を送信します。パソコンのチャットにも画像付きの同じメッセージが届き、Claude は src/routes/receipt.ts を読むところから始めます。"></a>
      <br><b>スマートフォンからスクリーンショットを送る</b>
      <br><sub>クリップでペインのフォルダーにアップロードしてパスを挿入。Claude が画像を読みます。</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <a href="https://github.com/user-attachments/assets/b410d41c-a822-47fe-94a5-88becab9b235"><img src="docs/media/readme/open.webp" width="100%" alt="実際の動作の録画。ブラウザのターミナルで Claude Code が bench/p95.svg を書き出しています。パスをクリックするとファイルビューアでグラフが開き、スマートフォンのチャットで同じパスをタップすると全画面で開きます。"></a>
      <br><b>エージェントが作ったファイルを開く</b>
      <br><sub>ターミナルのパスをクリック、またはチャットのパスをタップすると、その場でファイルが開きます。</sub>
    </td>
    <td width="50%" valign="top">
      <a href="https://github.com/user-attachments/assets/3a50f082-d13a-4a88-b2a4-7bc050e8a47a"><img src="docs/media/readme/worktree.webp" width="100%" alt="実際の動作の録画。スマートフォンで checkout-api の行の ⋯ メニュー → New worktree を開くと、ブランチ worktree/clear-forest-3580 が入力済みのフォームが表示されます。エージェントに Claude Code を選んで Create worktree をタップすると、ブラウザで checkout-api の下に新しい行が現れ、Claude Code に変わって READY になります。"></a>
      <br><b>2 つ目のエージェントを分岐させる</b>
      <br><sub>スマートフォンで ⋯ → New worktree。ブランチは入力済み、エージェントを選べば最初のものの隣で起動します。</sub>
    </td>
  </tr>
</table>

<p align="center"><sub>どのクリップも、パソコンとスマートフォンを同時に収録した実際の動作です。等速・カットなし。クリックすると動画全体を再生できます。</sub></p>

- **チャットとターミナルを、ひとつのペインで** — Claude Code、Codex、omp、omo、gjc、pi の会話履歴と、herdr が識別した OpenCode 2 のセッションを表示し、ワンクリックでライブターミナルに切り替えられます。エージェントの作業中に次のメッセージを書いておくと次のターンで送られ、Send now ですぐに送ることもできます。[対応エージェント →](docs/guide.md#supported-agents)
- **タップで承認** — 承認リクエスト、質問、計画メニューがカードになり、問いかけがまだ有効か確認してから回答を送信します。
- **対応が必要なときに通知** — すべてのペインの状態をリアルタイムに表示し、アプリを開いているときは通知が上から降りてきます。入力が必要なときや完了したときには、アプリを閉じていてもプッシュ通知が届きます。
- **スマートフォンにインストール** — キーボードの上にキーバー（Esc、Tab、Ctrl、Alt、Shift、Enter、矢印キー）が並ぶ PWA。キーの並べ替えや独自のキー組み合わせの追加は Settings（設定）でできます。Tailscale のアドレスは QR コードで表示されます。[スマートフォンの設定 →](docs/guide.md#on-your-phone)
- **話して入力** — チャットやターミナルの入力欄に音声で入力できます。韓国語と英語が混ざっても認識し、送信するまで何も送られません。自分の OpenAI API キー、またはブラウザの音声認識を使います。
- **いつもの作業環境をそのままに** — エージェントは herdr が管理し、このアプリはそこに接続します。エージェントを止めずに Settings（設定）からアップデートでき、アップデートごとの変更はパッチノートで確認できます。新しいタブや worktree は行の ⋯ メニューから作れます。[すべての機能 →](docs/guide.md#features)

---

<a id="install"></a>

## インストール

```bash
curl -fsSL https://herdrweb.dev/install.sh | sh
```

Linux（x64、arm64）または macOS に対応しています。必要な herdr 0.9.0+、Bun 1.4+、Node 18+ がなければ現在のユーザー向けにインストールし、その後アプリを herdr プラグインとしてインストールします。既存の herdr が 0.9.0 より古い場合は、自分で herdr を更新・再起動してからインストーラーを再実行してください。デフォルトの待ち受けアドレスを使用し、Tailscale が起動している場合、HTTPS の設定に成功すると tailnet 内のアクセス用アドレスと QR コードが表示されます。自分のデバイスはもともとコードなしで入れます。`tailscale serve` がログイン名を伝えるためです。それでも自分のスマートフォンがペアリングを求められるときは、`HERDR_WEB_TAILSCALE_SERVE_ONLY=1` を設定すると、ログインが1つだけの tailnet ならコードなしで入れるようになります。ただし、公開プロキシやトンネルなど別の経路でこのポートに届く場合は設定しないでください（[アクセスと安全性](docs/guide.md#access-and-safety)）。

<p align="center">
Windows x64 では PowerShell で:

```powershell
irm https://herdrweb.dev/install.ps1 | iex
```

[Git for Windows](https://git-scm.com/download/win) が必要です。足りない herdr と Bun を現在のユーザー向けにインストールし、同じプラグインをインストールします。Node や WSL は不要です。スマートフォンから使うには herdr で **Phone setup** を開いてください。herdr が Windows でターミナルのアタッチに対応するまで、Windows のターミナルは入力でき、グリッドが固定された[画面ミラー](docs/remote-pcs.md#windows-pcs)になります。

<p align="center">
  <img src="docs/screenshots/install.png" width="720" alt="インストーラーの出力：Bun、Node、herdr プラグインのインストール後、tailscale serve でアプリへのアクセスを有効にし、スマートフォン用の QR コードを表示します。">
</p>

必要なソフトウェアがすでにそろっている場合は、プラグインだけをインストールできます。

```bash
herdr plugin install devswha/herdr-web-ui
```

herdr が起動した状態で **[localhost:7317](http://localhost:7317)** を開きます。ペインを選ぶか、**New workspace（新規ワークスペース）** からエージェントを起動してください。スマートフォンで使う場合は、インストーラーの QR コードを読み取り、アプリをホーム画面に追加します。[クイックスタート →](docs/guide.md#quick-start)

サーバーのデフォルトの待ち受けアドレスは `127.0.0.1` です。別のデバイスからアクセスする場合は、[スマートフォンの設定](docs/guide.md#on-your-phone)と[アクセスと安全性](docs/guide.md#access-and-safety)を参照してください。

<a id="faq"></a>

## よくある質問

**Claude Code や Codex をスマートフォンから使えますか？**

はい。コンピューターの [herdr](https://github.com/herdrdev/herdr) のペインでエージェントを動かすと、このアプリが同じペインをスマートフォンのブラウザに表示します。エージェント自身の会話履歴はチャットとして、承認や質問はタップして答えるカードとして表示され、ライブターミナルにもすぐ切り替えられます。PWA としてホーム画面にインストールでき、エージェントが入力を待つとプッシュ通知が届きます。[スマートフォンの設定 →](docs/guide.md#on-your-phone)

**チャット表示はどのエージェントに対応していますか？**

Claude Code、Codex、omp、omo、gjc、pi は、それぞれのセッションファイルから読み取ります。OpenCode 2 は herdr が報告したセッションを OpenCode 自身のデータベースから読み取り、ホーム画面または 1.x のストアではライブターミナルを表示します。それ以外のプログラムはライブターミナルと状態が表示されます。[対応エージェント →](docs/guide.md#supported-agents)

**herdr の TUI の代わりになるものですか？**

いいえ。どちらも同じターミナルに同時に接続するので、ペインは机の上でも、ブラウザでも、スマートフォンでもそのまま動き続けます。止めたり引き渡したりするものはありません。 [TUI とブラウザ →](docs/guide.md#faq)

**Tailscale は必須ですか？**

いいえ。Tailscale、SSH トンネル、VPN、または自分で設定した HTTPS プロキシで PC に接続できます。アプリのインストールとプッシュ通知には HTTPS や localhost などのセキュアなコンテキストが必要ですが、基本的な閲覧は LAN 上の通常の HTTP アドレスでもできます。[ほかの方法 →](docs/guide.md#faq)

**コードや会話が自分のマシンの外に出ることはありますか？**

セッションファイルは各エージェントを実行している PC に残り、その内容は接続したブラウザへ送られます。このアプリ独自のクラウド中継やアカウントサービスはありません。任意の音声入力は録音を、文章の整形も使う場合はテキストも、設定したプロバイダーへ送ります。使用量表示を有効にするとプロバイダーの API に接続します。更新、リモート PC の設定、プッシュ通知でも外部サービスに接続することがあります。エージェント自身のモデルへの接続は、そのエージェントの設定によります。[データの送信とアクセス →](docs/guide.md#faq)

**Windows でも動きますか？**

はい。Windows x64 で、WSL なしで動きます。herdr が Windows でターミナルのアタッチに対応するまで、ターミナルは入力ができる固定グリッドの[画面ミラー](docs/remote-pcs.md#windows-pcs)です。

**collie、roamgate、herdr-remote とは何が違いますか？**

これらも herdr をスマートフォンやブラウザから使うためのクライアントです。このアプリはエージェント自身の会話履歴を読むので、ペインはターミナル出力ではなく、作業がターンごとに折りたたまれたチャットになります。ほかの PC はサイドバーから SSH で追加します。トンネルは付属せず、扱うのは herdr だけです。tmux や zellij、差分表示、Telegram、すぐ使えるトンネルが必要なら、ほかのクライアントのほうが向いています。[詳しい比較 →](docs/guide.md#faq)

**Happy、Paseo、CloudCLI UI とは何が違いますか？**

これらのプロジェクトには、エージェントのセッションを開始・管理する独自の仕組みがあります。このアプリは、すでに動いている herdr のペインを表示し、TUI とブラウザで同じターミナルを使い続けられます。herdr を使っていなければ、それらの導入方法と対応エージェントを比較してみてください。[詳しい比較 →](docs/guide.md#faq)

<a id="docs"></a>

## ドキュメント

まずは[ユーザーガイド](docs/guide.md)をご覧ください：[クイックスタート](docs/guide.md#quick-start) · [対応エージェント](docs/guide.md#supported-agents) · [機能](docs/guide.md#features) · [スマートフォン](docs/guide.md#on-your-phone) · [リモート PC](docs/remote-pcs.md) · [アクセスと安全性](docs/guide.md#access-and-safety) · [設定](docs/guide.md#configuration) · [キーボードショートカット](docs/guide.md#keyboard-shortcuts) · [よくある質問](docs/guide.md#faq)。

さらに詳しく：[仕組み](docs/guide.md#how-it-works) · [チャットの会話履歴](docs/chat-mode-audit.md) · [ターミナルのフロー制御](docs/terminal-flow-control.md) · [アプリのアップデート](docs/app-updates.md) · [変更履歴](CHANGELOG.md)。

<a id="thanks"></a>

## 謝辞

[herdr](https://github.com/herdrdev/herdr) を基盤とし、[chatmux](https://github.com/devswha/chatmux) から着想を得て、[xterm.js](https://xtermjs.org)、[React](https://react.dev)、[Bun](https://bun.sh)、[Lucide](https://lucide.dev) を使用しています。

[@Yoonwoo-Ha](https://github.com/Yoonwoo-Ha) をはじめ、貢献してくださったすべての方に感謝します。

<a id="agent-instructions"></a>

## エージェント向けの手順

アプリのインストールを支援する場合は、[INSTALL.md](INSTALL.md) に従ってください。リポジトリを変更する場合は、[CONTRIBUTING.md](CONTRIBUTING.md)、[レビュールール](.github/REVIEW.md)、[AGENTS.md](AGENTS.md) に従ってください。

<a id="development"></a>

## 開発

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

変更の送り方は [CONTRIBUTING.md](CONTRIBUTING.md)、テスト、メディア素材、リリースについては[開発ドキュメント](docs/development.md)、UI の規約については [DESIGN.md](DESIGN.md) を参照してください。セキュリティの問題は [SECURITY.md](SECURITY.md) の手順で非公開で報告してください。

<a id="license"></a>

## ライセンス

[MIT](LICENSE)。Copyright © 2026 devswha.
