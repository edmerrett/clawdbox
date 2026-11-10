// Clawdbox.app: the one macOS app for clawdbox.
//
// It is a menu bar item that shows whether the panel is connected and which state Clawd
// is in, with shortcuts (previewer, force a state, restart, logs, install update). It is
// also the daemon's host: when install-launchd has written a daemon config, the app
// spawns the node daemon as a child and supervises it. The child inherits this app's
// Bluetooth permission, which is why a separate wrapper bundle is not needed.
//
// Build with menubar/build.sh (needs only the Xcode command line tools).

import Cocoa

// MARK: - Daemon state (GET http://127.0.0.1:7676/state)

struct DaemonState: Decodable {
    struct Device: Decodable {
        let label: String
        let connected: Bool
        let pushes: Int
        let lastError: String?
    }
    struct Session: Decodable {
        let state: String
    }
    struct Update: Decodable {
        let version: String
        let commit: String?
        let latestCommit: String?
        let updateAvailable: Bool
    }
    let current: String
    let pending: String
    let forced: String?
    let transport: String?
    let sessions: [String: Session]
    let device: Device
    let uptimeSec: Int
    let update: Update?
}

/// The clawdbox checkout, read from the daemon's launchd plist (WorkingDirectory) that
/// `install-launchd` wrote. Never taken from the network: a process squatting the daemon's
/// port must not be able to point "Install Update…" at a script of its choosing.
func installedCheckout() -> URL? {
    let plist = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/LaunchAgents/\(launchdLabel).plist")
    guard let data = try? Data(contentsOf: plist),
          let dict = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
          let dir = dict["WorkingDirectory"] as? String else { return nil }
    let url = URL(fileURLWithPath: dir).standardizedFileURL
    let home = FileManager.default.homeDirectoryForCurrentUser.standardizedFileURL.path
    guard url.path.hasPrefix(home + "/"),
          let pkg = try? Data(contentsOf: url.appendingPathComponent("package.json")),
          let json = try? JSONSerialization.jsonObject(with: pkg) as? [String: Any],
          json["name"] as? String == "clawdbox",
          FileManager.default.isExecutableFile(atPath: url.appendingPathComponent("scripts/update.sh").path)
    else { return nil }
    return url
}

let daemonBase = URL(string: ProcessInfo.processInfo.environment["CLAWDBOX_URL"] ?? "http://127.0.0.1:7676")!

/// What the menu bar shows for a given daemon state. Shared by the live UI and `--check`,
/// so the headless check exercises exactly the rendering the user sees.
struct Rendering {
    let title: String
    let dimmed: Bool
    let connection: String
    let showing: String
    let transport: String
    let sessions: String
    /// Non-nil when the daemon reports a newer clawdbox on origin/main.
    let update: String?

    static func offline() -> Rendering {
        Rendering(title: " offline", dimmed: true, connection: "Daemon not running",
                  showing: "Use Restart Daemon below, or re-run the installer", transport: "", sessions: "", update: nil)
    }

    init(title: String, dimmed: Bool, connection: String, showing: String, transport: String, sessions: String, update: String?) {
        self.title = title; self.dimmed = dimmed; self.connection = connection
        self.showing = showing; self.transport = transport; self.sessions = sessions; self.update = update
    }

    init(_ s: DaemonState) {
        title = " " + s.current + (s.device.connected ? "" : " (no panel)")
        dimmed = !s.device.connected
        connection = s.device.connected
            ? "Connected to Divoom (\(s.device.pushes) pushes)"
            : "Panel disconnected" + (s.device.lastError.map { ": \($0)" } ?? "")
        var line = "Showing: \(s.current)"
        if s.pending != s.current { line += "  →  \(s.pending)" }
        if let f = s.forced { line += "  (forced \(f))" }
        showing = line
        transport = "Transport: \(s.transport ?? s.device.label)"
        let n = s.sessions.count
        sessions = "\(n) Claude session\(n == 1 ? "" : "s") · up \(s.uptimeSec / 60) min"
        if let u = s.update, u.updateAvailable {
            let from = u.commit.map { String($0.prefix(7)) } ?? "?"
            let to = u.latestCommit.map { String($0.prefix(7)) } ?? "?"
            update = "Update available: \(from) → \(to)"
        } else {
            update = nil
        }
    }
}

