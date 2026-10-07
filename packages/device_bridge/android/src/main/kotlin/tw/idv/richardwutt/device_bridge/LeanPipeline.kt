package tw.idv.richardwutt.device_bridge

import kotlin.math.*

/** Consumes ONLY successfully appended raw inputs, on the same IO owner.
 * Does not retain raw history: one latest input/source, a tiny quality window,
 * and one rest window. A discontinuity discards ALL cached inputs and fusion. */
internal class LeanPipeline(private val log: LeanLogWriter, private val sources: List<MotionSource>, boot: String) {
    private data class Input(val sequence: Long, val time: Long, val values: DoubleArray)
    private val latest = mutableMapOf<String, Input>()
    // Diagnostic evidence is bounded to one successfully stored input/source;
    // never use it as fusion history or upgrade the platform accuracy status.
    private data class Readiness(val measured: Boolean, val accuracy: String?)
    private val inputReadiness = mutableMapOf<String, Readiness>()
    private var blockReason: String? = "awaiting_inputs"
    private var blockedSources: List<String> = sources.map { it.id }
    private val fusion = LeanFusion()
    private val rest = UprightWindow()
    private val automatic = AutoUprightReference(boot)
    private var pendingAutomatic: AutoUprightReference.Reference? = null
    private var activeAutomatic: AutoUprightReference.Reference? = null
    private data class Manual(val mount: LeanMount, val restFrom: Long, val restTo: Long,
        val leftFrom: Long, val leftTo: Long, val leftMagnitude: Double, val spread: Double)
    private var pendingManual: Manual? = null
    private var available = false
    // Only the accelerometer may use the explicitly limited experimental path.
    // Its platform status is never upgraded; every affected estimate remains
    // ineligible for extrema, including after status recovery until recalibration.
    private var experimental = false
    private var calibrationUnverified = false
    private var pendingReason = "input_clock_state_change"
    private var epochStart = 0L
    private var lastEstimate = -1L
    private var command = "idle"
    private var upright: LeanVector? = null
    private var uprightFrom = 0L
    private var uprightTo = 0L
    private var uprightSpread = 0.0
    private var mount: LeanMount? = null
    private var effective = Long.MAX_VALUE
    private var publishedAngle: Double? = null
    private var publishedTime: Long? = null
    private var publishedFlags: List<String> = emptyList()
    private var closedMaxima: Map<String, Double?>? = null
    var progress: Double = 0.0
        private set
    val snapshot: Map<String, Any?> get() = mapOf("leanState" to if (available) "available" else "unavailable",
        "leanQualityMode" to when {
            available && experimental -> "experimental_unverified_accelerometer"
            calibrationUnverified -> "experimental_unverified_calibration"
            else -> "standard"
        },
        "leanAngleDeg" to publishedAngle, "leanMeasurementUs" to publishedTime,
        "leanBlockReason" to blockReason, "leanBlockedSourceIds" to blockedSources,
        "sensorAccuracy" to inputReadiness.mapValues { it.value.accuracy },
        "leanFlags" to publishedFlags, "calibrationState" to command, "calibrationProgress" to progress,
        "calibrationId" to log.calibrationId, "filterEpoch" to log.epoch,
        "autoReferenceState" to when {
            mount != null -> "manual_priority"
            command != "idle" -> "manual_in_progress"
            log.calibrationId != null -> "ready_axis_unknown"
            automatic.saturated -> "candidate_capacity_exceeded"
            else -> "collecting"
        }, "autoReferenceDurationUs" to (activeAutomatic?.accumulatedDurationUs ?: automatic.dominantDurationUs),
        "autoReferenceCandidateCount" to automatic.candidateCount) +
        (if (experimental || calibrationUnverified) mapOf("maxLeft" to null, "maxRight" to null)
            else closedMaxima ?: log.maxima)

    fun rideFix(fix: AutoUprightReference.Fix) {
        if (available && !experimental && mount == null && log.calibrationId == null && command == "idle")
            automatic.updateFix(fix)
    }

