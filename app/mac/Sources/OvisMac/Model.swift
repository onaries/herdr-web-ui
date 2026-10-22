import AppKit
import Foundation

struct Status: Equatable {
    var running: Bool
    var origin: URL?
    /// The HTTPS address Tailscale serves the app at, which the phone opens.
    var phoneURL: URL?
    /// "missing", "stopped" or "running", as /api/access reports Tailscale.
    var tailscale: String?
}

@MainActor
final class Model: ObservableObject {
    enum Phase: Equatable {
        case checking
        case notInstalled
        case working(String)
        case failed(String)
        case installed
    }

    @Published var phase: Phase = .checking
    @Published var log: [String] = []
    @Published var status: Status?
    private var pluginRoot: String?

    var logText: String { log.joined(separator: "\n") }

    func refresh() async {
        guard FileManager.default.isExecutableFile(atPath: Paths.herdr), let root = await findPluginRoot() else {
            pluginRoot = nil
            status = nil
            phase = .notInstalled
            return
        }
        pluginRoot = root
        status = await readStatus(root: root)
        phase = .installed
    }

    func install() async {
        log = []
        phase = .working(L("Downloading the installer…", "설치 프로그램을 받는 중…"))
        let script: URL
        do {
            let (data, response) = try await URLSession.shared.data(from: Ovis.installScript)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
            script = FileManager.default.temporaryDirectory.appendingPathComponent("ovis-install-\(UUID().uuidString).sh")
            try data.write(to: script)
        } catch {
            fail(L("Could not download the installer from ovis.sh. Check the internet connection.", "ovis.sh에서 설치 프로그램을 받지 못했습니다. 인터넷 연결을 확인해 주세요."), detail: error.localizedDescription)
            return
        }
        defer { try? FileManager.default.removeItem(at: script) }
        phase = .working(L("Installing herdr, Bun, Node and the Ovis server…", "herdr, Bun, Node, Ovis 서버를 설치하는 중…"))
        let result = await run("/bin/sh", [script.path], env: ["OVIS_NO_OPEN": "1"], onLine: appendLine)
        guard result.status == 0 else {
            fail(L("The installer stopped with an error.", "설치 중 오류가 났습니다."))
            return
        }
        phase = .working(L("Starting herdr…", "herdr를 시작하는 중…"))
        do {
            try await LaunchAgent.install()
        } catch {
            fail(L("Could not set herdr to start at login.", "로그인할 때 herdr가 켜지도록 설정하지 못했습니다."), detail: error.localizedDescription)
            return
        }
        await waitUntilRunning()
        await refresh()
    }

    func restart() async {
        phase = .working(L("Restarting…", "다시 시작하는 중…"))
        if await herdrRunning() {
            // the actions' output is in the log already: a failure only names which one stopped
            guard await run(Paths.herdr, ["plugin", "action", "invoke", "\(Ovis.pluginID).stop"], onLine: appendLine).status == 0 else {
                fail(L("Could not stop the Ovis server.", "Ovis 서버를 멈추지 못했습니다."))
                return
            }
            guard await run(Paths.herdr, ["plugin", "action", "invoke", "\(Ovis.pluginID).start"], onLine: appendLine).status == 0 else {
                fail(L("Could not start the Ovis server.", "Ovis 서버를 시작하지 못했습니다."))
                return
            }
        } else if !(await LaunchAgent.start()) {
            // herdr installed from a terminal has no login item to start: make it, which starts herdr
            do {
                try await LaunchAgent.install()
            } catch {
                fail(L("Could not start herdr.", "herdr를 시작하지 못했습니다."), detail: error.localizedDescription)
                return
            }
        }
        await waitUntilRunning()
        await refresh()
    }

    /// The installer's phone step: `tailscale serve` for this app, when Tailscale runs here.
    func makePhoneAddress() async {
        guard let root = pluginRoot else { return }
        log = []
        phase = .working(L("Making the phone address…", "휴대폰 주소를 만드는 중…"))
        _ = await run(Paths.bun, ["\(root)/scripts/plugin.ts", "phone"], onLine: appendLine)
        await refresh()
    }

    /// Takes the Ovis server off this Mac, as the guide's Uninstall does. herdr, Bun and Node stay, and
    /// herdr keeps running: stopping it would end every agent in it.
    func uninstall() async {
        log = []
        phase = .working(L("Removing…", "제거하는 중…"))
        let phoneURL = status?.phoneURL
        _ = await run(Paths.herdr, ["plugin", "action", "invoke", "\(Ovis.pluginID).stop"], onLine: appendLine)
        _ = await run(Paths.herdr, ["plugin", "uninstall", Ovis.pluginID], onLine: appendLine)
        if let phoneURL, let tailscale = Paths.tailscale {
            _ = await run(tailscale, ["serve", "--https=\(phoneURL.port ?? 443)", "off"], onLine: appendLine)
        }
        await LaunchAgent.remove()
        await refresh()
    }

    func open(_ url: URL) {
        NSWorkspace.shared.open(url)
    }

