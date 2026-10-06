package tw.idv.richardwutt.device_bridge

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorManager

/** Read-only inventory. Availability does not imply accurate vehicle lean. */
internal fun motionCapabilities(context: Context): Map<String, Any?> {
    val manager = context.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
    fun present(type: Int) = manager?.getDefaultSensor(type) != null
    return mapOf(
        "platform" to "android",
        "accelerometer" to present(Sensor.TYPE_ACCELEROMETER),
        "gyroscope" to present(Sensor.TYPE_GYROSCOPE),
        "rotationVector" to present(Sensor.TYPE_ROTATION_VECTOR),
        "gameRotationVector" to present(Sensor.TYPE_GAME_ROTATION_VECTOR),
        "measurementClock" to "elapsed_realtime_nanos",
        "leanRecordingAvailable" to false,
    )
}
