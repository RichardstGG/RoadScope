package tw.idv.richardwutt.device_bridge

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.HandlerThread
import android.os.IBinder
import android.os.SystemClock
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.util.UUID

class LocationRecorderService : Service(), LocationListener {
    companion object {
        const val ACTION_STOP = "tw.idv.richardwutt.device_bridge.STOP"
        private const val PREFS = "roadscope_location_recorder"
        private const val CHANNEL_ID = "roadscope_recording"
        private const val NOTIFICATION_ID = 8042

        private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

        fun logFile(context: Context): File? {
            val id = prefs(context).getString("latestId", null) ?: return null
            return File(File(context.filesDir, "recordings"), "$id.ndjson")
        }

        fun status(context: Context): Map<String, Any?> {
            val p = prefs(context)
            return mapOf(
                "state" to (p.getString("state", "idle") ?: "idle"),
                "recordingId" to p.getString("latestId", null),
                "logPath" to logFile(context)?.absolutePath,
                "error" to p.getString("error", null),
            )
        }
    }

    private lateinit var locationManager: LocationManager
    private lateinit var worker: HandlerThread
    private var sequence = 0L
    private var recordingId = ""
    private var bootId = ""
    @Volatile private var active = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        worker = HandlerThread("RoadScopeLocationWriter").apply { start() }
        locationManager = getSystemService(LOCATION_SERVICE) as LocationManager
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            active = false
            prefs(this).edit().putString("state", "idle").remove("error").commit()
            locationManager.removeUpdates(this)
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }
        if (active) return START_STICKY
        val p = prefs(this)
        recordingId = if (p.getString("state", null) == "recording") {
            p.getString("latestId", null) ?: UUID.randomUUID().toString()
        } else UUID.randomUUID().toString()
        val file = File(File(filesDir, "recordings"), "$recordingId.ndjson")
        file.parentFile?.mkdirs()
        // A crash may leave a partial final JSON line; never append onto it.
        if (file.exists()) RandomAccessFile(file, "rw").use { stream ->
            var cursor = stream.length() - 1
            if (cursor >= 0) {
                stream.seek(cursor)
                if (stream.readByte().toInt() != 10) {
                    while (cursor >= 0) {
                        stream.seek(cursor)
                        if (stream.readByte().toInt() == 10) break
                        cursor--
                    }
                    stream.setLength(cursor + 1)
                }
            }
        }
        sequence = if (file.exists()) file.useLines { lines ->
            lines.mapNotNull { line ->
                try { JSONObject(line).getLong("sequence") } catch (_: Exception) { null }
            }.lastOrNull()
        }?.plus(1) ?: 0L else 0L
        val bootAnchor = System.currentTimeMillis() - SystemClock.elapsedRealtime()
        val oldAnchor = p.getLong("bootAnchor", Long.MIN_VALUE)
        bootId = if (oldAnchor != Long.MIN_VALUE && kotlin.math.abs(bootAnchor - oldAnchor) < 60_000) {
            p.getString("bootId", null) ?: UUID.randomUUID().toString()
        } else UUID.randomUUID().toString()
        p.edit().putString("latestId", recordingId).putString("bootId", bootId)
            .putLong("bootAnchor", bootAnchor).putString("state", "recording")
            .remove("error").commit()

        val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, "RoadScope recording",
            NotificationManager.IMPORTANCE_LOW))
        val notificationBuilder = Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("RoadScope 正在記錄位置")
            .setContentText("開啟 App 可停止或匯出診斷")
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setOngoing(true)
        packageManager.getLaunchIntentForPackage(packageName)?.let { launchIntent ->
            notificationBuilder.setContentIntent(PendingIntent.getActivity(this, 0, launchIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
        }
        val notification = notificationBuilder.build()
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
        } else startForeground(NOTIFICATION_ID, notification)
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
            != PackageManager.PERMISSION_GRANTED) {
            p.edit().putString("state", "error").putString("error", "Location permission was revoked").commit()
            stopSelf()
            return START_NOT_STICKY
        }
        try {
            if (!locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                throw IllegalStateException("GPS location provider is disabled")
            }
            locationManager.removeUpdates(this)
            active = true
            locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1000L, 0f,
                this, worker.looper)
        } catch (error: Exception) {
            active = false
            p.edit().putString("state", "error").putString("error", error.message).commit()
            stopSelf()
            return START_NOT_STICKY
        }
        return START_STICKY
    }

    override fun onLocationChanged(location: Location) {
        if (!active) return
        val receivedUtc = java.time.Instant.now().toString()
        val receivedMono = SystemClock.elapsedRealtimeNanos() / 1000
        val flags = org.json.JSONArray()
        fun valid(value: Float): Any = if (value.isFinite() && value >= 0f) value.toDouble()
            else JSONObject.NULL
        val speed = if (location.hasSpeed()) valid(location.speed) else JSONObject.NULL
        if (speed == JSONObject.NULL) flags.put("invalid_speed")
        val heading = if (location.hasBearing() && location.bearing.isFinite() &&
            location.bearing in 0f..<360f) location.bearing.toDouble() else JSONObject.NULL
        if (heading == JSONObject.NULL) flags.put("invalid_heading")
        val horizontalAccuracy = if (location.hasAccuracy()) valid(location.accuracy) else JSONObject.NULL
        if (horizontalAccuracy == JSONObject.NULL) flags.put("invalid_horizontal_accuracy")
        val speedAccuracy = if (Build.VERSION.SDK_INT >= 26 && location.hasSpeedAccuracy())
            valid(location.speedAccuracyMetersPerSecond) else JSONObject.NULL
        if (speedAccuracy == JSONObject.NULL) flags.put("invalid_speed_accuracy")
        val altitude = if (location.hasAltitude() && location.altitude.isFinite())
            location.altitude else JSONObject.NULL
        if (altitude == JSONObject.NULL) flags.put("invalid_altitude")
        val sample = JSONObject().apply {
            put("schemaVersion", 1)
            put("recordingId", recordingId)
            put("sourceId", "android-gps")
            put("sourceType", "phone_gnss")
            put("deviceBootId", bootId)
            put("sequence", sequence)
            put("measuredAtUtc", java.time.Instant.ofEpochMilli(location.time).toString())
            put("receivedAtUtc", receivedUtc)
            put("measurementMonotonicUs", location.elapsedRealtimeNanos / 1000)
            put("receivedMonotonicUs", receivedMono)
            put("latDeg", location.latitude)
            put("lonDeg", location.longitude)
            put("altitudeM", altitude)
            put("speedMps", speed)
            put("headingDeg", heading)
            put("horizontalAccuracyM", horizontalAccuracy)
            put("speedAccuracyMps", speedAccuracy)
            put("qualityFlags", flags)
        }
        try {
            val file = File(File(filesDir, "recordings"), "$recordingId.ndjson")
            FileOutputStream(file, true).use { output ->
                output.write((sample.toString() + "\n").toByteArray(Charsets.UTF_8))
                output.fd.sync()
            }
            sequence++
        } catch (error: Exception) {
            active = false
            prefs(this).edit().putString("state", "error").putString("error", error.message).commit()
            locationManager.removeUpdates(this)
            stopSelf()
        }
    }

    override fun onProviderDisabled(provider: String) {
        if (provider == LocationManager.GPS_PROVIDER) {
            active = false
            prefs(this).edit().putString("state", "error")
                .putString("error", "GPS location provider was disabled").commit()
            stopSelf()
        }
    }

    override fun onDestroy() {
        active = false
        locationManager.removeUpdates(this)
        worker.quitSafely()
        super.onDestroy()
    }
}
