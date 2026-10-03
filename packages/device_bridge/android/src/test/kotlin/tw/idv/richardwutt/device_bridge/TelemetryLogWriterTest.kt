package tw.idv.richardwutt.device_bridge

import org.json.JSONObject
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File

class TelemetryLogWriterTest {
    @TempDir lateinit var directory: File
    private val utc = 1_800_000_000_000L
    private val mono = 10_000_000L

    private fun writer(file: File, heartbeatMs: Long = 300_000L) =
        TelemetryLogWriter(file, "synthetic-recording", "android-gps", "0.0.2+2", heartbeatMs)

    private fun snapshot(
        percent: Int? = 83,
        charging: Boolean? = false,
        source: String = "none",
        interactive: Boolean? = true,
        keyguard: Boolean? = false,
        lifecycle: String = "foreground",
        service: String = "started",
        detail: String? = null,
        restarts: Int = 0,
        resume: String? = null,
    ) = TelemetrySnapshot(
        batteryPercent = percent,
        batteryCharging = charging,
        batteryPowerSource = source,
        powerSaveMode = false,
        screenInteractive = interactive,
        keyguardLocked = keyguard,
        protectedDataAvailable = null,
        appLifecycle = lifecycle,
        locationServiceState = service,
        locationServiceDetail = detail,
        processRestartCount = restarts,
        resumeReason = resume,
    )

    private fun rows(file: File) =
        file.readLines().filter { it.isNotBlank() }.map { JSONObject(it) }

    private fun flags(row: JSONObject) =
        (0 until row.getJSONArray("unavailable").length())
            .map { row.getJSONArray("unavailable").getString(it) }
            .toSet()

    private fun export(file: File, name: String) {
        System.getProperty("roadscope.telemetryOutput")?.let { output ->
            File(output).mkdirs()
            file.copyTo(File(output, "$name.ndjson"), overwrite = true)
        }
    }

    @Test fun `opening row carries state, own sequence space and no position data`() {
        val file = File(directory, "telemetry.ndjson")
        val writer = writer(file)
        writer.recover()
        assertTrue(writer.record(TelemetryLogWriter.TRIGGER_RECORDING_STARTED,
            snapshot(), utc, mono, "boot-a", -1L))
        val row = rows(file).single()
        assertEquals(1, row.getInt("telemetryVersion"))
        assertEquals("diagnostics_telemetry", row.getString("recordType"))
        assertEquals("android", row.getString("platform"))
        assertEquals(0, row.getInt("telemetrySequence"))
        assertEquals(-1, row.getInt("locationLogLastSequence"))
        assertEquals(83, row.getInt("batteryPercent"))
        assertFalse(row.getBoolean("batteryCharging"))
        assertTrue(row.getBoolean("screenInteractive"))
        assertFalse(row.getBoolean("keyguardLocked"))
        assertEquals("foreground", row.getString("appLifecycle"))
        assertEquals("started", row.getString("locationServiceState"))
        assertEquals("initial_snapshot", row.getJSONArray("reasons").getString(0))
        // Diagnostics must never duplicate the location log's record stream.
        assertFalse(row.has("sequence"))
        assertFalse(row.has("schemaVersion"))
        for (key in listOf("latDeg", "lonDeg", "speedMps", "headingDeg",
            "horizontalAccuracyM", "speedAccuracyMps", "altitudeM")) {
            assertFalse(row.has(key), "telemetry must not carry $key")
        }
        export(file, "started")
    }

    @Test fun `null values always carry their flag and no flag appears without a null`() {
        val file = File(directory, "telemetry.ndjson")
        val writer = writer(file)
        writer.record(TelemetryLogWriter.TRIGGER_RECORDING_STARTED,
            snapshot(percent = null, charging = null, source = "unknown",
                interactive = null, keyguard = null, lifecycle = "unknown",
                service = "unknown"),
            null, null, null, -1L)
        val row = rows(file).single()
        assertTrue(row.isNull("batteryPercent"))
        assertTrue(row.isNull("occurredAtUtc"))
        assertTrue(row.isNull("occurredMonotonicUs"))
        assertTrue(row.isNull("deviceBootId"))
        assertEquals(setOf(
            "battery_percent_unavailable", "battery_charging_unavailable",
            "battery_power_source_unknown", "screen_interactive_unavailable",
            "keyguard_state_unavailable", "protected_data_state_unavailable",
            "app_lifecycle_unknown", "location_service_state_unknown",
            "device_boot_id_unavailable", "utc_time_unavailable",
            "monotonic_time_unavailable",
        ), flags(row))
        // powerSaveMode was observable, so it must not be flagged.
        assertFalse(flags(row).contains("power_save_mode_unavailable"))
        export(file, "all-unavailable")
    }

