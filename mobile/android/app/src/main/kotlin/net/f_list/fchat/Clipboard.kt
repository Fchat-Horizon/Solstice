package net.f_list.fchat

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface

// Bridges the clipboard for the WebView. navigator.clipboard is unavailable
// because the app is served from file:// (a non-secure context), so the web
// code's clipboard writes are routed here instead.
class Clipboard(private val ctx: Context) {
	private val manager: ClipboardManager by lazy {
		ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
	}

	// @JavascriptInterface methods are invoked on a binder thread; clipboard
	// writes need the main thread, so post there.
	@JavascriptInterface
	fun writeText(text: String) {
		Handler(Looper.getMainLooper()).post {
			manager.setPrimaryClip(ClipData.newPlainText("Solstice", text))
		}
	}

	@JavascriptInterface
	fun readText(): String {
		return try {
			val clip = manager.primaryClip ?: return ""
			if (clip.itemCount == 0) "" else clip.getItemAt(0).coerceToText(ctx).toString()
		} catch (e: Exception) {
			""
		}
	}
}
