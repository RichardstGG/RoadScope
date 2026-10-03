package tw.idv.richardwutt.device_bridge

import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.time.Instant
import java.util.UUID

/** Called only on the recorder worker looper, including start/recovery events. */
internal class LocationLogWriter(
    private val file: File,
    private val recordingId: String,
    private val appVersion: String,
    var bootId: String,
    var bootAnchor: Long,
) {
    var sequence = 0L
        private set
    private val thresholdMs = 60_000L

    fun start(utcMs: Long, monoUs: Long, resume: Boolean) {
        file.parentFile?.mkdirs()
        var truncated = 0L
        if (file.exists()) RandomAccessFile(file, "rw").use { stream ->
            val length = stream.length()
            var end = length
            if (length > 0) {
                stream.seek(length - 1)
                if (stream.readByte().toInt() != 10) {
                    var cursor = length - 1
                    while (cursor >= 0) {
                        stream.seek(cursor)
                        if (stream.readByte().toInt() == 10) break
                        cursor--
                    }
                    end = cursor + 1
                }
            }
            // Validate complete rows before touching the file. Never mix a legacy
            // recording with v1 or silently discard corrupt complete rows.
            var lastMono = 0L
            val completeText = Charsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(file.readBytes(), 0, end.toInt())).toString()
            completeText.lineSequence().forEach { line ->
                if (line.isBlank()) return@forEach
                val record = JSONObject(line)
                require(record.has("recordType")) { "舊格式紀錄已保留；請停止後開始新紀錄" }
                require(record.getString("recordingId") == recordingId)
                require(record.getInt("schemaVersion") == 1 && record.getString("sourceId") == "android-gps")
                bootId = record.getString("deviceBootId")
                if (record.has("bootAnchorUtcMs")) bootAnchor = record.getLong("bootAnchorUtcMs")
                if (record.getString("recordType") == "sample") {
                    val previous = record.getLong("sequence")
                    require(previous >= sequence) { "Invalid recovered sequence" }
                    sequence = previous + 1
                    lastMono = record.getLong("receivedMonotonicUs")
                } else if (record.getString("recordType") == "event") {
                    lastMono = record.getLong("occurredMonotonicUs")
                }
            }
            resumedAfterBoot = lastMono > monoUs
            truncated = length - end
            if (truncated > 0) { stream.setLength(end); stream.fd.sync() }
        }
        val previousId = bootId
        val previousAnchor = bootAnchor
        val anchor = utcMs - monoUs / 1000
        val changed = kotlin.math.abs(anchor - bootAnchor) >= thresholdMs || resumedAfterBoot
        if (changed) bootId = UUID.randomUUID().toString()
        bootAnchor = anchor
        event("recording_started", utcMs, monoUs, JSONObject().apply {
            put("platform", "android"); put("appVersion", appVersion)
            put("sourceType", "phone_location")
            put("sourceCapabilities", JSONObject().put("measurementMonotonic", true).put("monotonicIncludesSleep", true))
            put("bootAnchorUtcMs", bootAnchor)
        })
        if (resume && changed) clockEvent(previousId, previousAnchor, utcMs, monoUs)
        if (truncated > 0) event("log_truncated", utcMs, monoUs,
            JSONObject().put("truncatedBytes", truncated).put("resumedSequence", sequence))
        if (resume) event("recording_resumed", utcMs, monoUs,
            JSONObject().put("reason", if (resumedAfterBoot) "boot" else "process_restart").put("resumedSequence", sequence))
    }

    private var resumedAfterBoot = false

    /** Whether the last [start] looked like a reboot rather than a process restart. */
    val bootResumed get() = resumedAfterBoot

    fun sample(record: JSONObject, utcMs: Long, monoUs: Long) {
        val anchor = utcMs - monoUs / 1000
        if (kotlin.math.abs(anchor - bootAnchor) >= thresholdMs) {
            val previousId = bootId
            val previousAnchor = bootAnchor
            bootId = UUID.randomUUID().toString()
            bootAnchor = anchor
            clockEvent(previousId, previousAnchor, utcMs, monoUs)
        }
        record.put("schemaVersion", 1).put("recordType", "sample")
            .put("recordingId", recordingId).put("sourceId", "android-gps")
            .put("sourceType", "phone_location").put("deviceBootId", bootId)
            .put("sequence", sequence).put("receivedAtUtc", Instant.ofEpochMilli(utcMs).toString())
            .put("receivedMonotonicUs", monoUs)
        append(record)
        sequence++ // Advance only after a successful durable append.
    }

    private fun clockEvent(previousId: String, previousAnchor: Long, utcMs: Long, monoUs: Long) =
        event("clock_adjusted", utcMs, monoUs, JSONObject()
            .put("previousDeviceBootId", previousId).put("previousBootAnchorUtcMs", previousAnchor)
            .put("bootAnchorUtcMs", bootAnchor).put("thresholdMs", thresholdMs))

    private fun event(type: String, utcMs: Long, monoUs: Long, fields: JSONObject) {
        fields.put("schemaVersion", 1).put("recordType", "event").put("eventType", type)
            .put("recordingId", recordingId).put("sourceId", "android-gps")
            .put("deviceBootId", bootId).put("occurredAtUtc", Instant.ofEpochMilli(utcMs).toString())
            .put("occurredMonotonicUs", monoUs).put("lastSequence", sequence - 1)
        append(fields)
    }

    private fun append(record: JSONObject) {
        FileOutputStream(file, true).use { output ->
            output.write((record.toString() + "\n").toByteArray(Charsets.UTF_8))
            output.fd.sync()
        }
    }
}
