package net.f_list.fchat

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Environment
import org.json.JSONObject
import java.io.File

// Resolves where per-character data lives (`<character>/logs/*` and the `<character>/<key>` settings
// files): the user-chosen external folder when the "external data folder" option is enabled and the
// folder is reachable, otherwise the private filesDir. Root-level entries ('!settings', '!crashlog',
// '.import-pending.zip') always stay internal. Every NativeFile/NativeLogs path goes through here, so
// Device Sync, the backup importer and export follow the setting too. Mirrors DataRoot.swift.
object DataRoot {
	private const val PREFS = "storage"
	private const val KEY_ENABLED = "externalEnabled"
	private const val KEY_PATH = "externalPath"

	// Cached resolved root; recomputed after a settings change or when the app resumes (the
	// all-files access grant can change while the app is in the background).
	@Volatile private var cachedRoot: File? = null

	private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

	fun isEnabled(ctx: Context) = prefs(ctx).getBoolean(KEY_ENABLED, false)

	fun externalPath(ctx: Context): String? = prefs(ctx).getString(KEY_PATH, null)

	fun hasAccess(ctx: Context): Boolean =
		if(Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) Environment.isExternalStorageManager()
		else ctx.checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED

	private fun externalDir(ctx: Context): File? {
		val path = externalPath(ctx) ?: return null
		if(!hasAccess(ctx)) return null
		val dir = File(path)
		if(!dir.isDirectory && !dir.mkdirs()) return null
		return if(dir.canWrite()) dir else null
	}

	fun invalidate() {
		cachedRoot = null
	}

	fun root(ctx: Context): File {
		cachedRoot?.let { return it }
		val root = if(isEnabled(ctx)) externalDir(ctx) ?: ctx.filesDir else ctx.filesDir
		cachedRoot = root
		return root
	}

	fun resolve(ctx: Context, name: String): File {
		val trimmed = name.trimStart('/')
		if(trimmed.isEmpty() || trimmed.startsWith("!") || trimmed.startsWith(".")) return File(ctx.filesDir, trimmed)
		return File(root(ctx), trimmed)
	}

	fun status(ctx: Context): JSONObject = JSONObject().apply {
		put("enabled", isEnabled(ctx))
		put("path", externalPath(ctx) ?: JSONObject.NULL)
		put("available", externalDir(ctx) != null)
	}

	fun setExternalPath(ctx: Context, path: String) {
		prefs(ctx).edit().putString(KEY_PATH, path).apply()
		invalidate()
	}

	// Returns false when enabling without a usable folder.
	fun setEnabled(ctx: Context, enabled: Boolean): Boolean {
		if(enabled && externalDir(ctx) == null) return false
		prefs(ctx).edit().putBoolean(KEY_ENABLED, enabled).apply()
		invalidate()
		return true
	}

	// Copies every character directory between internal storage and the external folder. With
	// overwrite=false a file is skipped when the destination already has it, or its log counterpart
	// (`<key>` vs `<key>.idx`), so a data file and its index are never mixed from two sources.
	fun copyData(ctx: Context, toExternal: Boolean, overwrite: Boolean): JSONObject {
		val external = externalDir(ctx) ?: return JSONObject().put("error", "The external folder is not available.")
		val internal = ctx.filesDir
		val src = if(toExternal) internal else external
		val dst = if(toExternal) external else internal
		val counts = intArrayOf(0, 0)
		if(src.canonicalPath != dst.canonicalPath) {
			src.listFiles()
				?.filter { it.isDirectory && !it.name.startsWith(".") && !it.name.startsWith("!") }
				?.forEach { copyDir(it, File(dst, it.name), overwrite, counts) }
		}
		return JSONObject().put("copied", counts[0]).put("skipped", counts[1])
	}

	private fun copyDir(src: File, dst: File, overwrite: Boolean, counts: IntArray) {
		dst.mkdirs()
		for(file in src.listFiles() ?: return) {
			if(file.name.startsWith(".")) continue
			val target = File(dst, file.name)
			if(file.isDirectory) {
				copyDir(file, target, overwrite, counts)
				continue
			}
			val base = file.name.removeSuffix(".idx")
			if(!overwrite && (File(dst, base).exists() || File(dst, "$base.idx").exists())) {
				counts[1]++
				continue
			}
			file.copyTo(target, overwrite = true)
			counts[0]++
		}
	}
}
