package net.f_list.fchat

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Rect
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
import android.webkit.JavascriptInterface
import android.webkit.JsResult
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.LinearLayout
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.URLDecoder
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import org.json.JSONObject


class MainActivity : Activity() {
	// Prototype: up to three characters at once, one WebView each, the way desktop gives every tab
	// its own page. Each WebView gets its own bridge instances, so per-character native state (the
	// log index in Logs) never mixes. NativeSessions relays session state between the pages and
	// holds what they must share: the account credentials and the API ticket.
	private inner class Session(val id: Int, val view: WebView) {
		val background = BackgroundSession()
		var state: JSONObject = JSONObject()
	}

	private val sessions = ArrayList<Session>()
	private var nextSessionId = 1
	private var activeId = 0
	private val webView: WebView get() = (sessions.firstOrNull { it.id == activeId } ?: sessions[0]).view
	private lateinit var container: ViewGroup
	@Volatile private var credentials = ""
	@Volatile private var sharedTicket = ""
	private var backgroundHolders = 0
	private var viewHeight = ViewGroup.LayoutParams.MATCH_PARENT

	private val profileRegex = Regex("^https?://(www\\.)?f-list.net/c/([^/#]+)/?#?")
	private val backgroundPlugin = Background(this)
	private var debugPressed = 0
	private val debugHandler = Handler(Looper.getMainLooper())
	private var filePathCallback: ValueCallback<Array<Uri>>? = null
	private var pendingCameraPermissionRequest: PermissionRequest? = null

	private fun jsQuote(value: String?): String {
		return value?.let { JSONObject.quote(it) } ?: "null"
	}

	// The foreground service has to stay up while any character is connected, so each page holds
	// its own claim and the service only stops when the last one lets go.
	private inner class BackgroundSession {
		private var on = false

		@JavascriptInterface
		fun start() = synchronized(this@MainActivity) {
			if(on) return@synchronized
			on = true
			if(++backgroundHolders == 1) backgroundPlugin.start()
		}

		@JavascriptInterface
		fun stop() = synchronized(this@MainActivity) {
			if(!on) return@synchronized
			on = false
			if(--backgroundHolders == 0) backgroundPlugin.stop()
		}
	}

	private inner class SessionsBridge(private val sessionId: Int) {
		@JavascriptInterface
		fun id(): Int = sessionId

		@JavascriptInterface
		fun max(): Int = MAX_SESSIONS

		@JavascriptInterface
		fun state(): String = synchronized(this@MainActivity) { snapshot().toString() }

		@JavascriptInterface
		fun report(json: String) {
			runOnUiThread {
				sessions.firstOrNull { it.id == sessionId }?.state = try { JSONObject(json) } catch(e: Exception) { JSONObject() }
				broadcast()
			}
		}

		@JavascriptInterface
		fun switchTo(id: Int) = runOnUiThread { activate(id) }

		@JavascriptInterface
		fun add(): Boolean {
			if(sessions.size >= MAX_SESSIONS) return false
			runOnUiThread { addSession() }
			return true
		}

		@JavascriptInterface
		fun close(id: Int) = runOnUiThread { removeSession(id) }

		@JavascriptInterface
		fun setCredentials(json: String) { credentials = json }

		@JavascriptInterface
		fun getCredentials(): String = credentials

		@JavascriptInterface
		fun getTicket(): String = sharedTicket

		@JavascriptInterface
		fun setTicket(json: String) { sharedTicket = json }
	}

	private fun snapshot(): JSONObject {
		val list = org.json.JSONArray()
		for(session in sessions) list.put(JSONObject(session.state.toString()).put("id", session.id))
		return JSONObject().put("active", activeId).put("max", MAX_SESSIONS).put("sessions", list)
	}

	private fun broadcast() {
		val json = snapshot().toString()
		for(session in sessions) session.view.evaluateJavascript("window.__solsticeSessions && window.__solsticeSessions($json)", null)
	}

	private fun activate(id: Int) {
		if(sessions.none { it.id == id }) return
		activeId = id
		for(session in sessions) session.view.visibility = if(session.id == id) View.VISIBLE else View.GONE
		webView.requestFocus()
		broadcast()
	}

