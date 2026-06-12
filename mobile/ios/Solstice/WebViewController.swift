import UIKit
import WebKit
import UserNotifications
import UniformTypeIdentifiers

// The iOS analogue of Android's MainActivity: hosts the WKWebView, wires up the native
// bridges, intercepts profile links, drives the keyboard inset, bridges JS dialogs, and
// routes notification presentation/taps back into the web app.
final class WebViewController: UIViewController, WKNavigationDelegate, WKUIDelegate,
                               UNUserNotificationCenterDelegate, UIDocumentPickerDelegate {

    private(set) var webView: WKWebView!
    private var bottomConstraint: NSLayoutConstraint!

    // Native bridges. Retained here for clarity even though WKUserContentController also
    // retains its message handlers.
    private let nativeFile = NativeFile()
    private let nativeLogs = NativeLogs()
    private let nativeNotification = NativeNotification()
    private let nativeClipboard = NativeClipboard()
    private let nativeBackground = NativeBackground()
    private let nativeSocket = NativeSocket()
    private lazy var nativeView = NativeView(host: self)

    // Matches the Android profileRegex — f-list.net profile links are shown in the in-app
    // profile viewer rather than navigated to.
    private let profileRegex = try! NSRegularExpression(
        pattern: "^https?://(www\\.)?f-list\\.net/c/([^/#]+)/?#?")

    // MARK: - Setup

    override func loadView() {
        view = UIView()
        view.backgroundColor = .black

        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []

        let ucc = WKUserContentController()
        if let bridgeURL = Bundle.main.url(forResource: "bridge", withExtension: "js"),
           let bridgeJS = try? String(contentsOf: bridgeURL, encoding: .utf8) {
            ucc.addUserScript(WKUserScript(source: bridgeJS,
                                           injectionTime: .atDocumentStart,
                                           forMainFrameOnly: true))
        }
        nativeFile.host = self
        ucc.addScriptMessageHandler(nativeFile, contentWorld: .page, name: "nativeFile")
        ucc.addScriptMessageHandler(nativeLogs, contentWorld: .page, name: "nativeLogs")
        ucc.addScriptMessageHandler(nativeNotification, contentWorld: .page, name: "nativeNotification")
        ucc.addScriptMessageHandler(nativeClipboard, contentWorld: .page, name: "nativeClipboard")
        ucc.addScriptMessageHandler(nativeBackground, contentWorld: .page, name: "nativeBackground")
        nativeSocket.host = self
        ucc.addScriptMessageHandler(nativeSocket, contentWorld: .page, name: "nativeSocket")
        ucc.addScriptMessageHandler(nativeView, contentWorld: .page, name: "nativeView")
        config.userContentController = ucc

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.bounces = false
        webView.isOpaque = false
        webView.backgroundColor = .black
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)

        // Edge-to-edge so CSS env(safe-area-inset-*) resolves; the bottom constraint is
        // adjusted when the keyboard appears (Android does an equivalent manual resize).
        bottomConstraint = webView.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.topAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            bottomConstraint
        ])
        self.webView = webView
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        UNUserNotificationCenter.current().delegate = self

        NotificationCenter.default.addObserver(
            self, selector: #selector(keyboardWillChange(_:)),
            name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        NotificationCenter.default.addObserver(
            self, selector: #selector(keyboardWillChange(_:)),
            name: UIResponder.keyboardWillHideNotification, object: nil)

        if let indexURL = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "www") {
            webView.loadFileURL(indexURL, allowingReadAccessTo: indexURL.deletingLastPathComponent())
        }
    }

    deinit { NotificationCenter.default.removeObserver(self) }

    // MARK: - Theme (NativeView)

    func applyTheme(_ theme: String) {
        let color: UIColor = (theme == "light")
            ? .white
            : UIColor(red: 0.15, green: 0.15, blue: 0.16, alpha: 1)
        view.backgroundColor = color
        webView.backgroundColor = color
        webView.scrollView.backgroundColor = color
    }

    // MARK: - Keyboard

    @objc private func keyboardWillChange(_ note: Notification) {
        guard let end = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue
        else { return }
        let isHiding = note.name == UIResponder.keyboardWillHideNotification
        let converted = view.convert(end, from: nil)
        let overlap = isHiding ? 0 : max(0, view.bounds.maxY - converted.minY)
        bottomConstraint.constant = -overlap
        let duration = (note.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double) ?? 0.25
        UIView.animate(withDuration: duration) { self.view.layoutIfNeeded() }
    }

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { return decisionHandler(.allow) }
        if url.isFileURL || url.scheme == "about" { return decisionHandler(.allow) }

        let urlString = url.absoluteString
        let range = NSRange(urlString.startIndex..., in: urlString)
        if let match = profileRegex.firstMatch(in: urlString, options: [], range: range),
           let charRange = Range(match.range(at: 2), in: urlString) {
            let name = String(urlString[charRange]).removingPercentEncoding ?? String(urlString[charRange])
            webView.evaluateJavaScript(
                "document.dispatchEvent(new CustomEvent('open-profile',{detail:\(Self.jsString(name))}))")
            return decisionHandler(.cancel)
        }

        if url.scheme == "profile", let authority = url.host,
           let ext = URL(string: "https://www.f-list.net/c/\(authority)") {
            UIApplication.shared.open(ext)
            return decisionHandler(.cancel)
        }
        if url.scheme == "http" || url.scheme == "https" {
            UIApplication.shared.open(url)
            return decisionHandler(.cancel)
        }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // Android calls this from onPageFinished; bridge globals were already installed at
        // document-start, so we only need to announce the platform here.
        webView.evaluateJavaScript("window.setupPlatform && window.setupPlatform('ios')")
    }

    // MARK: - WKUIDelegate (the web app uses alert()/confirm())

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = UIAlertController(title: "Solstice", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        topPresenter().present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = UIAlertController(title: "Solstice", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        topPresenter().present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        let alert = UIAlertController(title: "Solstice", message: prompt, preferredStyle: .alert)
        alert.addTextField { $0.text = defaultText }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in
            completionHandler(alert.textFields?.first?.text)
        })
        topPresenter().present(alert, animated: true)
    }

    // MARK: - Notifications (UNUserNotificationCenterDelegate)

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        // Show the banner even in the foreground (we manage our own sound separately).
        completionHandler([.banner, .list])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let data = response.notification.request.content.userInfo["data"] as? String ?? ""
        webView.evaluateJavaScript(
            "document.dispatchEvent(new CustomEvent('notification-clicked',{detail:{data:\(Self.jsString(data))}}))")
        completionHandler()
    }

    // MARK: - Export / Import (called by NativeFile)

    func presentShareSheet(fileURL: URL) {
        let activity = UIActivityViewController(activityItems: [fileURL], applicationActivities: nil)
        activity.popoverPresentationController?.sourceView = view
        activity.popoverPresentationController?.sourceRect =
            CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 0, height: 0)
        topPresenter().present(activity, animated: true)
    }

    func presentImportPicker() {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [UTType.zip])
        picker.delegate = self
        picker.allowsMultipleSelection = false
        topPresenter().present(picker, animated: true)
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let url = urls.first else { return deliverImport(nil, nil) }
        let accessed = url.startAccessingSecurityScopedResource()
        defer { if accessed { url.stopAccessingSecurityScopedResource() } }
        deliverImport(try? Data(contentsOf: url), url.lastPathComponent)
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        deliverImport(nil, nil)
    }

    private func deliverImport(_ data: Data?, _ name: String?) {
        // Match the Android import flow: stage the picked file into app storage and hand the
        // web layer a temp filename (it reads it back in chunks via NativeFile.readBytes),
        // rather than passing the whole file as one giant base64 string.
        let tmpName = data.flatMap { nativeFile.stageImportFile($0) }
        let tmpArg = tmpName.map { Self.jsString($0) } ?? "null"
        let nameArg = (tmpName != nil ? name : nil).map { Self.jsString($0) } ?? "null"
        webView.evaluateJavaScript("window.__mobileFilePicker && window.__mobileFilePicker(\(tmpArg),\(nameArg))")
    }

    // MARK: - Helpers

    private func topPresenter() -> UIViewController {
        var presenter: UIViewController = self
        while let next = presenter.presentedViewController { presenter = next }
        return presenter
    }

    /// Encodes a string as a safe JS string literal (quotes included) for evaluateJavaScript.
    static func jsString(_ value: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: [value]),
              var json = String(data: data, encoding: .utf8) else { return "\"\"" }
        json.removeFirst()  // drop leading [
        json.removeLast()   // drop trailing ]
        return json
    }

    /// Run JS in the web view from any thread (hops to the main thread). Used by NativeSocket to
    /// push socket events to the page.
    func evalJS(_ js: String) {
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript(js, completionHandler: nil)
        }
    }
}
