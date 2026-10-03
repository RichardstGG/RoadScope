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
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.SystemClock
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.io.File
import java.util.UUID

class LocationRecorderService : Service(), LocationListener {
    companion object {
        const val ACTION_STOP = "tw.idv.richardwutt.device_bridge.STOP"
        private const val PREFS = "roadscope_location_recorder"
        private const val CHANNEL_ID = "roadscope_recording"
        private const val NOTIFICATION_ID = 8042
        @Volatile private var instance: LocationRecorderService? = null
        private val accessLock = Any()

        private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

        fun logFile(context: Context): File? {
            val id = prefs(context).getString("latestId", null) ?: return null
            return File(File(context.filesDir, "recordings"), "$id.ndjson")
        }

        /**
         * Diagnostics telemetry lives in its own directory and its own file, so
         * an export can never mix it with the `location-log` v1 record stream.
         */
        fun telemetryFile(context: Context): File? {
            val id = prefs(context).getString("latestId", null) ?: return null
            return File(File(context.filesDir, "diagnostics"), "$id.telemetry.ndjson")
        }

        fun status(context: Context): Map<String, Any?> {
            val p = prefs(context)
            return mapOf(
                "state" to (p.getString("state", "idle") ?: "idle"),
                "recordingId" to p.getString("latestId", null),
                "logPath" to logFile(context)?.absolutePath,
                "telemetryPath" to telemetryFile(context)?.absolutePath,
                "error" to p.getString("error", null),
                "sampleAgeMs" to (instance?.lastMeasurementMonoUs ?: -1).let { mono ->
                    val age = (SystemClock.elapsedRealtimeNanos() / 1000 - mono) / 1000
                    if (mono >= 0 && age >= 0 && p.getString("state", null) == "recording") age else null
                },
            )
        }

        fun readLog(context: Context, result: (String?, Exception?) -> Unit) =
            read(context, { logFile(it) }, result)

        fun readTelemetry(context: Context, result: (String?, Exception?) -> Unit) =
            read(context, { telemetryFile(it) }, result)

        private fun read(context: Context, pick: (Context) -> File?,
            result: (String?, Exception?) -> Unit) {
            val read = Runnable {
                synchronized(accessLock) {
                    try {
                        val file = pick(context)
                        result(if (file?.exists() == true) file.readText() else "", null)
                    } catch (error: Exception) { result(null, error) }
                }
            }
            val service = instance
            // Read between appends, so polling never sees a partially written row.
            if (service == null || !service.handler.post(read)) read.run()
        }
    }