	private fun addSession() {
		if(sessions.size >= MAX_SESSIONS) return
		val view = WebView(this)
		view.layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, viewHeight)
		container.addView(view)
		val session = Session(nextSessionId++, view)
		sessions.add(session)
		setupWebView(session)
		activate(session.id)
	}

	private fun removeSession(id: Int) {
		if(sessions.size <= 1) return
		val session = sessions.firstOrNull { it.id == id } ?: return
		session.background.stop()
		sessions.remove(session)
		container.removeView(session.view)
		session.view.destroy()
		if(activeId == id) activate(sessions[0].id) else broadcast()
	}

	override fun onCreate(savedInstanceState: Bundle?) {
		super.onCreate(savedInstanceState)
		setContentView(R.layout.activity_main)
		if(BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)
		container = findViewById(R.id.content)
		val first = Session(nextSessionId++, findViewById(R.id.webview))
		sessions.add(first)
		activeId = first.id

		// On many physical devices (especially OEM Android 11+), adjustResize doesn't reliably
		// resize the WebView when the soft keyboard appears. We handle it manually here.
		val rootView = window.decorView
		rootView.viewTreeObserver.addOnGlobalLayoutListener {
			val rect = Rect()
			rootView.getWindowVisibleDisplayFrame(rect)
			val heightDiff = rootView.height - rect.bottom
			// Keyboard visible: shrink to the visible area. Hidden: back to full height.
			val wanted = if(heightDiff > rootView.height * 0.15) rect.bottom - rect.top else ViewGroup.LayoutParams.MATCH_PARENT
			viewHeight = wanted
			for(session in sessions) {
				val params = session.view.layoutParams
				if(params.height != wanted) {
					params.height = wanted
					session.view.layoutParams = params
				}
			}
		}
		setupWebView(first)
		debugHandler.postDelayed(keepAlive, 10000);
	}

	private fun setupWebView(session: Session) {
		val view = session.view
		view.settings.javaScriptEnabled = true
		view.settings.mediaPlaybackRequiresUserGesture = false
		view.loadUrl("file:///android_asset/www/index.html")
		view.addJavascriptInterface(File(this), "NativeFile")
		view.addJavascriptInterface(Notifications(this), "NativeNotification")
		view.addJavascriptInterface(session.background, "NativeBackground")
		view.addJavascriptInterface(Logs(this), "NativeLogs")
		view.addJavascriptInterface(Clipboard(this), "NativeClipboard")
		view.addJavascriptInterface(Sync { js -> runOnUiThread { view.evaluateJavascript(js, null) } }, "SyncBridge")
		view.addJavascriptInterface(SessionsBridge(session.id), "NativeSessions")
		view.setDownloadListener { url, _, _, _, _ ->
			if(Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
				val permission = checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE)
				if(permission != PackageManager.PERMISSION_GRANTED)
					return@setDownloadListener requestPermissions(arrayOf(Manifest.permission.WRITE_EXTERNAL_STORAGE), 1)
			}
			val index = url.indexOf(',')
			val name = URLDecoder.decode(url.substring(5, index), Charsets.UTF_8.name())
			val dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
			val file = java.io.File(dir, name)
			FileOutputStream(file).use { it.write(URLDecoder.decode(url.substring(index + 1), Charsets.UTF_8.name()).toByteArray()) }
			val downloadManager = getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
			downloadManager.addCompletedDownload(name, name, false, "text/plain", file.absolutePath, file.length(), true)
		}
		view.webChromeClient = object : WebChromeClient() {
			override fun onJsAlert(view: WebView, url: String, message: String, result: JsResult): Boolean {
				AlertDialog.Builder(this@MainActivity).setTitle(R.string.app_name).setMessage(message).setPositiveButton(R.string.ok, { _, _ -> }).setOnDismissListener({ result.confirm() }).show()
				return true
			}

			override fun onPermissionRequest(request: PermissionRequest) {
				// The Device Sync QR scanner opens the camera via getUserMedia. Granting the WebView's
				// request only works once the app itself holds the OS CAMERA permission, so request it
				// first when missing and grant from onRequestPermissionsResult.
				if(request.resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE)
						&& checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
					pendingCameraPermissionRequest = request
					requestPermissions(arrayOf(Manifest.permission.CAMERA), CAMERA_PERMISSION_REQUEST)
				} else {
					request.grant(request.resources)
				}
			}

			override fun onJsConfirm(view: WebView, url: String, message: String, result: JsResult): Boolean {
				var ok = false
				AlertDialog.Builder(this@MainActivity).setTitle(R.string.app_name).setMessage(message).setOnDismissListener({ if(ok) result.confirm() else result.cancel() })
						.setPositiveButton(R.string.ok, { _, _ -> ok = true }).setNegativeButton(R.string.cancel, null).show()
				return true
			}

			override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
				filePathCallback?.onReceiveValue(null)
				filePathCallback = callback
				val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
					addCategory(Intent.CATEGORY_OPENABLE)
					type = "*/*"
				}
				startActivityForResult(Intent.createChooser(intent, "Select file"), FILE_CHOOSER_REQUEST)
				return true
			}
		}
		view.webViewClient = object : WebViewClient() {
			override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean {
				val match = profileRegex.find(url)
				if(match != null) {
					val char = URLDecoder.decode(match.groupValues[2], "UTF-8")
					view.evaluateJavascript("document.dispatchEvent(new CustomEvent('open-profile',{detail:${jsQuote(char)}}))", null)
				} else {
					var uri = Uri.parse(url)
					if(uri.scheme == "profile") uri = Uri.parse("https://www.f-list.net/c/${uri.authority}")
					startActivity(Intent(Intent.ACTION_VIEW, uri))
				}
				return true
			}

			override fun onPageFinished(page: WebView?, url: String?) {
				super.onPageFinished(page, url)
				view.evaluateJavascript("window.setupPlatform('android')", null)
				view.evaluateJavascript("(function(n){n.listFiles=function(p){return JSON.parse(n.listFilesN(p))};" +
						"n.listDirectories=function(p){return JSON.parse(n.listDirectoriesN(p))}})(NativeFile)", null)
				view.evaluateJavascript("(function(n){n.init=function(c){return JSON.parse(n.initN(c))};n.getBacklog=function(k){return JSON.parse(n.getBacklogN(k))};" +
						"n.getLogs=function(c,k,d){return JSON.parse(n.getLogsN(c,k,d))};n.loadIndex=function(c){return JSON.parse(n.loadIndexN(c))};" +
						"n.getCharacters=function(){return JSON.parse(n.getCharactersN())}})(NativeLogs)", null)
			}
		}
	}

	private fun addFolder(folder: java.io.File, out: ZipOutputStream, path: String) {
		for(file in folder.listFiles()) {
			if(file.isDirectory) addFolder(file, out, "$path${file.name}/")
			else {
				out.putNextEntry(ZipEntry("$path${file.name}"))
				FileInputStream(file).use { it.copyTo(out) }
			}
		}
	}

	override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
		super.onRequestPermissionsResult(requestCode, permissions, grantResults)
		if(requestCode == CAMERA_PERMISSION_REQUEST) {
			val request = pendingCameraPermissionRequest
			pendingCameraPermissionRequest = null
			if(request != null) {
				if(grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED)
					request.grant(request.resources)
				else request.deny()
			}
		}
	}

	companion object {
		private const val FILE_CHOOSER_REQUEST = 1001
		private const val CAMERA_PERMISSION_REQUEST = 1002
		private const val MAX_SESSIONS = 3
	}

	val keepAlive = object : Runnable {
		override fun run() {
			for(session in sessions) session.view.dispatchWindowVisibilityChanged(View.VISIBLE);
			debugHandler.postDelayed(this, 10000)
		}
	}

	val debug = Runnable {
		if(Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
			val permission = checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE)
			if(permission != PackageManager.PERMISSION_GRANTED) {
				return@Runnable requestPermissions(arrayOf(Manifest.permission.WRITE_EXTERNAL_STORAGE), 1)
			}
		}
		val view = EditText(this)
		view.hint = "Enter character name"
		AlertDialog.Builder(this).setView(view).setPositiveButton("OK") { _, _ ->
			val file = java.io.File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "test.zip")
			val dest = FileOutputStream(file)
			val out = ZipOutputStream(dest)
			addFolder(java.io.File(filesDir, view.text.toString()), out, "")
			out.close()
			val downloadManager = getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
			downloadManager.addCompletedDownload(file.name, file.name, false, "text/plain", file.absolutePath, file.length(), true)
		}.setNegativeButton("Cancel") { dialog, _ -> dialog.dismiss() }.setTitle("DEBUG").show()
	}

	override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
		if(keyCode == KeyEvent.KEYCODE_VOLUME_DOWN) debugPressed = debugPressed or 1
		else if(keyCode == KeyEvent.KEYCODE_VOLUME_UP) debugPressed = debugPressed or 2
		if(debugPressed == 3) debugHandler.postDelayed(debug, 5000)
		return super.onKeyDown(keyCode, event)
	}

	override fun onKeyUp(keyCode: Int, event: KeyEvent?): Boolean {
		if(keyCode == KeyEvent.KEYCODE_VOLUME_DOWN) debugPressed = debugPressed xor 1
		else if(keyCode == KeyEvent.KEYCODE_VOLUME_UP) debugPressed = debugPressed xor 2
		debugHandler.removeCallbacks(debug)
		return super.onKeyUp(keyCode, event)
	}

	override fun onBackPressed() {
		webView.evaluateJavascript("var e=new Event('backbutton',{cancelable:true});document.dispatchEvent(e);e.defaultPrevented", {
			if(it != "true") super.onBackPressed()
		})
	}

	override fun onNewIntent(intent: Intent) {
		super.onNewIntent(intent)
		if(intent.action == "notification") {
			val data = intent.extras?.getString("data")
			webView.evaluateJavascript("document.dispatchEvent(new CustomEvent('notification-clicked',{detail:{data:${jsQuote(data)}}}))", null)
		}
	}

	@Suppress("DEPRECATION")
	override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
		if (requestCode == FILE_CHOOSER_REQUEST) {
			// Always release the WebView's file input callback (pass null — we deliver
			// the content ourselves via evaluateJavascript so the FileReader path is bypassed).
			filePathCallback?.onReceiveValue(null)
			filePathCallback = null

			if (resultCode == RESULT_OK && data?.data != null) {
				val uri = data.data!!
				try {
					// Resolve display name
					var fileName = "backup.zip"
					contentResolver.query(uri, null, null, null, null)?.use { cursor ->
						val col = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
						if (cursor.moveToFirst() && col >= 0) fileName = cursor.getString(col)
					}
					// Copy the zip to a temp file in filesDir instead of base64-encoding
					// the whole file and passing it through the JS bridge. Large archives
					// (80+ MB) caused OOM crashes because the base64 payload + AdmZip
					// allocations exceeded the WebView heap. JS reads the file via
					// NativeFile.readBytes() in manageable chunks instead.
					val tmpName = ".import-pending.zip"
					val tmpFile = java.io.File(filesDir, tmpName)
					contentResolver.openInputStream(uri)!!.use { input ->
						FileOutputStream(tmpFile).use { input.copyTo(it) }
					}
					val safeName = JSONObject.quote(fileName)
					val safeTmp = JSONObject.quote(tmpName)
					webView.evaluateJavascript(
						"window.__mobileFilePicker && window.__mobileFilePicker($safeTmp,$safeName)",
						null
					)
				} catch (e: Exception) {
					webView.evaluateJavascript(
						"window.__mobileFilePicker && window.__mobileFilePicker(null,null)",
						null
					)
				}
			}
		}
		super.onActivityResult(requestCode, resultCode, data)
	}

	override fun onResume() {
		super.onResume()
		webView.requestFocus()
	}

	override fun onPause() {
		super.onPause()
		webView.clearFocus()
		// Issue 27: message drafts only reach disk on a timer, and Android can kill the process out of
		// the background without running any more JavaScript. A WebView's document visibility follows
		// the view rather than the activity lifecycle, so visibilitychange is not dependable here;
		// nudge the web layer directly. The flush itself writes through the synchronous File bridge.
		for(session in sessions) session.view.evaluateJavascript("window.solsticeFlushDrafts && window.solsticeFlushDrafts()", null)
	}

	override fun onDestroy() {
		super.onDestroy()
		val views = sessions.map { it.view }
		findViewById<ViewGroup>(R.id.content).removeAllViews()
		for(view in views) view.destroy()
		backgroundPlugin.stop()
	}
}
