import UIKit
import WebKit
import UserNotifications

// The iOS analogue of Android's MainActivity. It hosts one ChatPage (a WKWebView with its own native
// bridges) per signed-in character, up to maxSessions, stacked in one container with the active page
// on top. It owns what the pages share: the keyboard inset, the notification delegate (a tap brings
// the character it was for to the front), the background keep-alive, and the session state that
// mobile/sessions.ts reads (each page's reported character, status and unread counts, plus the
// account credentials and the API ticket, since F-List cancels an account's older tickets whenever it
// issues a new one).
//
// The keyboard slide: two mechanisms stack. keyboardWillChange below animates the page container
// above the keyboard, and each ChatPage pins its scroll view's contentOffset to 0 so WebKit's own
// caret-avoidance shove never paints (see the comment on ChatPage.contentOffsetObservation).
final class WebViewController: UIViewController, UNUserNotificationCenterDelegate {

    static let maxSessions = 3

    /// Shared by every page; keeps playing while any of them holds a claim.
    let nativeBackground = NativeBackground()

    private let pageContainer = UIView()
    private var bottomConstraint: NSLayoutConstraint!
    private var pages: [ChatPage] = []
    private var nextPageId = 1
    private var activeId = 0
    /// JSON strings as mobile/sessions.ts writes them ("" until a page logs in).
    private var sharedCredentials = ""
    private var sharedTicket = ""

    private var activePage: ChatPage? { pages.first { $0.id == activeId } ?? pages.first }

    // MARK: - Setup

    override func loadView() {
        view = UIView()
        view.backgroundColor = .black

        // Edge-to-edge so CSS env(safe-area-inset-*) resolves; the bottom constraint is
        // adjusted when the keyboard appears (Android does an equivalent manual resize).
        pageContainer.translatesAutoresizingMaskIntoConstraints = false
        pageContainer.backgroundColor = .clear
        view.addSubview(pageContainer)
        bottomConstraint = pageContainer.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        NSLayoutConstraint.activate([
            pageContainer.topAnchor.constraint(equalTo: view.topAnchor),
            pageContainer.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            pageContainer.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            bottomConstraint
        ])
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

        addPage()
    }

    deinit { NotificationCenter.default.removeObserver(self) }

    // MARK: - Sessions (NativeSessions)

    /// Opens a page for another character and brings it to the front. False when all are in use.
    @discardableResult
    func addPage() -> Bool {
        guard pages.count < Self.maxSessions else { return false }
        let id = nextPageId
        nextPageId += 1
        // The new page is already in the snapshot it boots with, so it sees itself straight away.
        var entries = sessionEntries()
        entries.append(["id": id])
        let page = ChatPage(id: id, controller: self, bootScript: bootScript(id: id, entries: entries))
        pages.append(page)
        let pageView: UIView = page.webView
        pageContainer.addSubview(pageView)
        NSLayoutConstraint.activate([
            pageView.topAnchor.constraint(equalTo: pageContainer.topAnchor),
            pageView.bottomAnchor.constraint(equalTo: pageContainer.bottomAnchor),
            pageView.leadingAnchor.constraint(equalTo: pageContainer.leadingAnchor),
            pageView.trailingAnchor.constraint(equalTo: pageContainer.trailingAnchor)
        ])
        page.load()
        activate(id)
        return true
    }

    /// Logs a character out of the switcher: its page goes, and the first remaining one comes forward.
    func removePage(_ id: Int) {
        guard pages.count > 1, let index = pages.firstIndex(where: { $0.id == id }) else { return }
        let page = pages.remove(at: index)
        page.tearDown()
        if activeId == id { activate(pages[0].id) } else { broadcast() }
    }

    func activate(_ id: Int) {
        guard let page = pages.first(where: { $0.id == id }) else { return }
        // Drop the keyboard first, or it stays attached to the page going under and types into it.
        view.endEditing(true)
        activeId = id
        pageContainer.bringSubviewToFront(page.webView)
        for other in pages { other.setActive(other.id == id) }
        view.backgroundColor = page.themeColor
        broadcast()
    }

    func updateState(of id: Int, json: String) {
        guard let page = pages.first(where: { $0.id == id }) else { return }
        let parsed = json.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) }
        page.state = (parsed as? [String: Any]) ?? [:]
        broadcast()
    }

    func setSharedCredentials(_ json: String, from id: Int) {
        sharedCredentials = json
        push("{credentials:\(Self.jsString(json))}", except: id)
    }

    func setSharedTicket(_ json: String, from id: Int) {
        sharedTicket = json
        push("{ticket:\(Self.jsString(json))}", except: id)
    }

    func pageDidLoad(_ page: ChatPage) {
        page.evalJS(pushJS("{state:\(snapshotJSON(sessionEntries())),credentials:\(Self.jsString(sharedCredentials))," +
                           "ticket:\(Self.jsString(sharedTicket))}"))
    }

    func pageDidChangeTheme(_ page: ChatPage) {
        if page.id == activeId { view.backgroundColor = page.themeColor }
    }

    private func sessionEntries() -> [[String: Any]] {
        pages.map { page in
            var entry = page.state
            entry["id"] = page.id
            return entry
        }
    }

    // The shape mobile/sessions.ts applies: {active, max, sessions: [{id, character, unread, ...}]}.
    private func snapshotJSON(_ entries: [[String: Any]]) -> String {
        let snapshot: [String: Any] = ["active": activeId, "max": Self.maxSessions, "sessions": entries]
        guard let data = try? JSONSerialization.data(withJSONObject: snapshot),
              let json = String(data: data, encoding: .utf8) else { return "{\"active\":0,\"max\":3,\"sessions\":[]}" }
        return json
    }

    private func bootScript(id: Int, entries: [[String: Any]]) -> String {
        "window.__solsticeSessionBoot={id:\(id),state:\(snapshotJSON(entries))," +
            "credentials:\(Self.jsString(sharedCredentials)),ticket:\(Self.jsString(sharedTicket))};"
    }

    private func pushJS(_ update: String) -> String {
        "window.__solsticeSessionsPush && window.__solsticeSessionsPush(\(update))"
    }

    private func push(_ update: String, except id: Int? = nil) {
        let js = pushJS(update)
        for page in pages where page.id != id { page.evalJS(js) }
    }

    private func broadcast() {
        push("{state:\(snapshotJSON(sessionEntries()))}")
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

    // MARK: - Notifications (UNUserNotificationCenterDelegate)

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        // Show the banner even in the foreground (we manage our own sound separately).
        completionHandler([.banner, .list])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        let data = info["data"] as? String ?? ""
        // Bring the character the notification was for to the front, then let its page open the
        // conversation. Notifications from before this field existed go to the page in front.
        if let session = (info["session"] as? NSNumber)?.intValue, session != activeId,
           pages.contains(where: { $0.id == session }) {
            activate(session)
        }
        activePage?.webView.evaluateJavaScript(
            "document.dispatchEvent(new CustomEvent('notification-clicked',{detail:{data:\(Self.jsString(data))}}))")
        completionHandler()
    }

    // MARK: - Helpers

    func topPresenter() -> UIViewController {
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
}
