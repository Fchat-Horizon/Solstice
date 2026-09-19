package net.f_list.fchat

import android.app.DownloadManager
import android.content.Context
import android.os.Environment
import android.webkit.JavascriptInterface
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.text.SimpleDateFormat
import java.util.*
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

class File(private val ctx: Context) {
	@JavascriptInterface
	fun read(name: String): String? {
		val file = File(ctx.filesDir, name)
		if(!file.exists()) return null
		return file.readText()
	}

	@JavascriptInterface
	fun getSize(name: String) = File(ctx.filesDir, name).length()

	@JavascriptInterface
	fun write(name: String, data: String) {
		FileOutputStream(File(ctx.filesDir, name)).use { it.write(data.toByteArray()) }
	}

	@JavascriptInterface
	fun writeBytes(name: String, base64: String) {
		val bytes = android.util.Base64.decode(base64, android.util.Base64.NO_WRAP)
		FileOutputStream(File(ctx.filesDir, name)).use { it.write(bytes) }
	}

	// Append, so the sync merge can extend a conversation without rewriting it. Without
	// this the only way to add a message to a 300 MB log is to read, re-encode and write
	// all 300 MB back, which costs about twice that in JavaScript objects.
	@JavascriptInterface
	fun appendBytes(name: String, base64: String) {
		val bytes = android.util.Base64.decode(base64, android.util.Base64.NO_WRAP)
		val file = File(ctx.filesDir, name)
		file.parentFile?.mkdirs()
		FileOutputStream(file, true).use { it.write(bytes) }
	}

	// Move a finished scratch file over the log it replaces, so a merge that dies partway
	// leaves the original intact rather than a half-written one.
	@JavascriptInterface
	fun rename(from: String, to: String): Boolean {
		val source = File(ctx.filesDir, from)
		val target = File(ctx.filesDir, to)
		if(!source.exists()) return false
		target.parentFile?.mkdirs()
		if(source.renameTo(target)) return true
		// Same-directory renames do not cross a filesystem boundary, so this only
		// happens if the target is locked; deleting it first is the documented remedy.
		return target.delete() && source.renameTo(target)
	}

	@JavascriptInterface
	fun listFilesN(name: String) = JSONArray(File(ctx.filesDir, name).listFiles().filter { it.isFile }.map { it.name }).toString()

	@JavascriptInterface
	fun listDirectoriesN(name: String) = JSONArray(File(ctx.filesDir, name).listFiles().filter { it.isDirectory }.map { it.name }).toString()

	@JavascriptInterface
	fun ensureDirectory(name: String) {
		File(ctx.filesDir, name).mkdirs()
	}

	@JavascriptInterface
	fun readBytes(name: String, offset: Long, length: Int): String {
		val buf = ByteArray(length)
		RandomAccessFile(File(ctx.filesDir, name), "r").use { raf ->
			raf.seek(offset)
			val read = raf.read(buf, 0, length)
			val actual = maxOf(0, read)
			return android.util.Base64.encodeToString(buf, 0, actual, android.util.Base64.NO_WRAP)
		}
	}

	@JavascriptInterface
	fun delete(name: String): Boolean = File(ctx.filesDir, name).delete()

	// In-memory zip builder for the log sync upload. The WebView's zlib and Buffer are
	// JavaScript polyfills, and on a real log store they cost more than everything else
	// in the send path put together, so the archive is framed here instead. Entries
	// arrive one at a time as plain strings (never base64: encoding them in the polyfill
	// is the cost being avoided) and are UTF-8 encoded on this side.
	//
	// Synchronized because addJavascriptInterface calls arrive on a binder thread, and
	// reset by zipStart so an abandoned build cannot leak into the next one.
	private var zipBuffer: java.io.ByteArrayOutputStream? = null
	private var zipStream: ZipOutputStream? = null

	@JavascriptInterface
	fun zipStart() {
		synchronized(this) {
			try { zipStream?.close() } catch(e: Exception) { /* abandoned build */ }
			val buffer = java.io.ByteArrayOutputStream()
			zipBuffer = buffer
			// BEST_SPEED rather than the default level 6: the archive goes straight onto a
			// LAN socket, so a few percent more bytes costs microseconds of transfer while
			// the stronger deflate costs the phone real CPU time on every batch.
			zipStream = ZipOutputStream(buffer).apply { setLevel(java.util.zip.Deflater.BEST_SPEED) }
		}
	}

	@JavascriptInterface
	fun zipAdd(name: String, text: String) {
		synchronized(this) {
			val stream = zipStream ?: return
			stream.putNextEntry(ZipEntry(name))
			stream.write(text.toByteArray(Charsets.UTF_8))
			stream.closeEntry()
		}
	}

	@JavascriptInterface
	fun zipFinish(): String {
		synchronized(this) {
			val stream = zipStream ?: return ""
			val buffer = zipBuffer ?: return ""
			stream.close()
			zipStream = null
			zipBuffer = null
			return android.util.Base64.encodeToString(buffer.toByteArray(), android.util.Base64.NO_WRAP)
		}
	}

