package net.f_list.fchat

import android.util.Base64
import android.webkit.JavascriptInterface
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread
import org.json.JSONObject

/**
 * Native HTTP for the LAN log sync session (Horizon repo docs/log-sync-protocol.md). A browser fetch
 * from the file:// page to Horizon's LAN server is blocked (cleartext plus a CORS preflight Horizon
 * never answers), so the sync client (mobile/sync) routes every request through this bridge. It is a
 * dumb byte transport - all crypto, zip and merge stay in JS. Mirrors iOS's NativeSync.swift.
 *
 * @JavascriptInterface calls are synchronous and would freeze the JS thread for the length of a
 * network request, so each request runs on a background thread and the result is delivered back
 * asynchronously via window.__nativeSyncResult(id, resultJson, error), the same callback shape the
 * JS wrapper in mobile/nativeSync.ts expects.
 */
class Sync(private val evalJs: (String) -> Unit) {
	@JavascriptInterface
	fun request(id: String, method: String, url: String, headersJson: String, bodyBase64: String?, timeoutMs: Int) {
		thread {
			try {
				deliver(id, perform(method, url, headersJson, bodyBase64, timeoutMs).toString(), null)
			} catch(e: Exception) {
				// Connection-level failure: reject so the client fails over to the next address.
				deliver(id, null, e.message ?: "request failed")
			}
		}
	}

	private fun perform(method: String, url: String, headersJson: String, bodyBase64: String?, timeoutMs: Int): JSONObject {
		val connection = URL(url).openConnection() as HttpURLConnection
		try {
			connection.requestMethod = method
			val timeout = if(timeoutMs > 0) timeoutMs else 30000
			connection.connectTimeout = timeout
			connection.readTimeout = timeout
			connection.useCaches = false
			val headers = JSONObject(headersJson)
			for(name in headers.keys()) connection.setRequestProperty(name, headers.getString(name))
			if(bodyBase64 != null) {
				connection.doOutput = true
				connection.outputStream.use { it.write(Base64.decode(bodyBase64, Base64.DEFAULT)) }
			}
			val status = connection.responseCode
			val stream = if(status in 200..399) connection.inputStream else connection.errorStream
			val bytes = stream?.use { readAll(it) } ?: ByteArray(0)
			return JSONObject()
				.put("status", status)
				.put("bodyBase64", Base64.encodeToString(bytes, Base64.NO_WRAP))
		} finally {
			connection.disconnect()
		}
	}

	private fun readAll(input: InputStream): ByteArray {
		val out = ByteArrayOutputStream()
		val buffer = ByteArray(16384)
		while(true) {
			val n = input.read(buffer)
			if(n < 0) break
			out.write(buffer, 0, n)
		}
		return out.toByteArray()
	}

	private fun deliver(id: String, resultJson: String?, error: String?) {
		val js = "window.__nativeSyncResult(${JSONObject.quote(id)}, " +
			(resultJson?.let { JSONObject.quote(it) } ?: "null") + ", " +
			(error?.let { JSONObject.quote(it) } ?: "null") + ")"
		evalJs(js)
	}
}
