package net.f_list.fchat

import android.app.DownloadManager
import android.content.Context
import android.os.Environment
import android.webkit.JavascriptInterface
import org.json.JSONArray
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

	@JavascriptInterface
	fun listFilesN(name: String) = JSONArray(File(ctx.filesDir, name).listFiles().filter { it.isFile }.map { it.name }).toString()

	@JavascriptInterface
	fun listDirectoriesN(name: String) = JSONArray(File(ctx.filesDir, name).listFiles().filter { it.isDirectory }.map { it.name }).toString()

	@JavascriptInterface
	fun ensureDirectory(name: String) {
		File(ctx.filesDir, name).mkdirs()
	}

	@JavascriptInterface
	fun exportData(): String {
		return try {
			val date = SimpleDateFormat("yyyy-MM-dd_HH-mm-ss", Locale.US).format(Date())
			val fileName = "horizon-backup-$date.zip"
			val dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
			val outFile = File(dir, fileName)
			val out = ZipOutputStream(FileOutputStream(outFile))
			zipFolder(ctx.filesDir, out, "")
			out.close()
			@Suppress("DEPRECATION")
			(ctx.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager)
				.addCompletedDownload(fileName, fileName, false, "application/zip", outFile.absolutePath, outFile.length(), true)
			fileName
		} catch (e: Exception) {
			""
		}
	}

	private fun zipFolder(folder: File, out: ZipOutputStream, path: String) {
		folder.listFiles()?.forEach { file ->
			if (file.isDirectory) zipFolder(file, out, "$path${file.name}/")
			else {
				out.putNextEntry(ZipEntry("$path${file.name}"))
				FileInputStream(file).use { it.copyTo(out) }
			}
		}
	}
}