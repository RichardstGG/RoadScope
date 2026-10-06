package tw.idv.richardwutt.device_bridge

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.Semaphore
import kotlin.math.sqrt

/** One sensor looper (cheap copy/offer), one IO looper, independent of GPS IO.
 * Queue entries are capped; each holds at most four primitive doubles and one
 * source's accumulated overflow counter, never unbounded callback payloads. */
internal class MotionSession(private val context: Context, private val id: String,
    version: String, boot: String, anchor: Long) : SensorEventListener {
    companion object {
        private val fileOwner = Semaphore(1)
        private val generations = AtomicLong()
        @Volatile var latest: Map<String, Any?> = mapOf("state" to "idle")
            private set
        fun unavailable(id: String, error: String?) {
            generations.incrementAndGet()
            latest = mapOf("state" to "error", "recordingId" to id, "error" to error)
            MotionUpdates.publish(latest)
        }
        @Volatile private var current: MotionSession? = null
        fun control(action: String, reply: (Exception?) -> Unit) {
            val session = current
            if (session == null) reply(IllegalStateException("Start recording before calibrating"))
            else session.controlOnWriter(action, reply)
        }
    }
    private val generation = generations.incrementAndGet()
    private val manager = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    private val attitude = manager.getDefaultSensor(Sensor.TYPE_GAME_ROTATION_VECTOR)
        ?: manager.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)
    private val sensors = listOfNotNull(manager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER),
        manager.getDefaultSensor(Sensor.TYPE_GYROSCOPE), attitude)
    private val sources = listOf(
        MotionSource("android-accelerometer", "accelerometer", sensors.any { it.type == Sensor.TYPE_ACCELEROMETER }),
        MotionSource("android-gyroscope", "gyroscope", sensors.any { it.type == Sensor.TYPE_GYROSCOPE }),
        MotionSource(if (attitude?.type == Sensor.TYPE_GAME_ROTATION_VECTOR) "android-game-rotation-vector"
            else "android-rotation-vector", "attitude", attitude != null,
            if (attitude?.type == Sensor.TYPE_GAME_ROTATION_VECTOR) "game_rotation_vector" else "rotation_vector"),
    )
    private val sensorThread = HandlerThread("RoadScopeMotionSensors")
    private val writerThread = HandlerThread("RoadScopeMotionWriter")
    private lateinit var sensorHandler: Handler
    private lateinit var writerHandler: Handler
    private val writer = MotionLogWriter(File(File(context.filesDir, "motion"), "$id.motion.ndjson"),
        id, version, boot, anchor, sources)
    private val lean = LeanLogWriter(File(File(context.filesDir, "motion"), "$id.lean.ndjson"),
        id, boot, version, sources.map { it.id }, { writer.counts }, { writer.sync(it) })
    private val pipeline = LeanPipeline(lean, sources, boot)
    private val rideHint = AtomicReference<AutoUprightReference.Fix?>(null)
    fun rideFix(fix: AutoUprightReference.Fix) {
        if (!stopping.get() && !failed) rideHint.set(fix) // Conflated, no queued GPS callbacks.
    }
    private val controlPending = AtomicBoolean(false)
    private data class Packet(val source: MotionSource, val measured: Long, val received: Long,
        val uptime: Long, val utc: Long, val accuracy: String?, val values: DoubleArray,
        val droppedBefore: Long, val invalidBefore: Long)
    private val buffer = MotionBuffer<Packet>()
    private val probes = sources.associate { it.id to MotionClockProbe() }
    // Sensor looper owns overflow aggregation; writer consumes only immutable packets.
    private val pendingDrops = mutableMapOf<String, Long>()
    private val pendingInvalid = mutableMapOf<String, Long>()
    private val draining = AtomicBoolean(false)
    private val stopping = AtomicBoolean(false)
    @Volatile private var failed = false
    private var publishedUs = 0L
    private var offsetUs: Long? = null
    private var checkedMapUs = 0L
    private var ownsFile = false // Writer looper only.

    fun start() {
        latest = mapOf("state" to "starting", "recordingId" to id)
        MotionUpdates.publish(latest)
        writerThread.start(); writerHandler = Handler(writerThread.looper)
        sensorThread.start(); sensorHandler = Handler(sensorThread.looper)
        current = this
        writerHandler.post {
            try {
                fileOwner.acquire(); ownsFile = true
                if (stopping.get()) return@post
                val mono = SystemClock.elapsedRealtimeNanos() / 1000
                val utc = System.currentTimeMillis()
                writer.start(utc, mono)
                lean.start(utc, mono)
                watchInputs()
                offsetUs = utc * 1000 - mono
                publish("recording")
                sensorHandler.post {
                    if (stopping.get() || failed) return@post
                    sensors.forEach { sensor ->
                        if (!manager.registerListener(this, sensor, 20_000, 0, sensorHandler)) {
                            fail(IllegalStateException("Sensor registration failed: ${sensor.name}"))
                        }
                    }
                }
            } catch (error: Exception) { fail(error) }
        }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit
    override fun onSensorChanged(event: SensorEvent) {
        if (failed || stopping.get()) return
        val source = when (event.sensor.type) {
            Sensor.TYPE_ACCELEROMETER -> sources[0]
            Sensor.TYPE_GYROSCOPE -> sources[1]
            else -> sources[2]
        }
        val received = SystemClock.elapsedRealtimeNanos() / 1000
        val uptime = SystemClock.uptimeMillis() * 1000
        val utc = System.currentTimeMillis()
        val v = if (source.kind == "attitude") {
            val q = FloatArray(4)
            SensorManager.getQuaternionFromVector(q, event.values)
            val n = sqrt(q.sumOf { it.toDouble() * it })
            if (!n.isFinite() || n < 1e-9) { pendingInvalid[source.id] = (pendingInvalid[source.id] ?: 0) + 1; return }
            DoubleArray(4) { q[it] / n }
        } else event.values.take(3).map { it.toDouble() }.toDoubleArray()
        val limit = if (source.kind == "accelerometer") 2000 else if (source.kind == "gyroscope") 1000 else 1
        if (v.any { !it.isFinite() || kotlin.math.abs(it) > limit } || (source.kind != "attitude" && v.size != 3)) {
            pendingInvalid[source.id] = (pendingInvalid[source.id] ?: 0) + 1; return
        }
        val accuracy = when (event.accuracy) {
            0 -> "unreliable"; 1 -> "low"; 2 -> "medium"; 3 -> "high"; else -> null
        }
        val dropped = pendingDrops[source.id] ?: 0L
        val packet = Packet(source, event.timestamp / 1000, received, uptime, utc, accuracy, v, dropped,
            pendingInvalid[source.id] ?: 0)
        if (buffer.offer(packet)) {
            pendingDrops.remove(source.id)
            pendingInvalid.remove(source.id)
            scheduleDrain()
        } else pendingDrops[source.id] = dropped + 1
    }

    private fun scheduleDrain() {
        if (draining.compareAndSet(false, true)) writerHandler.post { drain() }
    }
    private fun watchInputs() {
        writerHandler.postDelayed({
            if (stopping.get() || failed) return@postDelayed
            try {
                if (buffer.isEmpty() && pipeline.expire(SystemClock.elapsedRealtimeNanos() / 1000,
                        System.currentTimeMillis())) publish("recording")
                lean.syncIfDue(SystemClock.elapsedRealtimeNanos() / 1000)
                watchInputs()
            } catch (error: Exception) { fail(error) }
        }, 250)
    }
    private fun controlOnWriter(action: String, reply: (Exception?) -> Unit) {
        if (stopping.get() || failed || !controlPending.compareAndSet(false, true)) {
            reply(IllegalStateException("Motion recorder unavailable or control pending")); return
        }
        if (!writerHandler.post {
            try {
                check(!stopping.get() && !failed) { "Motion recorder stopped" }
                pipeline.control(action); publish("recording"); reply(null)
            } catch (error: Exception) { reply(error) }
            finally { controlPending.set(false) }
        }) { controlPending.set(false); reply(IllegalStateException("Motion writer closed")) }
    }
    private fun drain() {
        try {
            var processed = 0
            while (!failed && processed++ < 256) {
                val packet = buffer.poll() ?: break
                if (packet.droppedBefore > 0 || packet.invalidBefore > 0)
                    pipeline.interrupted("after_input_gap", packet.utc, packet.received)
                if (packet.droppedBefore > 0) writer.dropped(packet.source.id,
                    packet.droppedBefore, null, null, "buffer_full", packet.utc, packet.received)
                if (packet.invalidBefore > 0) writer.dropped(packet.source.id,
                    packet.invalidBefore, null, null, "sensor_interrupted", packet.utc, packet.received)
                val verified = probes.getValue(packet.source.id).observe(packet.measured, packet.received, packet.uptime)
                val oldClock = writer.clockStates[packet.source.id]
                writer.clock(packet.source.id, verified, packet.utc, packet.received)
                if (oldClock != writer.clockStates[packet.source.id])
                    pipeline.interrupted("input_clock_state_change", packet.utc, packet.received)
                // UTC mapping drift is separate from the shared boot decision.
                // If wall clock changes, emit a fresh map without rewriting rows.
                if (packet.received - checkedMapUs >= 1_000_000) {
                    check(context.filesDir.usableSpace >= 256L * 1024 * 1024) { "Motion recording stopped: less than 256 MiB free" }
                    val offset = packet.utc * 1000 - packet.received
                    if (offsetUs != null && kotlin.math.abs(offset - offsetUs!!) > 2_000) {
                        writer.map(packet.utc, packet.received, 2_000)
                        offsetUs = offset
                    }
                    checkedMapUs = packet.received
                }
                val sequence = writer.sample(packet.source, if (verified) packet.measured else null,
                    packet.received, packet.utc, packet.accuracy, packet.values)
                rideHint.getAndSet(null)?.let { pipeline.rideFix(it) }
                // Only a successful raw append may reach the estimator.
                pipeline.consume(packet.source, sequence, if (verified) packet.measured else null,
                    packet.received, packet.utc, packet.values, writer.lastSampleMapId,
                    SystemClock.elapsedRealtimeNanos() / 1000, packet.accuracy)
                if (packet.received - publishedUs >= 100_000) { publish("recording"); publishedUs = packet.received }
            }
        } catch (error: Exception) { fail(error) }
        finally {
            draining.set(false)
            if (!failed && !buffer.isEmpty()) scheduleDrain()
        }
    }

    private fun publish(state: String, error: String? = null) {
        if (generation != generations.get()) return
        latest = mapOf("state" to state, "recordingId" to id, "counts" to writer.counts,
            "clockStates" to writer.clockStates, "error" to error,
            "path" to File(File(context.filesDir, "motion"), "$id.motion.ndjson").absolutePath,
            "leanPath" to File(File(context.filesDir, "motion"), "$id.lean.ndjson").absolutePath) + pipeline.snapshot
        MotionUpdates.publish(latest)
    }
    private fun fail(error: Exception) {
        failed = true
        // Can be called on sensor looper; do not touch writer state off its owner.
        sensorHandler.post { manager.unregisterListener(this) }
        writerHandler.post {
            try { pipeline.interrupted("raw_write_failure", System.currentTimeMillis(),
                SystemClock.elapsedRealtimeNanos() / 1000) } catch (_: Exception) { /* Keep original failure. */ }
            publish("error", error.message)
            closeWriter()
            stop()
        }
    }
    fun stop(reason: String? = null) {
        if (!stopping.compareAndSet(false, true)) return
        if (current === this) current = null
        sensorHandler.post {
            manager.unregisterListener(this)
            val drops = pendingDrops.toMap()
            val invalid = pendingInvalid.toMap()
            pendingDrops.clear()
            // Producer stopped: drain cannot race new callbacks.
            writerHandler.post {
                try {
                    while (!failed && !buffer.isEmpty()) drain()
                    if (!failed) {
                        drops.forEach { (source, count) -> writer.dropped(source, count, null, null,
                            "buffer_full", System.currentTimeMillis(), SystemClock.elapsedRealtimeNanos() / 1000) }
                        invalid.forEach { (source, count) -> writer.dropped(source, count, null, null,
                            "sensor_interrupted", System.currentTimeMillis(), SystemClock.elapsedRealtimeNanos() / 1000) }
                        pipeline.stopped(SystemClock.elapsedRealtimeNanos() / 1000,
                            if (reason == null) "recording_stopped" else "recording_interrupted")
                        closeWriter()
                        if (!failed) publish(if (reason == null) "idle" else "error", reason)
                    }
                } catch (error: Exception) { failed = true; publish("error", error.message) }
                finally {
                    closeWriter()
                    sensorThread.quitSafely(); writerThread.quitSafely()
                }
            }
        }
    }
    private fun closeWriter() {
        try { lean.close() } catch (error: Exception) {
            failed = true; publish("error", error.message)
        }
        try { writer.close() } catch (error: Exception) {
            failed = true; publish("error", error.message)
        } finally {
            if (ownsFile) { ownsFile = false; fileOwner.release() }
        }
    }
}
