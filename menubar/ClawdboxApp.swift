// Clawdbox.app: the one macOS app for clawdbox.
//
// It is a menu bar item that shows whether the panel is connected and which state Clawd
// is in, with shortcuts (previewer, force/hold a state, restart, logs, check for and install updates). Its
// menu opens on a small digital Divoom that plays the animation the panel is showing. It is
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
        /// Newest release on origin, without the "v" (older daemons do not send this).
        let latestVersion: String?
        let latestCommit: String?
        let updateAvailable: Bool
        let error: String?
    }
    let current: String
    let pending: String
    let forced: String?
    /// The forced state stays until released (older daemons do not send this).
    let held: Bool?
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

/// CLAWDBOX_PANEL_LOG=1 logs every frame the digital Divoom draws to stderr (CI reads it to
/// confirm the open menu really animates).
let panelLog = ProcessInfo.processInfo.environment["CLAWDBOX_PANEL_LOG"] != nil
func logPanel(_ line: String) {
    if panelLog { FileHandle.standardError.write((line + "\n").data(using: .utf8)!) }
}

/// What the menu bar shows for a given daemon state. Shared by the live UI and `--check`,
/// so the headless check exercises exactly the rendering the user sees.
struct Rendering {
    let title: String
    let dimmed: Bool
    let connection: String
    let showing: String
    let transport: String
    let sessions: String
    /// "Clawdbox 0.4.0": the version the daemon is running.
    let version: String?
    /// Non-nil when the daemon reports a newer clawdbox release.
    let update: String?

    static func offline() -> Rendering {
        Rendering(title: " offline", dimmed: true, connection: "Daemon not running",
                  showing: "Use Restart Daemon below, or re-run the installer", transport: "", sessions: "",
                  version: nil, update: nil)
    }

    init(title: String, dimmed: Bool, connection: String, showing: String, transport: String, sessions: String,
         version: String?, update: String?) {
        self.title = title; self.dimmed = dimmed; self.connection = connection
        self.showing = showing; self.transport = transport; self.sessions = sessions
        self.version = version; self.update = update
    }

    init(_ s: DaemonState) {
        title = " " + s.current + (s.device.connected ? "" : " (no panel)")
        dimmed = !s.device.connected
        connection = s.device.connected
            ? "Connected to Divoom (\(s.device.pushes) pushes)"
            : "Panel disconnected" + (s.device.lastError.map { ": \($0)" } ?? "")
        var line = "Showing: \(s.current)"
        if s.pending != s.current { line += "  →  \(s.pending)" }
        if let f = s.forced { line += s.held == true ? "  (holding \(f))" : "  (forced \(f))" }
        showing = line
        transport = "Transport: \(s.transport ?? s.device.label)"
        let n = s.sessions.count
        sessions = "\(n) Claude session\(n == 1 ? "" : "s") · up \(s.uptimeSec / 60) min"
        version = s.update.map { "Clawdbox \($0.version)" }
        if let u = s.update, u.updateAvailable {
            update = "Update available: \(u.version) → \(newestRelease(u))"
        } else {
            update = nil
        }
    }
}

/// The newest release as people know it: its version, else its short commit.
func newestRelease(_ u: DaemonState.Update) -> String {
    u.latestVersion ?? u.latestCommit.map { String($0.prefix(7)) } ?? "a newer release"
}

/// GET a daemon path once, synchronously. Used by `--check` and `--snapshot`.
func fetchSync(_ path: String, timeout: TimeInterval = 3) -> Result<Data, Error> {
    var request = URLRequest(url: daemonBase.appendingPathComponent(path))
    request.timeoutInterval = timeout
    let sem = DispatchSemaphore(value: 0)
    var result: Result<Data, Error> = .failure(URLError(.unknown))
    URLSession.shared.dataTask(with: request) { data, _, error in
        defer { sem.signal() }
        if let error = error { result = .failure(error) } else { result = .success(data ?? Data()) }
    }.resume()
    sem.wait()
    return result
}

