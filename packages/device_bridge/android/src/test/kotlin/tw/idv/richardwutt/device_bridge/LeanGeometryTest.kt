package tw.idv.richardwutt.device_bridge

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import kotlin.math.*

class LeanGeometryTest {
    private fun up(deg: Double, pitch: Double = 0.0): LeanVector {
        val r = Math.toRadians(deg); val p = Math.toRadians(pitch)
        return LeanVector(-sin(r) * cos(p), sin(p), cos(r) * cos(p))
    }
    // Arbitrary orthogonal change of mount coordinates, including portrait,
    // landscape and slanted mounting. Not a change to the physical lean.
    private fun mount(v: LeanVector, degrees: Double): LeanVector {
        val r = Math.toRadians(degrees)
        val a = LeanVector(v.x * cos(r) - v.y * sin(r), v.x * sin(r) + v.y * cos(r), v.z)
        return LeanVector(a.x, (a.y - a.z) / sqrt(2.0), (a.y + a.z) / sqrt(2.0))
    }
    @Test fun `roll sign and pitch projection survive arbitrary mounting`() {
        for (rotation in listOf(0.0, 90.0, 180.0, 37.0)) {
            val calibration = LeanMount.fromLeftPose(mount(up(0.0), rotation), mount(up(-12.0), rotation))!!
            for (angle in listOf(-60.0, -20.0, 0.0, 20.0, 60.0)) {
                assertEquals(angle, calibration.angle(mount(up(angle, 15.0), rotation))!!, 1e-8)
            }
        }
    }
    @Test fun `insufficient and invalid direction poses are rejected`() {
        for (angle in listOf(0.0, -2.0, -40.0)) assertNull(LeanMount.fromLeftPose(up(0.0), up(angle)))
        assertNull(LeanMount.fromLeftPose(LeanVector(Double.NaN, 0.0, 1.0), up(-12.0)))
        val calibration = LeanMount.fromLeftPose(up(0.0), up(-12.0))!!
        assertNull(calibration.angle(LeanVector(0.0, 0.0, 0.0)))
        assertNull(calibration.angle(up(180.0)))
        assertNull(calibration.angle(up(0.0, 89.0)))
    }
    @Test fun `calibration requires three real seconds not a sample count`() {
        val window = UprightWindow()
        for (t in 0L until 3_000_000L step 20_000L) assertNull(window.add(t, up(0.0), 0.0, 9.80665))
        assertNotNull(window.add(3_000_000L, up(0.0), 0.0, 9.80665))
    }
    @Test fun `gaps clock regression vibration and movement reset qualification`() {
        for (failure in 0..4) {
            val window = UprightWindow()
            for (t in 0L..2_980_000L step 20_000L) window.add(t, up(0.0), 0.0, 9.80665)
            val result = when (failure) {
                0 -> window.add(4_000_000L, up(0.0), 0.0, 9.80665)
                1 -> window.add(1L, up(0.0), 0.0, 9.80665)
                2 -> window.add(3_000_000L, up(0.0), 0.2, 9.80665)
                3 -> window.add(3_000_000L, up(0.0), 0.0, 12.0)
                else -> window.add(3_000_000L, up(5.0), 0.0, 9.80665)
            }
            assertNull(result)
        }
    }
}
