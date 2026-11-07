import UIKit
import WebKit
import UniformTypeIdentifiers

// One character's page: a WKWebView with its own set of native bridges, the iOS side of the
// multi-character switcher (mobile/sessions.ts). Android's prototype runs one WebView per character
// the same way, as desktop gives every tab its own page. Because each page has its own bridge
// instances, per-character native state (the NativeLogs index, the native socket and the frames it
// buffers in the background) never mixes. WebViewController stacks the pages and keeps the active one
// on top; the others stay in the window underneath it, so WebKit treats them as visible and their
// JavaScript keeps running in the foreground, the way a desktop tab in the background does.
final class ChatPage: NSObject, WKNavigationDelegate, WKUIDelegate, UIDocumentPickerDelegate {
    let id: Int
    private(set) var webView: WKWebView!
    /// The state this page last reported through NativeSessions (character, status, unread counts).
    var state: [String: Any] = [:]
    /// The page theme's background, so the window behind it can match while it is in front.
    private(set) var themeColor = UIColor.black
    private weak var controller: WebViewController?

    // When the keyboard opens, WKWebView's built-in caret-avoidance programmatically scrolls the
    // document down (negative contentOffset). Stacked on top of the controller's keyboard frame-resize,
    // that makes the whole page visibly drop and spring back every time the keyboard appears. The app
    // is a fixed-height SPA whose lists scroll in inner elements, so the outer scroll view must always
    // sit at the top; we pin it there. isScrollEnabled / bounces=false do NOT stop this because the
    // offset is set programmatically, not by a drag. KVO fires synchronously before the next render,
    // so WebKit's shove never actually paints.
    private var contentOffsetObservation: NSKeyValueObservation?

    // Native bridges, one set per page. WKUserContentController also retains its message handlers;
    // tearDown() drops them so a closed page frees its socket and log index.
    private let nativeFile = NativeFile()
    private let nativeLogs = NativeLogs()
    private let nativeNotification = NativeNotification()
    private let nativeClipboard = NativeClipboard()
    private let nativeSocket = NativeSocket()
    private let nativeSync = NativeSync()
    private let nativeView = NativeView()
    private let nativeSessions: NativeSessions
    private let contentController = WKUserContentController()

    // Matches the Android profileRegex: f-list.net profile links are shown in the in-app
    // profile viewer rather than navigated to.
    private static let profileRegex = try! NSRegularExpression(
        pattern: "^https?://(www\\.)?f-list\\.net/c/([^/#]+)/?#?")

    /// `bootScript` runs before bridge.js and hands the page its session id and the shared session
    /// state, which mobile/sessions.ts reads synchronously as soon as the app script loads.
    init(id: Int, controller: WebViewController, bootScript: String) {
        self.id = id
        self.controller = controller
        nativeSessions = NativeSessions(pageId: id, controller: controller)
        super.init()

        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []

        let ucc = contentController
        ucc.addUserScript(WKUserScript(source: bootScript, injectionTime: .atDocumentStart,
                                       forMainFrameOnly: true))
        if let bridgeURL = Bundle.main.url(forResource: "bridge", withExtension: "js"),
           let bridgeJS = try? String(contentsOf: bridgeURL, encoding: .utf8) {
            ucc.addUserScript(WKUserScript(source: bridgeJS,
                                           injectionTime: .atDocumentStart,
                                           forMainFrameOnly: true))
        }
        nativeFile.host = self
        nativeSocket.host = self
        nativeSocket.pageId = id
        nativeNotification.pageId = id
        nativeView.host = self
        ucc.addScriptMessageHandler(nativeFile, contentWorld: .page, name: "nativeFile")
        ucc.addScriptMessageHandler(nativeLogs, contentWorld: .page, name: "nativeLogs")
        ucc.addScriptMessageHandler(nativeNotification, contentWorld: .page, name: "nativeNotification")
        ucc.addScriptMessageHandler(nativeClipboard, contentWorld: .page, name: "nativeClipboard")
        // One keep-alive for the whole app, shared by every page: it keeps playing while any
        // character is connected (see NativeBackground's claims).
        ucc.addScriptMessageHandler(controller.nativeBackground, contentWorld: .page, name: "nativeBackground")
        ucc.addScriptMessageHandler(nativeSocket, contentWorld: .page, name: "nativeSocket")
        ucc.addScriptMessageHandler(nativeSync, contentWorld: .page, name: "nativeSync")
        ucc.addScriptMessageHandler(nativeView, contentWorld: .page, name: "nativeView")
        ucc.addScriptMessageHandler(nativeSessions, contentWorld: .page, name: "nativeSessions")
        config.userContentController = ucc

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.bounces = false
        webView.isOpaque = false
        webView.backgroundColor = themeColor
        // Debug builds only: don't expose the WebView to Safari Web Inspector in shipped/Release
        // builds (CI builds -configuration Release, where DEBUG is undefined).
        #if DEBUG
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        #endif
        webView.translatesAutoresizingMaskIntoConstraints = false
        self.webView = webView

        contentOffsetObservation = webView.scrollView.observe(\.contentOffset, options: [.new]) { scrollView, _ in
            if scrollView.contentOffset.y != 0 { scrollView.contentOffset.y = 0 }
        }
    }

