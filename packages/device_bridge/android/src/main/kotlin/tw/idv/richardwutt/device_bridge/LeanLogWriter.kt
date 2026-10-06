package tw.idv.richardwutt.device_bridge

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.time.Instant
import kotlin.math.abs

/** Owner is the motion IO looper. A raw durability barrier ALWAYS precedes a
 * lean fsync (including startup, failure cleanup and normal close). Recovery
 * refuses complete lean rows whose raw references were lost, without rewriting
 * evidence. This is not a cross-file atomic transaction or zero-loss promise. */
internal class LeanLogWriter(private val file: File, private val id: String,
    private val boot: String, private val version: String,
    private val inputs: List<String>, private val rawCounts: () -> Map<String, Long>,
    private val rawSync: (Long) -> Unit, private val synthetic: Boolean = false,
    private val appendOverride: ((ByteArray) -> Unit)? = null) : AutoCloseable {
    companion object { const val ALGORITHM = "gyro-rest-up-auto-experimental-v2" }
    private var stream: RandomAccessFile? = null
    private var next = 0L
    val count: Long get() = next
    var epoch = -1
        private set
    private var unavailable = false
    private var unavailableReason: String? = null
    private var failed = false
    private var lastSync = 0L
    private var lastTime = 0L
    var calibrationId: String? = null
        private set
    private var calibrationBoot = boot
    private var eligible = 0L
    private var ineligible = 0L
    private var left: JSONObject? = null
    private var right: JSONObject? = null
    private data class Point(val time: Long, val angle: Double, val seq: Long)
    private val window = ArrayDeque<Point>()
    val maxima: Map<String, Double?> get() = mapOf("maxLeft" to if (calibrationId == null) null else left?.getDouble("peakAbsAngleDeg"),
        "maxRight" to if (calibrationId == null) null else right?.getDouble("peakAbsAngleDeg"))

    fun start(utc: Long, mono: Long) {
        check(stream == null)
        file.parentFile?.mkdirs()
        val raf = RandomAccessFile(file, "rw")
        var oldBoot: String? = null
        var complete = raf.length()
        val size = complete
        try {
            if (size > 0) {
                raf.seek(size - 1)
                if (raf.read() != 10) {
                    var cursor = size - 1
                    while (cursor >= 0) { raf.seek(cursor); if (raf.read() == 10) break; cursor-- }
                    complete = cursor + 1
                }
            }
            raf.seek(0)
            val counts = rawCounts()
            while (raf.filePointer < complete) {
                val text = raf.readLine() ?: break
                if (text.isBlank()) continue
                val decoded = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(text.toByteArray(Charsets.ISO_8859_1))).toString()
                val row = JSONObject(decoded)
                require(row.getInt("schemaVersion") == 1 && row.getString("recordingId") == id &&
                    row.getString("sourceId") == "lean-estimator")
                val type = row.getString("recordType")
                if (type != "lean_event") {
                    require(type in setOf("lean_calibration", "lean_estimate", "lean_extremum", "lean_segment_closed"))
                    require(row.getLong("sequence") == next) { "Invalid recovered lean sequence" }
                    next++
                }
                if (type != "lean_segment_closed") oldBoot = row.getString("deviceBootId")
                when (type) {
                    "lean_event" -> if (row.getString("eventType") == "estimator_reset") epoch = row.getInt("filterEpoch")
                    "lean_calibration" -> {
                        calibrationId = row.getString("calibrationId"); calibrationBoot = row.getString("deviceBootId")
                        lastTime = row.getLong("effectiveFromMonotonicUs")
                        left = null; right = null; eligible = 0; ineligible = 0
                    }
                    "lean_estimate" -> {
                        val refs = row.getJSONArray("sourceRefs")
                        for (i in 0 until refs.length()) {
                            val ref = refs.getJSONObject(i)
                            require(ref.getLong("lastSequence") < (counts[ref.getString("sourceId")] ?: 0)) {
                                "Lean references missing raw sequence; files preserved"
                            }
                        }
                        if (!row.isNull("calibrationId") && row.getString("calibrationId") == calibrationId) {
                            lastTime = row.getLong("measurementMonotonicUs")
                            if (row.getBoolean("extremumEligible")) eligible++ else ineligible++
                        }
                    }
                    "lean_extremum" -> if (row.getString("calibrationId") == calibrationId) {
                        val summary = JSONObject().put("peakAbsAngleDeg", row.getDouble("peakAbsAngleDeg"))
                            .put("eventMonotonicUs", row.getLong("eventMonotonicUs"))
                            .put("extremumSequence", row.getLong("sequence"))
                        if (row.getString("side") == "left") left = summary else right = summary
                    }
                    "lean_segment_closed" -> if (row.getString("calibrationId") == calibrationId) calibrationId = null
                }
            }
            // Do not repair even an incomplete tail if complete refs are broken.
            if (size > complete) { raf.setLength(complete); raf.fd.sync() }
            raf.seek(complete); stream = raf
        } catch (error: Exception) { raf.close(); throw error }
        if (oldBoot != null) event("recording_resumed", utc, mono, JSONObject()
            .put("reason", if (oldBoot == boot) "process_restart" else "boot").put("resumedSequence", next))
        if (size > complete) event("log_truncated", utc, mono, JSONObject()
            .put("truncatedBytes", size - complete).put("resumedSequence", next))
        // Same-boot process recovery also requires fresh manual calibration.
        closeSegment(lastTime, if (calibrationBoot == boot) "recording_interrupted" else "boot_changed")
        event("lean_started", utc, mono, JSONObject().put("platform", "android").put("appVersion", version)
            .put("algorithmVersion", ALGORITHM).put("inputSourceIds", JSONArray(inputs))
            .put("maxInputGapUs", 100_000).put("replayable", true)
            .put("extremumPolicy", JSONObject().put("policyVersion", "conservative-100ms-v1")
                .put("rule", "min_abs_in_same_side_window").put("minWindowUs", 100_000)))
        reset(if (epoch < 0) "start" else "recovery", rawCounts(), utc, mono)
        state(false, "input_clock_not_verified", utc, mono)
        sync(mono)
    }
    fun reset(reason: String, first: Map<String, Long>, utc: Long, mono: Long) {
        val proposed = epoch + 1
        event("estimator_reset", utc, mono, JSONObject().put("filterEpoch", proposed)
            .put("reason", reason).put("initialInputs", JSONArray(inputs.map {
                JSONObject().put("sourceId", it).put("firstSequence", first[it] ?: 0)
            })))
        epoch = proposed; window.clear()
    }
    fun state(available: Boolean, reason: String?, utc: Long, mono: Long) {
        val nextReason = if (available) null else reason
        if (unavailable == !available && unavailableReason == nextReason) return
        event("estimator_state", utc, mono, JSONObject().put("state", if (available) "available" else "unavailable")
            .put("reason", nextReason ?: JSONObject.NULL))
        unavailable = !available; unavailableReason = nextReason; window.clear()
    }
    fun calibrate(mount: LeanMount, restFrom: Long, restTo: Long, leftFrom: Long, leftTo: Long,
        leftMagnitude: Double, effective: Long, written: Long, spread: Double) {
        require(effective > restTo && effective > leftTo && effective <= written)
        val previous = calibrationId
        closeSegment(effective, "recalibrated")
        val proposed = "calibration-$next"
        record("lean_calibration", JSONObject().put("calibrationId", proposed)
            .put("supersedesCalibrationId", previous ?: JSONObject.NULL).put("origin", "manual_upright")
            .put("effectiveFromMonotonicUs", effective).put("writtenMonotonicUs", written)
            .put("upDevice", vector(mount.upright)).put("leanAxisDevice", vector(mount.axis))
            .put("leanAxisSource", "manual_left_lean")
            .put("leftLeanConfirmation", JSONObject().put("peakLeanMagnitudeDeg", leftMagnitude)
                .put("durationUs", leftTo - leftFrom).put("sourceRange", range(leftFrom, leftTo)))
            .put("evidence", JSONObject().put("kind", "manual_rest").put("restDurationUs", restTo - restFrom)
            .put("upSpreadDeg", spread).put("sourceRange", range(restFrom, restTo)))
            .put("carriedOverFromCalibrationId", JSONObject.NULL).put("algorithmVersion", ALGORITHM))
        calibrationId = proposed; calibrationBoot = boot; lastTime = effective
        left = null; right = null; eligible = 0; ineligible = 0; window.clear()
    }
    fun estimate(time: Long, computed: Long, angle: Double?, refs: Map<String, Long>, map: Int?,
        flags: List<String>, utc: Long): Long {
        check(!unavailable)
        val allFlags = flags.toMutableList()
        if (angle == null) allFlags.add("lean_unavailable")
        if (calibrationId == null) allFlags.add("no_valid_calibration")
        if (map == null) allFlags.add("clock_map_unavailable")
        val valid = angle != null && flags.isEmpty() && calibrationId != null
        val sequence = record("lean_estimate", JSONObject().put("measurementMonotonicUs", time)
            .put("computedMonotonicUs", computed).put("leanAngleDeg", angle ?: JSONObject.NULL)
            .put("calibrationId", calibrationId ?: JSONObject.NULL).put("algorithmVersion", ALGORITHM)
            .put("filterEpoch", epoch).put("clockMapId", map ?: JSONObject.NULL).put("extremumEligible", valid)
            .put("sourceRefs", JSONArray(refs.map { (source, seq) -> JSONObject().put("sourceId", source)
                .put("firstSequence", seq).put("lastSequence", seq) })), allFlags)
        if (calibrationId != null) { lastTime = time; if (valid) eligible++ else ineligible++ }
        val previous = window.lastOrNull()
        if (!valid || angle == 0.0 || (previous != null && (time <= previous.time ||
                time - previous.time > 100_000 || (angle!! < 0) != (previous.angle < 0)))) window.clear()
        if (valid && angle != 0.0) {
            window.addLast(Point(time, angle!!, sequence))
            while (window.size > 1 && time - window.elementAt(1).time >= 100_000) window.removeFirst()
            if (time - window.first().time >= 100_000) {
                val peak = window.minBy { abs(it.angle) }
                val isLeft = angle < 0
                if (abs(peak.angle) > ((if (isLeft) left else right)?.getDouble("peakAbsAngleDeg") ?: -1.0)) {
                    val extremumSeq = record("lean_extremum", JSONObject().put("calibrationId", calibrationId)
                        .put("side", if (isLeft) "left" else "right").put("peakAbsAngleDeg", abs(peak.angle))
                        .put("eventMonotonicUs", peak.time).put("estimateSequence", peak.seq)
                        .put("windowStartMonotonicUs", window.first().time).put("windowEndMonotonicUs", time)
                        .put("policyVersion", "conservative-100ms-v1"))
                    val summary = JSONObject().put("peakAbsAngleDeg", abs(peak.angle))
                        .put("eventMonotonicUs", peak.time).put("extremumSequence", extremumSeq)
                    if (isLeft) left = summary else right = summary
                }
            }
        }
        if (computed - lastSync >= 500_000) sync(computed)
        return sequence
    }
    fun autoCalibrate(reference: AutoUprightReference.Reference, effective: Long, written: Long) {
        require(effective > reference.toUs && effective <= written)
        val up = reference.up
        // Schema requires an orthogonal unit vector even for unknown axes.
        // This is ONLY a placeholder, never a mounting/left-right inference.
        val basis = listOf(LeanVector(1.0, 0.0, 0.0), LeanVector(0.0, 1.0, 0.0),
            LeanVector(0.0, 0.0, 1.0)).minBy { abs(it.dot(up)) }
        val previous = calibrationId
        closeSegment(effective, "recalibrated")
        val proposed = "calibration-$next"
        record("lean_calibration", JSONObject().put("calibrationId", proposed)
            .put("supersedesCalibrationId", previous ?: JSONObject.NULL).put("origin", "auto_straight_ride")
            .put("effectiveFromMonotonicUs", effective).put("writtenMonotonicUs", written)
            .put("upDevice", vector(up)).put("leanAxisDevice", vector(basis.cross(up).unit()!!))
            .put("leanAxisSource", "unknown").put("leftLeanConfirmation", JSONObject.NULL)
            .put("evidence", JSONObject().put("kind", "auto_straight")
                .put("accumulatedDurationUs", reference.accumulatedDurationUs).put("windowCount", reference.windowCount)
                .put("minSpeedMps", reference.minSpeedMps).put("maxYawRateRadPerS", reference.maxYawRateRadPerS)
                .put("upSpreadDeg", reference.upSpreadDeg).put("sourceRange", range(reference.fromUs, reference.toUs)))
            .put("carriedOverFromCalibrationId", JSONObject.NULL).put("algorithmVersion", ALGORITHM))
        calibrationId = proposed; calibrationBoot = boot; lastTime = effective
        left = null; right = null; eligible = 0; ineligible = 0; window.clear()
    }
    fun closeSegment(time: Long, reason: String) {
        val calibration = calibrationId ?: return
        record("lean_segment_closed", JSONObject().put("calibrationId", calibration)
            .put("closedAtMonotonicUs", maxOf(time, lastTime)).put("closeReason", reason)
            .put("maxLeft", left ?: JSONObject.NULL).put("maxRight", right ?: JSONObject.NULL)
            .put("eligibleEstimateCount", eligible).put("ineligibleEstimateCount", ineligible), recordBoot = calibrationBoot)
        calibrationId = null; window.clear()
    }
    private fun record(type: String, fields: JSONObject, flags: List<String> = emptyList(), recordBoot: String = boot): Long {
        fields.put("recordType", type).put("sourceId", "lean-estimator").put("sequence", next)
            .put("qualityFlags", JSONArray(flags + if (synthetic) listOf("synthetic") else emptyList()))
        append(fields, recordBoot); return next++
    }
    private fun event(type: String, utc: Long, mono: Long, fields: JSONObject) {
        fields.put("recordType", "lean_event").put("sourceId", "lean-estimator").put("eventType", type)
            .put("occurredAtUtc", Instant.ofEpochMilli(utc).toString()).put("occurredMonotonicUs", mono)
            .put("lastSequence", next - 1)
        append(fields, boot)
    }
    private fun append(row: JSONObject, recordBoot: String) {
        check(!failed) { "Lean writer failed; recovery required" }
        row.put("schemaVersion", 1).put("recordingId", id).put("deviceBootId", recordBoot)
        try {
            val bytes = (row.toString() + "\n").toByteArray(Charsets.UTF_8)
            if (appendOverride == null) stream!!.write(bytes) else appendOverride.invoke(bytes)
        } catch (error: Exception) { failed = true; throw error }
    }
    fun sync(mono: Long) {
        try { rawSync(mono); stream?.fd?.sync(); lastSync = mono }
        catch (error: Exception) { failed = true; throw error }
    }
    fun syncIfDue(mono: Long) { if (mono - lastSync >= 500_000) sync(mono) }
    override fun close() {
        val open = stream ?: return
        stream = null
        try { rawSync(lastSync); open.fd.sync() } finally { open.close() }
    }
    private fun vector(v: LeanVector) = JSONObject().put("x", v.x).put("y", v.y).put("z", v.z)
    private fun range(from: Long, to: Long) = JSONObject().put("fromMonotonicUs", from).put("toMonotonicUs", to)
}
