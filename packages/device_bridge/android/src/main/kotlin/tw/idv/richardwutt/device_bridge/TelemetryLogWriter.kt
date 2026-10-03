package tw.idv.richardwutt.device_bridge

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.time.Instant

/**
 * Append-only writer for the app-local diagnostics telemetry log.
 *
 * This file is **not** `contracts/location-log/v1`. It lives beside it, has its
 * own `telemetryVersion`, its own sequence space, and never contains position
 * data. Nothing here may be written into a location-log sample or event, and
 * the location log's sequence rules are untouched.
 *
 * Called only from the recorder worker looper, like [LocationLogWriter], so
 * there is a single writer per file.
 */
internal class TelemetryLogWriter(
    private val file: File,
    private val recordingId: String,
    private val sourceId: String,
    private val appVersion: String,
    private val heartbeatIntervalMs: Long = DEFAULT_HEARTBEAT_MS,
) {
    companion object {
        const val TELEMETRY_VERSION = 1
        const val RECORD_TYPE = "diagnostics_telemetry"
        const val DEFAULT_HEARTBEAT_MS = 300_000L

        const val TRIGGER_RECORDING_STARTED = "recording_started"
        const val TRIGGER_RECORDING_STOPPED = "recording_stopped"
        const val TRIGGER_RECORDING_RESUMED = "recording_resumed"
        const val TRIGGER_LOCATION_SERVICE = "location_service"
        const val TRIGGER_STATE_CHANGE = "state_change"
        const val TRIGGER_HEARTBEAT = "heartbeat"

        /**
         * A segment that ended without writing its own closing row, noticed
         * afterwards by a later process.
         *
         * Its `occurredAtUtc`/`occurredMonotonicUs` are **when the
         * interruption was noticed**, not when it happened; the actual end is
         * bounded by `locationLogLastSequence` and the previous row's time.
         * The device observables are left unavailable on purpose, because we
         * do not know what the device looked like when the segment died.
         */
        const val TRIGGER_RECORDING_INTERRUPTED = "recording_interrupted"

        /** Triggers that describe a lifecycle moment, so an unchanged state still matters. */
        private val ALWAYS_WRITE = setOf(
            TRIGGER_RECORDING_STARTED,
            TRIGGER_RECORDING_STOPPED,
            TRIGGER_RECORDING_RESUMED,
            TRIGGER_RECORDING_INTERRUPTED,
            TRIGGER_LOCATION_SERVICE,
        )

        internal fun snapshotFromJson(row: JSONObject) = TelemetrySnapshot(
            batteryPercent = row.optIntOrNull("batteryPercent"),
            batteryCharging = row.optBooleanOrNull("batteryCharging"),
            batteryPowerSource = row.optString("batteryPowerSource", TelemetrySnapshot.POWER_SOURCE_UNKNOWN),
            powerSaveMode = row.optBooleanOrNull("powerSaveMode"),
            screenInteractive = row.optBooleanOrNull("screenInteractive"),
            keyguardLocked = row.optBooleanOrNull("keyguardLocked"),
            protectedDataAvailable = row.optBooleanOrNull("protectedDataAvailable"),
            screenStateSource = row.optString("screenStateSource", TelemetrySnapshot.SCREEN_SOURCE_ANDROID),
            appLifecycle = row.optString("appLifecycle", TelemetrySnapshot.LIFECYCLE_UNKNOWN),
            locationServiceState = row.optString("locationServiceState", TelemetrySnapshot.SERVICE_UNKNOWN),
            locationServiceDetail = row.optStringOrNull("locationServiceDetail"),
            processRestartCount = row.optIntOrNull("processRestartCount") ?: 0,
            resumeReason = row.optStringOrNull("resumeReason"),
        )

        private fun JSONObject.optIntOrNull(key: String): Int? =
            if (isNull(key)) null else optInt(key)
        private fun JSONObject.optBooleanOrNull(key: String): Boolean? =
            if (isNull(key)) null else optBoolean(key)
        private fun JSONObject.optStringOrNull(key: String): String? =
            if (isNull(key)) null else optString(key).ifEmpty { null }
    }

    var sequence = 0L
        private set

    /** Last written state, so [record] can skip unchanged `state_change` ticks. */
    private var last: TelemetrySnapshot? = null
    private var lastWriteMonoUs: Long? = null
    private var pendingTruncatedBytes = 0L

    /**
     * Repairs an incomplete tail left by a crash and restores the sequence and
     * last-written state so change detection survives a process restart.
     *
     * Unparseable complete rows are left in place: a diagnostics file is never
     * worth destroying, and the Dart reader counts bad lines instead.
     */
    fun recover() {
        file.parentFile?.mkdirs()
        if (!file.exists()) return
        RandomAccessFile(file, "rw").use { stream ->
            val length = stream.length()
            var end = length
            if (length > 0) {
                stream.seek(length - 1)
                if (stream.readByte().toInt() != 10) {
                    var cursor = length - 1
                    while (cursor >= 0) {
                        stream.seek(cursor)
                        if (stream.readByte().toInt() == 10) break
                        cursor--
                    }
                    end = cursor + 1
                }
            }
            val complete = String(file.readBytes(), 0, end.toInt(), Charsets.UTF_8)
            complete.lineSequence().forEach { line ->
                if (line.isBlank()) return@forEach
                val row = try { JSONObject(line) } catch (error: Exception) { return@forEach }
                if (row.optString("recordType") != RECORD_TYPE) return@forEach
                if (row.optString("recordingId") != recordingId) return@forEach
                val recovered = row.optLong("telemetrySequence", -1L)
                if (recovered >= sequence) sequence = recovered + 1
                last = snapshotFromJson(row)
            }
            pendingTruncatedBytes = length - end
            if (pendingTruncatedBytes > 0) { stream.setLength(end); stream.fd.sync() }
        }
    }

    /**
     * Appends one telemetry row when it carries new information.
     *
     * Returns whether a row was written. State changes that change nothing and
     * heartbeats inside [heartbeatIntervalMs] are dropped, so an idle recording
     * does not pay for extra wakeups or writes.
     */
    fun record(
        trigger: String,
        snapshot: TelemetrySnapshot,
        utcMs: Long?,
        monoUs: Long?,
        bootId: String?,
        locationLogLastSequence: Long,
    ): Boolean {
        val previous = last
        // The interrupted marker deliberately claims nothing about the device,
        // so a field-by-field diff against the last row would read as if the
        // battery and screen had just become unavailable. Name the real reason.
        val changes = when {
            trigger == TRIGGER_RECORDING_INTERRUPTED -> listOf("previous_segment_not_closed")
            previous == null -> listOf("initial_snapshot")
            else -> snapshot.changesFrom(previous)
        }
        if (trigger !in ALWAYS_WRITE) {
            if (trigger == TRIGGER_HEARTBEAT) {
                val since = lastWriteMonoUs
                if (since != null && monoUs != null && monoUs - since < heartbeatIntervalMs * 1000) return false
            } else if (changes.isEmpty()) return false
        }

        val unavailable = JSONArray()
        if (snapshot.batteryPercent == null) unavailable.put("battery_percent_unavailable")
        if (snapshot.batteryCharging == null) unavailable.put("battery_charging_unavailable")
        if (snapshot.batteryPowerSource == TelemetrySnapshot.POWER_SOURCE_UNKNOWN) {
            unavailable.put("battery_power_source_unknown")
        }
        if (snapshot.powerSaveMode == null) unavailable.put("power_save_mode_unavailable")
        if (snapshot.screenInteractive == null) unavailable.put("screen_interactive_unavailable")
        if (snapshot.keyguardLocked == null) unavailable.put("keyguard_state_unavailable")
        if (snapshot.protectedDataAvailable == null) unavailable.put("protected_data_state_unavailable")
        if (snapshot.appLifecycle == TelemetrySnapshot.LIFECYCLE_UNKNOWN) unavailable.put("app_lifecycle_unknown")
        if (snapshot.locationServiceState == TelemetrySnapshot.SERVICE_UNKNOWN) {
            unavailable.put("location_service_state_unknown")
        }
        if (bootId == null) unavailable.put("device_boot_id_unavailable")
        if (utcMs == null) unavailable.put("utc_time_unavailable")
        if (monoUs == null) unavailable.put("monotonic_time_unavailable")

        val row = JSONObject()
            .put("telemetryVersion", TELEMETRY_VERSION)
            .put("recordType", RECORD_TYPE)
            .put("recordingId", recordingId)
            .put("sourceId", sourceId)
            .put("platform", "android")
            .put("appVersion", appVersion)
            .put("deviceBootId", bootId ?: JSONObject.NULL)
            .put("telemetrySequence", sequence)
            .put("trigger", trigger)
            .put("reasons", JSONArray(changes))
            .put("occurredAtUtc", utcMs?.let { Instant.ofEpochMilli(it).toString() } ?: JSONObject.NULL)
            .put("occurredMonotonicUs", monoUs ?: JSONObject.NULL)
            .put("locationLogLastSequence", locationLogLastSequence)
            .put("batteryPercent", snapshot.batteryPercent ?: JSONObject.NULL)
            .put("batteryCharging", snapshot.batteryCharging ?: JSONObject.NULL)
            .put("batteryPowerSource", snapshot.batteryPowerSource)
            .put("powerSaveMode", snapshot.powerSaveMode ?: JSONObject.NULL)
            .put("screenInteractive", snapshot.screenInteractive ?: JSONObject.NULL)
            .put("keyguardLocked", snapshot.keyguardLocked ?: JSONObject.NULL)
            .put("protectedDataAvailable", snapshot.protectedDataAvailable ?: JSONObject.NULL)
            .put("screenStateSource", snapshot.screenStateSource)
            .put("appLifecycle", snapshot.appLifecycle)
            .put("locationServiceState", snapshot.locationServiceState)
            .put("locationServiceDetail", snapshot.locationServiceDetail ?: JSONObject.NULL)
            .put("processRestartCount", snapshot.processRestartCount)
            .put("resumeReason", snapshot.resumeReason ?: JSONObject.NULL)
            .put("recoveredTruncatedBytes",
                if (pendingTruncatedBytes > 0) pendingTruncatedBytes else JSONObject.NULL)
            .put("unavailable", unavailable)

        FileOutputStream(file, true).use { output ->
            output.write((row.toString() + "\n").toByteArray(Charsets.UTF_8))
            output.fd.sync()
        }
        // Advance only after a durable append, matching the location log.
        sequence++
        last = snapshot
        lastWriteMonoUs = monoUs ?: lastWriteMonoUs
        pendingTruncatedBytes = 0
        return true
    }
}