func fetchStateSync(timeout: TimeInterval = 3) -> Result<DaemonState, Error> {
    fetchSync("state", timeout: timeout).flatMap { data in
        Result { try JSONDecoder().decode(DaemonState.self, from: data) }
    }
}

// MARK: - Animations (GET http://127.0.0.1:7676/anims)

/// The daemon's palette-index JSON for one animation (see src/anim/types.ts, AnimFile).
struct AnimFile: Decodable {
    struct Frame: Decodable {
        let ms: Int
        let palette: [String]
        let idx: [Int]
    }
    let frames: [Frame]
}

let panelSide = 16

/// One decoded frame: 256 pixels as 0xRRGGBB, row-major, top-left first.
struct PanelFrame {
    let ms: Int
    let pixels: [UInt32]
}

/// Decode /anims into frames per state. Malformed animations are dropped, not guessed at.
func decodeAnims(_ data: Data) -> [String: [PanelFrame]] {
    guard let files = try? JSONDecoder().decode([String: AnimFile].self, from: data) else { return [:] }
    var out: [String: [PanelFrame]] = [:]
    for (name, file) in files {
        var frames: [PanelFrame] = []
        for f in file.frames {
            let palette = f.palette.compactMap { hex -> UInt32? in
                guard hex.hasPrefix("#"), hex.count == 7 else { return nil }
                return UInt32(hex.dropFirst(), radix: 16)
            }
            guard palette.count == f.palette.count, f.idx.count == panelSide * panelSide,
                  f.idx.allSatisfy({ $0 >= 0 && $0 < palette.count }) else { break }
            frames.append(PanelFrame(ms: f.ms, pixels: f.idx.map { palette[$0] }))
        }
        if !frames.isEmpty, frames.count == file.frames.count { out[name] = frames }
    }
    return out
}
let allStates = ["idle", "thinking", "ultrathink", "reading", "writing", "running", "needs-you", "coffee", "vibing", "wave", "done", "error", "heart"]
let launchdLabel = "com.clawdbox.daemon"
let supportDir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/clawdbox")
let logsDir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/clawdbox")
let updateLog = logsDir.appendingPathComponent("update.log")

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

// MARK: - The digital Divoom at the top of the menu

/// A little TimeBox: dark body, 16x16 LED grid playing the current state's loop, and the
/// state's name underneath. It animates only while the menu is open.
final class PanelView: NSView {
    static let cell: CGFloat = 8
    static let bezel: CGFloat = 10
    static let side: CGFloat = 8 * 16 + 10 * 2
    static let size = NSSize(width: 220, height: 8 * 16 + 10 * 2 + 40)

    var anims: [String: [PanelFrame]] = [:] {
        didSet { restart() }
    }
    private var state = ""
    private var caption = "…"
    private var dimmed = true
    private var index = 0
    private var playing = false
    private var timer: Timer?

    override var isFlipped: Bool { true }

