import AppKit
import Darwin
import Foundation

final class SeerrApplication: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private let statusLine = NSMenuItem(title: "Starting Seerr…", action: nil, keyEquivalent: "")
    private let openItem = NSMenuItem(title: "Open Seerr", action: #selector(openSeerr), keyEquivalent: "o")
    private var child: Process?
    private var timer: Timer?
    private var started = Date()
    private var stopping = false
    private var ready = false
    private var dataDirectory: URL!
    private var webURL: URL!
    private var signals: [DispatchSourceSignal] = []
    private let networkItem = NSMenuItem(title: "Allow Network Access", action: #selector(toggleNetwork), keyEquivalent: "")

    func applicationDidFinishLaunching(_ notification: Notification) {
        for name in [SIGTERM, SIGINT] {
            signal(name, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: name, queue: .main)
            source.setEventHandler { NSApp.terminate(nil) }
            source.resume()
            signals.append(source)
        }
        let environment = ProcessInfo.processInfo.environment
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        dataDirectory = environment["SEERR_NATIVE_CONFIG_DIR"].map { URL(fileURLWithPath: $0, isDirectory: true) }
            ?? appSupport.appendingPathComponent("Seerr", isDirectory: true)
        let port = environment["SEERR_NATIVE_PORT"] ?? "5055"
        guard let portNumber = UInt16(port), portNumber > 0 else {
            fail("The Seerr port is invalid."); return
        }
        webURL = URL(string: "http://127.0.0.1:\(portNumber)")!
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "Seerr"
        let menu = NSMenu()
        statusLine.isEnabled = false
        menu.addItem(statusLine)
        menu.addItem(.separator())
        openItem.target = self
        openItem.isEnabled = false
        menu.addItem(openItem)
        let showData = NSMenuItem(title: "Show Data Folder", action: #selector(showDataFolder), keyEquivalent: "")
        showData.target = self
        menu.addItem(showData)
        networkItem.target = self
        networkItem.state = UserDefaults.standard.bool(forKey: "allowNetworkAccess") ? .on : .off
        menu.addItem(networkItem)
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "Quit Seerr", action: #selector(quitSeerr), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
        statusItem.menu = menu

        do {
            for directory in [dataDirectory!, dataDirectory.appendingPathComponent("db"), dataDirectory.appendingPathComponent("logs")] {
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            }
            guard portAvailable(portNumber) else {
                fail("Port \(portNumber) is already in use. Stop the other service or set SEERR_NATIVE_PORT before launching Seerr.")
                return
            }
            guard let serverURL = Bundle.main.url(forAuxiliaryExecutable: "SeerrServer") else {
                throw NSError(domain: "Seerr", code: 1)
            }
            let logURL = dataDirectory.appendingPathComponent("logs/native-launcher.log")
            if !FileManager.default.fileExists(atPath: logURL.path) {
                FileManager.default.createFile(atPath: logURL.path, contents: nil)
            }
            let log = try FileHandle(forWritingTo: logURL)
            try log.seekToEnd()
            let server = Process()
            server.executableURL = serverURL
            var variables = environment
            variables["CONFIG_DIRECTORY"] = dataDirectory.path
            variables["PORT"] = String(portNumber)
            variables["HOST"] = environment["SEERR_NATIVE_HOST"] ??
                (UserDefaults.standard.bool(forKey: "allowNetworkAccess") ? "0.0.0.0" : "127.0.0.1")
            server.environment = variables
            server.standardOutput = log
            server.standardError = log
            server.terminationHandler = { [weak self] process in
                DispatchQueue.main.async {
                    guard let self, !self.stopping else { return }
                    self.fail("The Seerr server stopped (exit \(process.terminationStatus)). See logs/native-launcher.log in the data folder.")
                }
            }
            try server.run()
            child = server
            started = Date()
            timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.checkReady() }
        } catch {
            fail("Could not start Seerr: \(error.localizedDescription)")
        }
    }

    private func portAvailable(_ port: UInt16) -> Bool {
        let descriptor = socket(AF_INET, SOCK_STREAM, 0)
        guard descriptor >= 0 else { return false }
        defer { close(descriptor) }
        var reuse: Int32 = 1
        guard setsockopt(descriptor, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout<Int32>.size)) == 0 else { return false }
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = port.bigEndian
        address.sin_addr = in_addr(s_addr: in_addr_t(INADDR_LOOPBACK).bigEndian)
        return withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) == 0
            }
        }
    }

    private func checkReady() {
        guard child?.isRunning == true, !ready else { return }
        if Date().timeIntervalSince(started) > 120 {
            fail("Seerr did not start within two minutes. See logs/native-launcher.log in the data folder.")
            return
        }
        let request = URLRequest(url: webURL.appendingPathComponent("api/v1/status"), cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 2)
        URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
            guard let self, (response as? HTTPURLResponse)?.statusCode == 200 else { return }
            DispatchQueue.main.async {
                guard !self.ready, self.child?.isRunning == true else { return }
                self.ready = true
                self.timer?.invalidate()
                self.statusLine.title = "Seerr is running"
                self.openItem.isEnabled = true
                if ProcessInfo.processInfo.environment["SEERR_NATIVE_NO_BROWSER"] != "1" { self.openSeerr() }
            }
        }.resume()
    }

    private func fail(_ message: String) {
        fputs("Seerr: \(message)\n", stderr)
        timer?.invalidate()
        statusLine.title = "Seerr could not start"
        openItem.isEnabled = false
        let alert = NSAlert()
        alert.messageText = "Seerr could not start"
        alert.informativeText = message
        alert.addButton(withTitle: "Quit")
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
        NSApp.terminate(nil)
    }

    @objc private func openSeerr() { NSWorkspace.shared.open(webURL) }
    @objc private func showDataFolder() { NSWorkspace.shared.open(dataDirectory) }
    @objc private func toggleNetwork() {
        let enable = !UserDefaults.standard.bool(forKey: "allowNetworkAccess")
        let alert = NSAlert()
        alert.messageText = enable ? "Allow network access?" : "Disable network access?"
        alert.informativeText = enable
            ? "Seerr will listen on all network interfaces after you quit and reopen it. Anyone who can reach this Mac can see its sign-in page."
            : "Seerr will listen only on this Mac after you quit and reopen it."
        alert.addButton(withTitle: enable ? "Allow" : "Disable")
        alert.addButton(withTitle: "Cancel")
        NSApp.activate(ignoringOtherApps: true)
        if alert.runModal() == .alertFirstButtonReturn {
            UserDefaults.standard.set(enable, forKey: "allowNetworkAccess")
            networkItem.state = enable ? .on : .off
        }
    }
    @objc private func quitSeerr() { NSApp.terminate(nil) }

    func applicationWillTerminate(_ notification: Notification) {
        stopping = true
        timer?.invalidate()
        if let child, child.isRunning {
            child.terminate()
            child.waitUntilExit()
        }
    }
}

let application = NSApplication.shared
let delegate = SeerrApplication()
application.delegate = delegate
application.setActivationPolicy(.accessory)
application.run()
