package tw.idv.richardwutt.device_bridge

import org.json.JSONObject
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.io.File
import java.nio.file.Files
import java.io.IOException

class MotionLogWriterTest {
    private val sources = listOf(MotionSource("android-accelerometer", "accelerometer", true),
        MotionSource("android-gyroscope", "gyroscope", true),
        MotionSource("android-game-rotation-vector", "attitude", true, "game_rotation_vector"))
    private val utc = 1_800_000_000_000L
    private fun writer(file: File, boot: String = "boot-a") =
        MotionLogWriter(file, "synthetic-motion", "test+1", boot, utc - 1000, sources, synthetic = true)
    private fun fixture(name: String): File {
        val base = System.getProperty("roadscope.nativeOutput")?.let { File(it).parentFile }
            ?: Files.createTempDirectory("motion-tests").toFile()
        return File(File(base, "native-motion-fixtures").apply { mkdirs() }, "$name.motion.ndjson")
            .also { it.delete() }
    }

    @Test fun `clock verification later and failure are recorded before affected samples`() {
        val file = fixture("clock-state")
        writer(file).use { w ->
            w.start(utc, 1_000_000)
            val probes = sources.associate { it.id to MotionClockProbe() }
            repeat(60) { index ->
                val time = 2_000_000L + index * 20_000
                sources.forEach { source ->
                    val received = time + 1000
                    val verified = probes.getValue(source.id).observe(time, received, 0)
                    w.clock(source.id, verified, utc + index * 20L, received)
                    w.sample(source, if (verified) time else null, received, utc + index * 20L,
                        "high", if (source.kind == "attitude") doubleArrayOf(1.0, 0.0, 0.0, 0.0)
                        else doubleArrayOf(0.0, 0.0, 9.80665))
                }
            }
            w.clock(sources[0].id, false, utc + 2000, 4_000_000)
            w.sample(sources[0], null, 4_000_001, utc + 2000, null, doubleArrayOf(0.0, 0.0, 9.8))
            assertEquals(61L, w.counts[sources[0].id])
        }
        val rows = file.readLines().map(::JSONObject)
        assertEquals(4, rows.count { it.optString("eventType") == "source_clock_state" })
        assertTrue(rows.filter { it.optString("recordType") == "motion_sample" }
            .any { it.isNull("measurementMonotonicUs") })
    }
    @Test fun `probe refuses ambiguous uptime future regressions and excessive latency`() {
        val p = MotionClockProbe()
        repeat(40) { i -> assertFalse(p.observe(10_000_000L + i * 20_000,
            10_001_000L + i * 20_000, 10_000_000L + i * 20_000)) }
        val q = MotionClockProbe()
        repeat(40) { i -> q.observe(10_000_000L + i * 20_000, 10_001_000L + i * 20_000, 1_000_000) }
        assertTrue(q.verified)
        assertFalse(q.observe(11_000_001, 11_000_000, 1_000_000))
        assertFalse(q.observe(9_000_000, 12_000_000, 1_000_000))
    }
    @Test fun `late sources never use a future map and evicted history is explicit null`() {
        val file = fixture("mapping-late-sources")
        writer(file).use { w ->
            w.start(utc, 1_000_000)
            sources.forEach { w.clock(it.id, true, utc, 1_000_000) }
            w.sample(sources[0], 999_000, 1_001_000, utc, "high", doubleArrayOf(0.0, 0.0, 9.8))
            assertNull(w.lastSampleMapId) // Measurement predates the initial map.
            w.map(utc + 100, 1_100_000, 2_000)
            w.sample(sources[0], 1_110_000, 1_111_000, utc + 111, "high", doubleArrayOf(0.0, 0.0, 9.8))
            assertEquals(1, w.lastSampleMapId)
            w.sample(sources[1], 1_090_000, 1_112_000, utc + 112, "high", doubleArrayOf(0.0, 0.0, 0.0))
            assertEquals(0, w.lastSampleMapId) // Late gyro retains a still-applicable older map.
            repeat(5) { i -> w.map(utc + 200 + i, 1_200_000L + i * 1000, 2_000) }
            w.sample(sources[2], 1_150_000, 1_210_000, utc + 210, "high", doubleArrayOf(1.0, 0.0, 0.0, 0.0))
            assertNull(w.lastSampleMapId) // Bounded history must not invent a mapping.
        }
        val rows = file.readLines().map(::JSONObject)
        val maps = rows.filter { it.optString("eventType") == "clock_map" }.associateBy { it.getInt("mapId") }
        val samples = rows.filter { it.optString("recordType") == "motion_sample" }
        for (sample in samples) {
            if (sample.isNull("clockMapId")) assertTrue(sample.getJSONArray("qualityFlags").toString().contains("clock_map_unavailable"))
            else assertTrue(sample.getLong("measurementMonotonicUs") >=
                maps.getValue(sample.getInt("clockMapId")).getLong("effectiveFromMonotonicUs"))
        }
    }
    @Test fun `resume repairs only incomplete tail and keeps per-source sequence across boot`() {
        val file = fixture("boot-and-tail")
        writer(file).use { w ->
            w.start(utc, 1_000_000)
            w.sample(sources[0], null, 1_100_000, utc + 100, "high", doubleArrayOf(0.0, 0.0, 9.8))
        }
        file.appendText("{\"partial\":")
        writer(file, "boot-b").use { w ->
            w.start(utc + 10_000, 10_000)
            assertEquals(1L, w.counts[sources[0].id])
            w.sample(sources[0], null, 20_000, utc + 10_010, "high", doubleArrayOf(0.0, 0.0, 9.8))
        }
        assertTrue(file.readText().contains("log_truncated"))
        assertEquals(listOf(0L, 1L), file.readLines().map(::JSONObject)
            .filter { it.optString("recordType") == "motion_sample" }.map { it.getLong("sequence") })
    }
    @Test fun `damaged complete row is preserved even with a partial tail`() {
        val file = Files.createTempFile("motion-corrupt", ".ndjson").toFile()
        file.writeText("not-json\npartial")
        val original = file.readBytes()
        assertThrows(Exception::class.java) { writer(file).start(utc, 1_000_000) }
        assertArrayEquals(original, file.readBytes())
    }
    @Test fun `same boot resume starts a new unverified segment without rewriting old samples`() {
        val file = fixture("same-boot-resume")
        writer(file).use { w ->
            w.start(utc, 1_000_000)
            w.clock(sources[0].id, true, utc + 100, 1_100_000)
            w.sample(sources[0], 1_100_000, 1_101_000, utc + 101, "high", doubleArrayOf(0.0, 0.0, 9.8))
        }
        val original = file.readBytes()
        writer(file).use { w ->
            w.start(utc + 1000, 2_000_000)
            assertEquals("unverified", w.clockStates[sources[0].id])
            w.sample(sources[0], null, 2_001_000, utc + 1001, "high", doubleArrayOf(0.0, 0.0, 9.8))
        }
        assertArrayEquals(original, file.readBytes().copyOfRange(0, original.size))
        val samples = file.readLines().map(::JSONObject).filter { it.optString("recordType") == "motion_sample" }
        assertEquals(1_100_000L, samples[0].getLong("measurementMonotonicUs"))
        assertTrue(samples[1].isNull("measurementMonotonicUs"))
        assertEquals(1L, samples[1].getLong("sequence"))
    }
    @Test fun `partial failed append is repaired on a fresh writer without inventing a sequence`() {
        val file = fixture("partial-write-failure")
        var fail = false
        val w = MotionLogWriter(file, "synthetic-motion", "test+1", "boot-a", utc - 1000,
            sources, appendOverride = { bytes ->
                if (fail) { file.appendBytes(bytes.copyOfRange(0, bytes.size / 2)); throw IOException("partial IO") }
                file.appendBytes(bytes)
            }, synthetic = true)
        w.use {
            it.start(utc, 1_000_000)
            fail = true
            assertThrows(IOException::class.java) {
                it.sample(sources[0], null, 1_100_000, utc + 100, "high", doubleArrayOf(0.0, 0.0, 9.8))
            }
            assertNull(it.counts[sources[0].id])
        }
        writer(file).use {
            it.start(utc + 1000, 2_000_000)
            assertEquals(0L, it.sample(sources[0], null, 2_001_000, utc + 1001, "high", doubleArrayOf(0.0, 0.0, 9.8)))
        }
        assertEquals(1, file.readLines().map(::JSONObject).count { it.optString("eventType") == "log_truncated" })
    }
    @Test fun `failed append does not advance sequence or permit blind retry`() {
        val file = Files.createTempFile("motion-failure", ".ndjson").toFile()
        var fail = false
        val w = MotionLogWriter(file, "id", "test", "boot", 0, sources, appendOverride = {
            if (fail) throw IOException("simulated full disk")
        })
        w.use {
            it.start(utc, 1000)
            fail = true
            assertThrows(IOException::class.java) { it.sample(sources[0], null, 2000, utc, null, doubleArrayOf(0.0, 0.0, 9.8)) }
            assertNull(it.counts[sources[0].id])
            assertThrows(IllegalStateException::class.java) { it.sample(sources[0], null, 3000, utc, null, doubleArrayOf(0.0, 0.0, 9.8)) }
        }
    }
    @Test fun `known overflow and unknown sensor gaps retain their different counts`() {
        val file = fixture("drops")
        writer(file).use { w ->
            w.start(utc, 1_000_000)
            w.dropped(sources[0].id, 4, null, null, "buffer_full", utc + 100, 1_100_000)
            w.sample(sources[0], null, 1_110_000, utc + 110, "high", doubleArrayOf(0.0, 0.0, 9.8))
            w.clock(sources[0].id, true, utc + 200, 1_200_000)
            w.sample(sources[0], 1_200_000, 1_201_000, utc + 201, "high", doubleArrayOf(0.0, 0.0, 9.8))
            w.sample(sources[0], 1_400_000, 1_401_000, utc + 401, "high", doubleArrayOf(0.0, 0.0, 9.8))
        }
        val drops = file.readLines().map(::JSONObject).filter { it.optString("eventType") == "samples_dropped" }
        assertEquals(4L, drops[0].getLong("droppedCount"))
        assertTrue(drops[1].isNull("droppedCount"))
    }
    @Test fun `bounded buffer drops new and preserves accepted ordering`() {
        val b = MotionBuffer<Int>(2)
        assertTrue(b.offer(1)); assertTrue(b.offer(2)); assertFalse(b.offer(3))
        assertEquals(1, b.poll()); assertTrue(b.offer(4))
        assertEquals(2, b.poll()); assertEquals(4, b.poll()); assertTrue(b.isEmpty())
    }
}
