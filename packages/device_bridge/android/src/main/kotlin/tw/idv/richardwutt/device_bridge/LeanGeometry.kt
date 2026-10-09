package tw.idv.richardwutt.device_bridge

import kotlin.math.*

/** Geometry only: inputs must be independently validated estimates of WORLD up
 * expressed in device axes. Raw acceleration in a turn is NOT world up.
 * No Android display rotation or wall-clock time enters these calculations. */
internal data class LeanVector(val x: Double, val y: Double, val z: Double) {
    operator fun plus(b: LeanVector) = LeanVector(x + b.x, y + b.y, z + b.z)
    operator fun minus(b: LeanVector) = LeanVector(x - b.x, y - b.y, z - b.z)
    operator fun times(k: Double) = LeanVector(x * k, y * k, z * k)
    fun dot(b: LeanVector) = x * b.x + y * b.y + z * b.z
    fun cross(b: LeanVector) = LeanVector(y * b.z - z * b.y, z * b.x - x * b.z, x * b.y - y * b.x)
    fun norm() = sqrt(dot(this))
    fun unit(): LeanVector? {
        val n = sqrt(dot(this))
        return if (!n.isFinite() || n < 1e-9) null else this * (1 / n)
    }
}

internal data class LeanMount(val upright: LeanVector, val right: LeanVector) {
    val axis: LeanVector get() = right.cross(upright).unit()!!
    /** Positive = right lean, negative = left lean. Pitch is projected out.
     * Near the forward-axis singularity or upside down, return unavailable. */
    fun angle(upInDevice: LeanVector): Double? {
        val up = upInDevice.unit() ?: return null
        val vertical = up.dot(upright)
        val lateral = up.dot(right)
        if (vertical <= 0 || hypot(vertical, lateral) < 0.25) return null
        return -Math.toDegrees(atan2(lateral, vertical))
    }

    companion object {
        /** Second pose is explicitly labelled LEFT by the user, front wheel
         * straight. A yaw-only or tiny movement must not establish an axis. */
        fun fromLeftPose(upright: LeanVector, left: LeanVector): LeanMount? {
            val a = upright.unit() ?: return null
            val b = left.unit() ?: return null
            val tilt = Math.toDegrees(acos(a.dot(b).coerceIn(-1.0, 1.0)))
            if (tilt < 5.0 || tilt > 25.0) return null
            val right = (b - a * a.dot(b)).unit() ?: return null
            return LeanMount(a, right)
        }
    }
}

/** Three seconds of contiguous stationary observations, sensor time in us.
 * Rejected/gapped data resets the window; sparse callbacks cannot qualify. */
internal class UprightWindow {
    val startUs: Long? get() = start
    val lastUs: Long? get() = previous
    var spreadDeg = 0.0
        private set
    private var start: Long? = null
    private var previous: Long? = null
    private var anchor: LeanVector? = null
    private var sum = LeanVector(0.0, 0.0, 0.0)

    fun reset() {
        start = null; previous = null; anchor = null
        sum = LeanVector(0.0, 0.0, 0.0)
        spreadDeg = 0.0
    }

    fun add(timeUs: Long, up: LeanVector, gyroRadS: Double, accelerationMps2: Double): LeanVector? {
        val unit = up.unit()
        if (timeUs < 0 || unit == null || !gyroRadS.isFinite() || gyroRadS < 0 ||
            gyroRadS > 0.035 || !accelerationMps2.isFinite() ||
            abs(accelerationMps2 - 9.80665) > 0.4) {
            reset(); return null
        }
        val last = previous
        if (last != null && (timeUs <= last || timeUs - last > 100_000)) reset()
        val reference = anchor
        if (reference != null && reference.dot(unit) < cos(Math.toRadians(1.5))) reset()
        if (start == null) { start = timeUs; anchor = unit }
        spreadDeg = maxOf(spreadDeg, Math.toDegrees(acos(anchor!!.dot(unit).coerceIn(-1.0, 1.0))))
        previous = timeUs
        sum += unit
        return if (timeUs - start!! >= 3_000_000) sum.unit() else null
    }
}
