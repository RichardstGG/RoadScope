package tw.idv.richardwutt.device_bridge

import kotlin.math.*

/** Experimental gyro propagation of WORLD up in DEVICE coordinates. Platform
 * attitude only seeds the epoch and supplies slow correction while stationary.
 * Specific force is a quality/rest gate, never used as dynamic world-up.
 * No accuracy claim: gyro bias and platform initial attitude still matter. */
internal class LeanFusion {
    var up: LeanVector? = null
        private set
    private var gyroTime: Long? = null
    fun reset() { up = null; gyroTime = null }
    fun seed(q: DoubleArray) {
        require(q.size == 4 && q.all { it.isFinite() })
        val w = q[0]; val x = q[1]; val y = q[2]; val z = q[3]
        up = LeanVector(2 * (x * z - w * y), 2 * (y * z + w * x),
            1 - 2 * (x * x + y * y)).unit()
    }
    fun gyro(time: Long, rate: LeanVector) {
        val previous = gyroTime
        gyroTime = time
        val current = up ?: return
        if (previous == null) return
        val dt = (time - previous) / 1e6
        require(dt > 0 && dt <= 0.1) { "Gyro continuity lost" }
        val magnitude = rate.norm()
        if (magnitude < 1e-9) return
        val axis = rate * (1 / magnitude)
        val angle = -magnitude * dt
        up = (current * cos(angle) + axis.cross(current) * sin(angle) +
            axis * (axis.dot(current) * (1 - cos(angle)))).unit()
    }
    fun stationaryCorrection(q: DoubleArray) {
        val old = up ?: return
        seed(q)
        up = (old * 0.99 + up!! * 0.01).unit()
    }
}
