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
        guard reachable, let s = lastState else {
            statusItem.button?.image = clawdIcon(dimmed: true)
            statusItem.button?.title = " offline"
            connectionItem.title = "Daemon not running"
            showingItem.title = "Start it with: clawdbox daemon --ble"
            transportItem.title = ""
            sessionsItem.title = ""
            return
        }
        statusItem.button?.image = clawdIcon(dimmed: !s.device.connected)
        statusItem.button?.title = " " + s.current + (s.device.connected ? "" : " (no panel)")
        connectionItem.title = s.device.connected
            ? "Connected to Divoom (\(s.device.pushes) pushes)"
            : "Panel disconnected" + (s.device.lastError.map { ": \($0)" } ?? "")
        var showing = "Showing: \(s.current)"
        if s.pending != s.current { showing += "  →  \(s.pending)" }
        if let f = s.forced { showing += "  (forced \(f))" }
        showingItem.title = showing
        transportItem.title = "Transport: \(s.transport ?? s.device.label)"
        let n = s.sessions.count
        sessionsItem.title = "\(n) Claude session\(n == 1 ? "" : "s") · up \(s.uptimeSec / 60) min"
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

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