/// Fetch /state once, synchronously. Used by `--check`.
func fetchStateSync(timeout: TimeInterval = 3) -> Result<DaemonState, Error> {
    var request = URLRequest(url: daemonBase.appendingPathComponent("state"))
    request.timeoutInterval = timeout
    let sem = DispatchSemaphore(value: 0)
    var result: Result<DaemonState, Error> = .failure(URLError(.unknown))
    URLSession.shared.dataTask(with: request) { data, _, error in
        defer { sem.signal() }
        if let error = error { result = .failure(error); return }
        do { result = .success(try JSONDecoder().decode(DaemonState.self, from: data ?? Data())) }
        catch { result = .failure(error) }
    }.resume()
    sem.wait()
    return result
}
let allStates = ["idle", "thinking", "ultrathink", "reading", "writing", "running", "needs-you", "coffee", "vibing", "wave", "done", "error", "heart"]
let launchdLabel = "com.clawdbox.daemon"
let supportDir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/clawdbox")
let logsDir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/clawdbox")

// MARK: - Daemon supervisor

/// Written by `clawdbox install-launchd`: how to start the daemon.
struct DaemonConfig: Decodable {
    let node: String
    let cli: String
    let args: [String]
    let cwd: String
}

/// Runs the node daemon as a child process and restarts it with backoff when it exits.
final class DaemonSupervisor {
    private let config: DaemonConfig
    private var process: Process?
    private var backoff: TimeInterval = 2
    private var stopped = false
    private var logHandle: FileHandle?

    init?(configURL: URL) {
        guard let data = try? Data(contentsOf: configURL),
              let cfg = try? JSONDecoder().decode(DaemonConfig.self, from: data) else { return nil }
        // Refuse anything outside the user's home or that is not clawdbox's own CLI.
        let home = FileManager.default.homeDirectoryForCurrentUser.standardizedFileURL.path
        guard cfg.cwd.hasPrefix(home + "/"), cfg.cli.hasPrefix(cfg.cwd + "/"), cfg.cli.hasSuffix("/dist/cli.js"),
              FileManager.default.isExecutableFile(atPath: cfg.node) else { return nil }
        config = cfg
    }

    func start() {
        stopped = false
        spawn()
    }

    private func spawn() {
        guard !stopped, process == nil else { return }
        try? FileManager.default.createDirectory(at: logsDir, withIntermediateDirectories: true)
        let log = logsDir.appendingPathComponent("clawdbox.log")
        if !FileManager.default.fileExists(atPath: log.path) { FileManager.default.createFile(atPath: log.path, contents: nil) }
        logHandle = try? FileHandle(forWritingTo: log)
        logHandle?.seekToEndOfFile()
        let p = Process()
        p.executableURL = URL(fileURLWithPath: config.node)
        p.arguments = [config.cli, "daemon"] + config.args
        p.currentDirectoryURL = URL(fileURLWithPath: config.cwd)
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        env["CLAWDBOX_SUPERVISED"] = "1"  // the daemon exits by itself if this app disappears
        p.environment = env
        p.standardOutput = logHandle
        p.standardError = logHandle
        p.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async { self?.exited(code: proc.terminationStatus) }
        }
        do {
            try p.run()
            process = p
            backoff = 2
        } catch {
            exited(code: -1)
        }
    }

    private func exited(code: Int32) {
        process = nil
        try? logHandle?.close()
        logHandle = nil
        guard !stopped else { return }
        let delay = backoff
        backoff = min(backoff * 2, 30)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in self?.spawn() }
    }

    /// SIGTERM lets the daemon disconnect the panel cleanly; the supervisor restarts it.
    func restart() {
        process?.terminate()
    }

    func stop() {
        stopped = true
        process?.terminate()
        let p = process
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { if p?.isRunning == true { kill(p!.processIdentifier, SIGKILL) } }
    }

    var isRunning: Bool { process?.isRunning == true }
}

