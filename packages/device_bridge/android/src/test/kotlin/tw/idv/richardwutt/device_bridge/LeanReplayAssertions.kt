package tw.idv.richardwutt.device_bridge

import java.io.File
import org.json.JSONObject
import org.junit.jupiter.api.Assertions.*
import kotlin.math.abs

/** Test-only full replay from persisted files. Uses production fusion, not a
 * second product estimator. Calibration records are fixed replay inputs; GPS
 * candidate selection is NOT claimed replayable by this comparison. */
internal object LeanReplayAssertions {
    fun verify(motion: File, lean: File): Int {
        val raw = motion.readLines().filter { it.isNotBlank() }.map(::JSONObject)
            .filter { it.getString("recordType") == "motion_sample" }
        val rows = lean.readLines().filter { it.isNotBlank() }.map(::JSONObject)
        val epochs = rows.filter { it.optString("eventType") == "estimator_reset" }
            .associateBy { it.getInt("filterEpoch") }
        val calibrations = rows.filter { it.getString("recordType") == "lean_calibration" }
            .associateBy { it.getString("calibrationId") }
        var checked = 0
        for (estimate in rows.filter { it.getString("recordType") == "lean_estimate" && !it.isNull("leanAngleDeg") }) {
            val epoch = epochs.getValue(estimate.getInt("filterEpoch"))
            val boot = estimate.getString("deviceBootId")
            val starts = epoch.getJSONArray("initialInputs").let { array ->
                (0 until array.length()).associate { i -> array.getJSONObject(i).let {
                    it.getString("sourceId") to it.getLong("firstSequence") } }
            }
            val ends = estimate.getJSONArray("sourceRefs").let { array ->
                (0 until array.length()).associate { i -> array.getJSONObject(i).let {
                    it.getString("sourceId") to it.getLong("lastSequence") } }
            }
            val inputs = raw.filter { it.getString("deviceBootId") == boot &&
                it.getLong("sequence") in starts.getValue(it.getString("sourceId"))..ends.getValue(it.getString("sourceId")) }
            val fusion = LeanFusion()
            val latest = mutableMapOf<String, JSONObject>()
            var seeded = false
            for (input in inputs) {
                assertFalse(input.isNull("measurementMonotonicUs"))
                val kind = input.getString("sensorType")
                latest[kind] = input
                if (latest.size != 3) continue
                val gyro = latest.getValue("gyroscope")
                val accel = latest.getValue("accelerometer")
                val attitude = latest.getValue("attitude")
                val rate = vector(gyro, "xRadPerS", "yRadPerS", "zRadPerS")
                val q = doubleArrayOf(attitude.getDouble("qw"), attitude.getDouble("qx"),
                    attitude.getDouble("qy"), attitude.getDouble("qz"))
                if (!seeded) {
                    fusion.seed(q); fusion.gyro(gyro.getLong("measurementMonotonicUs"), rate); seeded = true
                } else if (kind == "gyroscope") fusion.gyro(input.getLong("measurementMonotonicUs"), rate)
                if (kind == "attitude" && rate.norm() <= 0.035 &&
                    abs(vector(accel, "xMps2", "yMps2", "zMps2").norm() - 9.80665) <= 0.4) fusion.stationaryCorrection(q)
            }
            val calibration = calibrations.getValue(estimate.getString("calibrationId"))
            fun arrayVector(key: String): LeanVector {
                val a = calibration.getJSONObject(key)
                return LeanVector(a.getDouble("x"), a.getDouble("y"), a.getDouble("z"))
            }
            val up = arrayVector("upDevice")
            val mount = LeanMount(up, up.cross(arrayVector("leanAxisDevice")).unit()!!)
            assertEquals(estimate.getDouble("leanAngleDeg"), mount.angle(fusion.up!!)!!, 1e-9,
                "Stored estimate sequence ${estimate.getLong("sequence")} cannot be replayed")
            checked++
        }
        return checked
    }
    private fun vector(row: JSONObject, x: String, y: String, z: String) =
        LeanVector(row.getDouble(x), row.getDouble(y), row.getDouble(z))
}