    @Test fun `unchanged state writes nothing and a real change names its reason`() {
        val file = File(directory, "telemetry.ndjson")
        val writer = writer(file)
        writer.record(TelemetryLogWriter.TRIGGER_RECORDING_STARTED, snapshot(), utc, mono, "boot-a", -1L)
        assertFalse(writer.record(TelemetryLogWriter.TRIGGER_STATE_CHANGE,
            snapshot(), utc + 1000, mono + 1_000_000, "boot-a", 3L))
        assertTrue(writer.record(TelemetryLogWriter.TRIGGER_STATE_CHANGE,
            snapshot(percent = 82, interactive = false, keyguard = true, lifecycle = "background"),
            utc + 2000, mono + 2_000_000, "boot-a", 5L))
        val rows = rows(file)
        assertEquals(2, rows.size)
        val reasons = (0 until rows[1].getJSONArray("reasons").length())
            .map { rows[1].getJSONArray("reasons").getString(it) }
        assertEquals(listOf("battery_percent", "screen_interactive", "keyguard_locked",
            "app_lifecycle"), reasons)
        assertEquals(1, rows[1].getInt("telemetrySequence"))
        assertEquals(5, rows[1].getInt("locationLogLastSequence"))
        export(file, "state-change")
    }

    @Test fun `heartbeat is rate limited but lifecycle triggers always write`() {
        val file = File(directory, "telemetry.ndjson")
        val writer = writer(file, heartbeatMs = 60_000L)
        writer.record(TelemetryLogWriter.TRIGGER_RECORDING_STARTED, snapshot(), utc, mono, "boot-a", -1L)
        assertFalse(writer.record(TelemetryLogWriter.TRIGGER_HEARTBEAT,
            snapshot(), utc + 30_000, mono + 30_000_000, "boot-a", 0L))
        assertTrue(writer.record(TelemetryLogWriter.TRIGGER_HEARTBEAT,
            snapshot(), utc + 90_000, mono + 90_000_000, "boot-a", 1L))
        // Nothing changed, but a stop still has to be recorded.
        assertTrue(writer.record(TelemetryLogWriter.TRIGGER_RECORDING_STOPPED,
            snapshot(service = "stopped"), utc + 91_000, mono + 91_000_000, "boot-a", 2L))
        val rows = rows(file)
        assertEquals(listOf("recording_started", "heartbeat", "recording_stopped"),
            rows.map { it.getString("trigger") })
        assertEquals(listOf(0, 1, 2), rows.map { it.getInt("telemetrySequence") })
        export(file, "heartbeat")
    }

    @Test fun `incomplete tail is repaired and the restored state survives a restart`() {
        val file = File(directory, "telemetry.ndjson")
        val first = writer(file)
        first.record(TelemetryLogWriter.TRIGGER_RECORDING_STARTED, snapshot(), utc, mono, "boot-a", -1L)
        first.record(TelemetryLogWriter.TRIGGER_STATE_CHANGE,
            snapshot(percent = 80), utc + 1000, mono + 1_000_000, "boot-a", 2L)
        val partial = "{\"telemetryVersion\":1,\"recordType\":\"diag".toByteArray(Charsets.UTF_8)
        file.appendBytes(partial)

        val resumed = writer(file)
        resumed.recover()
        assertEquals(2L, resumed.sequence)
        // Restored state means an unchanged resume still writes (lifecycle
        // trigger) but a following identical state change does not.
        assertTrue(resumed.record(TelemetryLogWriter.TRIGGER_RECORDING_RESUMED,
            snapshot(percent = 80, service = "restarted", restarts = 1, resume = "process_restart"),
            utc + 2000, mono + 2_000_000, "boot-a", 2L))
        val resumedRow = rows(file)[2]
        assertEquals(partial.size, resumedRow.getInt("recoveredTruncatedBytes"))
        assertEquals("process_restart", resumedRow.getString("resumeReason"))
        assertEquals(1, resumedRow.getInt("processRestartCount"))
        assertEquals(2, resumedRow.getInt("telemetrySequence"))
        assertFalse(resumed.record(TelemetryLogWriter.TRIGGER_STATE_CHANGE,
            snapshot(percent = 80, service = "restarted", restarts = 1, resume = "process_restart"),
            utc + 3000, mono + 3_000_000, "boot-a", 2L))
        assertEquals(3, rows(file).size)
        // Only the row that followed the repair reports the dropped bytes.
        assertTrue(rows(file)[0].isNull("recoveredTruncatedBytes"))
        assertTrue(rows(file)[1].isNull("recoveredTruncatedBytes"))
        export(file, "truncated-resume")
    }

