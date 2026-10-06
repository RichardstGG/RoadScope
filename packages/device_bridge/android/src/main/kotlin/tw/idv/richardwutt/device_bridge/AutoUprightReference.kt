package tw.idv.richardwutt.device_bridge

import kotlin.math.*

/** Pure candidate selector, not yet connected to the recorder. Never infers a
 * motorcycle longitudinal axis or a signed lean angle. All thresholds below
 * are conservative engineering defaults, not road-accuracy claims.
 * Owner: the motion writer. No IO, timers, raw history or unbounded collections. */
internal class AutoUprightReference(private val boot: String) {
    data class Fix(val boot: String, val measuredUs: Long?, val clockVerified: Boolean,
        val speedMps: Double?, val horizontalAccuracyM: Double?, val speedAccuracyMps: Double?,
        val headingDeg: Double?, val headingAccuracyDeg: Double?)
    data class Reference(val up: LeanVector, val accumulatedDurationUs: Long, val windowCount: Int,
        val minSpeedMps: Double, val maxYawRateRadPerS: Double, val upSpreadDeg: Double,
        val fromUs: Long, val toUs: Long)
    private data class QualifiedFix(val time: Long, val speed: Double, val heading: Double)
    private data class Bucket(val anchor: LeanVector, var sum: LeanVector,
        var duration: Long, var windows: Int, var minSpeed: Double, var maxYaw: Double,
        var spread: Double, val from: Long, var to: Long)
    private val buckets = ArrayList<Bucket>(8)
    private var previousFix: QualifiedFix? = null
    private var fix: QualifiedFix? = null
    private var windowAnchor: LeanVector? = null
    private var windowSum = LeanVector(0.0, 0.0, 0.0)
    private var windowFrom = 0L
    private var lastTime: Long? = null
    private var highWater: Long? = null
    private var windowSpread = 0.0
    private var minSpeed = Double.POSITIVE_INFINITY
    private var maxYaw = 0.0
    private var delivered = false
    var saturated = false
        private set
    val candidateCount: Int get() = buckets.size
    val dominantDurationUs: Long get() = buckets.maxOfOrNull { it.duration } ?: 0L

    /** Need two independently measured GPS fixes to qualify straight travel.
     * A duplicate/out-of-order/invalid fix cannot prolong an earlier fix. */
    fun updateFix(value: Fix) {
        val time = value.measuredUs
        fun bounded(v: Double?, lo: Double, hi: Double) = v != null && v.isFinite() && v in lo..hi
        if (value.boot != boot || !value.clockVerified || time == null || time < 0 ||
            !bounded(value.speedMps, 5.0, 100.0) || !bounded(value.horizontalAccuracyM, 0.0, 10.0) ||
            !bounded(value.speedAccuracyMps, 0.0, 1.5) || !bounded(value.headingDeg, 0.0, 360.0) ||
            value.headingDeg == 360.0 ||
            !bounded(value.headingAccuracyDeg, 0.0, 5.0)) {
            previousFix = null; fix = null; breakWindow(); return
        }
        val current = QualifiedFix(time, value.speedMps!!, value.headingDeg!!)
        val old = previousFix
        if (old != null && time <= old.time) {
            fix = null; breakWindow(); return // Do not replace the high-water mark.
        }
        previousFix = current
        val dt = if (old == null) 0L else time - old.time
        val change = if (old == null) 180.0 else abs((current.heading - old.heading + 540.0) % 360.0 - 180.0)
        fix = if (dt in 100_000L..2_000_000L && change / (dt / 1_000_000.0) <= 1.0) current else null
        if (fix == null) breakWindow()
    }

