package tw.idv.richardwutt.device_bridge

import android.Manifest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class BackgroundExecutionSupportTest {
    @Test
    fun `Android 13 start requests missing location and notification permissions together`() {
        assertEquals(
            listOf(
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_COARSE_LOCATION,
                Manifest.permission.POST_NOTIFICATIONS,
            ),
            requiredRecordingPermissions(33, false, false),
        )
    }

    @Test
    fun `notification denial does not cause location to be requested again`() {
        assertEquals(
            listOf(Manifest.permission.POST_NOTIFICATIONS),
            requiredRecordingPermissions(36, true, false),
        )
        assertEquals(emptyList<String>(), requiredRecordingPermissions(32, true, false))
    }

    @Test
    fun `vendor guidance is explicit and conservative`() {
        assertTrue(BackgroundExecutionSupport.recommendsVendorGuidance("Xiaomi"))
        assertTrue(BackgroundExecutionSupport.recommendsVendorGuidance("OPPO"))
        assertTrue(BackgroundExecutionSupport.recommendsVendorGuidance("HUAWEI"))
        assertFalse(BackgroundExecutionSupport.recommendsVendorGuidance("Google"))
    }
}
