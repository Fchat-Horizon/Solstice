import UIKit
import WebKit
import AVFoundation

// Mirrors Background.kt / BackgroundService.kt. iOS has no foreground service + wake lock, so
// to keep the WebSocket alive while backgrounded we use the silent-audio trick: an app with
// the `audio` background mode (Info.plist) stays running as long as it produces audio. We
// loop an inaudible (very low amplitude, NOT pure digital-silence) PCM buffer.
//
// Robustness matters because the naive version gets the app killed:
//   * Pure digital silence can trip iOS's "not actually producing audio" termination, so the
//     buffer carries a tiny non-zero signal.
//   * After an interruption (phone call, another app's audio) the session is deactivated; if
//     we don't resume, audio stops, the app is suspended and may be killed — so we observe
//     interruption/route-change notifications and restart.
//
// LiveContainer caveat: the guest's UIBackgroundModes only take effect if the LiveContainer
// host honors background audio for the guest. If iOS kills the app on backgrounding under
// LiveContainer, enable background audio / "keep alive" for Solstice in LiveContainer's
// per-app settings (or run it standalone). See the README "iOS limitations" section.
final class NativeBackground: NSObject, WKScriptMessageHandlerWithReply {
    private var taskId: UIBackgroundTaskIdentifier = .invalid
    private var player: AVAudioPlayer?
    private var active = false

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
        guard !active else { return }
        active = true
        beginTask()
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(handleInterruption(_:)),
                           name: AVAudioSession.interruptionNotification, object: nil)
        center.addObserver(self, selector: #selector(handleRouteChange(_:)),
                           name: AVAudioSession.routeChangeNotification, object: nil)
        // mediaserverd (the media server) can reset - rare, but more likely under memory pressure,
        // which the WebView creates plenty of. A reset invalidates the audio session AND every
        // AVAudioPlayer, so the keep-alive tone stops for good, the app is suspended, and the native
        // socket dies: a silent, intermittent background disconnect. Rebuild everything on reset.
        center.addObserver(self, selector: #selector(handleMediaReset),
                           name: AVAudioSession.mediaServicesWereResetNotification, object: nil)
        // Safety net: a background audio restart can silently fail (you can't always reactivate the
        // session while suspended). On every return to the foreground, make sure the tone is still
        // playing so the NEXT backgrounding is protected even if the last recovery didn't take.
        center.addObserver(self, selector: #selector(ensureAudio),
                           name: UIApplication.didBecomeActiveNotification, object: nil)
        startAudio()
    }

    private func stop() {
        guard active else { return }
        active = false
        NotificationCenter.default.removeObserver(self)
        player?.stop()
        player = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
        endTask()
    }

    private func startAudio() {
        do {
            let session = AVAudioSession.sharedInstance()
            // .mixWithOthers so we don't interrupt the user's music; still counts as "playing".
            try session.setCategory(.playback, options: [.mixWithOthers])
            try session.setActive(true)
            if player == nil {
                player = try AVAudioPlayer(data: Self.makeKeepAliveWAV())
                player?.numberOfLoops = -1
            }
            // play() returns false when the player is orphaned (e.g. after a media-server reset). A
            // stale player that won't play is the same as no keep-alive, so rebuild it once and retry.
            if player?.play() != true {
                player = try AVAudioPlayer(data: Self.makeKeepAliveWAV())
                player?.numberOfLoops = -1
                player?.play()
            }
        } catch {
            // Audio unavailable (e.g. host didn't grant background audio): fall back to the
            // background-task grace window only. Won't keep alive long, but won't crash.
        }
    }

    @objc private func handleInterruption(_ note: Notification) {
        guard active,
              let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              AVAudioSession.InterruptionType(rawValue: raw) == .ended else { return }
        startAudio()
    }

    @objc private func handleRouteChange(_ note: Notification) {
        guard active, player?.isPlaying != true else { return }
        startAudio()
    }

    // After a media-server reset every audio object is dead; dispose the old player unconditionally
    // (isPlaying can't be trusted here) and rebuild the whole chain from scratch.
    @objc private func handleMediaReset() {
        guard active else { return }
        player?.stop()
        player = nil
        startAudio()
    }

    // Foreground safety net: only restarts if the tone actually stopped, so a healthy session is
    // left untouched.
    @objc private func ensureAudio() {
        guard active, player?.isPlaying != true else { return }
        startAudio()
    }

    private func beginTask() {
        endTask()
        taskId = UIApplication.shared.beginBackgroundTask(withName: "fchat") { [weak self] in
            self?.endTask()
        }
    }

    private func endTask() {
        guard taskId != .invalid else { return }
        UIApplication.shared.endBackgroundTask(taskId)
        taskId = .invalid
    }

    /// 1-second mono 16-bit PCM WAV carrying a tiny, inaudible low-frequency signal (amplitude
    /// ~16/32767 ≈ -66 dBFS) rather than pure silence, so iOS registers real audio output.
    private static func makeKeepAliveWAV(sampleRate: UInt32 = 8000) -> Data {
        let bytesPerSample: UInt32 = 2
        let numSamples = sampleRate
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
        for i in 0..<Int(numSamples) {
            let s = Int16(16.0 * sin(2.0 * Double.pi * 50.0 * Double(i) / Double(sampleRate)))
            le16(UInt16(bitPattern: s))
        }
        return d
    }
}
