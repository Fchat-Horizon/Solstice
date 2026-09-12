import UIKit

// Scene-based life cycle (required by the iOS 26 / Xcode 27 SDK). Single full-screen window
// hosting the WebView; mirrors the old AppDelegate window bootstrap. App-level background/
// foreground notifications (which NativeSocket and NativeBackground observe) still fire, so the
// keep-alive machinery is unaffected.
final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession,
               options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = WebViewController()
        window.makeKeyAndVisible()
        self.window = window
    }
}
