// Clawdbar: a tiny macOS menu bar companion for the clawdbox daemon.
// Shows whether the daemon is connected to the Divoom and which state Clawd is in,
// and offers a few shortcuts (open previewer, force a state, restart the daemon).
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
    let current: String
    let pending: String
    let forced: String?
    let transport: String?
    let sessions: [String: Session]
    let device: Device
    let uptimeSec: Int
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

    static func offline() -> Rendering {
        Rendering(title: " offline", dimmed: true, connection: "Daemon not running",
                  showing: "Start it with: clawdbox daemon --ble", transport: "", sessions: "")
    }

    init(title: String, dimmed: Bool, connection: String, showing: String, transport: String, sessions: String) {
        self.title = title; self.dimmed = dimmed; self.connection = connection
        self.showing = showing; self.transport = transport; self.sessions = sessions
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

    func applicationDidFinishLaunching(_ notification: Notification) {
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
        for item in [connectionItem, showingItem, transportItem, sessionsItem] {
            item.isEnabled = false
            menu.addItem(item)
        }
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
        let quit = NSMenuItem(title: "Quit Clawdbar", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.addItem(quit)
        return menu
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
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        task.arguments = ["kickstart", "-k", "gui/\(getuid())/\(launchdLabel)"]
        try? task.run()
    }

    @objc private func showLogs() {
        let logs = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/clawdbox/clawdbox.log")
        NSWorkspace.shared.open(logs)
    }
}

// `Clawdbar --check`: print what the menu bar would show and exit (used by CI and for debugging).
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
app.run()
