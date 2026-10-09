package tw.idv.richardwutt.device_bridge

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import kotlin.math.*

class AutoUprightReferenceTest {
    private fun up(deg: Double) = LeanVector(sin(Math.toRadians(deg)), 0.0, cos(Math.toRadians(deg)))
    private fun fix(time: Long, heading: Double = 0.0) = AutoUprightReference.Fix(
        "boot", time, true, 10.0, 3.0, 0.5, heading, 2.0)
    private class Harness {
        val selector = AutoUprightReference("boot")
        var time = 1_000_000L
        private var lastFix = 0L
        init { selector.updateFix(AutoUprightReference.Fix("boot", 0L, true, 10.0, 3.0, 0.5, 0.0, 2.0)) }
        fun run(duration: Long, pose: Double = 0.0, step: Long = 20_000,
            gyro: Double = 0.0, acceleration: Double = 9.80665): AutoUprightReference.Reference? {
            val end = time + duration
            var result: AutoUprightReference.Reference? = null
            while (time <= end) {
                if (time - lastFix >= 1_000_000) {
                    selector.updateFix(AutoUprightReference.Fix(
                        "boot", time, true, 10.0, 3.0, 0.5, 0.0, 2.0))
                    lastFix = time
                }
                val radians = Math.toRadians(pose)
                result = selector.add(time, LeanVector(sin(radians), 0.0, cos(radians)), gyro, acceleration) ?: result
                time += step
            }
            return result
        }
    }
    @Test fun `thirty seconds uses duration not callback count`() {
        for (step in listOf(20_000L, 100_000L)) {
            val h = Harness()
            val result = h.run(30_000_000, 17.0, step)!!
            assertEquals(30_000_000, result.accumulatedDurationUs)
            assertEquals(10, result.windowCount)
            assertEquals(17.0, Math.toDegrees(atan2(result.up.x, result.up.z)), 1e-8)
            assertEquals(10.0, result.minSpeedMps)
            assertEquals(0.0, result.maxYawRateRadPerS)
            assertNull(h.run(3_000_000)) // One proposal only; no automatic churn.
        }
    }
    @Test fun `missing gps never invents a reference`() {
        val s = AutoUprightReference("boot")
        for (t in 0L..60_000_000L step 20_000) assertNull(s.add(t, up(0.0), 0.0, 9.80665))
        assertEquals(0L, s.dominantDurationUs)
    }
    @Test fun `spread bounds all inputs relative to the final weighted reference`() {
        val s = AutoUprightReference("boot"); s.updateFix(fix(0))
        var result: AutoUprightReference.Reference? = null
        for (t in 1_000_000L..31_000_000L step 20_000) {
            if (t % 1_000_000 == 0L) s.updateFix(fix(t))
            val pose = if ((t - 1_000_000) % 3_000_000 < 1_500_000) 0.4 else -0.4
            result = s.add(t, up(pose), 0.0, 9.80665) ?: result
        }
        val reference = result!!
        val degrees = Math.toDegrees(atan2(reference.up.x, reference.up.z))
        assertTrue(reference.upSpreadDeg >= maxOf(abs(degrees - 0.4), abs(degrees + 0.4)))
        assertTrue(reference.upSpreadDeg <= 2.0)
    }
    @Test fun `gps needs two fixes and wraps heading correctly`() {
        val s = AutoUprightReference("boot")
        s.updateFix(fix(0, 359.5)); s.add(0, up(0.0), 0.0, 9.80665)
        s.updateFix(fix(1_000_000, 0.0))
        for (t in 1_000_000L..4_000_000L step 20_000) {
            if (t % 1_000_000 == 0L && t > 1_000_000) s.updateFix(fix(t))
            s.add(t, up(0.0), 0.0, 9.80665)
        }
        assertEquals(3_000_000L, s.dominantDurationUs)
    }
    @Test fun `wrong boot unverified missing poor or nonfinite gps resets the window`() {
        val good = fix(3_000_000)
        val bad = listOf(good.copy(boot = "other"), good.copy(clockVerified = false),
            good.copy(measuredUs = null), good.copy(speedMps = null), good.copy(speedMps = 0.0),
            good.copy(horizontalAccuracyM = 11.0), good.copy(speedAccuracyMps = 2.0),
            good.copy(headingDeg = null), good.copy(headingAccuracyDeg = 6.0),
            good.copy(headingDeg = 360.0), good.copy(speedMps = Double.NaN))
        for (value in bad) {
            val h = Harness(); h.run(1_980_000); h.selector.updateFix(value)
            h.selector.add(3_000_000, up(0.0), 0.0, 9.80665)
            assertEquals(0L, h.selector.dominantDurationUs)
        }
    }
    @Test fun `stale future turning duplicate and regressing fixes cannot qualify`() {
        for (failure in 0..4) {
            val s = AutoUprightReference("boot")
            s.updateFix(fix(0)); s.updateFix(fix(1_000_000))
            when (failure) {
                0 -> s.add(2_500_001, up(0.0), 0.0, 9.80665)
                1 -> s.add(999_999, up(0.0), 0.0, 9.80665)
                2 -> s.updateFix(fix(2_000_000, 10.0))
                3 -> s.updateFix(fix(1_000_000))
                4 -> s.updateFix(fix(500_000))
            }
            for (t in 3_000_000L..6_000_000L step 20_000) s.add(t, up(0.0), 0.0, 9.80665)
            assertEquals(0L, s.dominantDurationUs)
        }
    }
    @Test fun `vibration gyro rotation and orientation spread prevent accumulation`() {
        for (failure in 0..3) {
            val h = Harness()
            when (failure) {
                0 -> h.run(35_000_000, gyro = 0.02)
                1 -> h.run(35_000_000, acceleration = 10.3)
                2 -> h.run(35_000_000, gyro = Double.NaN)
                3 -> repeat(20) { h.run(1_000_000, if (it % 2 == 0) 0.0 else 5.0) }
            }
            assertEquals(0L, h.selector.dominantDurationUs)
        }
    }
    @Test fun `callback gaps and time replay cannot inflate duration`() {
        val h = Harness(); h.run(1_980_000)
        h.time += 200_000; h.run(1_980_000)
        assertEquals(0L, h.selector.dominantDurationUs)
        repeat(3) {
            for (t in 1_000_000L..4_000_000L step 20_000) h.selector.add(t, up(0.0), 0.0, 9.80665)
        }
        assertEquals(0L, h.selector.dominantDurationUs)
    }
    @Test fun `longest accumulated pose wins only with a clear margin`() {
        val h = Harness()
        assertNull(h.run(24_000_000, 0.0))
        assertNull(h.run(30_000_000, 10.0)) // 30 versus 24 is ambiguous.
        val result = h.run(9_000_000, 10.0)!!
        assertTrue(result.accumulatedDurationUs >= 36_000_000)
        assertEquals(10.0, Math.toDegrees(atan2(result.up.x, result.up.z)), 1e-8)
        assertTrue(result.toUs - result.fromUs >= result.accumulatedDurationUs)
    }
    @Test fun `sparse longer pose defeats dense shorter pose`() {
        val h = Harness()
        assertNull(h.run(12_000_000, 0.0, 20_000)) // About 600 callbacks.
        val result = h.run(30_200_000, 10.0, 100_000)!! // About 300 callbacks.
        assertEquals(10.0, Math.toDegrees(atan2(result.up.x, result.up.z)), 1e-8)
        assertEquals(30_000_000L, result.accumulatedDurationUs)
    }
    @Test fun `bounded candidate overflow fails closed without eviction`() {
        val h = Harness()
        repeat(9) { assertNull(h.run(3_020_000, it * 5.0)) }
        assertEquals(8, h.selector.candidateCount)
        assertTrue(h.selector.saturated)
        assertNull(h.run(60_000_000))
        h.selector.reset()
        assertEquals(0, h.selector.candidateCount); assertFalse(h.selector.saturated)
        assertEquals(0L, h.selector.dominantDurationUs)
    }
}
