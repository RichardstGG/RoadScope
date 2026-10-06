package tw.idv.richardwutt.device_bridge

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.time.Instant

internal data class MotionSource(val id: String, val kind: String, val available: Boolean,
    val reference: String? = null) {
    fun declaration() = JSONObject().apply {
        put("sourceId", id); put("sensorType", kind); put("available", available)
        put("measurementClock", if (available) "unverified" else "unavailable")
        if (available) {
            put("axisFrame", "android_sensor"); put("platformFused", kind == "attitude")
            put("requestedSamplingPeriodUs", 20_000); put("maxReportLatencyUs", 0)
            put("storageStride", 1); put("gapThresholdUs", 100_000)
            if (kind == "attitude") put("attitudeReference", reference)
        } else put("unavailableReason", "sensor_not_available")
    }
}

/** A sanity check, deliberately fails closed if uptime and elapsed time are
 * too close to distinguish. Measurements remain null until qualified.
 * Callback scheduling delay is diagnosed, never subtracted from timestamps. */
internal class MotionClockProbe {
    var verified = false
        private set
    private var last = -1L
    private var first = -1L
    private var count = 0
    fun observe(measured: Long, received: Long, uptime: Long): Boolean {
        val good = measured > last && measured >= 0 && uptime >= 0 && received >= measured &&
            received - measured <= 250_000 && received - uptime >= 2_000_000
        last = measured
        if (!good) { verified = false; first = -1; count = 0; return false }
        if (first < 0) first = received
        count++
        if (count >= 32 && received - first >= 500_000) verified = true
        return verified
    }
}

/** Sole owner of one raw file. Sensor callbacks never call this class.
 * Complete rows are validated before an incomplete tail is truncated.
 * The injected appender supports failure tests; partial writes poison the
 * instance and require recovery, never blind retry into a damaged tail. */