    @Test fun `unreadable complete rows are preserved and do not reset the sequence`() {
        val file = File(directory, "telemetry.ndjson")
        val writer = writer(file)
        writer.record(TelemetryLogWriter.TRIGGER_RECORDING_STARTED, snapshot(), utc, mono, "boot-a", -1L)
        val before = file.readText()
        file.appendText("not-json\n")
        file.appendText("{\"recordType\":\"diagnostics_telemetry\",\"recordingId\":\"other\"}\n")
        val resumed = writer(file)
        resumed.recover()
        assertEquals(1L, resumed.sequence)
        assertTrue(file.readText().startsWith(before))
        resumed.record(TelemetryLogWriter.TRIGGER_RECORDING_RESUMED,
            snapshot(service = "restarted"), utc + 1000, mono + 1_000_000, "boot-a", 0L)
        // The junk lines are still there, so only the appended tail is parsed.
        val appended = JSONObject(file.readLines().last { it.isNotBlank() })
        assertEquals(1, appended.getInt("telemetrySequence"))
        assertEquals("recording_resumed", appended.getString("trigger"))
        assertTrue(file.readText().contains("not-json"))
    }

    @Test fun `an interrupted segment is marked without claiming device state`() {
        val file = File(directory, "telemetry.ndjson")
        val first = writer(file)
        first.record(TelemetryLogWriter.TRIGGER_RECORDING_STARTED, snapshot(), utc, mono, "boot-a", -1L)
        first.record(TelemetryLogWriter.TRIGGER_STATE_CHANGE,
            snapshot(percent = 80), utc + 1000, mono + 1_000_000, "boot-a", 20L)

        // A later process notices that the segment never closed itself.
        val later = writer(file)
        later.recover()
        assertTrue(later.record(TelemetryLogWriter.TRIGGER_RECORDING_INTERRUPTED,
            TelemetrySnapshot(
                locationServiceDetail = "previous process ended without a closing telemetry row",
                processRestartCount = 0),
            utc + 60_000, mono + 60_000_000, "boot-a", 41L))
        val row = rows(file).last()
        assertEquals("recording_interrupted", row.getString("trigger"))
        assertEquals(2, row.getInt("telemetrySequence"))
        // The only hard fact about where collection got to.
        assertEquals(41, row.getInt("locationLogLastSequence"))
        assertEquals("previous process ended without a closing telemetry row",
            row.getString("locationServiceDetail"))
        // Not a field-by-field diff: the values did not become unavailable,
        // we simply never knew them.
        assertEquals(listOf("previous_segment_not_closed"),
            (0 until row.getJSONArray("reasons").length())
                .map { row.getJSONArray("reasons").getString(it) })
        // Nothing is claimed about the device at the moment the segment died.
        for (key in listOf("batteryPercent", "batteryCharging", "powerSaveMode",
            "screenInteractive", "keyguardLocked")) {
            assertTrue(row.isNull(key), "$key must not be claimed")
        }
        assertTrue(flags(row).containsAll(listOf(
            "battery_percent_unavailable", "battery_charging_unavailable",
            "power_save_mode_unavailable", "screen_interactive_unavailable",
            "keyguard_state_unavailable", "app_lifecycle_unknown",
            "location_service_state_unknown", "battery_power_source_unknown")))
        export(file, "interrupted")
    }

    @Test fun `the interrupted marker is written even when nothing changed`() {
        val file = File(directory, "telemetry.ndjson")
        val writer = writer(file)
        val interrupted = TelemetrySnapshot(processRestartCount = 0)
        assertTrue(writer.record(TelemetryLogWriter.TRIGGER_RECORDING_INTERRUPTED,
            interrupted, utc, mono, "boot-a", 5L))
        // Same state again as a plain state change writes nothing...
        assertFalse(writer.record(TelemetryLogWriter.TRIGGER_STATE_CHANGE,
            interrupted, utc + 1000, mono + 1_000_000, "boot-a", 5L))
        // ...but the lifecycle marker always does.
        assertTrue(writer.record(TelemetryLogWriter.TRIGGER_RECORDING_INTERRUPTED,
            interrupted, utc + 2000, mono + 2_000_000, "boot-a", 5L))
        assertEquals(2, rows(file).size)
    }

    @Test fun `a failed append does not advance the sequence`() {
        val file = File(directory, "telemetry.ndjson")
        val writer = writer(file)
        writer.record(TelemetryLogWriter.TRIGGER_RECORDING_STARTED, snapshot(), utc, mono, "boot-a", -1L)
        assertTrue(file.delete())
        assertTrue(file.mkdir()) // A directory cannot be opened as an append file.
        assertThrows(Exception::class.java) {
            writer.record(TelemetryLogWriter.TRIGGER_RECORDING_STOPPED,
                snapshot(service = "stopped"), utc, mono, "boot-a", 0L)
        }
        assertEquals(1L, writer.sequence)
    }
}
