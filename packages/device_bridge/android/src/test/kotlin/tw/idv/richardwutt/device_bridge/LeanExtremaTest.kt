package tw.idv.richardwutt.device_bridge

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class LeanExtremaTest {
    @Test fun `isolated spike does not set maximum and both sides are separate`() {
        val state = LeanExtrema()
        state.calibrate("a", "boot", 0)
        for (t in 0L..200_000L step 20_000L) state.add(t, "boot", if (t == 80_000L) -80.0 else -20.0, true)
        assertEquals(20.0, state.current!!.left!!.magnitudeDeg)
        assertNull(state.current!!.right)
        for (t in 220_000L..340_000L step 20_000L) state.add(t, "boot", 30.0, true)
        assertEquals(30.0, state.current!!.right!!.magnitudeDeg)
    }
    @Test fun `recalibration preserves old segment and does not inherit its maximum`() {
        val state = LeanExtrema()
        state.calibrate("a", "boot", 0)
        for (t in 0L..100_000L step 20_000L) state.add(t, "boot", -20.0, true)
        state.calibrate("b", "boot", 200_000L)
        assertNull(state.current!!.left)
        assertEquals(20.0, state.segments.first().left!!.magnitudeDeg)
        assertEquals(2, state.segments.size)
    }
    @Test fun `invalid stale gapped and other boot data never bridge peak window`() {
        val state = LeanExtrema()
        state.calibrate("a", "boot", 0)
        state.add(0, "boot", -20.0, true)
        state.add(20_000, "boot", null, false)
        state.add(40_000, "boot", -20.0, true)
        state.add(60_000, "other", -20.0, true)
        state.add(80_000, "boot", -20.0, true)
        state.add(400_000, "boot", -20.0, true)
        state.add(390_000, "boot", -20.0, true)
        assertNull(state.current!!.left)
    }
}
