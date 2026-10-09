package tw.idv.richardwutt.device_bridge

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import io.flutter.plugin.common.EventChannel
import java.util.concurrent.atomic.AtomicBoolean

/** A conflated mailbox: at most one pending main-looper delivery, even while
 * Flutter is paused. No raw samples/files cross the channel. */
internal object MotionUpdates {
    private val main = Handler(Looper.getMainLooper())
    private val pending = AtomicBoolean(false)
    @Volatile private var latest: Map<String, Any?> = emptyMap()
    private var sink: EventChannel.EventSink? = null // Main looper only.
    fun attach(value: EventChannel.EventSink) {
        sink = value; value.success(motionSnapshotAt(MotionSession.latest, SystemClock.elapsedRealtimeNanos() / 1000))
    }
    fun detach(value: EventChannel.EventSink?) { if (sink === value) sink = null }
    fun publish(value: Map<String, Any?>) {
        latest = value
        if (pending.compareAndSet(false, true)) main.post {
            pending.set(false); sink?.success(motionSnapshotAt(latest, SystemClock.elapsedRealtimeNanos() / 1000))
        }
    }
}