    /** Called with verified, successfully stored motion measurement times.
     * Only complete, non-overlapping three-second windows contribute time.
     * gyro norm bounds yaw without needing the still-unknown vehicle axis. */
    fun add(time: Long, up: LeanVector, gyroNorm: Double, accelerationNorm: Double): Reference? {
        if (delivered || saturated) return null
        if (time < 0 || (highWater != null && time <= highWater!!)) { breakWindow(); return null }
        highWater = time
        val gps = fix
        val unit = up.unit()
        if (gps == null || time < gps.time || time - gps.time > 1_500_000 || unit == null ||
            !gyroNorm.isFinite() || gyroNorm !in 0.0..0.017453292519943295 ||
            !accelerationNorm.isFinite() || abs(accelerationNorm - 9.80665) > 0.4) {
            breakWindow(); return null
        }
        val prior = lastTime
        if (prior != null && (time <= prior || time - prior > 100_000)) breakWindow()
        val anchor = windowAnchor
        if (anchor != null && angle(anchor, unit) > 1.5) breakWindow()
        if (windowAnchor == null) {
            windowAnchor = unit; windowFrom = time; windowSum = LeanVector(0.0, 0.0, 0.0)
            minSpeed = gps.speed; maxYaw = gyroNorm
        } else {
            // Duration weighting, not callback-count weighting.
            windowSum += unit * (time - lastTime!!).toDouble()
            windowSpread = maxOf(windowSpread, angle(windowAnchor!!, unit))
            minSpeed = minOf(minSpeed, gps.speed); maxYaw = maxOf(maxYaw, gyroNorm)
        }
        lastTime = time
        val duration = time - windowFrom
        if (duration < 3_000_000) return null
        val mean = windowSum.unit()!!
        // Triangle inequality: bound every input's spread from the final mean
        // without retaining the whole window. Do not under-report anchor drift.
        val spreadBound = windowSpread + angle(windowAnchor!!, mean)
        val bucket = buckets.firstOrNull { angle(it.anchor, mean) + spreadBound <= 2.0 }
        if (bucket == null) {
            // Never evict accumulated evidence: that could manufacture a winner.
            if (buckets.size == 8) { saturated = true; breakWindow(); return null }
            buckets.add(Bucket(mean, mean * duration.toDouble(), duration, 1,
                minSpeed, maxYaw, spreadBound, windowFrom, time))
        } else {
            bucket.sum += mean * duration.toDouble(); bucket.duration += duration; bucket.windows++
            bucket.minSpeed = minOf(bucket.minSpeed, minSpeed); bucket.maxYaw = maxOf(bucket.maxYaw, maxYaw)
            bucket.spread = maxOf(bucket.spread, angle(bucket.anchor, mean) + spreadBound); bucket.to = time
        }
        // Share only the boundary point with the next window, never its duration.
        breakWindow(); windowAnchor = unit; windowFrom = time; lastTime = time
        minSpeed = gps.speed; maxYaw = gyroNorm
        val ordered = buckets.sortedByDescending { it.duration }
        val winner = ordered.first()
        val runner = ordered.getOrNull(1)?.duration ?: 0L
        if (winner.duration < 30_000_000 || winner.duration - runner < 6_000_000 ||
            winner.duration.toDouble() < runner * 1.5) return null
        delivered = true
        val reference = winner.sum.unit()!!
        return Reference(reference, winner.duration, winner.windows, winner.minSpeed,
            winner.maxYaw, winner.spread + angle(winner.anchor, reference), winner.from, winner.to)
    }
    /** A new session/boot or explicit reset must not inherit old candidate time. */
    fun reset() {
        buckets.clear(); previousFix = null; fix = null; highWater = null
        delivered = false; saturated = false; breakWindow()
    }
    private fun breakWindow() {
        windowAnchor = null; windowSum = LeanVector(0.0, 0.0, 0.0); lastTime = null
        windowSpread = 0.0; minSpeed = Double.POSITIVE_INFINITY; maxYaw = 0.0
    }
    private fun angle(a: LeanVector, b: LeanVector) = Math.toDegrees(acos(a.dot(b).coerceIn(-1.0, 1.0)))
}
