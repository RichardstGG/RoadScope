package tw.idv.richardwutt.device_bridge

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class LocationRecorderServiceStateTest {
    @Test fun `persisted intent without a service is interrupted`() {
        assertEquals(
            "interrupted",
            LocationRecorderService.resolvedRecorderState("recording", false, false),
        )
    }

    @Test fun `created service is resuming until writer becomes active`() {
        assertEquals(
            "resuming",
            LocationRecorderService.resolvedRecorderState("recording", true, false),
        )
    }

    @Test fun `active service is recording and terminal states stay unchanged`() {
        assertEquals(
            "recording",
            LocationRecorderService.resolvedRecorderState("recording", true, true),
        )
        assertEquals(
            "idle",
            LocationRecorderService.resolvedRecorderState("idle", false, false),
        )
        assertEquals(
            "error",
            LocationRecorderService.resolvedRecorderState("error", true, false),
        )
    }
}