    private lateinit var locationManager: LocationManager
    private lateinit var worker: HandlerThread
    private lateinit var writer: LocationLogWriter
    private lateinit var handler: Handler
    private var telemetry: DeviceStateMonitor? = null
    @Volatile private var destroyed = false
    @Volatile private var active = false
    @Volatile private var lastMeasurementMonoUs = -1L

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        worker = HandlerThread("RoadScopeLocationWriter").apply { start() }
        handler = Handler(worker.looper)
        locationManager = getSystemService(LOCATION_SERVICE) as LocationManager
        instance = this
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            handler.post {
                if (destroyed) return@post
                active = false
                telemetry?.stop("stopped")
                telemetry = null
                prefs(this).edit().putString("state", "idle").remove("error").commit()
                locationManager.removeUpdates(this)
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
            return START_NOT_STICKY
        }
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
        handler.post { startRecording() }
        return START_STICKY
    }

    private fun startRecording() {
        // A previous Service's final callback can still be finishing when Android
        // creates its replacement. Recover only after that append has completed.
        synchronized(accessLock) { startRecordingLocked() }
    }

    private fun startRecordingLocked() {
        if (active || destroyed) return
        val p = prefs(this)
        try {
            check(ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
                == PackageManager.PERMISSION_GRANTED) { "Location permission was revoked" }
            check(locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) { "GPS location provider is disabled" }
            val resume = p.getString("state", null) == "recording"
            val id = if (resume) p.getString("latestId", null) ?: UUID.randomUUID().toString()
                else UUID.randomUUID().toString()
            val utcMs = System.currentTimeMillis()
            val monoUs = SystemClock.elapsedRealtimeNanos() / 1000
            val info = packageManager.getPackageInfo(packageName, 0)
            @Suppress("DEPRECATION")
            val version = "${info.versionName ?: "unknown"}+${info.versionCode}"
            writer = LocationLogWriter(File(File(filesDir, "recordings"), "$id.ndjson"), id,
                version, p.getString("bootId", null) ?: UUID.randomUUID().toString(),
                p.getLong("bootAnchor", utcMs - monoUs / 1000))
            writer.start(utcMs, monoUs, resume)
            lastMeasurementMonoUs = -1L
            val restarts = if (resume) p.getInt("restartCount", 0) + 1 else 0
            p.edit().putString("latestId", id).putString("state", "recording")
                .putInt("restartCount", restarts).remove("error").commit()
            persistClock()
            startTelemetry(id, version, resume, restarts)
            // The first callback cannot overtake recording_started: both run here.
            active = true
            locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1000L, 0f,
                this, worker.looper)
        } catch (error: Exception) { fail(error) }
    }

    /**
     * Diagnostics telemetry is best-effort: a failure here must not stop the
     * recording it is only meant to describe.
     */
    private fun startTelemetry(id: String, version: String, resume: Boolean, restarts: Int) {
        try {
            val monitor = DeviceStateMonitor(
                context = applicationContext,
                handler = handler,
                writer = TelemetryLogWriter(
                    File(File(filesDir, "diagnostics"), "$id.telemetry.ndjson"),
                    id, "android-gps", version),
                clock = { longArrayOf(System.currentTimeMillis(), SystemClock.elapsedRealtimeNanos() / 1000) },
                bootId = { if (::writer.isInitialized) writer.bootId else null },
                locationLogLastSequence = { if (::writer.isInitialized) writer.sequence - 1 else -1L },
            )
            telemetry = monitor
            monitor.start(
                serviceState = if (resume) "restarted" else "started",
                restartCount = restarts,
                resume = if (!resume) null else if (writer.bootResumed) "boot" else "process_restart",
            )
        } catch (_: Exception) {
            telemetry = null
        }
    }

    private fun persistClock() {
        prefs(this).edit().putString("bootId", writer.bootId)
            .putLong("bootAnchor", writer.bootAnchor).apply()
    }

    private fun fail(error: Exception) {
        active = false
        telemetry?.stop("failed", error.message)
        telemetry = null
        prefs(this).edit().putString("state", "error").putString("error", error.message).commit()
        locationManager.removeUpdates(this)
        stopSelf()
    }

    override fun onLocationChanged(location: Location) {
        synchronized(accessLock) { recordLocation(location) }
    }

    private fun recordLocation(location: Location) {
        if (!active) return
        val receivedUtc = System.currentTimeMillis()
        val receivedMono = SystemClock.elapsedRealtimeNanos() / 1000
        val flags = org.json.JSONArray()
        fun valid(value: Float): Any = if (value.isFinite() && value >= 0f) value.toDouble()
            else JSONObject.NULL
        val speed = if (location.hasSpeed()) valid(location.speed) else JSONObject.NULL
        if (speed == JSONObject.NULL) flags.put("speed_unavailable")
        val heading = if (location.hasBearing() && location.bearing.isFinite() &&
            location.bearing in 0f..<360f) location.bearing.toDouble() else JSONObject.NULL
        if (heading == JSONObject.NULL) flags.put("heading_unavailable")
        val horizontalAccuracy = if (location.hasAccuracy()) valid(location.accuracy) else JSONObject.NULL
        if (horizontalAccuracy == JSONObject.NULL) flags.put("horizontal_accuracy_unavailable")
        val speedAccuracy = if (Build.VERSION.SDK_INT >= 26 && location.hasSpeedAccuracy())
            valid(location.speedAccuracyMetersPerSecond) else JSONObject.NULL
        if (speedAccuracy == JSONObject.NULL) flags.put("speed_accuracy_unavailable")
        val altitude = if (location.hasAltitude() && location.altitude.isFinite())
            location.altitude else JSONObject.NULL
        if (altitude == JSONObject.NULL) flags.put("altitude_unavailable")
        val sample = JSONObject().apply {
            put("measuredAtUtc", java.time.Instant.ofEpochMilli(location.time).toString())
            put("measurementMonotonicUs", location.elapsedRealtimeNanos / 1000)
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
            val previousBootId = writer.bootId
            writer.sample(sample, receivedUtc, receivedMono)
            lastMeasurementMonoUs = location.elapsedRealtimeNanos / 1000
            if (writer.bootId != previousBootId) persistClock()
        } catch (error: Exception) { fail(error) }
    }

    override fun onProviderDisabled(provider: String) {
        if (provider == LocationManager.GPS_PROVIDER) {
            active = false
            telemetry?.stop("failed", "GPS location provider was disabled")
            telemetry = null
            prefs(this).edit().putString("state", "error")
                .putString("error", "GPS location provider was disabled").commit()
            stopSelf()
        }
    }

    override fun onDestroy() {
        destroyed = true
        active = false
        if (instance === this) instance = null
        locationManager.removeUpdates(this)
        // quitSafely still drains queued work, so the closing row can be written.
        handler.post {
            telemetry?.stop("stopped", "recorder service destroyed")
            telemetry = null
        }
        worker.quitSafely()
        super.onDestroy()
    }
}
