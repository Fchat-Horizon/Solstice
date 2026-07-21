package net.f_list.fchat

import android.Manifest
import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.pm.PackageManager
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.os.AsyncTask
import android.os.Build
import android.os.Vibrator
import android.provider.Settings
import android.webkit.JavascriptInterface
import java.net.URL

class Notifications(private val ctx: Context) {
	init {
		if(Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
			val manager = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager;
			manager.createNotificationChannel(NotificationChannel("messages", ctx.getString(R.string.channel_messages), NotificationManager.IMPORTANCE_HIGH))
		}
	}

	private fun playSoundFile(sound: String) {
		try {
			val player = MediaPlayer()
			val asset = ctx.assets.openFd("www/sounds/$sound.mp3")
			player.setDataSource(asset.fileDescriptor, asset.startOffset, asset.length)
			asset.close()
			player.setAudioAttributes(
				AudioAttributes.Builder()
					.setUsage(AudioAttributes.USAGE_MEDIA)
					.setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
					.build()
			)
			player.setOnPreparedListener { it.start() }
			player.setOnCompletionListener { it.release() }
			player.prepareAsync()
		} catch(e: Exception) {
			// Sound file not found or playback error — silently ignore
		}
	}

	@JavascriptInterface
	fun playSound(sound: String) {
		playSoundFile(sound)
	}

	@JavascriptInterface
	fun notify(notify: Boolean, title: String, text: String, icon: String, sound: String?, data: String?): Int {
		if(sound != null) {
			playSoundFile(sound)
		}
		if(!notify) {
			if((ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager).ringerMode != AudioManager.RINGER_MODE_SILENT) {
				val vibrator = (ctx.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator)
				if(Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP)
					vibrator.vibrate(400, Notification.AUDIO_ATTRIBUTES_DEFAULT)
				else vibrator.vibrate(400)
			}
			return 0
		}
		val intent = Intent(ctx, MainActivity::class.java)
		intent.action = "notification"
		intent.putExtra("data", data)
		val pendingIntentFlags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
		val notification = Notification.Builder(ctx).setContentTitle(title).setContentText(text).setSmallIcon(R.drawable.ic_notification).setAutoCancel(true)
				.setContentIntent(PendingIntent.getActivity(ctx, 1, intent, pendingIntentFlags)).setDefaults(Notification.DEFAULT_VIBRATE or Notification.DEFAULT_LIGHTS)
				// Classify as a message so Android's notification ranking treats it as a conversation and
				// doesn't demote it into a low-priority/promotional bucket (issue #14).
				.setCategory(Notification.CATEGORY_MESSAGE)
		if(Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) notification.setChannelId("messages")
		object : AsyncTask<String, Void, Bitmap>() {
			override fun doInBackground(vararg args: String): Bitmap? {
				return try {
					val connection = URL(args[0]).openConnection()
					BitmapFactory.decodeStream(connection.getInputStream())
				} catch(e: Exception) {
					null
				}
			}

			override fun onPostExecute(result: Bitmap?) {
				notification.setLargeIcon(result)
				(ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(2, notification.build())
			}
		}.execute(icon)
		return 2
	}

	@JavascriptInterface
	fun requestPermission() {
		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
			val activity = ctx as? Activity ?: return
			if (activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
				activity.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 0)
			}
		}
	}
}