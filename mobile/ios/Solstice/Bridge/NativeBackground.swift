import UIKit
import WebKit
import AVFoundation

// Mirrors Background.kt / BackgroundService.kt. iOS has no foreground service + wake lock, so
// to keep the WebSocket alive while backgrounded we use the well-known silent-audio trick: an
// app with the `audio` background mode (see Info.plist) stays running as long as it is
// producing audio. We loop an inaudible PCM buffer, which keeps the WKWebView (and its JS
// WebSocket) running. start()/stop() are driven by the connection lifecycle in Index.vue.
//
// We use `.mixWithOthers` so we don't hijack the user's music; the app is still "playing
// audio" for background purposes. As a secondary measure we also hold a background task.
final class NativeBackground: NSObject, WKScriptMessageHandlerWithReply {
    private var taskId: UIBackgroundTaskIdentifier = .invalid
    private var silencePlayer: AVAudioPlayer?

    func userContentController(_ userContentController: WKUserContentController,
                              didReceive message: WKScriptMessage,
                              replyHandler: @escaping (Any?, String?) -> Void) {
        guard let call = BridgeCall(message) else { return replyHandler(nil, "bad call") }
        switch call.method {
        case "start": start(); replyHandler(nil, nil)
        case "stop": stop(); replyHandler(nil, nil)
        default: replyHandler(nil, "unknown method \(call.method)")
        }
    }

    private func start() {
        stopBackgroundTask()
        taskId = UIApplication.shared.beginBackgroundTask(withName: "fchat") { [weak self] in
            self?.stopBackgroundTask()
        }

        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, options: [.mixWithOthers])
            try session.setActive(true)
            if silencePlayer == nil {
                silencePlayer = try AVAudioPlayer(data: Self.makeSilentWAV())
                silencePlayer?.numberOfLoops = -1   // loop forever
                silencePlayer?.volume = 0
                silencePlayer?.prepareToPlay()
            }
            silencePlayer?.play()
        } catch {
            // If audio can't start, we still have the (short) background-task grace window.
        }
    }

    private func stop() {
        silencePlayer?.stop()
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
        stopBackgroundTask()
    }

    private func stopBackgroundTask() {
        guard taskId != .invalid else { return }
        UIApplication.shared.endBackgroundTask(taskId)
        taskId = .invalid
    }

    /// Builds a 1-second mono 16-bit PCM WAV of silence in memory (no bundled asset needed).
    private static func makeSilentWAV(seconds: Double = 1, sampleRate: UInt32 = 8000) -> Data {
        let bytesPerSample: UInt32 = 2
        let numSamples = UInt32(Double(sampleRate) * seconds)
        let dataSize = numSamples * bytesPerSample
        let byteRate = sampleRate * bytesPerSample

        var d = Data()
        func ascii(_ s: String) { d.append(contentsOf: Array(s.utf8)) }
        func le16(_ v: UInt16) { d.append(UInt8(v & 0xFF)); d.append(UInt8((v >> 8) & 0xFF)) }
        func le32(_ v: UInt32) {
            d.append(UInt8(v & 0xFF)); d.append(UInt8((v >> 8) & 0xFF))
            d.append(UInt8((v >> 16) & 0xFF)); d.append(UInt8((v >> 24) & 0xFF))
        }

        ascii("RIFF"); le32(36 + dataSize); ascii("WAVE")
        ascii("fmt "); le32(16); le16(1); le16(1)               // PCM, mono
        le32(sampleRate); le32(byteRate); le16(2); le16(16)     // block align, bits/sample
        ascii("data"); le32(dataSize)
        d.append(Data(count: Int(dataSize)))                    // silence (zeros)
        return d
    }
}