internal class MotionLogWriter(
    private val file: File, private val id: String, private val version: String,
    private val boot: String, private val anchor: Long,
    private val sources: List<MotionSource>,
    private val appendOverride: ((ByteArray) -> Unit)? = null,
    private val synthetic: Boolean = false,
) : AutoCloseable {
    private var stream: RandomAccessFile? = null
    private val next = mutableMapOf<String, Long>()
    private val clocks = mutableMapOf<String, String>()
    private val lastMeasurement = mutableMapOf<String, Long>()
    private var mapId = -1
    private var failed = false
    private var lastSyncUs = 0L
    val counts: Map<String, Long> get() = next.toMap()
    val clockStates: Map<String, String> get() = clocks.toMap()

    fun start(utc: Long, mono: Long) {
        check(stream == null)
        file.parentFile?.mkdirs()
        var truncated = 0L
        var oldBoot: String? = null
        var oldAnchor = anchor
        val raf = RandomAccessFile(file, "rw")
        try {
            val size = raf.length()
            var complete = size
            if (size > 0) {
                raf.seek(size - 1)
                if (raf.read() != 10) {
                    var cursor = size - 1
                    while (cursor >= 0) { raf.seek(cursor); if (raf.read() == 10) break; cursor-- }
                    complete = cursor + 1
                }
            }
            raf.seek(0)
            while (raf.filePointer < complete) {
                val text = raf.readLine() ?: break
                if (text.isBlank()) continue
                val decoded = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(text.toByteArray(Charsets.ISO_8859_1))).toString()
                val row = JSONObject(decoded)
                require(row.getInt("schemaVersion") == 1 && row.getString("recordingId") == id)
                oldBoot = row.getString("deviceBootId")
                if (row.has("bootAnchorUtcMs")) oldAnchor = row.getLong("bootAnchorUtcMs")
                when (row.getString("recordType")) {
                    "motion_sample" -> {
                        val source = row.getString("sourceId")
                        val seq = row.getLong("sequence")
                        require(seq == (next[source] ?: 0L)) { "Invalid recovered motion sequence" }
                        next[source] = seq + 1
                    }
                    "motion_event" -> if (row.getString("eventType") == "clock_map") {
                        mapId = maxOf(mapId, row.getInt("mapId"))
                    }
                    else -> error("Unknown complete motion row; file preserved")
                }
            }
            truncated = size - complete
            if (truncated > 0) { raf.setLength(complete); raf.fd.sync() }
            raf.seek(complete)
            stream = raf
        } catch (error: Exception) { raf.close(); throw error }
        val resumed = oldBoot != null
        if (resumed) {
            if (oldBoot != boot) event("clock_adjusted", utc, mono, JSONObject()
                .put("previousDeviceBootId", oldBoot).put("previousBootAnchorUtcMs", oldAnchor)
                .put("bootAnchorUtcMs", anchor).put("thresholdMs", 60_000))
            event("recording_resumed", utc, mono, JSONObject()
                .put("reason", if (oldBoot != boot) "boot" else "process_restart")
                .put("resumedSequences", JSONObject(next)))
        }
        if (truncated > 0) event("log_truncated", utc, mono, JSONObject()
            .put("truncatedBytes", truncated).put("resumedSequences", JSONObject(next)))
        sources.forEach { clocks[it.id] = if (it.available) "unverified" else "unavailable" }
        event("motion_started", utc, mono, JSONObject().put("platform", "android")
            .put("appVersion", version).put("bootAnchorUtcMs", anchor)
            .put("sources", JSONArray(sources.map { it.declaration() })))
        map(utc, mono, 2_000)
        sync(mono)
    }

    fun map(utc: Long, mono: Long, uncertainty: Long, effectiveFrom: Long = mono) {
        val proposed = mapId + 1
        event("clock_map", utc, mono, JSONObject().put("mapId", proposed)
            .put("effectiveFromMonotonicUs", effectiveFrom).put("offsetUtcMinusMonotonicUs", utc * 1000 - mono)
            .put("mappingSource", "wall_clock_pair").put("uncertaintyUs", uncertainty))
        mapId = proposed
    }

    fun clock(source: String, verified: Boolean, utc: Long, mono: Long) {
        val state = if (verified) "elapsed_realtime" else "unverified"
        val previous = clocks.getValue(source)
        if (previous == state) return
        event("source_clock_state", utc, mono, JSONObject().put("sourceId", source)
            .put("previousMeasurementClock", previous).put("measurementClock", state)
            .put("reason", if (verified) "verification_passed" else "verification_failed"))
        clocks[source] = state
        lastMeasurement.remove(source)
    }

    fun dropped(source: String, count: Long?, first: Long?, last: Long?, reason: String,
        utc: Long, mono: Long) = event("samples_dropped", utc, mono, JSONObject()
        .put("sourceId", source).put("droppedCount", count ?: JSONObject.NULL)
        .put("firstDroppedMonotonicUs", first ?: JSONObject.NULL)
        .put("lastDroppedMonotonicUs", last ?: JSONObject.NULL).put("reason", reason))

    fun sample(source: MotionSource, measured: Long?, received: Long, utc: Long,
        accuracy: String?, values: DoubleArray): Long {
        require(source.available && clocks.containsKey(source.id))
        require(values.all { it.isFinite() })
        require((clocks[source.id] == "elapsed_realtime") == (measured != null))
        if (measured != null) {
            require(measured <= received && measured > (lastMeasurement[source.id] ?: -1L))
            val last = lastMeasurement[source.id]
            if (last != null && measured - last > 100_000) dropped(source.id, null, last,
                measured, "sensor_interrupted", utc, received)
        }
        val sequence = next[source.id] ?: 0L
        val fields = when (source.kind) {
            "accelerometer" -> listOf("xMps2", "yMps2", "zMps2")
            "gyroscope" -> listOf("xRadPerS", "yRadPerS", "zRadPerS")
            else -> listOf("qw", "qx", "qy", "qz")
        }
        require(values.size == fields.size)
        val flags = JSONArray()
        if (synthetic) flags.put("synthetic")
        if (measured == null) flags.put("measurement_monotonic_unavailable")
        if (accuracy == null) flags.put("accuracy_unavailable")
        val row = JSONObject().put("schemaVersion", 1).put("recordType", "motion_sample")
            .put("recordingId", id).put("deviceBootId", boot).put("sourceId", source.id)
            .put("sensorType", source.kind).put("sequence", sequence)
            .put("measurementMonotonicUs", measured ?: JSONObject.NULL)
            .put("receivedMonotonicUs", received).put("receivedAtUtc", Instant.ofEpochMilli(utc).toString())
            .put("clockMapId", mapId).put("accuracyLevel", accuracy ?: JSONObject.NULL).put("qualityFlags", flags)
        fields.forEachIndexed { i, field -> row.put(field, values[i]) }
        append(row)
        next[source.id] = sequence + 1
        if (measured != null) lastMeasurement[source.id] = measured
        if (received - lastSyncUs >= 500_000) sync(received)
        return sequence
    }

    private fun event(type: String, utc: Long, mono: Long, extra: JSONObject) {
        val row = JSONObject().put("schemaVersion", 1).put("recordType", "motion_event")
            .put("eventType", type).put("recordingId", id).put("deviceBootId", boot)
            .put("occurredAtUtc", Instant.ofEpochMilli(utc).toString()).put("occurredMonotonicUs", mono)
            .put("lastSequences", JSONObject(next.mapValues { it.value - 1 }))
        extra.keys().forEach { key -> row.put(key, extra.get(key)) }
        append(row)
    }

    private fun append(row: JSONObject) {
        check(!failed) { "Motion writer failed; recovery required" }
        try {
            val bytes = (row.toString() + "\n").toByteArray(Charsets.UTF_8)
            if (appendOverride != null) appendOverride.invoke(bytes) else stream!!.write(bytes)
        } catch (error: Exception) { failed = true; throw error }
    }
    fun sync(mono: Long) {
        try { stream?.fd?.sync(); lastSyncUs = mono }
        catch (error: Exception) { failed = true; throw error }
    }
    override fun close() {
        val open = stream ?: return
        stream = null
        try { open.fd.sync() } finally { open.close() }
    }
}