    func copyLog() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(logText, forType: .string)
    }

    private func fail(_ message: String, detail: String? = nil) {
        if let detail { log.append(detail) }
        phase = .failed(message)
    }

    /// Called on the pipe's thread for each line a child prints; the log is appended on the main thread, in order.
    private nonisolated var appendLine: @Sendable (String) -> Void {
        { [weak self] line in
            // a QR code drawn in block characters means nothing in a log
            guard !line.isEmpty, line.contains(where: { !"█▀▄ ".contains($0) }) else { return }
            DispatchQueue.main.async {
                MainActor.assumeIsolated { self?.log.append(line) }
            }
        }
    }

    private func findPluginRoot() async -> String? {
        let result = await run(Paths.herdr, ["plugin", "list", "--json"], keepStderr: false)
        guard result.status == 0,
              let json = try? JSONSerialization.jsonObject(with: Data(result.output.utf8)) as? [String: Any],
              let plugins = (json["result"] as? [String: Any])?["plugins"] as? [[String: Any]]
        else { return nil }
        return plugins.first { $0["plugin_id"] as? String == Ovis.pluginID }?["plugin_root"] as? String
    }

    /// `plugin.ts status` knows the port the plugin settled on: "running http://127.0.0.1:7317 (pid 1)" or "down …".
    private func readStatus(root: String) async -> Status {
        let result = await run(Paths.bun, ["\(root)/scripts/plugin.ts", "status"], keepStderr: false)
        let words = (result.output.split(separator: "\n").first ?? "").split(separator: " ")
        var status = Status(running: words.first == "running", origin: words.count > 1 ? URL(string: String(words[1])) : nil)
        guard status.running, let origin = status.origin else { return status }
        var request = URLRequest(url: origin.appendingPathComponent("api/access"))
        request.timeoutInterval = 5
        if let (data, response) = try? await URLSession.shared.data(for: request),
           (response as? HTTPURLResponse)?.statusCode == 200,
           let access = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let tailscale = access["tailscale"] as? [String: Any] {
            status.tailscale = tailscale["state"] as? String
            status.phoneURL = (tailscale["serving_url"] as? String).flatMap(URL.init(string:))
        }
        return status
    }

    private func herdrRunning() async -> Bool {
        let result = await run(Paths.herdr, ["status", "server", "--json"], keepStderr: false)
        return result.output.contains("\"running\":true")
    }

    /// herdr starts the app from its startup hook; give it up to two minutes, checking every two seconds.
    private func waitUntilRunning() async {
        for _ in 0..<60 {
            if let root = await findPluginRoot(), await readStatus(root: root).running { return }
            try? await Task.sleep(nanoseconds: 2_000_000_000)
        }
    }
}

/// `herdr server` as a login item of this user, so herdr, and the app with it, is up without a terminal.
enum LaunchAgent {
    private static var domain: String { "gui/\(getuid())" }
    private static var service: String { "\(domain)/\(Ovis.agentLabel)" }

    static func install() async throws {
        let manager = FileManager.default
        try manager.createDirectory(atPath: Paths.logDir, withIntermediateDirectories: true)
        try manager.createDirectory(atPath: (Paths.launchAgent as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        let plist: [String: Any] = [
            "Label": Ovis.agentLabel,
            "ProgramArguments": [Paths.herdr, "server"],
            "RunAtLoad": true,
            // launchd starts herdr with no locale, and its panes' shells inherit that: without a
            // character set they read Korean and emoji as bytes
            "EnvironmentVariables": ["PATH": Paths.path, "HOME": Paths.home, "LC_CTYPE": "UTF-8"],
            // launchd kills the job's whole process group when herdr exits; a server herdr hands its
            // sessions to (an update) would go with it, and every agent in it
            "AbandonProcessGroup": true,
            "StandardOutPath": "\(Paths.logDir)/herdr-server.log",
            "StandardErrorPath": "\(Paths.logDir)/herdr-server.log",
            "ProcessType": "Interactive",
        ]
        try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0).write(to: URL(fileURLWithPath: Paths.launchAgent))
        _ = await run("/bin/launchctl", ["enable", service])
        // a loaded agent may be running herdr with the user's agents in it: never boot it out to reload
        if await loaded() { _ = await start(); return }
        let result = await run("/bin/launchctl", ["bootstrap", domain, Paths.launchAgent])
        guard result.status == 0 else { throw NSError(domain: "Ovis", code: Int(result.status), userInfo: [NSLocalizedDescriptionKey: result.output]) }
    }

    /// Starts herdr when it is not running; a running herdr is left as it is. False when launchd has
    /// no such agent (herdr set up from a terminal, or the plist removed).
    @discardableResult
    static func start() async -> Bool {
        await run("/bin/launchctl", ["kickstart", service]).status == 0
    }

    /// Stops it from starting at the next login without stopping the herdr that runs now.
    static func remove() async {
        _ = await run("/bin/launchctl", ["disable", service])
        try? FileManager.default.removeItem(atPath: Paths.launchAgent)
    }

    private static func loaded() async -> Bool {
        await run("/bin/launchctl", ["print", service], keepStderr: false).status == 0
    }
}