    init() {
        super.init(frame: NSRect(origin: .zero, size: PanelView.size))
        autoresizingMask = [.width]
        setAccessibilityElement(true)
        setAccessibilityRole(.image)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// `state` is an animation name ("" for a dark panel); `dimmed` when the real panel is not connected.
    func show(state: String, caption: String, dimmed: Bool) {
        let changed = state != self.state
        self.state = state
        self.caption = caption
        self.dimmed = dimmed
        setAccessibilityLabel("Divoom panel: \(caption)")
        if changed { restart() } else { needsDisplay = true }
    }

    func play() {
        playing = true
        restart()
    }

    func pause() {
        playing = false
        timer?.invalidate()
        timer = nil
    }

    private var frames: [PanelFrame] { anims[state] ?? [] }

    private func restart() {
        index = 0
        timer?.invalidate()
        timer = nil
        needsDisplay = true
        scheduleNext()
    }

    private func scheduleNext() {
        let f = frames
        guard playing, f.count > 1 else { return }
        let ms = max(f[index % f.count].ms, 30)
        let t = Timer(timeInterval: Double(ms) / 1000, repeats: false) { [weak self] _ in
            guard let self = self else { return }
            let n = self.frames.count
            self.index = n > 0 ? (self.index + 1) % n : 0
            self.needsDisplay = true
            self.scheduleNext()
        }
        // .common: the run loop is in event-tracking mode while a menu is open
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    override func draw(_ dirtyRect: NSRect) {
        let cell = PanelView.cell
        let body = NSRect(x: ((bounds.width - PanelView.side) / 2).rounded(), y: 8, width: PanelView.side, height: PanelView.side)
        NSColor(white: 0.16, alpha: 1).setFill()
        NSBezierPath(roundedRect: body, xRadius: 14, yRadius: 14).fill()
        let screen = body.insetBy(dx: PanelView.bezel - 2, dy: PanelView.bezel - 2)
        NSColor.black.setFill()
        NSBezierPath(roundedRect: screen, xRadius: 4, yRadius: 4).fill()

        let f = frames
        logPanel("panel draw: state=\(state) frame=\(f.isEmpty ? 0 : index % f.count) of=\(f.count) inMenu=\(window != nil)")
        let pixels: [UInt32]? = f.isEmpty ? nil : f[index % f.count].pixels
        let off = NSColor(white: 0.09, alpha: 1)
        let alpha: CGFloat = dimmed ? 0.4 : 1
        let x0 = body.minX + PanelView.bezel
        let y0 = body.minY + PanelView.bezel
        for i in 0..<(panelSide * panelSide) {
            let rgb = pixels?[i] ?? 0
            if rgb == 0 {
                off.setFill()
            } else {
                NSColor(srgbRed: CGFloat((rgb >> 16) & 0xff) / 255, green: CGFloat((rgb >> 8) & 0xff) / 255,
                        blue: CGFloat(rgb & 0xff) / 255, alpha: alpha).setFill()
            }
            // each LED is a 7pt square on an 8pt pitch
            NSRect(x: x0 + CGFloat(i % panelSide) * cell + 0.5, y: y0 + CGFloat(i / panelSide) * cell + 0.5,
                   width: cell - 1, height: cell - 1).fill()
        }

        let text = NSAttributedString(string: caption, attributes: [
            .font: NSFont.systemFont(ofSize: 12, weight: .medium),
            .foregroundColor: NSColor.secondaryLabelColor,
        ])
        let size = text.size()
        text.draw(at: NSPoint(x: ((bounds.width - size.width) / 2).rounded(), y: body.maxY + 8))
    }
}

/// What the digital Divoom shows for a rendering: the current loop, or a dark panel when the daemon is away.
func configure(_ panel: PanelView, state: DaemonState?) {
    if let s = state {
        panel.show(state: s.current, caption: s.device.connected ? s.current : "\(s.current) (no panel)", dimmed: !s.device.connected)
    } else {
        panel.show(state: "", caption: "offline", dimmed: true)
    }
}

/// Draw the digital Divoom to a PNG without opening the menu. Used by `--snapshot` (CI screenshots).
func snapshotPanel(_ panel: PanelView, to path: String) -> Bool {
    guard let rep = panel.bitmapImageRepForCachingDisplay(in: panel.bounds) else { return false }
    panel.cacheDisplay(in: panel.bounds, to: rep)
    guard let png = rep.representation(using: .png, properties: [:]) else { return false }
    return (try? png.write(to: URL(fileURLWithPath: path))) != nil
}

// MARK: - App

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var statusItem: NSStatusItem!
    private var timer: Timer?
    private var openTimer: Timer?
    private let panel = PanelView()
    private var fetchingAnims = false
    private var animsUptime = Int.max
    private var lastState: DaemonState?
    private var reachable = false

    private let connectionItem = NSMenuItem(title: "Connecting…", action: nil, keyEquivalent: "")
    private let showingItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private let transportItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private let sessionsItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private let versionItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private let updateItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private let installUpdateItem = NSMenuItem(title: "Install Update…", action: #selector(installUpdate), keyEquivalent: "u")
    private let checkUpdatesItem = NSMenuItem(title: "Check for Updates…", action: #selector(checkForUpdates), keyEquivalent: "")
    private let forceMenu = NSMenu()
    private let releaseItem = NSMenuItem(title: "Release (follow hooks)", action: #selector(releaseForce), keyEquivalent: "")
    /// A one-off update line ("Checking…", "Update installed…"), shown until the menu has been seen with it.
    private var updateNote: String?
    private var updateNoteSeen = false
    private var checkingUpdates = false
    /// scripts/update.sh while it runs (it restarts the daemon, and usually this app, at the end).
    private var installing: Process?
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
        // `--open-menu`: click our own icon shortly after launch (CI uses it to exercise the open menu).
        if CommandLine.arguments.contains("--open-menu") {
            Timer.scheduledTimer(withTimeInterval: 3, repeats: false) { [weak self] _ in
                self?.statusItem.button?.performClick(nil)
            }
        }
    }

    private func buildMenu() -> NSMenu {
        let menu = NSMenu()
        menu.delegate = self
        let panelItem = NSMenuItem()
        panelItem.view = panel
        menu.addItem(panelItem)
        menu.addItem(.separator())
        for item in [connectionItem, showingItem, transportItem, sessionsItem, versionItem, updateItem] {
            item.isEnabled = false
            menu.addItem(item)
        }
        updateItem.isHidden = true
        installUpdateItem.target = self
        installUpdateItem.isHidden = true
        menu.addItem(installUpdateItem)
        checkUpdatesItem.target = self
        menu.addItem(checkUpdatesItem)
        menu.addItem(.separator())

        let open = NSMenuItem(title: "Open Previewer", action: #selector(openPreviewer), keyEquivalent: "o")
        open.target = self
        menu.addItem(open)

        // A state picked here is held until released (or picked again), whatever the hooks say.
        let force = NSMenuItem(title: "Force State", action: nil, keyEquivalent: "")
        releaseItem.target = self
        forceMenu.addItem(releaseItem)
        forceMenu.addItem(.separator())
        for s in allStates {
            let it = NSMenuItem(title: s, action: #selector(forceState(_:)), keyEquivalent: "")
            it.target = self
            it.representedObject = s
            forceMenu.addItem(it)
        }
        force.submenu = forceMenu
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

    // MARK: menu open/close: the digital Divoom animates, and follows the daemon closely, only while visible

    func menuWillOpen(_ menu: NSMenu) {
        logPanel("menu opened")
        if updateNote != nil && !checkingUpdates { updateNoteSeen = true }
        panel.play()
        refresh()
        let t = Timer(timeInterval: 0.5, repeats: true) { [weak self] _ in self?.refresh() }
        RunLoop.main.add(t, forMode: .common)  // the 2 s timer does not fire while the menu tracks events
        openTimer = t
    }

    func menuDidClose(_ menu: NSMenu) {
        openTimer?.invalidate()
        openTimer = nil
        panel.pause()
        if updateNoteSeen {
            updateNote = nil
            updateNoteSeen = false
        }
    }

    /// Load the sprites once, and again after the daemon restarts (they may have been rebuilt).
    private func loadAnimsIfNeeded(uptime: Int) {
        guard !fetchingAnims, panel.anims.isEmpty || uptime < animsUptime else { return }
        fetchingAnims = true
        var request = URLRequest(url: daemonBase.appendingPathComponent("anims"))
        request.timeoutInterval = 3
        URLSession.shared.dataTask(with: request) { [weak self] data, _, error in
            let anims = error == nil ? decodeAnims(data ?? Data()) : [:]
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.fetchingAnims = false
                if !anims.isEmpty { self.panel.anims = anims }
            }
        }.resume()
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
                    self.noticeVersion(state)
                    self.loadAnimsIfNeeded(uptime: state.uptimeSec)
                    self.animsUptime = state.uptimeSec
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
        statusItem.button?.title = installing != nil ? " updating…" : r.title
        configure(panel, state: reachable ? lastState : nil)
        connectionItem.title = r.connection
        showingItem.title = r.showing
        transportItem.title = r.transport
        sessionsItem.title = r.sessions
        versionItem.title = r.version ?? ""
        versionItem.isHidden = r.version == nil
        if installing != nil {
            updateItem.title = "Installing update… (log: ~/Library/Logs/clawdbox/update.log)"
            updateItem.isHidden = false
            installUpdateItem.isHidden = true
        } else {
            let updateLine = r.update ?? updateNote
            updateItem.title = updateLine ?? ""
            updateItem.isHidden = updateLine == nil
            installUpdateItem.isHidden = r.update == nil || installedCheckout() == nil
        }
        checkUpdatesItem.isEnabled = installing == nil && !checkingUpdates

        // Force State: tick the held state; Release only when something is forced.
        let forced = reachable ? lastState?.forced : nil
        let held = reachable && lastState?.held == true
        for item in forceMenu.items {
            guard let s = item.representedObject as? String else { continue }
            item.state = held && s == forced ? .on : .off
        }
        releaseItem.title = forced.map { "Release \($0) (follow hooks)" } ?? "Release (follow hooks)"
        releaseItem.isHidden = forced == nil
        forceMenu.items.first(where: { $0.isSeparatorItem })?.isHidden = forced == nil
    }

    // MARK: actions

    @objc private func openPreviewer() {
        NSWorkspace.shared.open(daemonBase)
    }

    /// Hold the picked state on the panel until released; picking the held state again releases it.
    @objc private func forceState(_ sender: NSMenuItem) {
        guard let state = sender.representedObject as? String else { return }
        if sender.state == .on {
            releaseForce()
            return
        }
        var url = URLComponents(url: daemonBase.appendingPathComponent("show/\(state)"), resolvingAgainstBaseURL: false)!
        url.queryItems = [URLQueryItem(name: "hold", value: "1")]
        post(url.url!)
    }

    /// Let the hooks drive the panel again.
    @objc private func releaseForce() {
        post(daemonBase.appendingPathComponent("release"))
    }

    private func post(_ url: URL) {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 2
        URLSession.shared.dataTask(with: request) { [weak self] _, _, _ in
            DispatchQueue.main.async { self?.refresh() }
        }.resume()
    }

    /// Ask the daemon to look for a newer release now instead of at its next 6-hourly check,
    /// and say what it found in a dialog (the menu has closed by the time the answer arrives).
    @objc private func checkForUpdates() {
        guard !checkingUpdates, installing == nil else { return }
        checkingUpdates = true
        updateNote = "Checking for updates…"
        updateNoteSeen = false
        render()
        var request = URLRequest(url: daemonBase.appendingPathComponent("update-check"))
        request.httpMethod = "POST"
        request.timeoutInterval = 120  // ls-remote plus a shallow fetch
        URLSession.shared.dataTask(with: request) { [weak self] data, _, error in
            let info = error == nil ? data.flatMap { try? JSONDecoder().decode(DaemonState.Update.self, from: $0) } : nil
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.checkingUpdates = false
                self.updateNote = nil
                self.refresh()
                guard let info = info else {
                    self.alert("Couldn't check for updates",
                               error?.localizedDescription ?? "The daemon is not running. Use Restart Daemon, then try again.")
                    return
                }
                if info.updateAvailable {
                    self.offerUpdate(info)
                } else if let err = info.error {
                    self.alert("Couldn't check for updates", err)
                } else {
                    self.alert("Clawdbox is up to date", "You have \(info.version), the newest release.")
                }
            }
        }.resume()
    }

    private func offerUpdate(_ info: DaemonState.Update) {
        let title = "Clawdbox \(newestRelease(info)) is available"
        guard installedCheckout() != nil else {
            alert(title, "You have \(info.version). This install is not a git checkout set up by install-launchd, "
                + "so update it from Terminal with: clawdbox update")
            return
        }
        let answer = alert(title, "You have \(info.version). Installing takes about a minute; Clawdbox restarts "
                           + "when it is done and tells you the new version.", buttons: ["Install Now", "Later"])
        if answer == .alertFirstButtonReturn { installUpdate() }
    }

    @discardableResult
    private func alert(_ title: String, _ text: String, buttons: [String] = ["OK"]) -> NSApplication.ModalResponse {
        let a = NSAlert()
        a.messageText = title
        a.informativeText = text
        for b in buttons { a.addButton(withTitle: b) }
        NSApp.activate(ignoringOtherApps: true)  // a menu bar app is never frontmost on its own
        return a.runModal()
    }

    /// When the daemon comes back on a new version after Install Update…, say so in a dialog.
    /// Updates the background updater installs are not announced; the version line shows them.
    private func noticeVersion(_ state: DaemonState) {
        guard let version = state.update?.version else { return }
        let defaults = UserDefaults.standard
        let previous = defaults.string(forKey: "lastSeenVersion")
        defaults.set(version, forKey: "lastSeenVersion")
        let requestedAt = defaults.double(forKey: "updateRequestedAt")
        let requested = requestedAt > 0 && Date().timeIntervalSince1970 - requestedAt < 15 * 60
        if requestedAt > 0 && !requested { defaults.removeObject(forKey: "updateRequestedAt") }
        guard let was = previous, was != version, requested else { return }
        defaults.removeObject(forKey: "updateRequestedAt")
        installing = nil
        let answer = alert("Clawdbox updated to \(version)", "You were on \(was).", buttons: ["OK", "What's New"])
        if answer == .alertSecondButtonReturn,
           let url = URL(string: "https://github.com/edmerrett/clawdbox/releases/tag/v\(version)") {
            NSWorkspace.shared.open(url)
        }
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
    /// daemon and relaunches this app if the menu bar sources changed. Progress shows in the
    /// menu and the status item; noticeVersion reports the new version once it is running.
    @objc private func installUpdate() {
        guard installing == nil, let root = installedCheckout() else { return }
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/bash")
        task.arguments = [root.appendingPathComponent("scripts/update.sh").path]
        try? FileManager.default.createDirectory(at: logsDir, withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: updateLog.path) {
            FileManager.default.createFile(atPath: updateLog.path, contents: nil)
        }
        if let handle = try? FileHandle(forWritingTo: updateLog) {
            handle.seekToEndOfFile()
            task.standardOutput = handle
            task.standardError = handle
        }
        task.terminationHandler = { [weak self] t in
            DispatchQueue.main.async { self?.installFinished(t.terminationStatus) }
        }
        // survives this app being restarted by the update, so the result can still be reported
        UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: "updateRequestedAt")
        do {
            try task.run()
            installing = task
        } catch {
            UserDefaults.standard.removeObject(forKey: "updateRequestedAt")
            alert("Couldn't start the update", error.localizedDescription)
        }
        render()
    }

    /// Only reached when the update did not restart this app.
    private func installFinished(_ status: Int32) {
        guard installing != nil else { return }
        installing = nil
        if status == 0 {
            updateNote = "Update installed; waiting for the daemon to restart…"
            updateNoteSeen = false
        } else {
            UserDefaults.standard.removeObject(forKey: "updateRequestedAt")
            let answer = alert("Update failed", "Clawdbox stays on the version it had. The update log says why.",
                               buttons: ["Open Update Log", "OK"])
            if answer == .alertFirstButtonReturn { NSWorkspace.shared.open(updateLog) }
        }
        render()
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
        if let v = r.version { print(v) }
        if let u = r.update { print(u) }
        // The digital Divoom: the sprites it plays, and optionally a PNG of it (`--snapshot <file>`).
        var anims: [String: [PanelFrame]] = [:]
        if case .success(let data) = fetchSync("anims") { anims = decodeAnims(data) }
        print("anims: \(anims.count) (\(state.current): \(anims[state.current]?.count ?? 0) frames)")
        if let i = CommandLine.arguments.firstIndex(of: "--snapshot"), i + 1 < CommandLine.arguments.count {
            _ = NSApplication.shared
            let panel = PanelView()
            panel.anims = anims
            configure(panel, state: state)
            let path = CommandLine.arguments[i + 1]
            print("snapshot: \(snapshotPanel(panel, to: path) ? path : "failed")")
        }
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