    func load() {
        if let indexURL = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "www") {
            webView.loadFileURL(indexURL, allowingReadAccessTo: indexURL.deletingLastPathComponent())
        }
    }

    /// Only the page in front takes touches and is read by VoiceOver; the ones under it stay live.
    func setActive(_ active: Bool) {
        webView.isUserInteractionEnabled = active
        webView.accessibilityElementsHidden = !active
    }

    /// The character was logged out from the switcher: close its socket (it is native, so it would
    /// otherwise outlive the page), give up its keep-alive claim and free its bridges.
    func tearDown() {
        nativeSocket.shutdown()
        controller?.nativeBackground.release(contentController)
        contentOffsetObservation = nil
        contentController.removeAllScriptMessageHandlers()
        contentController.removeAllUserScripts()
        webView.stopLoading()
        webView.removeFromSuperview()
    }

    // MARK: - Theme (NativeView)

    func applyTheme(_ theme: String) {
        themeColor = (theme == "light")
            ? .white
            : UIColor(red: 0.15, green: 0.15, blue: 0.16, alpha: 1)
        webView.backgroundColor = themeColor
        webView.scrollView.backgroundColor = themeColor
        controller?.pageDidChangeTheme(self)
    }

    // MARK: - JS dispatch

    /// Run JS in this page from any thread (hops to the main thread). Used by NativeSocket to push
    /// socket events and by the controller to push session state.
    func evalJS(_ js: String) {
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript(js, completionHandler: nil)
        }
    }

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { return decisionHandler(.allow) }
        if url.isFileURL || url.scheme == "about" { return decisionHandler(.allow) }

        let urlString = url.absoluteString
        let range = NSRange(urlString.startIndex..., in: urlString)
        if let match = Self.profileRegex.firstMatch(in: urlString, options: [], range: range),
           let charRange = Range(match.range(at: 2), in: urlString) {
            let name = String(urlString[charRange]).removingPercentEncoding ?? String(urlString[charRange])
            webView.evaluateJavaScript(
                "document.dispatchEvent(new CustomEvent('open-profile',{detail:\(WebViewController.jsString(name))}))")
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
        // Drop the keyboard "‹ › Done" accessory bar (the WKContentView exists by now).
        webView.hideInputAccessoryBar()
        // The boot script carried the session state as it was when this page was created; anything
        // pushed while it loaded went to the previous document, so send the current state now.
        controller?.pageDidLoad(self)
    }

    // MARK: - WKUIDelegate (the web app uses alert()/confirm())

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        guard let presenter = controller?.topPresenter() else { return completionHandler() }
        let alert = UIAlertController(title: "Solstice", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        presenter.present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        guard let presenter = controller?.topPresenter() else { return completionHandler(false) }
        let alert = UIAlertController(title: "Solstice", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        presenter.present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        guard let presenter = controller?.topPresenter() else { return completionHandler(nil) }
        let alert = UIAlertController(title: "Solstice", message: prompt, preferredStyle: .alert)
        alert.addTextField { $0.text = defaultText }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in
            completionHandler(alert.textFields?.first?.text)
        })
        presenter.present(alert, animated: true)
    }

    // The Device Sync QR scanner opens the camera via getUserMedia. Grant so WebKit shows its own
    // camera prompt (backed by NSCameraUsageDescription in Info.plist); the camera is used nowhere else.
    @available(iOS 15.0, *)
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.grant)
    }

    // MARK: - Export / Import (called by NativeFile)

    func presentShareSheet(fileURL: URL) {
        guard let controller = controller else { return }
        let activity = UIActivityViewController(activityItems: [fileURL], applicationActivities: nil)
        activity.popoverPresentationController?.sourceView = controller.view
        activity.popoverPresentationController?.sourceRect =
            CGRect(x: controller.view.bounds.midX, y: controller.view.bounds.midY, width: 0, height: 0)
        controller.topPresenter().present(activity, animated: true)
    }

    func presentImportPicker() {
        guard let controller = controller else { return deliverImport(nil, nil) }
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [UTType.zip])
        picker.delegate = self
        picker.allowsMultipleSelection = false
        controller.topPresenter().present(picker, animated: true)
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
        let tmpArg = tmpName.map { WebViewController.jsString($0) } ?? "null"
        let nameArg = (tmpName != nil ? name : nil).map { WebViewController.jsString($0) } ?? "null"
        webView.evaluateJavaScript("window.__mobileFilePicker && window.__mobileFilePicker(\(tmpArg),\(nameArg))")
    }
}
