package tw.idv.richardwutt.device_bridge

import org.json.JSONObject
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.io.File
import java.io.IOException
import java.nio.file.Files
import kotlin.math.*

class LeanPipelineTest {
    private val sources = listOf(MotionSource("android-accelerometer", "accelerometer", true),
        MotionSource("android-gyroscope", "gyroscope", true),
        MotionSource("android-game-rotation-vector", "attitude", true, "game_rotation_vector"))
    private val utc = 1_800_000_000_000L
    private fun fixture(name: String): File {
        val base = System.getProperty("roadscope.nativeOutput")?.let { File(it).parentFile }
            ?: Files.createTempDirectory("lean-tests").toFile()
        return File(File(base, "native-lean-fixtures").apply { mkdirs() }, name)
    }
    private inner class Harness(val name: String, val boot: String = "boot-a", initial: Long = 1_000_000,
        fresh: Boolean = true) : AutoCloseable {
        val motionFile = fixture("$name.motion.ndjson")
        val leanFile = fixture("$name.lean.ndjson")
        init { if (fresh) { motionFile.delete(); leanFile.delete() } }
        val raw = MotionLogWriter(motionFile, "synthetic-lean", "test", boot, utc - 1000, sources, synthetic = true)
        val log = LeanLogWriter(leanFile, "synthetic-lean", boot, "test", sources.map { it.id },
            { raw.counts }, { raw.sync(it) }, synthetic = true)
        val pipeline = LeanPipeline(log, sources, boot)
        var time = initial
        private var roll = 0.0
        init { raw.start(utc, time); log.start(utc, time) }
        fun frame(angle: Double = roll, verified: Boolean = true, force: Double = 9.80665,
            accuracies: List<String?> = listOf("high", "high", "high")) {
            time += 20_000
            val radians = Math.toRadians(angle)
            val rate = Math.toRadians(angle - roll) / 0.02
            roll = angle
            val values = listOf(doubleArrayOf(0.0, sin(radians) * force, cos(radians) * force),
                doubleArrayOf(rate, 0.0, 0.0), doubleArrayOf(cos(radians / 2), sin(radians / 2), 0.0, 0.0))
            sources.forEachIndexed { index, source ->
                val previous = raw.clockStates[source.id]
                raw.clock(source.id, verified, utc + time / 1000, time + 1000)
                if (previous != raw.clockStates[source.id]) pipeline.interrupted("input_clock_state_change", utc + time / 1000, time + 1000)
                val sequence = raw.sample(source, if (verified) time else null, time + 1000,
                    utc + time / 1000, accuracies[index], values[index])
                pipeline.consume(source, sequence, if (verified) time else null, time + 1000,
                    utc + time / 1000, values[index], raw.currentMapId, time + 2000, accuracies[index])
            }
        }
        fun calibrate(accuracies: List<String?> = listOf("high", "high", "high")) {
            repeat(60) { frame(0.0, accuracies = accuracies) }
            pipeline.control("upright")
            repeat(152) { frame(0.0, accuracies = accuracies) }
            assertEquals("awaiting_left", pipeline.snapshot["calibrationState"])
            frame(15.0, accuracies = accuracies)
            pipeline.control("left")
            repeat(160) { frame(15.0, accuracies = accuracies) }
            assertNotNull(log.calibrationId)
        }
        fun rows() = leanFile.readLines().map(::JSONObject)
        fun ride(seconds: Int, quality: Boolean = true) {
            repeat(seconds * 50) { i ->
                if (i % 50 == 0) pipeline.rideFix(AutoUprightReference.Fix(boot, time, quality,
                    10.0, 3.0, 0.5, 0.0, 2.0))
                frame(0.0)
            }
        }
        override fun close() { log.close(); raw.close() }
    }
    @Test fun `quaternion up and gyro propagation use device axes with correct lean sign`() {
        val f = LeanFusion()
        f.seed(doubleArrayOf(1.0, 0.0, 0.0, 0.0))
        f.gyro(0, LeanVector(1.0, 0.0, 0.0))
        repeat(50) { i -> f.gyro((i + 1) * 20_000L, LeanVector(Math.PI / 6, 0.0, 0.0)) }
        assertEquals(0.5, f.up!!.y, 1e-8)
        assertEquals(cos(Math.PI / 6), f.up!!.z, 1e-8)
        val mount = LeanMount.fromLeftPose(LeanVector(0.0, 0.0, 1.0), f.up!!) // >25 rejected
        assertNull(mount)
        f.reset(); assertNull(f.up)
    }
    @Test fun `automatic reference is persisted after evidence but never guesses lean axis`() {
        Harness("automatic-axis-unknown").use { h ->
            repeat(60) { h.frame() }; h.ride(35)
            val calibration = h.rows().single { it.optString("recordType") == "lean_calibration" }
            assertEquals("auto_straight_ride", calibration.getString("origin"))
            assertEquals("unknown", calibration.getString("leanAxisSource"))
            assertTrue(calibration.isNull("leftLeanConfirmation"))
            val evidence = calibration.getJSONObject("evidence")
            assertEquals(30_000_000L, evidence.getLong("accumulatedDurationUs"))
            assertTrue(calibration.getLong("effectiveFromMonotonicUs") >
                evidence.getJSONObject("sourceRange").getLong("toMonotonicUs"))
            assertNull(h.pipeline.snapshot["leanAngleDeg"])
            assertEquals("ready_axis_unknown", h.pipeline.snapshot["autoReferenceState"])
            h.pipeline.control("cancel")
            assertEquals(calibration.getString("calibrationId"), h.log.calibrationId)
            assertEquals(30_000_000L, h.pipeline.snapshot["autoReferenceDurationUs"])
            val estimates = h.rows().filter { it.optString("recordType") == "lean_estimate" && !it.isNull("calibrationId") }
            assertTrue(estimates.isNotEmpty())
            assertTrue(estimates.all { it.isNull("leanAngleDeg") && !it.getBoolean("extremumEligible") &&
                it.getJSONArray("qualityFlags").toString().contains("lean_axis_unknown") })
            assertTrue(h.log.maxima.values.all { it == null })
            h.pipeline.stopped(h.time, "recording_stopped")
        }
    }
    @Test fun `manual supersedes automatic and future ride cannot replace manual calibration`() {
        Harness("automatic-to-manual").use { h ->
            repeat(60) { h.frame() }; h.ride(35)
            val auto = h.log.calibrationId!!
            h.calibrate()
            val manual = h.log.calibrationId!!
            assertNotEquals(auto, manual)
            h.ride(40)
            assertEquals(manual, h.log.calibrationId)
            assertEquals("manual_priority", h.pipeline.snapshot["autoReferenceState"])
            val calibration = h.rows().last { it.optString("recordType") == "lean_calibration" }
            assertEquals(auto, calibration.getString("supersedesCalibrationId"))
            assertEquals("manual_upright", calibration.getString("origin"))
            h.pipeline.stopped(h.time, "recording_stopped")
        }
    }
    @Test fun `unverified gps cannot produce an automatic reference`() {
        Harness("automatic-gps-unverified").use { h ->
            repeat(60) { h.frame() }; h.ride(40, quality = false)
            assertNull(h.log.calibrationId)
            assertEquals(0L, h.pipeline.snapshot["autoReferenceDurationUs"])
            h.pipeline.stopped(h.time, "recording_stopped")
        }
    }
    @Test fun `input interruption discards automatic candidate duration`() {
        Harness("automatic-gap-reset").use { h ->
            repeat(60) { h.frame() }; h.ride(28)
            assertNotEquals(0L, h.pipeline.snapshot["autoReferenceDurationUs"])
            h.raw.dropped(sources[0].id, 1, null, null, "buffer_full", utc + h.time / 1000, h.time + 1000)
            h.pipeline.interrupted("after_input_gap", utc + h.time / 1000, h.time + 1000)
            h.ride(10)
            assertNull(h.log.calibrationId)
            h.ride(25)
            assertNotNull(h.log.calibrationId)
            h.pipeline.stopped(h.time, "recording_stopped")
        }
    }
    @Test fun `manual calibration persisted estimate and conservative maxima have raw references`() {
        Harness("manual-and-peaks").use { h ->
            h.calibrate()
            repeat(20) { h.frame(15.0) }
            assertEquals(-15.0, h.pipeline.snapshot["leanAngleDeg"] as Double, 0.05)
            assertNotNull(h.log.maxima["maxLeft"])
            h.frame(-15.0); repeat(20) { h.frame(-15.0) }
            assertNotNull(h.log.maxima["maxRight"])
            h.pipeline.stopped(h.time, "recording_stopped")
        }
    }
    @Test fun `unverified inputs never create receive-time estimates`() {
        Harness("unverified").use { h ->
            repeat(60) { h.frame(verified = false) }
            assertFalse(h.rows().any { it.optString("recordType") == "lean_estimate" })
            assertThrows(IllegalStateException::class.java) { h.pipeline.control("upright") }
        }
    }
    @Test fun `persistent unreliable acceleration remains explicitly experimental without extrema`() {
        Harness("persistent-accuracy-experimental").use { h ->
            repeat(32) { h.frame(verified = false, accuracies = listOf("unreliable", "high", "high")) }
            repeat(500) { h.frame(accuracies = listOf("unreliable", "high", "high")) }
            val status = h.pipeline.snapshot
            assertNull(status["leanBlockReason"])
            assertEquals(emptyList<String>(), status["leanBlockedSourceIds"])
            assertEquals("unreliable", (status["sensorAccuracy"] as Map<*, *>)[sources[0].id])
            assertEquals("available", status["leanState"])
            assertEquals("experimental_unverified_accelerometer", status["leanQualityMode"])
            assertTrue(h.rows().filter { it.optString("recordType") == "lean_estimate" }.all {
                !it.getBoolean("extremumEligible") &&
                    it.getJSONArray("qualityFlags").toString().contains("sensor_accuracy_unreliable")
            })
            assertTrue(h.rows().any { it.optString("recordType") == "lean_estimate" })
            h.pipeline.control("upright")
            val states = h.rows().filter { it.optString("eventType") == "estimator_state" }
            assertEquals(2, states.size)
            h.pipeline.stopped(h.time, "recording_stopped")
        }
    }
    @Test fun `manual experimental calibration yields angles but never maxima or automatic reference`() {
        Harness("experimental-manual-only").use { h ->
            val weak = listOf("unreliable", "high", "high")
            h.calibrate(weak)
            repeat(30) { h.frame(15.0, accuracies = weak) }
            assertEquals(-15.0, h.pipeline.snapshot["leanAngleDeg"] as Double, 0.05)
            assertEquals("experimental_unverified_accelerometer", h.pipeline.snapshot["leanQualityMode"])
            assertTrue(h.log.maxima.values.all { it == null })
            h.ride(35)
            assertEquals("experimental_unverified_calibration", h.pipeline.snapshot["leanQualityMode"])
            assertNull(h.pipeline.snapshot["maxLeft"])
            assertNull(h.pipeline.snapshot["maxRight"])
            val calibration = h.rows().single { it.optString("recordType") == "lean_calibration" }
            assertEquals("manual_upright", calibration.getString("origin"))
            assertTrue(calibration.getJSONArray("qualityFlags").toString().contains("sensor_accuracy_unreliable"))
            val estimates = h.rows().filter { it.optString("recordType") == "lean_estimate" &&
                !it.isNull("leanAngleDeg") }
            assertTrue(estimates.isNotEmpty())
            assertTrue(estimates.all { !it.getBoolean("extremumEligible") })
            assertFalse(h.rows().any { it.optString("recordType") == "lean_extremum" })
            h.pipeline.stopped(h.time, "recording_stopped")
            assertTrue(LeanReplayAssertions.verify(h.motionFile, h.leanFile) > 0)
        }
    }
    @Test fun `other unreliable sources still block experimental path`() {
        Harness("gyro-accuracy-blocker").use { h ->
            repeat(60) { h.frame(accuracies = listOf("unreliable", "unreliable", "high")) }
            assertEquals("unavailable", h.pipeline.snapshot["leanState"])
            assertEquals("sensor_accuracy_unreliable", h.pipeline.snapshot["leanBlockReason"])
            assertEquals(listOf(sources[1].id), h.pipeline.snapshot["leanBlockedSourceIds"])
            assertFalse(h.rows().any { it.optString("recordType") == "lean_estimate" })
        }
    }
    @Test fun `quality mode changes reset epoch and hide prior extrema while experimental`() {
        Harness("experimental-transition").use { h ->
            h.calibrate()
            val trustedMax = h.log.maxima["maxLeft"]
            assertNotNull(trustedMax)
            val oldEpoch = h.log.epoch
            repeat(60) { h.frame(20.0, accuracies = listOf("unreliable", "high", "high")) }
            assertTrue(h.log.epoch > oldEpoch)
            assertEquals("experimental_unverified_accelerometer", h.pipeline.snapshot["leanQualityMode"])
            assertNull(h.pipeline.snapshot["maxLeft"])
            assertEquals(trustedMax, h.log.maxima["maxLeft"])
            val weakEpoch = h.log.epoch
            repeat(60) { h.frame(0.0) }
            assertTrue(h.log.epoch > weakEpoch)
            assertEquals("standard", h.pipeline.snapshot["leanQualityMode"])
            assertEquals(trustedMax, h.pipeline.snapshot["maxLeft"])
            h.pipeline.stopped(h.time, "recording_stopped")
        }
    }
    @Test fun `quality recovery clears blocker only after fresh complete inputs and new epoch`() {
        Harness("accuracy-recovery").use { h ->
            h.calibrate()
            val epoch = h.log.epoch
            val max = h.log.maxima
            repeat(20) { h.frame(accuracies = listOf("high", null, "high")) }
            assertEquals("sensor_accuracy_unavailable", h.pipeline.snapshot["leanBlockReason"])
            assertEquals(listOf(sources[1].id), h.pipeline.snapshot["leanBlockedSourceIds"])
            assertNull(h.pipeline.snapshot["leanAngleDeg"])
            assertEquals(max, h.log.maxima)
            repeat(60) { h.frame() }
            assertTrue(h.log.epoch > epoch)
            assertEquals("available", h.pipeline.snapshot["leanState"])
            assertNull(h.pipeline.snapshot["leanBlockReason"])
            assertEquals(emptyList<String>(), h.pipeline.snapshot["leanBlockedSourceIds"])
            val states = h.rows().filter { it.optString("eventType") == "estimator_state" }
            assertTrue(states.last().isNull("reason"))
            h.pipeline.stopped(h.time, "recording_stopped")
        }
    }
    @Test fun `clock failure and buffer gap clear inputs and return on fresh epoch`() {
        Harness("clock-and-gap").use { h ->
            h.calibrate()
            val initialEpoch = h.log.epoch
            h.frame(verified = false)
            assertNull(h.pipeline.snapshot["leanAngleDeg"])
            repeat(60) { h.frame() }
            assertTrue(h.log.epoch > initialEpoch)
            val epoch = h.log.epoch
            h.raw.dropped(sources[0].id, 4, null, null, "buffer_full", utc + h.time / 1000, h.time + 1000)
            h.pipeline.interrupted("after_input_gap", utc + h.time / 1000, h.time + 1000)
            repeat(60) { h.frame() }
            assertTrue(h.log.epoch > epoch)
            h.pipeline.stopped(h.time, "recording_stopped")
        }
    }
    @Test fun `high force flags do not increase maximum and cancellation retains old calibration`() {
        Harness("quality-gate").use { h ->
            h.calibrate()
            val id = h.log.calibrationId
            val max = h.log.maxima
            repeat(20) { h.frame(15.0, force = 15.0) }
            assertEquals(max, h.log.maxima)
            assertTrue((h.pipeline.snapshot["leanFlags"] as List<*>).contains("dynamic_acceleration_high"))
            h.pipeline.control("upright"); h.pipeline.control("cancel")
            assertEquals(id, h.log.calibrationId)
            h.pipeline.stopped(h.time, "recording_stopped")
        }
    }
    @Test fun `boot recovery repairs lean tail closes old segment and requires fresh calibration`() {
        var last = 0L
        Harness("boot-recovery").use { h -> h.calibrate(); last = h.time }
        fixture("boot-recovery.lean.ndjson").appendText("{\"incomplete\":")
        Harness("boot-recovery", "boot-b", 10_000, fresh = false).use { h ->
            assertNull(h.log.calibrationId)
            assertNull(h.log.maxima["maxLeft"]) // Current segment must not inherit old peaks.
            repeat(60) { h.frame(0.0) }
            assertNull(h.pipeline.snapshot["leanAngleDeg"])
            val closed = h.rows().single { it.optString("recordType") == "lean_segment_closed" }
            assertEquals("boot-a", closed.getString("deviceBootId"))
            assertEquals("boot_changed", closed.getString("closeReason"))
            assertTrue(closed.getLong("closedAtMonotonicUs") <= last)
        }
    }
    @Test fun `dangling complete raw reference is rejected before repairing partial lean tail`() {
        Harness("dangling", fresh = true).use { h -> repeat(60) { h.frame() } }
        val file = fixture("dangling.lean.ndjson")
        file.appendText("partial")
        val original = file.readBytes()
        val log = LeanLogWriter(file, "synthetic-lean", "boot-a", "test", sources.map { it.id },
            { emptyMap() }, {})
        assertThrows(IllegalArgumentException::class.java) { log.start(utc, 5_000_000) }
        assertArrayEquals(original, file.readBytes())
        // Deliberately broken case is not an emitted valid fixture.
        file.delete(); fixture("dangling.motion.ndjson").delete()
    }
    @Test fun `lean sync calls raw durability barrier and append failure never advances sequence`() {
        val file = Files.createTempFile("lean-failure", ".ndjson").toFile()
        var barrier = 0
        var fail = false
        val log = LeanLogWriter(file, "id", "boot", "test", sources.map { it.id },
            { sources.associate { it.id to 0L } }, { barrier++ }, appendOverride = { if (fail) throw IOException("lean IO") })
        log.use {
            it.start(utc, 1_000_000)
            assertEquals(1, barrier)
            it.state(true, null, utc, 2_000_000)
            fail = true
            assertThrows(IOException::class.java) {
                it.estimate(2_000_000, 2_001_000, null, sources.associate { s -> s.id to 0L }, 0, emptyList(), utc)
            }
            assertEquals(0L, it.count)
            assertThrows(IllegalStateException::class.java) { it.reset("recovery", emptyMap(), utc, 3_000_000) }
        }
        assertEquals(2, barrier)
    }
    @Test fun `stale and future UI values are hidden without modifying persisted snapshot`() {
        val value = mapOf("leanMeasurementUs" to 1_000_000L, "leanAngleDeg" to -20.0, "leanState" to "available")
        assertEquals(-20.0, motionSnapshotAt(value, 1_500_000)["leanAngleDeg"])
        assertNull(motionSnapshotAt(value, 1_500_001)["leanAngleDeg"])
        assertEquals("input_stale", motionSnapshotAt(value, 1_500_001)["leanBlockReason"])
        assertNull(motionSnapshotAt(value, 999_999)["leanAngleDeg"])
        assertEquals(-20.0, value["leanAngleDeg"])
    }
    @Test fun `silent sensor interruption is logged and fresh inputs use another epoch`() {
        Harness("silent-gap").use { h ->
            h.calibrate()
            val epoch = h.log.epoch
            h.time += 600_000
            assertTrue(h.pipeline.expire(h.time, utc + h.time / 1000))
            assertNull(h.pipeline.snapshot["leanAngleDeg"])
            assertFalse(h.pipeline.expire(h.time, utc + h.time / 1000))
            repeat(60) { h.frame() }
            assertTrue(h.log.epoch > epoch)
            h.pipeline.stopped(h.time, "recording_stopped")
        }
    }
    @Test fun `recalibration preserves closed maxima and starts with no maxima`() {
        Harness("recalibration").use { h ->
            h.calibrate()
            val old = h.log.calibrationId
            val oldMax = h.log.maxima["maxLeft"]
            assertNotNull(oldMax)
            repeat(20) { h.frame(0.0) }
            h.pipeline.control("upright"); repeat(152) { h.frame(0.0) }
            h.frame(15.0); h.pipeline.control("left"); repeat(151) { h.frame(15.0) }
            assertEquals("activating_manual", h.pipeline.snapshot["calibrationState"])
            assertEquals(old, h.log.calibrationId)
            h.frame(15.0) // Actual next measurement activates; no invented future write time.
            assertNotEquals(old, h.log.calibrationId)
            assertNull(h.log.maxima["maxLeft"])
            val closed = h.rows().single { it.optString("recordType") == "lean_segment_closed" }
            assertEquals(old, closed.getString("calibrationId"))
            assertEquals(oldMax, closed.getJSONObject("maxLeft").getDouble("peakAbsAngleDeg"))
            h.pipeline.stopped(h.time + 1, "recording_stopped")
        }
    }
    @Test fun `unreliable gyroscope never reaches estimator or completes calibration`() {
        Harness("accuracy-gate").use { h ->
            repeat(60) { h.frame() }
            h.pipeline.control("upright")
            h.pipeline.consume(sources[1], 60, h.time + 20_000, h.time + 21_000, utc,
                doubleArrayOf(0.0, 0.0, 0.0), h.raw.currentMapId, h.time + 22_000, "unreliable")
            assertEquals("unavailable", h.pipeline.snapshot["leanState"])
            assertEquals("idle", h.pipeline.snapshot["calibrationState"])
            assertNull(h.pipeline.snapshot["leanAngleDeg"])
        }
    }
    @Test fun `stored full epoch inputs reproduce every nonnull estimate across resets`() {
        Harness("full-epoch-replay").use { h ->
            h.calibrate()
            repeat(200) { h.frame(20.0 * sin(it / 40.0), force = if (it in 80..90) 12.0 else 9.80665) }
            h.raw.dropped(sources[1].id, 2, null, null, "buffer_full", utc + h.time / 1000, h.time + 1000)
            h.pipeline.interrupted("after_input_gap", utc + h.time / 1000, h.time + 1000)
            repeat(150) { h.frame(12.0 * sin(it / 30.0)) }
            h.frame(verified = false)
            repeat(120) { h.frame(-5.0) }
            h.pipeline.stopped(h.time, "recording_stopped")
            assertTrue(LeanReplayAssertions.verify(h.motionFile, h.leanFile) > 100)
        }
    }
}