    fun control(action: String) {
        require(action in setOf("upright", "left", "cancel")) { "Unknown calibration action" }
        if (action == "cancel") {
            command = "idle"; upright = null; pendingManual = null; pendingAutomatic = null
            automatic.reset(); rest.reset(); progress = 0.0; return
        }
        check(available) { "Wait for verified clocks and trustworthy sensor inputs: $blockReason" }
        if (action == "left") check(command == "awaiting_left" && upright != null) { "First collect a stationary upright reference" }
        else upright = null
        automatic.reset(); pendingAutomatic = null; pendingManual = null
        rest.reset(); command = if (action == "left") "collecting_left" else "collecting_upright"; progress = 0.0
    }
    fun interrupted(reason: String, utc: Long, mono: Long) {
        log.state(false, if (reason == "raw_write_failure") "raw_write_failed"
            else if (reason == "input_clock_state_change") "input_clock_not_verified" else "input_interrupted", utc, mono)
        available = false; pendingReason = reason; latest.clear(); fusion.reset(); rest.reset()
        experimental = false
        blockReason = if (reason == "input_clock_state_change") "input_clock_not_verified"
            else if (reason == "raw_write_failure") "raw_write_failed" else "input_interrupted"
        blockedSources = emptyList()
        automatic.reset(); pendingAutomatic = null; pendingManual = null
        // Never finish a calibration with evidence from opposite sides of a break.
        upright = null; command = "idle"; progress = 0.0
        publishedAngle = null; publishedTime = null; publishedFlags = emptyList()
    }
    fun expire(mono: Long, utc: Long): Boolean {
        if (!available || latest.values.none { mono - it.time > 500_000 }) return false
        interrupted("after_input_gap", utc, mono); return true
    }
    fun consume(source: MotionSource, sequence: Long, measured: Long?, received: Long, utc: Long,
        values: DoubleArray, mapId: Int?, computed: Long, accuracy: String? = "high") {
        inputReadiness[source.id] = Readiness(measured != null, accuracy)
        val experimentalInput = inputReadiness[sources[0].id]?.accuracy == "unreliable"
        if (available && experimental != experimentalInput) interrupted("after_input_gap", utc, received)
        // Aggregate all sources so healthy gyro/attitude callbacks cannot hide
        // a persistent accelerometer blocker. Clock failures take precedence.
        val blocked = listOf(
            "sensor_unavailable" to sources.filter { !it.available }.map { it.id },
            "awaiting_inputs" to sources.filter { !inputReadiness.containsKey(it.id) }.map { it.id },
            "input_clock_not_verified" to sources.filter { inputReadiness[it.id]?.measured == false }.map { it.id },
            "sensor_accuracy_unreliable" to sources.filter {
                it.kind != "accelerometer" && inputReadiness[it.id]?.accuracy == "unreliable"
            }.map { it.id },
            "sensor_accuracy_unavailable" to sources.filter { inputReadiness[it.id]?.accuracy == null }.map { it.id }
        ).firstOrNull { it.second.isNotEmpty() }
        if (blocked != null) {
            interrupted(if (blocked.first in setOf("awaiting_inputs", "input_clock_not_verified"))
                "input_clock_state_change" else "after_input_gap", utc, received)
            blockReason = blocked.first; blockedSources = blocked.second
            return
        }
        if (measured == null) return // Guard Kotlin nullable type; readiness rejects this above.
        val previous = latest[source.id]
        if (previous != null && (measured <= previous.time || measured - previous.time > 100_000 || sequence != previous.sequence + 1)) {
            interrupted("after_input_gap", utc, received)
        }
        latest[source.id] = Input(sequence, measured, values)
        if (sources.any { !it.available || !latest.containsKey(it.id) }) return
        val time = latest.values.maxOf { it.time }
        if (latest.values.any { time - it.time > 100_000 }) {
            interrupted("after_input_gap", utc, received); return
        }
        if (computed < time) { interrupted("input_clock_state_change", utc, received); return }
        val accel = latest.getValue(sources[0].id)
        val gyro = latest.getValue(sources[1].id)
        val attitude = latest.getValue(sources[2].id)
        val a = vector(accel.values); val g = vector(gyro.values)
        if (!available) {
            log.state(true, null, utc, received)
            log.reset(pendingReason, latest.mapValues { it.value.sequence }, utc, received)
            fusion.reset(); fusion.seed(attitude.values)
            fusion.gyro(gyro.time, g)
            available = true; experimental = experimentalInput
            epochStart = time; blockReason = null; blockedSources = emptyList()
        } else if (source.kind == "gyroscope") fusion.gyro(measured, g)
        if (source.kind != "attitude") return
        val stationary = g.norm() <= 0.035 && abs(a.norm() - 9.80665) <= 0.4
        if (stationary) fusion.stationaryCorrection(attitude.values)
        val up = fusion.up ?: return
        // Defer activation to a later REAL measurement, never manufacture a
        // future write time to put calibration after the current evidence.
        val auto = pendingAutomatic
        if (auto != null && time > maxOf(auto.toUs, lastEstimate) && computed >= time) {
            log.autoCalibrate(auto, time, computed); effective = time; pendingAutomatic = null
            activeAutomatic = auto; calibrationUnverified = false
        }
        val manual = pendingManual
        if (manual != null && time > maxOf(manual.leftTo, lastEstimate) && computed >= time) {
            log.calibrate(manual.mount, manual.restFrom, manual.restTo, manual.leftFrom, manual.leftTo,
                manual.leftMagnitude, time, computed, manual.spread,
                if (experimental) listOf("sensor_accuracy_unreliable") else emptyList())
            effective = time; mount = manual.mount; command = "calibrated"; pendingManual = null; activeAutomatic = null
            calibrationUnverified = experimental
        }
        if (!experimental && mount == null && log.calibrationId == null && command == "idle" && pendingAutomatic == null &&
            time - epochStart >= 1_000_000) {
            pendingAutomatic = automatic.add(time, up, g.norm(), a.norm())
        }
        if (command == "collecting_upright" || command == "collecting_left") {
            val reference = rest.add(time, up, g.norm(), a.norm())
            progress = ((time - (rest.startUs ?: time)) / 3_000_000.0).coerceIn(0.0, 1.0)
            if (reference != null) {
                if (command == "collecting_upright") {
                    upright = reference; uprightFrom = rest.startUs!!; uprightTo = time
                    uprightSpread = rest.spreadDeg; command = "awaiting_left"
                } else {
                    val candidate = LeanMount.fromLeftPose(upright!!, reference)
                    if (candidate == null) { rest.reset(); progress = 0.0; return }
                    pendingManual = Manual(candidate, uprightFrom, uprightTo, rest.startUs!!, time,
                        abs(candidate.angle(reference)!!), uprightSpread)
                    command = "activating_manual"; upright = null
                }
                rest.reset()
            }
        }
        if (log.calibrationId != null && time < effective) return
        if (time <= lastEstimate || time - lastEstimate < 50_000) return // <=20 Hz stored/UI values
        val flags = mutableListOf<String>()
        if (time - epochStart < 1_000_000) flags.add("after_input_gap")
        // Conservative engineering gate, NOT a validated turn-accuracy model.
        if (abs(a.norm() - 9.80665) > 2.0) flags.add("dynamic_acceleration_high")
        if (experimental) flags.add("sensor_accuracy_unreliable")
        if (calibrationUnverified) flags.add("calibration_input_unverified")
        if (log.calibrationId != null && mount == null) flags.add("lean_axis_unknown")
        val angle = if (time >= effective && log.calibrationId != null) mount?.angle(up) else null
        log.estimate(time, computed, angle, latest.mapValues { it.value.sequence }, mapId, flags, utc)
        lastEstimate = time
        publishedAngle = angle; publishedTime = time
        publishedFlags = flags + (if (angle == null) listOf("lean_unavailable") else emptyList()) +
            (if (log.calibrationId == null) listOf("no_valid_calibration") else emptyList()) +
            (if (mapId == null) listOf("clock_map_unavailable") else emptyList())
    }
    fun stopped(mono: Long, reason: String) {
        closedMaxima = log.maxima
        log.closeSegment(mono, reason); publishedAngle = null; publishedTime = null
        available = false; command = "idle"; upright = null; mount = null; progress = 0.0
        experimental = false; calibrationUnverified = false
        blockReason = "recording_stopped"; blockedSources = emptyList()
        pendingManual = null; pendingAutomatic = null; activeAutomatic = null; automatic.reset(); rest.reset()
    }
    private fun vector(v: DoubleArray) = LeanVector(v[0], v[1], v[2])
}
