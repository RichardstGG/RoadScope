package tw.idv.richardwutt.device_bridge

import android.app.Activity
import android.app.Application
import android.app.KeyguardManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.PowerManager
import androidx.core.content.ContextCompat

/**
 * Watches the publicly observable Android state that explains a recording
 * afterwards: battery, screen interactivity, keyguard, app foreground and the
 * recorder service's own lifecycle.
 *
 * Writes happen on state change plus a low-frequency heartbeat, never on a
 * timer tied to location callbacks, so an idle recording adds almost no wakeups
 * or flash writes. All appends run on the recorder worker [handler], which is
 * the same single writer thread the location log uses.
 *
 * None of this proves background collection works; it only records what the OS
 * reported while we were running.
 */
internal class DeviceStateMonitor(
    private val context: Context,
    private val handler: Handler,
    private val writer: TelemetryLogWriter,
    private val clock: () -> LongArray,
    private val bootId: () -> String?,
    private val locationLogLastSequence: () -> Long,
    private val heartbeatIntervalMs: Long = TelemetryLogWriter.DEFAULT_HEARTBEAT_MS,
) {
    private val power = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
    private val keyguard = context.getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager

    private var batteryPercent: Int? = null
    private var batteryCharging: Boolean? = null
    private var batteryPowerSource = TelemetrySnapshot.POWER_SOURCE_UNKNOWN
    private var locationServiceState = TelemetrySnapshot.SERVICE_UNKNOWN
    private var locationServiceDetail: String? = null
    private var processRestartCount = 0
    private var resumeReason: String? = null
    private var startedActivities = 0
    private var sawActivity = false
    private var running = false

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(received: Context?, intent: Intent?) {
            when (intent?.action) {
                Intent.ACTION_BATTERY_CHANGED -> readBattery(intent)
                else -> {}
            }
            record(TelemetryLogWriter.TRIGGER_STATE_CHANGE)
        }
    }

    private val activityCallbacks = object : Application.ActivityLifecycleCallbacks {
        override fun onActivityStarted(activity: Activity) = shift(1)
        override fun onActivityStopped(activity: Activity) = shift(-1)
        override fun onActivityCreated(activity: Activity, state: Bundle?) {}
        override fun onActivityResumed(activity: Activity) {}
        override fun onActivityPaused(activity: Activity) {}
        override fun onActivitySaveInstanceState(activity: Activity, state: Bundle) {}
        override fun onActivityDestroyed(activity: Activity) {}

        // Delivered on the main thread; hand it to the single writer thread.
        private fun shift(delta: Int) {
            handler.post {
                sawActivity = true
                startedActivities = (startedActivities + delta).coerceAtLeast(0)
                record(TelemetryLogWriter.TRIGGER_STATE_CHANGE)
            }
        }
    }

    private val heartbeat = object : Runnable {
        override fun run() {
            if (!running) return
            record(TelemetryLogWriter.TRIGGER_HEARTBEAT)
            handler.postDelayed(this, heartbeatIntervalMs)
        }
    }

    /**
     * Registers the state sources and writes the opening row for this segment.
     *
     * [initialForeground] seeds the activity state, because
     * `ActivityLifecycleCallbacks` never replays the activity that was already
     * started before we registered. Without it the opening row — the one that
     * answers "was the app in the foreground when recording began?" — would
     * always read `unknown`, and a recording that never leaves the foreground
     * would read `unknown` throughout. Pass `null` when it is genuinely not
     * known, such as a service restarted by the system with no activity.
     */
    fun start(serviceState: String, restartCount: Int, resume: String?,
        initialForeground: Boolean?) {
        if (running) return
        running = true
        processRestartCount = restartCount
        resumeReason = resume
        locationServiceState = serviceState
        if (initialForeground != null) {
            sawActivity = true
            startedActivities = if (initialForeground) 1 else 0
        }
        writer.recover()
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_BATTERY_CHANGED)
            addAction(Intent.ACTION_SCREEN_ON)
            addAction(Intent.ACTION_SCREEN_OFF)
            addAction(Intent.ACTION_USER_PRESENT)
            addAction(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED)
        }
        // Protected system broadcasts only; nothing here is exported.
        ContextCompat.registerReceiver(context, receiver, filter, null, handler,
            ContextCompat.RECEIVER_NOT_EXPORTED)?.let(::readBattery)
        (context.applicationContext as? Application)
            ?.registerActivityLifecycleCallbacks(activityCallbacks)
        record(if (resume == null) TelemetryLogWriter.TRIGGER_RECORDING_STARTED
            else TelemetryLogWriter.TRIGGER_RECORDING_RESUMED)
        handler.postDelayed(heartbeat, heartbeatIntervalMs)
    }

    /** Writes the closing row, then unregisters. Safe to call when not running. */
    fun stop(serviceState: String, detail: String? = null) {
        if (!running) return
        locationServiceState = serviceState
        locationServiceDetail = detail
        record(TelemetryLogWriter.TRIGGER_RECORDING_STOPPED)
        running = false
        handler.removeCallbacks(heartbeat)
        try { context.unregisterReceiver(receiver) } catch (_: IllegalArgumentException) {}
        (context.applicationContext as? Application)
            ?.unregisterActivityLifecycleCallbacks(activityCallbacks)
    }

    /** Records a location service transition such as a restart or a failure. */
    fun noteLocationService(state: String, detail: String? = null) {
        locationServiceState = state
        locationServiceDetail = detail
        if (running) record(TelemetryLogWriter.TRIGGER_LOCATION_SERVICE)
    }

    /** Records that Android removed the app task while the service remained. */
    fun noteTaskRemoved() {
        if (running) record(TelemetryLogWriter.TRIGGER_TASK_REMOVED)
    }

    fun snapshot() = TelemetrySnapshot(
        batteryPercent = batteryPercent,
        batteryCharging = batteryCharging,
        batteryPowerSource = batteryPowerSource,
        powerSaveMode = if (Build.VERSION.SDK_INT >= 21) power?.isPowerSaveMode else null,
        screenInteractive = power?.isInteractive,
        keyguardLocked = keyguard?.isKeyguardLocked,
        // Android has no equivalent of the iOS protected-data signal.
        protectedDataAvailable = null,
        screenStateSource = TelemetrySnapshot.SCREEN_SOURCE_ANDROID,
        appLifecycle = when {
            !sawActivity -> TelemetrySnapshot.LIFECYCLE_UNKNOWN
            startedActivities > 0 -> "foreground"
            else -> "background"
        },
        locationServiceState = locationServiceState,
        locationServiceDetail = locationServiceDetail,
        processRestartCount = processRestartCount,
        resumeReason = resumeReason,
    )

    private fun record(trigger: String) {
        val now = clock()
        try {
            writer.record(trigger, snapshot(), now[0], now[1], bootId(), locationLogLastSequence())
        } catch (_: Exception) {
            // Diagnostics must never take the recorder down with it.
        }
    }

    private fun readBattery(intent: Intent) {
        val level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
        val scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
        batteryPercent = if (level >= 0 && scale > 0) level * 100 / scale else null
        val status = intent.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
        batteryCharging = when (status) {
            BatteryManager.BATTERY_STATUS_CHARGING, BatteryManager.BATTERY_STATUS_FULL -> true
            BatteryManager.BATTERY_STATUS_DISCHARGING, BatteryManager.BATTERY_STATUS_NOT_CHARGING -> false
            else -> null
        }
        batteryPowerSource = when (intent.getIntExtra(BatteryManager.EXTRA_PLUGGED, -1)) {
            0 -> "none"
            BatteryManager.BATTERY_PLUGGED_AC -> "ac"
            BatteryManager.BATTERY_PLUGGED_USB -> "usb"
            BatteryManager.BATTERY_PLUGGED_WIRELESS -> "wireless"
            8 -> "dock" // BATTERY_PLUGGED_DOCK, API 33; named here to keep minSdk 24.
            else -> TelemetrySnapshot.POWER_SOURCE_UNKNOWN
        }
    }
}
