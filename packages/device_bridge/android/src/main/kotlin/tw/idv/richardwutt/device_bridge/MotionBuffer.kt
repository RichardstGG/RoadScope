package tw.idv.richardwutt.device_bridge

import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicInteger

/** No waiting for capacity or consumer IO. Includes reserved-but-not-enqueued
 * items in size so even concurrent producers cannot exceed the bound. */
internal class MotionBuffer<T>(private val capacity: Int = 1024) {
    init { require(capacity > 0) }
    private val entries = ConcurrentLinkedQueue<T>()
    private val size = AtomicInteger()
    fun offer(item: T): Boolean {
        while (true) {
            val current = size.get()
            if (current >= capacity) return false
            if (size.compareAndSet(current, current + 1)) break
        }
        entries.offer(item)
        return true
    }
    fun poll(): T? = entries.poll()?.also { size.decrementAndGet() }
    fun isEmpty() = size.get() == 0
}