	// Extensions that are internal SQLite/journal files — never include in exports.
	private val skippedExtensions = setOf(".db", ".db-wal", ".db-shm", ".db-journal")

	@JavascriptInterface
	fun exportData(): String {
		return try {
			val date = SimpleDateFormat("yyyy-MM-dd_HH-mm-ss", Locale.US).format(Date())
			val fileName = "solstice-backup-$date.zip"
			val dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
			val outFile = File(dir, fileName)
			val out = ZipOutputStream(FileOutputStream(outFile))

			// General settings: stored as '!settings' on device, exported as 'settings'
			// so Horizon's importer (which looks for 'settings') can read it.
			val settingsFile = File(ctx.filesDir, "!settings")
			if (settingsFile.exists()) {
				out.putNextEntry(ZipEntry("settings"))
				FileInputStream(settingsFile).use { it.copyTo(out) }
			}

			// Character directories: export under 'characters/<name>/' so the zip
			// matches the structure Horizon expects. Within each character:
			//   logs/        → characters/<name>/logs/<file>   (binary log files, verbatim)
			//   <settings>   → characters/<name>/settings/<file>
			val charDirs = ctx.filesDir.listFiles()
				?.filter { it.isDirectory && !it.name.startsWith("!") && !it.name.startsWith(".") }
				?: emptyList()

			for (charDir in charDirs) {
				zipCharacterDir(charDir, out)
			}

			// manifest.json — required by Horizon's isValidManifest() check.
			val isoNow = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US)
				.apply { timeZone = TimeZone.getTimeZone("UTC") }
				.format(Date())
			val charNames = JSONArray(charDirs.map { it.name })
			val includes = JSONObject().apply {
				put("generalSettings", settingsFile.exists())
				put("logs", true)
				put("drafts", false)
				put("characterSettings", true)
				put("pinned", true)
				put("eicons", false)
				put("recents", true)
				put("hidden", true)
				put("jsonLogs", false)
			}
			val manifest = JSONObject().apply {
				put("version", 2)
				put("createdAt", isoNow)
				put("app", "horizon")
				put("expectedFiles", 0)
				put("characters", charNames)
				put("includes", includes)
			}
			out.putNextEntry(ZipEntry("manifest.json"))
			out.write(manifest.toString().toByteArray(Charsets.UTF_8))

			out.close()

			@Suppress("DEPRECATION")
			(ctx.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager)
				.addCompletedDownload(fileName, fileName, false, "application/zip", outFile.absolutePath, outFile.length(), true)
			fileName
		} catch (e: Exception) {
			""
		}
	}

	// Copies the sanitized diagnostic log ('!crashlog', written by mobile/chat.ts) into the public
	// Downloads folder so it can be attached to a bug report. Returns the saved file name, or "" when
	// there is no log yet or the copy failed. Mirrors NativeFile.swift's exportCrashLog (share sheet).
	@JavascriptInterface
	fun exportCrashLog(): String {
		return try {
			val src = File(ctx.filesDir, "!crashlog")
			if (!src.exists() || src.length() == 0L) return ""
			val date = SimpleDateFormat("yyyy-MM-dd_HH-mm-ss", Locale.US).format(Date())
			val fileName = "solstice-crashlog-$date.txt"
			val dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
			val outFile = File(dir, fileName)
			FileInputStream(src).use { input -> FileOutputStream(outFile).use { input.copyTo(it) } }
			@Suppress("DEPRECATION")
			(ctx.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager)
				.addCompletedDownload(fileName, fileName, false, "text/plain", outFile.absolutePath, outFile.length(), true)
			fileName
		} catch (e: Exception) {
			""
		}
	}

	private fun zipCharacterDir(charDir: File, out: ZipOutputStream) {
		val charPrefix = "characters/${charDir.name}"
		charDir.listFiles()?.forEach { file ->
			if (file.name.startsWith(".")) return@forEach
			if (skippedExtensions.any { file.name.endsWith(it) }) return@forEach

			if (file.isDirectory && file.name == "logs") {
				// Binary log files go verbatim into characters/<name>/logs/
				file.listFiles()?.forEach { logFile ->
					if (logFile.isFile && skippedExtensions.none { logFile.name.endsWith(it) }) {
						out.putNextEntry(ZipEntry("$charPrefix/logs/${logFile.name}"))
						FileInputStream(logFile).use { it.copyTo(out) }
					}
				}
			} else if (file.isFile) {
				// Character settings files (settings, pinned, modes, etc.) go under
				// characters/<name>/settings/<file> to match Horizon's expected layout.
				out.putNextEntry(ZipEntry("$charPrefix/settings/${file.name}"))
				FileInputStream(file).use { it.copyTo(out) }
			}
		}
	}
}
