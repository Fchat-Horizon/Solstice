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

	// One notification per conversation (Discord-style): conversation key -> how many unread messages
	// its single notification represents. Drives the "(N)" title suffix + badge; reset on
	// cancelConversation. @JavascriptInterface calls are serialized on the WebView's JS thread, so a
	// plain map is safe.
	private val unreadCounts = HashMap<String, Int>()
	private var lastVibrateMs = 0L

	// Vibrate unless the ringer is fully silent. Works from the background because the Android host is
	// kept alive by the foreground service (mirrors the iOS AudioServices buzz).
	private fun doVibrate() {
		if((ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager).ringerMode == AudioManager.RINGER_MODE_SILENT) return
		val vibrator = (ctx.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator)
		if(Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP)
			vibrator.vibrate(400, Notification.AUDIO_ATTRIBUTES_DEFAULT)
		else vibrator.vibrate(400)
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
		// Respect the ring switch for the notification ping: no audible ping when the phone is on
		// vibrate or silent, so a message doesn't announce itself out loud in your pocket (issue #13).
		// The vibration still fires below. iOS needs no equivalent: its background UNNotificationSound
		// already honors the silent switch.
		if(sound != null && (ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager).ringerMode == AudioManager.RINGER_MODE_NORMAL) {
			playSoundFile(sound)
		}
		if(!notify) {
			doVibrate()
			return 0
		}
		// One notification per conversation: a stable id from the conversation key so a new message
		// updates that conversation's notification in place instead of stacking a fresh one; the count
		// drives the "(N)" suffix and the badge number. An empty key falls back to a single shared id.
		val key = data ?: ""
		val notifId = if(key.isEmpty()) 2 else key.hashCode()
		val count = (unreadCounts[key] ?: 0) + 1
		unreadCounts[key] = count
		val displayTitle = if(count > 1) "$title ($count)" else title

		// Buzz, rate-limited so a busy notify-all channel can't vibrate continuously.
		val nowMs = System.currentTimeMillis()
		if(nowMs - lastVibrateMs > 1500) { lastVibrateMs = nowMs; doVibrate() }

		val intent = Intent(ctx, MainActivity::class.java)
		intent.action = "notification"
		intent.putExtra("data", data)
		val pendingIntentFlags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
		val notification = Notification.Builder(ctx).setContentTitle(displayTitle).setContentText(text).setSmallIcon(R.drawable.ic_notification).setAutoCancel(true)
				.setContentIntent(PendingIntent.getActivity(ctx, 1, intent, pendingIntentFlags)).setDefaults(Notification.DEFAULT_VIBRATE or Notification.DEFAULT_LIGHTS)
				.setNumber(count)
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
				(ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(notifId, notification.build())
			}
		}.execute(icon)
		return notifId
	}

	// The user opened a conversation (JS fires this via the select-conversation event): cancel its
	// notification and reset its unread count so it stops contributing to the badge. Mirrors iOS
	// NativeSocket.clearConversation.
	@JavascriptInterface
	fun cancelConversation(data: String?) {
		val key = data ?: return
		if(key.isEmpty()) return
		unreadCounts.remove(key)
		(ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(key.hashCode())
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