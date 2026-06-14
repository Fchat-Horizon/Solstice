import UIKit
import WebKit
import ObjectiveC

// Helper whose `inputAccessoryView` getter (returning nil) is grafted onto a runtime subclass of
// the live WKContentView to hide the "‹ › Done" toolbar WKWebView shows above the keyboard.
private final class NoInputAccessory: NSObject {
    @objc var inputAccessoryView: UIView? { nil }
}

extension WKWebView {
    /// Hide the keyboard input accessory toolbar. WKWebView exposes no API for this, so subclass the
    /// live WKContentView at runtime and override `inputAccessoryView` to return nil. Idempotent
    /// (reuses the generated subclass on repeat calls).
    func hideInputAccessoryBar() {
        guard let target = scrollView.subviews.first(where: {
            String(describing: type(of: $0)).hasPrefix("WKContent")
        }) else { return }

        let newClassName = "\(type(of: target))_NoInputAccessory"
        if let existing = NSClassFromString(newClassName) {
            object_setClass(target, existing)
            return
        }
        guard let baseClass = object_getClass(target),
              let subclass = objc_allocateClassPair(baseClass, newClassName, 0)
        else { return }

        let selector = #selector(getter: UIResponder.inputAccessoryView)
        if let method = class_getInstanceMethod(NoInputAccessory.self, selector) {
            class_addMethod(subclass, selector,
                            method_getImplementation(method),
                            method_getTypeEncoding(method))
        }
        objc_registerClassPair(subclass)
        object_setClass(target, subclass)
    }
}