// MARK: - Clawd icon drawn from the same 12x8 body the panel uses

func clawdIcon(dimmed: Bool) -> NSImage {
    let rows = [
        "..OOOOOOOO..",
        "..OKOOOOKO..",
        "OOOOOOOOOOOO",
        "OOOOOOOOOOOO",
        "..OOOOOOOO..",
        "..OOOOOOOO..",
        "..O.O..O.O..",
        "..O.O..O.O..",
    ]
    let cell: CGFloat = 1.5
    let size = NSSize(width: CGFloat(rows[0].count) * cell, height: CGFloat(rows.count) * cell)
    let image = NSImage(size: size, flipped: true) { _ in
        NSColor.black.withAlphaComponent(dimmed ? 0.35 : 1.0).setFill()
        for (y, row) in rows.enumerated() {
            for (x, ch) in row.enumerated() where ch == "O" {
                NSRect(x: CGFloat(x) * cell, y: CGFloat(y) * cell, width: cell, height: cell).fill()
            }
        }
        return true
    }
    image.isTemplate = true
    return image
}

// MARK: - App

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var timer: Timer?
    private var lastState: DaemonState?
    private var reachable = false

    private let connectionItem = NSMenuItem(title: "Connecting…", action: nil, keyEquivalent: "")
    private let showingItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private let transportItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private let sessionsItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private let updateItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private let installUpdateItem = NSMenuItem(title: "Install Update…", action: #selector(installUpdate), keyEquivalent: "u")
    private var supervisor: DaemonSupervisor?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Host the daemon when install-launchd configured one (and we were not told to stay a pure UI).
        if !CommandLine.arguments.contains("--no-daemon"),
           let sup = DaemonSupervisor(configURL: supportDir.appendingPathComponent("daemon.json")) {
            supervisor = sup
            sup.start()
        }
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.image = clawdIcon(dimmed: true)
        statusItem.button?.imagePosition = .imageLeading
        statusItem.button?.title = " …"
        statusItem.menu = buildMenu()
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.refresh() }
    }

    private func buildMenu() -> NSMenu {
        let menu = NSMenu()
        for item in [connectionItem, showingItem, transportItem, sessionsItem, updateItem] {
            item.isEnabled = false
            menu.addItem(item)
        }
        updateItem.isHidden = true
        installUpdateItem.target = self
        installUpdateItem.isHidden = true
        menu.addItem(installUpdateItem)
        menu.addItem(.separator())

        let open = NSMenuItem(title: "Open Previewer", action: #selector(openPreviewer), keyEquivalent: "o")
        open.target = self
        menu.addItem(open)

        let force = NSMenuItem(title: "Force State", action: nil, keyEquivalent: "")
        let sub = NSMenu()
        for s in allStates {
            let it = NSMenuItem(title: s, action: #selector(forceState(_:)), keyEquivalent: "")
            it.target = self
            it.representedObject = s
            sub.addItem(it)
        }
        force.submenu = sub
        menu.addItem(force)

        let restart = NSMenuItem(title: "Restart Daemon", action: #selector(restartDaemon), keyEquivalent: "r")
        restart.target = self
        menu.addItem(restart)

        let logs = NSMenuItem(title: "Show Logs", action: #selector(showLogs), keyEquivalent: "l")
        logs.target = self
        menu.addItem(logs)

        menu.addItem(.separator())
        let quit = NSMenuItem(title: "Quit Clawdbox", action: #selector(quitApp), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
        return menu
    }

    func applicationWillTerminate(_ notification: Notification) {
        supervisor?.stop()
    }

    /// Under launchd, quitting would just get us relaunched; unload the agent first so
    /// "Quit" means "until next login" (the installer or launchctl bootstrap brings it back).
    @objc private func quitApp() {
        supervisor?.stop()
        if supervisor != nil {
            let task = Process()
            task.executableURL = URL(fileURLWithPath: "/bin/launchctl")
            task.arguments = ["bootout", "gui/\(getuid())/\(launchdLabel)"]
            try? task.run()
        }
        NSApp.terminate(nil)
    }

    // MARK: polling

    private func refresh() {
        var request = URLRequest(url: daemonBase.appendingPathComponent("state"))
        request.timeoutInterval = 1.5
        URLSession.shared.dataTask(with: request) { [weak self] data, _, error in
            DispatchQueue.main.async {
                guard let self = self else { return }
                if let data = data, error == nil, let state = try? JSONDecoder().decode(DaemonState.self, from: data) {
                    self.reachable = true
                    self.lastState = state
                } else {
                    self.reachable = false
                }
                self.render()
            }
        }.resume()
    }

    private func render() {
        let r: Rendering
        if reachable, let s = lastState { r = Rendering(s) } else { r = Rendering.offline() }
        statusItem.button?.image = clawdIcon(dimmed: r.dimmed)
        statusItem.button?.title = r.title
        connectionItem.title = r.connection
        showingItem.title = r.showing
        transportItem.title = r.transport
        sessionsItem.title = r.sessions
        updateItem.title = r.update ?? ""
        updateItem.isHidden = r.update == nil
        installUpdateItem.isHidden = r.update == nil || installedCheckout() == nil
    }

    // MARK: actions

    @objc private func openPreviewer() {
        NSWorkspace.shared.open(daemonBase)
    }

    @objc private func forceState(_ sender: NSMenuItem) {
        guard let state = sender.representedObject as? String else { return }
        var request = URLRequest(url: daemonBase.appendingPathComponent("show/\(state)"))
        request.httpMethod = "POST"
        request.timeoutInterval = 2
        URLSession.shared.dataTask(with: request) { [weak self] _, _, _ in
            DispatchQueue.main.async { self?.refresh() }
        }.resume()
    }

    @objc private func restartDaemon() {
        if let sup = supervisor {
            sup.restart()
            return
        }
        // not hosting the daemon ourselves: ask launchd (older wrapper-bundle installs)
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        task.arguments = ["kickstart", "-k", "gui/\(getuid())/\(launchdLabel)"]
        try? task.run()
    }

    /// Runs scripts/update.sh in the installed checkout (located via our own launchd plist,
    /// never via the daemon). It updates to the newest release, rebuilds, restarts the
    /// daemon and relaunches this app if the menu bar sources changed.
    @objc private func installUpdate() {
        guard let root = installedCheckout() else { return }
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/bash")
        task.arguments = [root.appendingPathComponent("scripts/update.sh").path]
        try? FileManager.default.createDirectory(at: logsDir, withIntermediateDirectories: true)
        let log = logsDir.appendingPathComponent("update.log")
        if !FileManager.default.fileExists(atPath: log.path) { FileManager.default.createFile(atPath: log.path, contents: nil) }
        if let handle = try? FileHandle(forWritingTo: log) {
            handle.seekToEndOfFile()
            task.standardOutput = handle
            task.standardError = handle
        }
        updateItem.title = "Updating… (see ~/Library/Logs/clawdbox/update.log)"
        installUpdateItem.isHidden = true
        try? task.run()
    }

    @objc private func showLogs() {
        NSWorkspace.shared.open(logsDir.appendingPathComponent("clawdbox.log"))
    }
}

// `Clawdbox --check`: print what the menu bar would show and exit (used by CI and for debugging).
if CommandLine.arguments.contains("--check") {
    switch fetchStateSync() {
    case .success(let state):
        let r = Rendering(state)
        print("title:\(r.title)")
        print("connected: \(state.device.connected)")
        print("state: \(state.current)")
        print("transport: \(state.transport ?? "-")")
        print(r.connection)
        print(r.showing)
        print(r.sessions)
        if let u = r.update { print(u) }
        exit(0)
    case .failure(let error):
        let r = Rendering.offline()
        print("title:\(r.title)")
        print("error: \(error.localizedDescription)")
        exit(1)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
// launchctl kickstart -k sends SIGTERM; terminate through AppKit so applicationWillTerminate stops the daemon child.
signal(SIGTERM, SIG_IGN)
let termSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
termSource.setEventHandler { NSApp.terminate(nil) }
termSource.resume()
app.run()
