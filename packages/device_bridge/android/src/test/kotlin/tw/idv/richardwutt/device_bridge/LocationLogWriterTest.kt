package tw.idv.richardwutt.device_bridge

import org.json.JSONArray
import org.json.JSONObject
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.time.Instant

class LocationLogWriterTest {
    @TempDir lateinit var directory: File
    private val utc = 1_800_000_000_000L
    private val mono = 10_000_000L
    private val anchor get() = utc - mono / 1000
    private fun writer(file: File, boot: String = "boot-a", base: Long = anchor) =
        LocationLogWriter(file, "synthetic-recording", "0.0.2+2", boot, base)
    private fun sample(time: Long, monotonic: Long) = JSONObject().apply {
        put("measuredAtUtc", Instant.ofEpochMilli(time - 20).toString())
        put("measurementMonotonicUs", monotonic - 20_000)
        put("latDeg", 25.0); put("lonDeg", 121.0)
        put("altitudeM", JSONObject.NULL); put("speedMps", 4.1)
        put("headingDeg", 37.0); put("horizontalAccuracyM", 5.0)
        put("speedAccuracyMps", JSONObject.NULL)
        put("qualityFlags", JSONArray(listOf("synthetic", "altitude_unavailable", "speed_accuracy_unavailable")))
    }
    private fun rows(file: File) = file.readLines().filter { it.isNotBlank() }.map { JSONObject(it) }
    private fun export(file: File, name: String) {
        System.getProperty("roadscope.nativeOutput")?.let { output ->
            File(output).mkdirs()
            file.copyTo(File(output, "$name.ndjson"), overwrite = true)
        }
    }

    @Test fun `start precedes callbacks and events do not consume sequence`() {
        val file = File(directory, "log.ndjson")
        val writer = writer(file)
        writer.start(utc, mono, false)
        writer.sample(sample(utc + 1000, mono + 1_000_000), utc + 1000, mono + 1_000_000)
        val rows = rows(file)
        assertEquals("recording_started", rows[0].getString("eventType"))
        assertEquals(-1, rows[0].getInt("lastSequence"))
        assertEquals(0, rows[1].getInt("sequence"))
        assertEquals("phone_location", rows[1].getString("sourceType"))
        export(file, "started")
    }

    @Test fun `truncated UTF-8 tail is repaired and announced before resumed sample`() {
        val file = File(directory, "log.ndjson")
        val first = writer(file)
        first.start(utc, mono, false)
        first.sample(sample(utc + 1000, mono + 1_000_000), utc + 1000, mono + 1_000_000)
        val partial = "{\"partial\":\"測試".toByteArray(Charsets.UTF_8)
        file.appendBytes(partial)
        val resumed = writer(file)
        resumed.start(utc + 2000, mono + 2_000_000, true)
        resumed.sample(sample(utc + 3000, mono + 3_000_000), utc + 3000, mono + 3_000_000)
        val rows = rows(file)
        assertEquals(listOf("recording_started", "sample", "recording_started", "log_truncated", "recording_resumed", "sample"),
            rows.map { it.optString("eventType", it.getString("recordType")) })
        assertEquals(partial.size, rows[3].getInt("truncatedBytes"))
        assertEquals(0, rows[3].getInt("lastSequence"))
        assertEquals(1, rows[3].getInt("resumedSequence"))
        assertEquals(1, rows.last().getInt("sequence"))
        assertEquals("process_restart", rows[4].getString("reason"))
        export(file, "truncated-resume")
    }

    @Test fun `clock change is declared and persisted log wins over stale preferences`() {
        val file = File(directory, "log.ndjson")
        val first = writer(file)
        first.start(utc, mono, false)
        first.sample(sample(utc + 1000, mono + 1_000_000), utc + 1000, mono + 1_000_000)
        first.sample(sample(utc + 122000, mono + 2_000_000), utc + 122000, mono + 2_000_000)
        val rows = rows(file)
        val change = rows[2]
        assertEquals("clock_adjusted", change.getString("eventType"))
        assertEquals("boot-a", change.getString("previousDeviceBootId"))
        assertEquals(anchor + 120000, change.getLong("bootAnchorUtcMs"))
        assertEquals(0, change.getInt("lastSequence"))
        val resumed = writer(file) // Simulate crash before new boot prefs were flushed.
        resumed.start(utc + 123000, mono + 3_000_000, true)
        assertEquals(first.bootId, resumed.bootId)
        resumed.sample(sample(utc + 124000, mono + 4_000_000), utc + 124000, mono + 4_000_000)
        assertEquals(1, rows(file).count { it.optString("eventType") == "clock_adjusted" })
        assertEquals(2, rows(file).last().getInt("sequence"))
        export(file, "clock-change")
    }

    @Test fun `boot rollback changes time domain but sequence continues`() {
        val file = File(directory, "log.ndjson")
        val first = writer(file)
        first.start(utc, mono, false)
        first.sample(sample(utc + 1000, mono + 1_000_000), utc + 1000, mono + 1_000_000)
        val resumed = writer(file)
        resumed.start(utc + 2000, 1_000_000, true)
        resumed.sample(sample(utc + 3000, 2_000_000), utc + 3000, 2_000_000)
        assertNotEquals(first.bootId, resumed.bootId)
        assertEquals("boot", rows(file).first { it.optString("eventType") == "recording_resumed" }.getString("reason"))
        assertEquals(1, rows(file).last().getInt("sequence"))
        export(file, "boot-resume")
    }

    @Test fun `legacy and corrupt complete rows are preserved rather than appended`() {
        for ((index, content) in listOf("{\"schemaVersion\":1}\n", "not-json\npartial").withIndex()) {
            val file = File(directory, "$index.ndjson")
            file.writeText(content)
            assertThrows(Exception::class.java) { writer(file).start(utc, mono, true) }
            assertEquals(content, file.readText())
        }
    }

    @Test fun `append failure does not advance sequence`() {
        val file = File(directory, "log.ndjson")
        val writer = writer(file)
        writer.start(utc, mono, false)
        assertTrue(file.delete())
        assertTrue(file.mkdir()) // A directory cannot be opened as an append file.
        assertThrows(Exception::class.java) { writer.sample(sample(utc, mono), utc, mono) }
        assertEquals(0L, writer.sequence)
    }
}
